import { useEffect, useRef, useState, useCallback } from "react";
import { useRoute, Link } from "wouter";
import { Radio, WifiOff, ChevronLeft, ExternalLink, Volume2, VolumeX, Flag, CheckCircle2, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useListMotos, useListResults } from "@workspace/api-client-react";
import { SplitView360 } from "@/components/SplitView360";
import { StackedSplitView } from "@/components/StackedSplitView";
import { getPublicOrigin } from "@/lib/publicOrigin";

type ViewerState = "connecting" | "buffering" | "playing" | "offline" | "ended" | "error";

function WatchLiveCountdown({ startedAt, timeLimitMs, plusLaps }: { startedAt: string; timeLimitMs: number; plusLaps: number | null }) {
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    const start = new Date(startedAt).getTime();
    const tick = () => setRemaining(Math.max(0, timeLimitMs - (Date.now() - start)));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [startedAt, timeLimitMs]);

  const totalSeconds = Math.floor(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const color = remaining < 60_000 ? "text-red-400" : remaining < 120_000 ? "text-orange-400" : "text-white/70";
  return (
    <span className={`flex items-center gap-1 text-[10px] font-bold uppercase ${color}`}>
      <Flag size={9} />
      {minutes}:{String(seconds).padStart(2, "0")}
      {plusLaps != null && plusLaps > 0 && <span className="text-white/40 font-normal">+{plusLaps}L</span>}
    </span>
  );
}

function getWsUrl(eventId: number): string {
  const origin = getPublicOrigin();
  const proto = origin.startsWith("https:") ? "wss:" : "ws:";
  const host = origin.replace(/^https?:\/\//, "");
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
  // True when we've been in "connecting" for more than 8 s with no server response
  const [connectingSlow, setConnectingSlow] = useState(false);

  const [viewerCount, setViewerCount] = useState<number | null>(null);
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
  // Tracks the last lap number that actually triggered an announcement.
  // Separate from prevLapsRef (which updates on every SSE message) so the
  // "wait for 3 riders" threshold can still fire after prevLapsRef has
  // already advanced past the leader's crossing.
  const lastAnnouncedLapRef = useRef<number>(0);
  const esRef = useRef<EventSource | null>(null);
  const activeMotoIdRef = useRef<number | null>(null);
  const prevSseStatusRef = useRef<string | null>(null);

  // Live moto + results — poll every 5 s so moto start/complete is detected quickly
  const { data: motos } = useListMotos(eventId, {
    query: { enabled: !!eventId, refetchInterval: 5_000, refetchOnWindowFocus: false, staleTime: 3_000 } as any,
  });
  const { data: results } = useListResults(eventId, {
    query: { enabled: !!eventId, refetchInterval: 5_000, refetchOnWindowFocus: false, staleTime: 3_000 } as any,
  });

  // Active moto: prefer in_progress, fall back to most-recently-completed
  const activeMoto =
    motos?.find(m => m.status === "in_progress") ??
    [...(motos ?? [])].filter(m => m.status === "completed").pop();

  // All motos sorted for the schedule panel
  const scheduleMotos = [...(motos ?? [])]
    .sort((a, b) => (a.motoNumber ?? a.id) - (b.motoNumber ?? b.id));

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

  // Keep announcerOnRef in sync with state so SSE callbacks see the latest value.
  // When muted: immediately stop whatever is playing and flush the queue.
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    announcerOnRef.current = announcerOn;
    if (!announcerOn) {
      // Stop the currently-playing clip
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
        currentAudioRef.current.src = "";
        currentAudioRef.current = null;
      }
      annPlayingRef.current = false;
      // Revoke and discard all queued URLs
      for (const url of audioQueueRef.current) URL.revokeObjectURL(url);
      audioQueueRef.current = [];
    }
  }, [announcerOn]);

  // ── Announcer audio queue ─────────────────────────────────────────────────
  const drainQueue = useCallback(() => {
    if (annPlayingRef.current || audioQueueRef.current.length === 0) return;
    if (!announcerOnRef.current) { audioQueueRef.current = []; return; }
    const url = audioQueueRef.current.shift()!;
    annPlayingRef.current = true;
    const audio = new Audio(url);
    currentAudioRef.current = audio;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      annPlayingRef.current = false;
      if (currentAudioRef.current === audio) currentAudioRef.current = null;
      drainQueue();
    };
    audio.onended = cleanup;
    audio.onerror = cleanup;
    audio.play().catch(() => { annPlayingRef.current = false; drainQueue(); });
  }, []);

  const enqueueAudio = useCallback((blob: Blob) => {
    if (!announcerOnRef.current) return;   // discard if muted after fetch resolved
    const url = URL.createObjectURL(blob);
    audioQueueRef.current.push(url);
    drainQueue();
  }, [drainQueue]);

  // ── Moto-start hype intro ────────────────────────────────────────────────
  const triggerStartAnnouncement = useCallback(async (moto: typeof activeMoto) => {
    if (!announcerOnRef.current || !moto) return;
    try {
      setAnnouncerLabel("Race starting!");
      const res = await fetch("/api/timing/announce-moto-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          motoName: moto.name,
          motoType: moto.type,
          raceClass: moto.raceClass ?? null,
          lineup: ((moto.lineup ?? []) as Array<{ bibNumber?: string | null; riderName?: string | null }>)
            .map(r => ({ bibNumber: r.bibNumber ?? null, riderName: r.riderName ?? null })),
        }),
      });
      if (!res.ok) { setAnnouncerLabel(null); return; }
      enqueueAudio(await res.blob());
      setTimeout(() => setAnnouncerLabel(null), 6_000);
    } catch { setAnnouncerLabel(null); }
  }, [enqueueAudio]);

  // ── Full AI TTS announcement (OpenAI voice — used for race-complete only) ────
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

    // Fire the race-start hype intro whenever we connect to a new in_progress moto.
    triggerStartAnnouncement(activeMoto);

    const es = new EventSource(`/api/timing/live/${motoId}`);
    esRef.current = es;

    es.onmessage = (evt) => {
      try {
        const payload = JSON.parse(evt.data);
        if (payload.error) return;

        const leaderboard = payload.leaderboard as LeaderboardEntry[];
        const isComplete = payload.status === "completed";
        const wasInProgress = prevSseStatusRef.current === "in_progress";

        // Skip announcements on the very first SSE message (initial snapshot) —
        // prevLapsRef is empty so every rider would look like a new crossing.
        const isFirstMessage = prevLapsRef.current.size === 0;

        if (!isFirstMessage) {
          // Detect position changes across all riders
          const positionChanges: Array<{ riderName: string; from: number; to: number }> = [];
          for (const entry of leaderboard) {
            const prevPos = prevPositionsRef.current.get(entry.riderId);
            if (prevPos !== undefined && prevPos !== entry.position) {
              positionChanges.push({ riderName: entry.riderName, from: prevPos, to: entry.position });
            }
          }

          if (isComplete && wasInProgress) {
            // Race complete — full podium recap
            const top5 = leaderboard.filter(r => !r.dnf && !r.dns).slice(0, 5);
            triggerAnnouncement(top5[0]?.laps ?? 0, top5, [], true);
          } else if (!isComplete) {
            // Announce when enough riders have completed the leader's current
            // lap.  We gate on ≥3 riders to avoid premature callouts in the
            // opening seconds when only 1–2 riders have crossed.
            //
            // We use lastAnnouncedLapRef (not prevLapsRef) for the "new lap"
            // check.  prevLapsRef is updated on every SSE message, so it
            // advances to N the moment the leader crosses; subsequent SSE
            // messages (P2, P3 crossing) would see leader.laps === prevLapsRef
            // and never fire.  lastAnnouncedLapRef only advances when we
            // actually speak — so the gate stays open until 3 riders are on
            // the same lap, at which point the gaps are time-based, not laps.
            const leader = leaderboard[0];
            if (leader && leader.laps > lastAnnouncedLapRef.current) {
              const ridersOnLeaderLap = leaderboard.filter(r => r.laps >= leader.laps && !r.dnf && !r.dns).length;
              if (ridersOnLeaderLap >= 5) {
                const top5 = leaderboard.filter(r => !r.dnf && !r.dns).slice(0, 5);
                triggerAnnouncement(leader.laps, top5, positionChanges, false);
                lastAnnouncedLapRef.current = leader.laps;
              }
            }
          }
        }

        for (const entry of leaderboard) {
          prevLapsRef.current.set(entry.riderId, entry.laps);
          prevPositionsRef.current.set(entry.riderId, entry.position);
        }
        prevSseStatusRef.current = payload.status;
        setSseLeaderboard(leaderboard);
      } catch { /* ignore parse errors */ }
    };

    return () => {
      es.close();
      if (esRef.current === es) { esRef.current = null; activeMotoIdRef.current = null; }
    };
  }, [activeMoto?.id, activeMoto?.status, triggerAnnouncement, triggerStartAnnouncement]);

  useEffect(() => {
    if (!eventId) return;
    connect();
    return () => {
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  // Show a "slow connection" hint after 8 s in "connecting" state so the user
  // knows the page is still trying rather than silently stuck.
  useEffect(() => {
    if (viewerState !== "connecting") { setConnectingSlow(false); return; }
    const t = setTimeout(() => setConnectingSlow(true), 8_000);
    return () => clearTimeout(t);
  }, [viewerState]);

  function teardownMSE() {
    // Null refs first — any subsequent sourceclose/updateend from old objects is harmless
    const hadMs = msRef.current !== null;
    msRef.current = null;
    sbRef.current = null;
    queueRef.current = [];
    // Only reset video.src when there was an active MediaSource to detach.
    // Skipping this on a fresh connection (hadMs = false) avoids spurious
    // load events that can interfere with a pending MSE initialisation.
    if (videoRef.current && hadMs) {
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
      // Code 3 = MEDIA_ERR_DECODE — decoder rejected MSE data, unrecoverable without a reconnect.
      // Code 4 = MEDIA_ERR_SRC_NOT_SUPPORTED — fired by video.src="" during normal teardown; ignore.
      // Guard: only reconnect when we still own an active MediaSource (not already torn down).
      if (code === 3 && !cleaningUpRef.current && msRef.current !== null) {
        logEvent("decode error — tearing down and reconnecting");
        teardownMSE();
        wsRef.current?.close(); // ws.onclose handles the 3s delayed reconnect
      }
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
        // "sequence" mode: MSE assigns timestamps sequentially, ignoring the
        // timestamps embedded in the WebM cluster blocks. This is essential for
        // live streaming where late-joining viewers receive an init segment from
        // t=0 followed by buffered chunks from a much later timestamp. Without
        // sequence mode the decoder detects the timestamp gap and fires a decode
        // error that closes the MediaSource and causes the viewer to cycle.
        sb.mode = "sequence";
        sbRef.current = sb;

        sb.addEventListener("error", (e) => {
          logEvent(`SB error: ${(e as any)?.message ?? "unknown"}`);
          // SourceBuffer errors leave the MediaSource in an unrecoverable state.
          // Tear down and close the WS so ws.onclose schedules a clean reconnect.
          if (!cleaningUpRef.current) {
            teardownMSE();
            wsRef.current?.close();
          }
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

    // Send a hello immediately on open so the Replit proxy sees client→server
    // data at t≈0. Without this, the first client→server frame (a pong reply)
    // doesn't arrive until ~1.65 s after connect — right at the proxy's ~2 s
    // per-direction idle timeout — causing the connection to drop before the
    // first heartbeat exchange completes.
    ws.onopen = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "hello" }));
      }
      // Liveness watchdog: the server always sends either {"type":"offline"} or
      // {"type":"init"} within ~150 ms of the WS opening, followed by heartbeats
      // every 1 s.  If no message arrives within 6 s the proxy is silently
      // blocking server→client frames — close and let ws.onclose schedule a retry.
      const livenessTimer = setTimeout(() => {
        logEvent("no server message in 6 s — reconnecting");
        if (ws.readyState === WebSocket.OPEN) ws.close();
      }, 6_000);
      ws.addEventListener("message", () => clearTimeout(livenessTimer), { once: true });
      ws.addEventListener("close",   () => clearTimeout(livenessTimer), { once: true });
    };

    // Independent client→server keep-alive: send a ping every 1.5 s regardless
    // of whether a server heartbeat has arrived. This guarantees the proxy sees
    // client→server application data within its idle-timeout window even if the
    // first server heartbeat is delayed or the pong reply is lost.
    const keepAliveId = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "hello" }));
      }
    }, 1_500);
    ws.addEventListener("close", () => clearInterval(keepAliveId), { once: true });

    ws.onmessage = (e) => {
      // The Replit proxy converts text WebSocket frames into binary frames.
      // Detect JSON messages by checking for the '{' magic byte (0x7b) so we
      // handle them correctly regardless of whether they arrive as string or ArrayBuffer.
      let jsonMsg: Record<string, unknown> | null = null;
      if (typeof e.data === "string") {
        try {
          jsonMsg = JSON.parse(e.data) as Record<string, unknown>;
        } catch {
          // Non-JSON string frame — ignore (shouldn't happen in normal operation)
        }
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
        if (jsonMsg.type === "heartbeat") {
          // Server keep-alive frame — reply with a pong so the Replit proxy sees
          // bidirectional application-data flow from the CLIENT side too.
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "pong" }));
          }
          if (typeof jsonMsg.viewers === "number") {
            setViewerCount(jsonMsg.viewers);
          }
        } else if (jsonMsg.type === "offline") {
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
          // Tear down any existing MSE but do NOT create a new one yet.
          // The MediaSource is created lazily on the first binary chunk (see the
          // binary branch below).  Creating it eagerly here — before any data
          // has arrived — causes Chrome to fire sourceclose on the empty
          // MediaSource after ~2.4 s, which closed the WebSocket and triggered
          // the reconnect cycle.  The server now holds this viewer in a
          // "pending" queue and only sends binary data once a fresh keyframe is
          // ready, so the MSE is guaranteed to have data within its first tick.
          teardownMSE();
          setNeedsTap(false);
          audioUnlockedRef.current = false; setAudioUnlocked(false);
          logEvent("init → teardownMSE, awaiting first binary chunk");
        }
      } else {
        // ── Binary video data ──────────────────────────────────────────────────
        if (!sbRef.current && !msRef.current) {
          // First binary chunk — lazily create the MSE now that we have real data.
          // We do NOT set "playing" here; sourceopen will set it once the MSE
          // is open and the init segment is being appended.  Setting "playing"
          // prematurely (before sourceopen) makes the overlay disappear while
          // video.src is connected to a not-yet-open MediaSource, leaving a
          // black frame.  If autoplay is blocked the user would see a black
          // screen with the Live badge but no video — exactly the symptom.
          initMSE(mimeTypeRef.current);
          queueRef.current.push(e.data as ArrayBuffer);
        } else {
          // Subsequent binary chunks — MSE is initialising or already open.
          // Don't set "playing" here either; sourceopen is the single source
          // of truth.  appendChunk will queue the data until the SourceBuffer
          // is ready.
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
          {viewerState === "playing" && viewerCount !== null && (
            <span className="flex items-center gap-1 text-white/40 text-xs">
              <Eye size={12} />
              {viewerCount}
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
                <div className="mt-1.5 space-y-1">
                  {activeMoto.status === "in_progress" && (
                    <span className="flex items-center gap-1 text-red-400 text-[10px] font-bold uppercase">
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-400" />
                      </span>
                      In Progress · Lineup
                    </span>
                  )}
                  {activeMoto.status === "in_progress" && (activeMoto as any).timeLimitMs && !(activeMoto as any).timeExpiredAt && (activeMoto as any).startedAt && (
                    <WatchLiveCountdown
                      startedAt={(activeMoto as any).startedAt}
                      timeLimitMs={(activeMoto as any).timeLimitMs}
                      plusLaps={(activeMoto as any).plusLaps ?? null}
                    />
                  )}
                  {activeMoto.status === "in_progress" && (activeMoto as any).timeExpiredAt && (activeMoto as any).plusLaps > 0 && (
                    <span className="flex items-center gap-1 text-orange-400 text-[10px] font-bold uppercase animate-pulse">
                      <Flag size={9} />
                      +{(activeMoto as any).plusLaps} Lap{(activeMoto as any).plusLaps > 1 ? "s" : ""} to Go
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
                  <span className="text-[10px] shrink-0">#</span>
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

              {/* Full Schedule */}
              {scheduleMotos.length > 0 && (
                <div className="shrink-0 border-t border-white/10 flex flex-col" style={{ maxHeight: "40%" }}>
                  <div className="px-3 pt-2.5 pb-1 text-white/25 text-[10px] uppercase tracking-widest font-bold shrink-0">
                    Schedule
                  </div>
                  <div className="overflow-y-auto">
                    {scheduleMotos.map((m, idx) => {
                      const isActive = m.status === "in_progress";
                      const isDone   = m.status === "completed";
                      return (
                        <div
                          key={m.id}
                          className={`flex items-center gap-2 px-3 py-1.5 ${idx < scheduleMotos.length - 1 ? "border-b border-white/5" : ""} ${isActive ? "bg-white/5" : ""}`}
                        >
                          {/* Status dot */}
                          <div className="w-3 shrink-0 flex items-center justify-center">
                            {isActive ? (
                              <span className="relative flex h-1.5 w-1.5">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-400" />
                              </span>
                            ) : isDone ? (
                              <CheckCircle2 size={10} className="text-white/20" />
                            ) : (
                              <span className="h-1 w-1 rounded-full bg-white/15" />
                            )}
                          </div>
                          {/* Type badge */}
                          <span className={`text-[9px] font-bold uppercase tracking-wider px-1 py-0.5 rounded shrink-0 ${isDone ? "bg-white/5 text-white/20" : motoTypeColor(m.type)}`}>
                            {motoTypeLabel(m.type)}
                          </span>
                          {/* Name + class */}
                          <div className="flex-1 min-w-0">
                            <div className={`text-[11px] font-heading uppercase tracking-wide truncate leading-tight ${isDone ? "text-white/20" : isActive ? "text-white/90" : "text-white/55"}`}>
                              {m.name}
                            </div>
                            {m.raceClass && (
                              <div className={`text-[10px] truncate leading-tight ${isDone ? "text-white/15" : "text-white/25"}`}>{m.raceClass}</div>
                            )}
                          </div>
                          {m.scheduledTime && !isDone && (
                            <div className="text-white/20 text-[10px] font-mono shrink-0">
                              {new Date(m.scheduledTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              {scheduleMotos.length > 0 ? (
                <div className="flex flex-col flex-1 min-h-0">
                  <div className="px-3 pt-2.5 pb-1 text-white/25 text-[10px] uppercase tracking-widest font-bold shrink-0 border-b border-white/10">
                    Schedule
                  </div>
                  <div className="overflow-y-auto flex-1">
                    {scheduleMotos.map((m, idx) => {
                      const isActive = m.status === "in_progress";
                      const isDone   = m.status === "completed";
                      return (
                        <div
                          key={m.id}
                          className={`flex items-center gap-2 px-3 py-1.5 ${idx < scheduleMotos.length - 1 ? "border-b border-white/5" : ""}`}
                        >
                          <div className="w-3 shrink-0 flex items-center justify-center">
                            {isActive ? (
                              <span className="relative flex h-1.5 w-1.5">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-400" />
                              </span>
                            ) : isDone ? (
                              <CheckCircle2 size={10} className="text-white/20" />
                            ) : (
                              <span className="h-1 w-1 rounded-full bg-white/15" />
                            )}
                          </div>
                          <span className={`text-[9px] font-bold uppercase tracking-wider px-1 py-0.5 rounded shrink-0 ${isDone ? "bg-white/5 text-white/20" : motoTypeColor(m.type)}`}>
                            {motoTypeLabel(m.type)}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className={`text-[11px] font-heading uppercase tracking-wide truncate leading-tight ${isDone ? "text-white/20" : isActive ? "text-white/90" : "text-white/55"}`}>
                              {m.name}
                            </div>
                            {m.raceClass && (
                              <div className={`text-[10px] truncate leading-tight ${isDone ? "text-white/15" : "text-white/25"}`}>{m.raceClass}</div>
                            )}
                          </div>
                          {m.scheduledTime && !isDone && (
                            <div className="text-white/20 text-[10px] font-mono shrink-0">
                              {new Date(m.scheduledTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center px-4">
                    <Flag size={22} className="text-white/15 mx-auto mb-2" />
                    <p className="text-white/20 text-xs">No active race</p>
                  </div>
                </div>
              )}
            </>
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

        {viewerState === "playing" && (
          <button
            className="absolute bottom-3 right-3 p-2 rounded-full bg-black/50 hover:bg-black/70 border border-white/20 transition-colors"
            title={needsTap ? "Tap to enable audio" : audioUnlocked ? "Mute audio" : "Unmute audio"}
            onClick={() => {
              if (needsTap) {
                handleTap();
              } else if (videoRef.current) {
                const nowMuted = !videoRef.current.muted;
                videoRef.current.muted = nowMuted;
                if (nowMuted) { audioUnlockedRef.current = false; setAudioUnlocked(false); setNeedsTap(true); }
              }
            }}
          >
            {audioUnlocked && !needsTap
              ? <Volume2 size={15} className="text-white/70" />
              : <VolumeX size={15} className="text-white/40" />}
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
                {connectingSlow && (
                  <>
                    <p className="text-white/30 text-xs text-center max-w-xs">
                      Taking longer than expected. The stream may not be live yet.
                    </p>
                    <Button
                      variant="outline"
                      className="border-white/20 text-white/60 hover:text-white font-heading uppercase text-xs mt-1"
                      onClick={() => { cleanup(); connect(); }}
                    >
                      Retry
                    </Button>
                  </>
                )}
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
        RM Tracker · Live Stream
      </div>
    </div>
  );
}
