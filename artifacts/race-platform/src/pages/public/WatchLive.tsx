import { useEffect, useRef, useState, useCallback } from "react";
import { useRoute, Link } from "wouter";
import { Radio, WifiOff, ChevronLeft, ExternalLink, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";

type ViewerState = "connecting" | "buffering" | "playing" | "offline" | "ended" | "error";

function getWsUrl(eventId: number): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  return `${proto}//${host}/api/video/watch/${eventId}`;
}

export default function WatchLive() {
  const [, params] = useRoute("/watch/:eventId");
  const eventId = parseInt(params?.eventId ?? "0", 10);

  const [viewerState, setViewerState] = useState<ViewerState>("connecting");
  const setViewerStateSynced = (s: ViewerState) => { viewerStateRef.current = s; setViewerState(s); };

  const [needsTap, setNeedsTap] = useState(false);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const audioUnlockedRef = useRef(false);
  const [debugLine, setDebugLine] = useState("waiting…");

  const videoRef = useRef<HTMLVideoElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const msRef = useRef<MediaSource | null>(null);
  const sbRef = useRef<SourceBuffer | null>(null);
  const queueRef = useRef<ArrayBuffer[]>([]);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewerStateRef = useRef<ViewerState>("connecting");
  const cleaningUpRef = useRef(false);
  const mimeTypeRef = useRef('video/webm; codecs="vp8,opus"');
  const bytesRef = useRef(0);
  const lastErrRef = useRef("");
  // Rolling event log — last 5 events; gives a chronological trace instead of just the final state
  const eventLogRef = useRef<string[]>([]);
  const logEvent = (msg: string) => {
    lastErrRef.current = msg;
    eventLogRef.current = [...eventLogRef.current.slice(-4), msg];
  };

  // Update debug display every second
  useEffect(() => {
    const id = setInterval(() => {
      const v = videoRef.current;
      if (!v) return;
      const rs = ["NOTHING", "METADATA", "CURRENT", "FUTURE", "ENOUGH"][v.readyState] ?? v.readyState;
      const buf = v.buffered.length > 0
        ? `${v.buffered.start(0).toFixed(1)}–${v.buffered.end(v.buffered.length - 1).toFixed(1)}s`
        : "empty";
      const log = eventLogRef.current.length > 0 ? ` | ${eventLogRef.current.join(" → ")}` : "";
      setDebugLine(`rs:${rs} t:${v.currentTime.toFixed(1)}s buf:${buf} paused:${v.paused} bytes:${(bytesRef.current / 1024).toFixed(0)}KB${log}`);
    }, 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!eventId) return;
    connect();
    return () => cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  function cleanup() {
    cleaningUpRef.current = true;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    wsRef.current?.close();
    wsRef.current = null;
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
        } else if (jsonMsg.type === "ended") {
          setViewerStateSynced("ended");
          wsRef.current?.close();
        } else if (jsonMsg.type === "init") {
          const newMime = jsonMsg.mimeType as string;
          mimeTypeRef.current = newMime;

          const existingSb = sbRef.current;
          const existingMs = msRef.current;

          if (existingMs && existingMs.readyState === "open" && existingSb) {
            // ── REUSE path ──────────────────────────────────────────────────────
            // MSE fully active. Broadcaster reconnected (Replit proxy drops WS).
            // Discard stale queued data, abort in-flight SB op, and clear the
            // buffer so new initSegment + clusters don't conflict on timestamps.
            queueRef.current = [];
            if (existingSb.updating) {
              try { existingSb.abort(); } catch {}
            }
            try {
              if (existingSb.buffered.length > 0) {
                existingSb.remove(0, Infinity);
              }
            } catch {}
            logEvent("bcst reconnect — reusing MSE");
            setNeedsTap(false);
          } else if (existingMs) {
            // ── PENDING path ────────────────────────────────────────────────────
            // A MediaSource exists but sourceopen hasn't fired yet (readyState
            // "closed"). Do NOT clear the queue — the WebM init segment that was
            // already queued is essential for the decoder to initialise.
            // Do NOT create a new MS — that would close this one and cascade.
            // The pending sourceopen will fire, create the SB, and drain the queue.
            logEvent(`pending q:${queueRef.current.length}`);
          } else {
            // ── FRESH INIT path ─────────────────────────────────────────────────
            // No MediaSource at all (first connect, or sourceclose already cleared
            // the refs). Discard any stale queue and start fresh.
            queueRef.current = [];
            sbRef.current = null;
            setNeedsTap(false);
            audioUnlockedRef.current = false; setAudioUnlocked(false);
            initMSE(newMime);
          }
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

    ws.onerror = () => { setViewerStateSynced("error"); };

    ws.onclose = () => {
      if (!cleaningUpRef.current) {
        const delay = viewerStateRef.current === "ended" ? 8000 : 4000;
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
        </div>
        <a href={resultsUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-white/50 hover:text-white text-xs transition-colors">
          Results <ExternalLink size={12} />
        </a>
      </div>

      {/* Video area */}
      <div className="flex-1 flex items-center justify-center relative bg-black">
        <video
          ref={videoRef}
          className="w-full max-h-[80vh] object-contain"
          playsInline
          muted
        />

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
      </div>

      {/* Debug status line — always visible while playing so we can diagnose issues */}
      <div className="px-3 py-1 text-center text-white/30 text-[10px] font-mono break-all leading-relaxed min-h-[1.5rem]">
        {viewerState === "playing" ? debugLine : viewerState}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-white/10 text-center text-white/20 text-xs">
        Rocky Mountain MX · Live Stream
      </div>
    </div>
  );
}
