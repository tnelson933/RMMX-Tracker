import { useEffect, useRef, useState } from "react";
import { useRoute, Link } from "wouter";
import { Radio, WifiOff, ChevronLeft, ExternalLink } from "lucide-react";
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
  const [mimeType, setMimeType] = useState<string>('video/webm; codecs="vp8,opus"');

  const videoRef = useRef<HTMLVideoElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const msRef = useRef<MediaSource | null>(null);
  const sbRef = useRef<SourceBuffer | null>(null);
  const queueRef = useRef<ArrayBuffer[]>([]);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewerStateRef = useRef<ViewerState>("connecting");

  useEffect(() => {
    if (!eventId) return;
    connect();
    return () => cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  function cleanup() {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    wsRef.current?.close();
    wsRef.current = null;
  }

  function initMSE(mime: string) {
    if (!videoRef.current) return;

    const ms = new MediaSource();
    msRef.current = ms;
    videoRef.current.src = URL.createObjectURL(ms);

    ms.addEventListener("sourceopen", () => {
      try {
        const sb = ms.addSourceBuffer(mime);
        sbRef.current = sb;

        sb.addEventListener("updateend", () => {
          if (queueRef.current.length > 0 && !sb.updating) {
            const next = queueRef.current.shift()!;
            sb.appendBuffer(next);
          }
          if (videoRef.current && videoRef.current.paused) {
            videoRef.current.play().catch(() => {});
          }
        });

        // Flush queued chunks that arrived before MSE was ready
        if (queueRef.current.length > 0 && !sb.updating) {
          const next = queueRef.current.shift()!;
          sb.appendBuffer(next);
        }

        setViewerStateSynced("playing");
      } catch (e) {
        setViewerStateSynced("error");
      }
    }, { once: true });
  }

  function appendChunk(data: ArrayBuffer) {
    const sb = sbRef.current;
    if (!sb) {
      queueRef.current.push(data);
      return;
    }
    if (sb.updating || queueRef.current.length > 0) {
      queueRef.current.push(data);
    } else {
      try {
        sb.appendBuffer(data);
      } catch {
        // SourceBuffer may be full or detached — guard every access
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
    setViewerStateSynced("connecting");
    const ws = new WebSocket(getWsUrl(eventId));
    wsRef.current = ws;
    ws.binaryType = "arraybuffer";

    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        const msg = JSON.parse(e.data);
        if (msg.type === "offline") {
          setViewerStateSynced("offline");
        } else if (msg.type === "ended") {
          setViewerStateSynced("ended");
        } else if (msg.type === "init") {
          // Fresh stream starting — reinitialise MSE
          setMimeType(msg.mimeType);
          queueRef.current = [];
          sbRef.current = null;
          msRef.current = null;
          initMSE(msg.mimeType);
        }
      } else {
        // Binary video chunk
        if (!sbRef.current && !msRef.current) {
          // MSE not yet initialised — init now then queue
          initMSE(mimeType);
          queueRef.current.push(e.data as ArrayBuffer);
        } else {
          setViewerStateSynced("playing");
          appendChunk(e.data as ArrayBuffer);
        }
      }
    };

    ws.onerror = () => {
      setViewerStateSynced("error");
    };

    ws.onclose = () => {
      // Use ref instead of state to avoid stale closure
      if (viewerStateRef.current !== "ended") {
        // Auto-reconnect after 4s
        reconnectTimer.current = setTimeout(() => connect(), 4000);
      }
    };
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
          autoPlay
        />

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
                <p className="text-white/40 text-sm">The live broadcast has ended.</p>
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

      {/* Footer */}
      <div className="px-4 py-3 border-t border-white/10 text-center text-white/20 text-xs">
        Rocky Mountain MX · Live Stream
      </div>
    </div>
  );
}
