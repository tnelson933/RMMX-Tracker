import { useEffect, useRef, useState } from "react";
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

  // needsTap: video is playing (possibly muted) and waiting for a tap to enable audio / start
  const [needsTap, setNeedsTap] = useState(false);
  // audioUnlocked: user explicitly enabled audio via tap
  const [audioUnlocked, setAudioUnlocked] = useState(false);

  // Debug state — bytes received + video readyState/time for diagnosing black screen
  const [bytesReceived, setBytesReceived] = useState(0);
  const [debugInfo, setDebugInfo] = useState("");
  const bytesRef = useRef(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const msRef = useRef<MediaSource | null>(null);
  const sbRef = useRef<SourceBuffer | null>(null);
  const queueRef = useRef<ArrayBuffer[]>([]);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewerStateRef = useRef<ViewerState>("connecting");
  const cleaningUpRef = useRef(false);
  const mimeTypeRef = useRef('video/webm; codecs="vp8,opus"');

  // Update debug info every second
  useEffect(() => {
    const id = setInterval(() => {
      const v = videoRef.current;
      if (!v) return;
      const rs = v.readyState;
      const rsLabel = ["NOTHING", "METADATA", "CURRENT", "FUTURE", "ENOUGH"][rs] ?? rs;
      const buffered = v.buffered.length > 0
        ? `${v.buffered.start(0).toFixed(1)}–${v.buffered.end(v.buffered.length - 1).toFixed(1)}s`
        : "empty";
      setDebugInfo(`readyState:${rsLabel} t:${v.currentTime.toFixed(1)}s buf:${buffered} paused:${v.paused} bytes:${(bytesRef.current / 1024).toFixed(0)}KB`);
      setBytesReceived(bytesRef.current);
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
    if (!videoRef.current) return;

    const ms = new MediaSource();
    msRef.current = ms;
    const objUrl = URL.createObjectURL(ms);
    videoRef.current.src = objUrl;

    ms.addEventListener("sourceopen", () => {
      // Revoke the ObjectURL — video element has already opened it
      URL.revokeObjectURL(objUrl);

      if (!MediaSource.isTypeSupported(mime)) {
        setViewerStateSynced("error");
        return;
      }

      try {
        const sb = ms.addSourceBuffer(mime);
        sbRef.current = sb;

        sb.addEventListener("updateend", () => {
          // Guard: bail if this SourceBuffer was replaced by a newer initMSE call
          if (sbRef.current !== sb || msRef.current?.readyState !== "open") return;
          // Drain the queue one chunk at a time
          if (queueRef.current.length > 0 && !sb.updating) {
            const next = queueRef.current.shift()!;
            try { sb.appendBuffer(next); } catch { /* sb detached mid-flight */ }
          }
          tryPlay();
        });

        // Flush queued chunks that arrived before MSE was ready
        if (queueRef.current.length > 0 && !sb.updating) {
          const next = queueRef.current.shift()!;
          try { sb.appendBuffer(next); } catch { /* sb detached mid-flight */ }
        }

        setViewerStateSynced("playing");
        tryPlay();
      } catch {
        setViewerStateSynced("error");
      }
    }, { once: true });
  }

  /**
   * Attempt to start/continue playback.
   * Always starts muted (to satisfy autoplay policy), then prompts user to tap for audio.
   * Called after data is buffered and from the tap overlay.
   */
  function tryPlay() {
    const video = videoRef.current;
    if (!video) return;

    if (!video.paused) {
      // Already playing (e.g. browser autoplayed). Just make sure needsTap is set
      // so the user gets the tap-for-audio overlay.
      if (!audioUnlocked) setNeedsTap(true);
      return;
    }

    // Start muted — always succeeds without a user gesture
    video.muted = true;
    video.play().then(() => {
      setNeedsTap(true); // playing muted, show tap-for-audio overlay
    }).catch(() => {
      // Even muted autoplay blocked — prompt tap to start
      setNeedsTap(true);
    });
  }

  function appendChunk(data: ArrayBuffer) {
    bytesRef.current += data.byteLength;
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
        // SourceBuffer may be full or detached — try to evict old data first
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
          wsRef.current?.close();
        } else if (msg.type === "init") {
          mimeTypeRef.current = msg.mimeType;
          queueRef.current = [];
          sbRef.current = null;
          msRef.current = null;
          setNeedsTap(false);
          setAudioUnlocked(false);
          initMSE(msg.mimeType);
        }
      } else {
        // Binary video chunk
        if (!sbRef.current && !msRef.current) {
          initMSE(mimeTypeRef.current);
          queueRef.current.push(e.data as ArrayBuffer);
        } else {
          if (viewerStateRef.current !== "playing") setViewerStateSynced("playing");
          appendChunk(e.data as ArrayBuffer);
        }
      }
    };

    ws.onerror = () => {
      setViewerStateSynced("error");
    };

    ws.onclose = () => {
      if (!cleaningUpRef.current) {
        const delay = viewerStateRef.current === "ended" ? 8000 : 4000;
        reconnectTimer.current = setTimeout(() => connect(), delay);
      }
    };
  }

  /** Called when the user taps the overlay. Start/unmute playback. */
  async function handleTap() {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      // Video isn't playing yet — start it unmuted (user gesture makes this work)
      video.muted = false;
      try {
        await video.play();
        setAudioUnlocked(true);
        setNeedsTap(false);
      } catch {
        // Can't play unmuted; try muted
        video.muted = true;
        try {
          await video.play();
          // Now playing muted — hide overlay, keep needsTap=false, show mute toggle
          setNeedsTap(false);
        } catch {
          // Still blocked — keep overlay so user can try again
        }
      }
    } else {
      // Already playing (autoplay succeeded) — just unmute
      video.muted = false;
      setAudioUnlocked(true);
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

        {/* Tap-to-watch / tap-for-audio overlay — only shown while needsTap is true */}
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

        {/* Unmute toggle button — shown after user tapped and audio is on */}
        {viewerState === "playing" && audioUnlocked && !needsTap && (
          <button
            className="absolute bottom-4 right-4 flex items-center gap-1.5 bg-black/50 hover:bg-black/70 border border-white/20 rounded-full px-3 py-1.5 transition-colors"
            onClick={() => {
              if (videoRef.current) {
                const nowMuted = !videoRef.current.muted;
                videoRef.current.muted = nowMuted;
                if (nowMuted) { setAudioUnlocked(false); setNeedsTap(true); }
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

      {/* Debug status line (always visible while we're diagnosing black screen) */}
      {viewerState === "playing" && (
        <div className="px-4 py-1 text-center text-white/30 text-[10px] font-mono">
          {debugInfo || "waiting for video data…"}
        </div>
      )}

      {/* Footer */}
      <div className="px-4 py-3 border-t border-white/10 text-center text-white/20 text-xs">
        Rocky Mountain MX · Live Stream
      </div>
    </div>
  );
}
