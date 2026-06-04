import { useEffect, useRef, useState, useCallback } from "react";
import { useRoute, Link } from "wouter";
import { Radio, WifiOff, ChevronLeft, ExternalLink, Volume2, VolumeX, Flag, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useListMotos, useListResults } from "@workspace/api-client-react";
import { SplitView360 } from "@/components/SplitView360";
import { StackedSplitView } from "@/components/StackedSplitView";

type ViewerState = "connecting" | "buffering" | "playing" | "offline" | "ended" | "error";

function getWsUrl(eventId: number): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  return `${proto}//${host}/api/video/watch/${eventId}`;
}

interface LeaderboardEntry {
  position: number;
  riderId: number;
  riderName: string;
  bibNumber: string | null;
  laps: number;
  lastLap: string | null;
  gap: string;
  dnf: boolean;
  dns: boolean;
}

export default function WatchLive() {
  const [, params] = useRoute("/watch/:eventId");
  const eventId = parseInt(params?.eventId ?? "0", 10);

  const [viewerState, setViewerState] = useState<ViewerState>("connecting");
  const setViewerStateSynced = (s: ViewerState) => { viewerStateRef.current = s; setViewerState(s); };

  const [is360, setIs360] = useState(false);
  const [isDualFisheye, setIsDualFisheye] = useState(false);
  const [videoNaturalDims, setVideoNaturalDims] = useState({ w: 0, h: 0 });
  const [needsTap, setNeedsTap] = useState(false);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [announcerOn, setAnnouncerOn] = useState(true);
  const [announcerLabel, setAnnouncerLabel] = useState<string | null>(null);
  const [sseLeaderboard, setSseLeaderboard] = useState<LeaderboardEntry[] | null>(null);
  const audioUnlockedRef = useRef(false);
  // Once a 360 format is confirmed, lock it so MSE reconnects can't reset the detection.
  const formatLockedRef = useRef(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const msRef = useRef<MediaSource | null>(null);
  const sbRef = useRef<SourceBuffer | null>(null);
  const queueRef = useRef<ArrayBuffer[]>([]);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTimeRef = useRef<number>(-1);
  const viewerStateRef = useRef<ViewerState>("connecting");
  const cleaningUpRef = useRef(false);
  const mimeTypeRef = useRef('video/webm; codecs="vp8,opus"');
  const bytesRef = useRef(0);
  const lastErrRef = useRef("");
  // Rolling event log — last 5 events; gives a chronological trace instead of just the final state
  const eventLogRef = useRef<string[]>([]);

  // Announcer refs
  const announcerOnRef = useRef(true);
  const audioQueueRef = useRef<string[]>([]);
  const annPlayingRef = useRef(false);
  const prevLapsRef = useRef<Map<number, number>>(new Map());
  const prevPositionsRef = useRef<Map<number, number>>(new Map());
  const esRef = useRef<EventSource | null>(null);
  const activeMotoIdRef = useRef<number | null>(null);
  const prevSseStatusRef = useRef<string | null>(null);

  // Live moto + results — poll every 15 s; no burst on window focus
  const { data: motos } = useListMotos(eventId, {
    query: { enabled: !!eventId, refetchInterval: 15_000, refetchOnWindowFocus: false, staleTime: 10_000 } as any,
  });
  const { data: results } = useListResults(eventId, {
    query: { enabled: !!eventId, refetchInterval: 15_000, refetchOnWindowFocus: false, staleTime: 10_000 } as any,
  });

  // Active moto: prefer in_progress, fall back to most-recently-completed
  const activeMoto =
    motos?.find(m => m.status === "in_progress") ??
    [...(motos ?? [])].filter(m => m.status === "completed").pop();

  // Unified rider row type satisfied by both LineupEntry and RaceResult
  type RiderRow = { position: number; riderId: number; riderName: string; bibNumber?: string | null };
  const liveRiders: RiderRow[] = activeMoto
    ? activeMoto.status === "completed"
      ? (results ?? [])
          .filter(r => r.motoId === activeMoto.id)
          .sort((a, b) => a.position - b.position)
      : [...(activeMoto.lineup ?? [])].sort((a, b) => a.position - b.position)
    : [];

  const motoTypeLabel = (t: string) =>
    t === "main" ? "Main Event" : t === "lcq" ? "LCQ" : t === "heat" ? "Heat" : "Practice";
  const motoTypeColor = (t: string) =>
    t === "main" ? "bg-amber-500/20 text-amber-400" :
    t === "lcq"  ? "bg-purple-500/20 text-purple-400" :
    t === "heat" ? "bg-blue-500/20 text-blue-400" :
                   "bg-white/10 text-white/40";

  const logEvent = (msg: string) => {
    lastErrRef.current = msg;
    eventLogRef.current = [...eventLogRef.current.slice(-4), msg];
    // eslint-disable-next-line no-console
    console.debug("[WatchLive]", msg);
  };

  // Keep announcerOnRef in sync with state so SSE callbacks see the latest value
  useEffect(() => { announcerOnRef.current = announcerOn; }, [announcerOn]);

  // ── Announcer audio queue ─────────────────────────────────────────────────
  const drainQueue = useCallback(() => {
    if (annPlayingRef.current || audioQueueRef.current.length === 0) return;
    const url = audioQueueRef.current.shift()!;
    annPlayingRef.current = true;
    const audio = new Audio(url);
    audio.onended = () => { URL.revokeObjectURL(url); annPlayingRef.current = false; drainQueue(); };
    audio.onerror = () => { URL.revokeObjectURL(url); annPlayingRef.current = false; drainQueue(); };
    audio.play().catch(() => { annPlayingRef.current = false; drainQueue(); });
  }, []);

  const enqueueAudio = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob);
    audioQueueRef.current.push(url);
    drainQueue();
  }, [drainQueue]);

  const triggerAnnouncement = useCallback(async (
    lapCompleted: number,
    top5: LeaderboardEntry[],
    positionChanges: Array<{ riderName: string; from: number; to: number }>,
    isComplete: boolean
  ) => {
    if (!announcerOnRef.current) return;
    try {
      setAnnouncerLabel(isComplete ? "Race complete!" : `Lap ${lapCompleted} announced`);
      const res = await fetch("/api/timing/announce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lapCompleted,
          top5: top5.slice(0, 5).map(e => ({
            position: e.position, riderName: e.riderName, laps: e.laps,
            lastLap: e.lastLap, gap: e.gap, dnf: e.dnf, dns: e.dns,
          })),
          positionChanges,
          isComplete,
        }),
      });
      if (!res.ok) return;
      enqueueAudio(await res.blob());
    } catch { /* skip silently */ }
  }, [enqueueAudio]);

  // ── SSE: real-time timing data + announcer ────────────────────────────────
  useEffect(() => {
    const motoId = activeMoto?.status === "in_progress" ? activeMoto.id : null;
    if (!motoId) {
      esRef.current?.close();
      esRef.current = null;
      activeMotoIdRef.current = null;
      prevSseStatusRef.current = null;
      setSseLeaderboard(null);
      return;
    }
    if (activeMotoIdRef.current === motoId) return; // already connected

    esRef.current?.close();
    activeMotoIdRef.current = motoId;
    prevLapsRef.current = new Map();
    prevPositionsRef.current = new Map();
    prevSseStatusRef.current = null;

    const es = new EventSource(`/api/timing/live/${motoId}`);
    esRef.current = es;

    es.onmessage = (evt) => {
      try {
        const payload = JSON.parse(evt.data);
        if (payload.error) return;

        const top5 = (payload.leaderboard as LeaderboardEntry[]).filter(r => !r.dnf && !r.dns).slice(0, 5);
        let maxNewLap = 0;
        const posChanges: Array<{ riderName: string; from: number; to: number }> = [];

        for (const entry of top5) {
          const oldLaps = prevLapsRef.current.get(entry.riderId) ?? 0;
          const oldPos = prevPositionsRef.current.get(entry.riderId);
          if (entry.laps > oldLaps && entry.laps > 0) maxNewLap = Math.max(maxNewLap, entry.laps);
          if (oldPos !== undefined && oldPos !== entry.position && entry.position <= 5) {
            posChanges.push({ riderName: entry.riderName, from: oldPos, to: entry.position });
          }
        }
        for (const entry of payload.leaderboard as LeaderboardEntry[]) {
          prevLapsRef.current.set(entry.riderId, entry.laps);
          prevPositionsRef.current.set(entry.riderId, entry.position);
        }

        const isComplete = payload.status === "completed";
        const wasInProgress = prevSseStatusRef.current === "in_progress";
        prevSseStatusRef.current = payload.status;

        if (maxNewLap > 0) triggerAnnouncement(maxNewLap, top5, posChanges, isComplete);
        else if (isComplete && wasInProgress) triggerAnnouncement(top5[0]?.laps ?? 0, top5, posChanges, true);

        setSseLeaderboard(payload.leaderboard as LeaderboardEntry[]);
      } catch { /* ignore parse errors */ }
    };

    return () => {
      es.close();
      if (esRef.current === es) { esRef.current = null; activeMotoIdRef.current = null; }
    };
  }, [activeMoto?.id, activeMoto?.status, triggerAnnouncement]);

  useEffect(() => {
    if (!eventId) return;
    connect();
    return () => cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  function teardownMSE() {
    // Null refs first — any subsequent sourceclose/updateend from old objects is harmless
    msRef.current = null;
    sbRef.current = null;
    queueRef.current = [];
    if (videoRef.current) {
      videoRef.current.src = "";   // triggers sourceclose on the old MediaSource (ignored since ref is null)
      videoRef.current.load();     // reset decoder state
    }
  }

  function cleanup() {
    cleaningUpRef.current = true;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    if (stallTimerRef.current) clearInterval(stallTimerRef.current);
    wsRef.current?.close();
    wsRef.current = null;
    teardownMSE();
  }

  function initMSE(mime: string) {
    if (!videoRef.current) {
      logEvent("videoRef null");
      return;
    }

    const ms = new MediaSource();
    msRef.current = ms;
    const objUrl = URL.createObjectURL(ms);
    logEvent(`initMSE q:${queueRef.current.length}`);
    videoRef.current.src = objUrl;

    // Also listen for video-level errors
    videoRef.current.onerror = () => {
      const code = videoRef.current?.error?.code ?? -1;
      const msg = videoRef.current?.error?.message ?? "";
      logEvent(`video.error ${code}: ${msg}`);
    };

    ms.addEventListener("sourceopen", () => {
      // If this MediaSource was superseded by a newer initMSE call, abandon it.
      // Do NOT revoke the objUrl here — revoking inside sourceopen can race with
      // SourceBuffer attachment on some Chrome versions and close the MediaSource.
      if (msRef.current !== ms) {
        logEvent("stale sourceopen ignored");
        return;
      }

      if (!MediaSource.isTypeSupported(mime)) {
        logEvent(`mime not supported: ${mime}`);
        setViewerStateSynced("error");
        return;
      }

      logEvent(`sourceopen q:${queueRef.current.length}`);

      try {
        const sb = ms.addSourceBuffer(mime);
        sbRef.current = sb;

        sb.addEventListener("error", (e) => {
          logEvent(`SB error: ${(e as any)?.message ?? "unknown"}`);
        });

        sb.addEventListener("updateend", () => {
          if (sbRef.current !== sb || msRef.current?.readyState !== "open") return;
          if (queueRef.current.length > 0 && !sb.updating) {
            const next = queueRef.current.shift()!;
            try {
              sb.appendBuffer(next);
            } catch (err) {
              logEvent(`appendBuffer(queue): ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          tryPlay();
        });

        // Flush first queued chunk (should be the WebM init segment)
        if (queueRef.current.length > 0 && !sb.updating) {
          const next = queueRef.current.shift()!;
          // Log first 4 bytes so we can confirm it's a WebM EBML header (1A 45 DF A3)
          const hdr = new Uint8Array(next, 0, Math.min(4, next.byteLength));
          const hex = Array.from(hdr).map(b => b.toString(16).padStart(2, "0")).join(" ");
          logEvent(`hdr:${hex}(${next.byteLength}B)`);
          try {
            sb.appendBuffer(next);
          } catch (err) {
            logEvent(`appendBuffer(init): ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          logEvent("sourceopen: queue empty — no init segment!");
        }

        setViewerStateSynced("playing");
        tryPlay();
      } catch (err) {
        logEvent(`addSourceBuffer: ${err instanceof Error ? err.message : String(err)}`);
        setViewerStateSynced("error");
      }
    }, { once: true });

    ms.addEventListener("sourceclose", () => {
      // Guard: only act if THIS ms is the one currently in use.
      // Old MediaSources fire sourceclose when video.src is updated to a new one — ignore those.
      if (msRef.current === ms) {
        logEvent("MS closed→reconnect");
        msRef.current = null;
        sbRef.current = null;
        queueRef.current = [];  // stale mid-stream data is useless without the init segment
        // Reconnect so the server resends init segment + buffer; without it
        // self-healing would try to decode mid-stream clusters with no EBML header.
        wsRef.current?.close();  // triggers auto-reconnect via onclose handler
      } else {
        logEvent("old MS closed (ignored)");
      }
    });

    ms.addEventListener("error", () => {
      logEvent("MediaSource error");
    });
  }

  const tryPlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    // Seek to the live edge so we're always watching the most recent data.
    // If currentTime is more than 3 s behind the buffer end, snap forward.
    if (video.buffered.length > 0) {
      const liveEdge = video.buffered.end(video.buffered.length - 1);
      if (liveEdge - video.currentTime > 3) {
        video.currentTime = Math.max(0, liveEdge - 0.5);
      }
    }

    if (!video.paused) {
      // Use the ref so we always see the live value, not a stale closure capture
      if (!audioUnlockedRef.current) setNeedsTap(true);
      return;
    }

    video.muted = true;
    video.play().then(() => {
      if (!audioUnlockedRef.current) setNeedsTap(true);
    }).catch((err) => {
      logEvent(`play() failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!audioUnlockedRef.current) setNeedsTap(true);
    });
  }, []);

  function appendChunk(data: ArrayBuffer) {
    bytesRef.current += data.byteLength;
    const sb = sbRef.current;
    // Guard: if there's no SourceBuffer or the parent MediaSource isn't open, queue the chunk
    if (!sb || msRef.current?.readyState !== "open") {
      queueRef.current.push(data);
      return;
    }
    if (sb.updating || queueRef.current.length > 0) {
      queueRef.current.push(data);
    } else {
      try {
        sb.appendBuffer(data);
      } catch (err) {
        logEvent(`appendBuffer(live): ${err instanceof Error ? err.message : String(err)}`);
        try {
          if (videoRef.current && msRef.current?.readyState === "open" && sb.buffered.length > 0) {
            const current = videoRef.current.currentTime;
            const start = sb.buffered.start(0);
            if (current - start > 20) {
              try { sb.remove(start, current - 10); } catch {}
            }
          }
        } catch {}
        queueRef.current.push(data);
      }
    }
  }

  function connect() {
    cleaningUpRef.current = false;
    bytesRef.current = 0;
    eventLogRef.current = [];
    setViewerStateSynced("connecting");
    const ws = new WebSocket(getWsUrl(eventId));
    wsRef.current = ws;
    ws.binaryType = "arraybuffer";

    ws.onmessage = (e) => {
      // The Replit proxy converts text WebSocket frames into binary frames.
      // Detect JSON messages by checking for the '{' magic byte (0x7b) so we
      // handle them correctly regardless of whether they arrive as string or ArrayBuffer.
      let jsonMsg: Record<string, unknown> | null = null;
      if (typeof e.data === "string") {
        jsonMsg = JSON.parse(e.data) as Record<string, unknown>;
      } else {
        const bytes = new Uint8Array(e.data as ArrayBuffer);
        if (bytes[0] === 0x7b) {
          // Looks like JSON — decode and parse it
          try {
            jsonMsg = JSON.parse(new TextDecoder().decode(e.data as ArrayBuffer)) as Record<string, unknown>;
          } catch {
            // Not valid JSON after all — treat as binary video data (fall through)
          }
        }
      }

      if (jsonMsg !== null) {
        // ── Text / JSON control message ────────────────────────────────────────
        if (jsonMsg.type === "offline") {
          setViewerStateSynced("offline");
          // Poll the REST status endpoint every 8 s while offline so we reconnect
          // promptly when the stream goes live, even if the push notification is
          // missed (e.g. the proxy dropped the WS in the interim).
          const offlinePollId = setInterval(async () => {
            try {
              const r = await fetch(`/api/video/status/${eventId}`);
              if (r.ok) {
                const body = await r.json() as { live: boolean };
                if (body.live) {
                  clearInterval(offlinePollId);
                  // Close this WS — onclose will re-open it and the server will
                  // now send the init + initSegment since the stream is live.
                  ws.close();
                }
              }
            } catch { /* ignore network errors during poll */ }
          }, 8_000);
          // Stop polling when this WS connection closes (cleanup).
          ws.addEventListener("close", () => clearInterval(offlinePollId), { once: true });
        } else if (jsonMsg.type === "ended") {
          setViewerStateSynced("ended");
          wsRef.current?.close();
        } else if (jsonMsg.type === "init") {
          const newMime = jsonMsg.mimeType as string;
          mimeTypeRef.current = newMime;
          // Formats are mutually exclusive — isDualFisheye takes priority if both are somehow set.
          const sigIs360 = jsonMsg.is360 === true && jsonMsg.isDualFisheye !== true;
          const sigDualFisheye = jsonMsg.isDualFisheye === true;
          setIs360(sigIs360);
          setIsDualFisheye(sigDualFisheye);
          if (sigIs360 || sigDualFisheye) { formatLockedRef.current = true; }
          // ws.onclose always calls teardownMSE() before reconnecting, so msRef
          // is always null here. Always do a clean FRESH INIT — no REUSE path.
          queueRef.current = [];
          sbRef.current = null;
          setNeedsTap(false);
          audioUnlockedRef.current = false; setAudioUnlocked(false);
          logEvent("init → fresh MSE");
          initMSE(newMime);
        }
      } else {
        // ── Binary video data ──────────────────────────────────────────────────
        if (!sbRef.current && !msRef.current) {
          initMSE(mimeTypeRef.current);
          queueRef.current.push(e.data as ArrayBuffer);
        } else {
          if (viewerStateRef.current !== "playing") setViewerStateSynced("playing");
          appendChunk(e.data as ArrayBuffer);
        }
      }
    };

    // Stall watchdog — if playing but currentTime hasn't advanced in 4 s, force a full reconnect.
    // Only closes the WS — ws.onclose handles teardown + reconnect scheduling so we don't
    // end up with two simultaneous connect() calls.
    if (stallTimerRef.current) clearInterval(stallTimerRef.current);
    lastTimeRef.current = -1;
    stallTimerRef.current = setInterval(() => {
      const video = videoRef.current;
      if (!video || viewerStateRef.current !== "playing") return;
      const t = video.currentTime;
      if (t === lastTimeRef.current && !video.paused) {
        logEvent("stall detected — reconnecting");
        clearInterval(stallTimerRef.current!);
        stallTimerRef.current = null;
        wsRef.current?.close(); // ws.onclose schedules the reconnect
      } else {
        lastTimeRef.current = t;
      }
    }, 4000);

    ws.onerror = () => { setViewerStateSynced("error"); };

    ws.onclose = () => {
      if (stallTimerRef.current) { clearInterval(stallTimerRef.current); stallTimerRef.current = null; }
      if (!cleaningUpRef.current) {
        // Capture state BEFORE overwriting so the "ended" delay check is accurate.
        const wasEnded = viewerStateRef.current === "ended";
        // Always tear down MSE on unexpected disconnect so reconnect gets a clean slate.
        // This eliminates the fragile REUSE path (stale currentTime + SB updating race).
        teardownMSE();
        setViewerStateSynced("buffering");
        // Back off longer after a clean stream-end to avoid hammering the server.
        const delay = wasEnded ? 8000 : 3000;
        reconnectTimer.current = setTimeout(() => connect(), delay);
      }
    };
  }

  async function handleTap() {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      video.muted = false;
      try {
        await video.play();
        audioUnlockedRef.current = true; setAudioUnlocked(true);
        setNeedsTap(false);
      } catch {
        video.muted = true;
        try {
          await video.play();
          setNeedsTap(false);
        } catch (err) {
          logEvent(`tap play() failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      video.muted = false;
      audioUnlockedRef.current = true; setAudioUnlocked(true);
      setNeedsTap(false);
    }
  }

  const resultsUrl = `/results/${eventId}`;

  return (
    <div className="min-h-screen bg-black flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <Link href={resultsUrl} className="flex items-center gap-1.5 text-white/50 hover:text-white text-sm transition-colors">
          <ChevronLeft size={16} /> Results
        </Link>
        <div className="flex items-center gap-2">
          {viewerState === "playing" && (
            <span className="flex items-center gap-1.5 text-red-400 text-xs font-bold uppercase">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-400" />
              </span>
              Live
            </span>
          )}
          {(viewerState === "connecting" || viewerState === "buffering") && (
            <span className="text-yellow-400 text-xs font-bold uppercase animate-pulse">Connecting…</span>
          )}
          {/* AI Announcer toggle — always visible */}
          <button
            onClick={() => setAnnouncerOn(v => !v)}
            title={announcerOn ? "Mute AI announcer" : "Enable AI announcer"}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider transition-all ${
              announcerOn
                ? "bg-primary/20 text-primary border border-primary/40 hover:bg-primary/30"
                : "bg-white/5 text-white/30 border border-white/10 hover:bg-white/10"
            }`}
          >
            {announcerOn ? <Volume2 size={13} /> : <VolumeX size={13} />}
            {announcerOn ? "Announcer" : "Muted"}
          </button>
        </div>
        <a href={resultsUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-white/50 hover:text-white text-xs transition-colors">
          Results <ExternalLink size={12} />
        </a>
      </div>

      {/* Main content: sidebar + video */}
      <div className="flex-1 flex min-h-0">

        {/* ── Left sidebar: current moto + leaderboard ── */}
        <div className="w-64 shrink-0 border-r border-white/10 flex flex-col overflow-hidden">
          {activeMoto ? (
            <>
              {/* Moto header */}
              <div className="px-3 py-3 border-b border-white/10 shrink-0">
                <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${motoTypeColor(activeMoto.type)}`}>
                    {motoTypeLabel(activeMoto.type)}
                  </span>
                  {activeMoto.raceClass && (
                    <span className="text-white/40 text-[10px] uppercase tracking-wide">{activeMoto.raceClass}</span>
                  )}
                </div>
                <div className="text-white text-sm font-heading uppercase tracking-wide leading-tight">{activeMoto.name}</div>
                <div className="mt-1.5">
                  {activeMoto.status === "in_progress" && (
                    <span className="flex items-center gap-1 text-red-400 text-[10px] font-bold uppercase">
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-400" />
                      </span>
                      In Progress · Lineup
                    </span>
                  )}
                  {activeMoto.status === "completed" && (
                    <span className="flex items-center gap-1 text-green-400 text-[10px] font-bold uppercase">
                      <CheckCircle2 size={10} />
                      Final Results
                    </span>
                  )}
                </div>
              </div>

              {/* Announcer status */}
              {announcerOn && announcerLabel && (
                <div className="px-3 py-1 border-b border-white/5 shrink-0 flex items-center gap-1 text-primary/60 text-[10px]">
                  <Volume2 size={9} />
                  {announcerLabel}
                </div>
              )}

              {/* Column headers */}
              {sseLeaderboard && activeMoto.status === "in_progress" ? (
                <div className="flex items-center px-3 py-1 text-white/20 text-[10px] uppercase tracking-wider border-b border-white/5 shrink-0">
                  <span className="w-5 text-right mr-2.5 shrink-0">#</span>
                  <span className="flex-1">Rider</span>
                  <span className="text-right shrink-0 w-8">Laps</span>
                  <span className="text-right shrink-0 w-12 ml-1">Last</span>
                </div>
              ) : (
                <div className="flex items-center px-3 py-1 text-white/20 text-[10px] uppercase tracking-wider border-b border-white/5 shrink-0">
                  <span className="w-5 text-right mr-2.5 shrink-0">#</span>
                  <span className="flex-1">Rider</span>
                  <span className="text-[10px] shrink-0">Bib</span>
                </div>
              )}

              {/* Rider rows */}
              <div className="flex-1 overflow-y-auto">
                {sseLeaderboard && activeMoto.status === "in_progress" ? (
                  sseLeaderboard.length === 0 ? (
                    <div className="px-3 py-10 text-white/20 text-xs text-center">Waiting for first crossing…</div>
                  ) : (
                    sseLeaderboard.map((entry) => (
                      <div
                        key={entry.riderId}
                        className={`flex items-center gap-2.5 px-3 py-2 border-b border-white/5 ${entry.position === 1 ? "bg-white/5" : ""} ${entry.dnf || entry.dns ? "opacity-40" : ""}`}
                      >
                        <span className={`text-xs font-bold w-5 text-right shrink-0 ${
                          entry.dnf || entry.dns ? "text-white/20" :
                          entry.position === 1 ? "text-yellow-400" :
                          entry.position === 2 ? "text-white/50" :
                          entry.position === 3 ? "text-orange-600/70" :
                          "text-white/25"
                        }`}>
                          {entry.dnf ? "D" : entry.dns ? "—" : entry.position}
                        </span>
                        <span className="text-white/90 text-xs flex-1 truncate">{entry.riderName}</span>
                        <span className="text-white/40 text-[10px] font-mono text-right w-8 shrink-0">{entry.laps}</span>
                        <span className="text-white/20 text-[10px] font-mono text-right w-12 ml-1 shrink-0 tabular-nums">{entry.lastLap ?? "—"}</span>
                      </div>
                    ))
                  )
                ) : liveRiders.length === 0 ? (
                  <div className="px-3 py-10 text-white/20 text-xs text-center">No lineup yet</div>
                ) : (
                  liveRiders.map((rider, idx) => (
                    <div
                      key={rider.riderId}
                      className={`flex items-center gap-2.5 px-3 py-2 border-b border-white/5 ${
                        activeMoto.status === "completed" && idx === 0 ? "bg-amber-500/5" : ""
                      }`}
                    >
                      <span className={`text-xs font-bold w-5 text-right shrink-0 ${
                        activeMoto.status === "completed"
                          ? idx === 0 ? "text-amber-400"
                          : idx === 1 ? "text-white/50"
                          : idx === 2 ? "text-orange-600/70"
                          : "text-white/20"
                          : "text-white/25"
                      }`}>
                        {rider.position}
                      </span>
                      <span className="text-white/90 text-xs flex-1 truncate">{rider.riderName}</span>
                      {rider.bibNumber ? (
                        <span className="text-white/20 text-[10px] shrink-0">#{rider.bibNumber}</span>
                      ) : (
                        <span className="w-6 shrink-0" />
                      )}
                    </div>
                  ))
                )}
              </div>

              <div className="px-3 py-1.5 border-t border-white/5 text-white/15 text-[10px] text-center shrink-0">
                {sseLeaderboard && activeMoto.status === "in_progress" ? "● live timing" : "↻ updates every 15s"}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center px-4">
                <Flag size={22} className="text-white/15 mx-auto mb-2" />
                <p className="text-white/20 text-xs">No active race</p>
              </div>
            </div>
          )}
        </div>

        {/* ── Video (right side) ── */}
        <div className="flex-1 flex items-center justify-center relative bg-black">
          {/* 360 split view: front + back lenses side-by-side via canvas */}
          {is360 && <SplitView360 videoRef={videoRef} />}

          {/* Stacked dual-fisheye: canvas slices top→left, bottom→right */}
          {isDualFisheye && <StackedSplitView videoRef={videoRef} />}

          {/* Normal video — invisible (not display:none) when a canvas renderer is active
              so MSE decoding keeps running and StackedSplitView can read frames from it. */}
          <div className={(is360 || isDualFisheye) ? "absolute inset-0 pointer-events-none" : "w-full flex items-center justify-center"}>
            <video
              ref={videoRef}
              className={(is360 || isDualFisheye) ? "opacity-0 w-full h-full object-contain" : "w-full max-h-[80vh] object-contain"}
              playsInline
              muted
              onLoadedMetadata={(e) => {
                // If the broadcaster already told us the format via signaling, trust that
                // over dimension detection. MSE reconnects re-fire this event with potentially
                // wrong temporary dimensions which would corrupt the locked format.
                if (formatLockedRef.current) return;
                const v = e.currentTarget;
                if (v.videoWidth > 0 && v.videoHeight > 0) {
                  const ratio = v.videoWidth / v.videoHeight;
                  setVideoNaturalDims({ w: v.videoWidth, h: v.videoHeight });
                  if (ratio > 1.8) {
                    setIs360(true);
                    setIsDualFisheye(false);
                    formatLockedRef.current = true;
                  } else if (ratio < 0.7) {
                    setIs360(false);
                    setIsDualFisheye(true);
                    formatLockedRef.current = true;
                  } else {
                    setIs360(false);
                    setIsDualFisheye(false);
                  }
                }
              }}
            />
          </div>
          {is360 && viewerState === "playing" && (
            <div className="absolute top-3 right-3 flex items-center gap-1.5 bg-black/60 backdrop-blur text-white/70 text-[10px] font-bold px-2.5 py-1 rounded-full pointer-events-none select-none">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400" />
              360° · SPLIT VIEW
            </div>
          )}
          {isDualFisheye && viewerState === "playing" && (
            <div className="absolute top-3 right-3 flex items-center gap-1.5 bg-black/60 backdrop-blur text-white/70 text-[10px] font-bold px-2.5 py-1 rounded-full pointer-events-none select-none">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-400" />
              360° · DUAL FISHEYE
            </div>
          )}

        {viewerState === "playing" && needsTap && (
          <button
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 cursor-pointer bg-transparent hover:bg-black/10 transition-colors"
            onClick={handleTap}
          >
            <div className="flex items-center gap-2 bg-white/10 border border-white/20 rounded-full px-5 py-3 backdrop-blur-sm">
              <VolumeX size={18} className="text-white/70" />
              <span className="text-white text-sm font-heading uppercase tracking-wider">Tap to watch with audio</span>
            </div>
          </button>
        )}

        {viewerState === "playing" && audioUnlocked && !needsTap && (
          <button
            className="absolute bottom-4 right-4 flex items-center gap-1.5 bg-black/50 hover:bg-black/70 border border-white/20 rounded-full px-3 py-1.5 transition-colors"
            onClick={() => {
              if (videoRef.current) {
                const nowMuted = !videoRef.current.muted;
                videoRef.current.muted = nowMuted;
                if (nowMuted) { audioUnlockedRef.current = false; setAudioUnlocked(false); setNeedsTap(true); }
              }
            }}
            title="Toggle audio"
          >
            <Volume2 size={14} className="text-white/60" />
            <span className="text-white/60 text-xs">Audio on</span>
          </button>
        )}

        {viewerState !== "playing" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-4">
            {viewerState === "offline" && (
              <>
                <Radio size={52} className="text-white/20" />
                <h2 className="font-heading text-2xl uppercase font-bold">Stream Not Started</h2>
                <p className="text-white/40 text-sm text-center max-w-sm">
                  The organizer hasn't started the live stream yet. This page will automatically connect when they go live.
                </p>
                <Button
                  variant="outline"
                  className="border-white/20 text-white/60 hover:text-white font-heading uppercase text-xs mt-2"
                  onClick={() => connect()}
                >
                  Check Again
                </Button>
              </>
            )}
            {viewerState === "ended" && (
              <>
                <Radio size={52} className="text-white/20" />
                <h2 className="font-heading text-2xl uppercase font-bold">Stream Ended</h2>
                <p className="text-white/40 text-sm text-center max-w-sm">
                  The broadcast was interrupted. Reconnecting automatically…
                </p>
                <Link href={resultsUrl}>
                  <Button variant="outline" className="border-white/20 text-white/60 hover:text-white font-heading uppercase text-xs mt-2">
                    View Results
                  </Button>
                </Link>
              </>
            )}
            {viewerState === "connecting" && (
              <>
                <Radio size={52} className="text-white/20 animate-pulse" />
                <p className="text-white/40 text-sm font-heading uppercase tracking-widest animate-pulse">Connecting…</p>
              </>
            )}
            {viewerState === "error" && (
              <>
                <WifiOff size={52} className="text-white/20" />
                <h2 className="font-heading text-2xl uppercase font-bold">Connection Lost</h2>
                <p className="text-white/40 text-sm">Reconnecting automatically…</p>
              </>
            )}
          </div>
        )}
        </div>{/* end video panel */}
      </div>{/* end sidebar+video flex row */}

      {/* Footer */}
      <div className="px-4 py-3 border-t border-white/10 text-center text-white/20 text-xs">
        Rocky Mountain MX · Live Stream
      </div>
    </div>
  );
}
