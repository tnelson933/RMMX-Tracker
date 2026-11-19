import { useEffect, useRef, useState } from "react";
import { Maximize2, Radio, X } from "lucide-react";
import { getPublicOrigin } from "@/lib/publicOrigin";
import { isPlaybackStalled, isVideoQueueOverLimit } from "@/lib/videoPlaybackPolicy";

export type LiveCamera = { id: string; name: string; reconnecting?: boolean };

// iPhones (iOS 17.1+) only offer ManagedMediaSource.
const MediaSourceImpl: typeof MediaSource | undefined = typeof window === "undefined"
  ? undefined
  : (window.MediaSource ?? (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource);

/** The live video relay for an event; without a camera it picks the first live one. */
export function getWatchWsUrl(eventId: number, cameraId: string | null): string {
  const origin = getPublicOrigin();
  const proto = origin.startsWith("https:") ? "wss:" : "ws:";
  const host = origin.replace(/^https?:\/\//, "");
  return `${proto}//${host}/api/video/watch/${eventId}${cameraId ? `/${encodeURIComponent(cameraId)}` : ""}`;
}

type State = "connecting" | "playing" | "reconnecting" | "offline" | "unsupported";

/**
 * A second (third, fourth) camera watched beside the main one on Watch Live.
 * Muted, with the same relay protocol as the main player: JSON control frames
 * (heartbeat → pong, init → new format, reconnecting/offline/ended) and WebM
 * chunks fed to a MediaSource in "sequence" mode; reconnects on drops and stalls.
 * 360° cameras show as the flat video here; make one the main view to split it.
 */
export function SideCameraPlayer({ eventId, camera, onRemove, onMakeMain }: {
  eventId: number;
  camera: LiveCamera;
  onRemove: () => void;
  onMakeMain: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<State>("connecting");

  useEffect(() => {
    if (!MediaSourceImpl) { setState("unsupported"); return; }
    let stopped = false;
    let ws: WebSocket | null = null;
    let ms: MediaSource | null = null;
    let sb: SourceBuffer | null = null;
    let queue: ArrayBuffer[] = [];
    let queuedBytes = 0;
    let mime = 'video/webm; codecs="vp8,opus"';
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let lastTime = -1;
    let playing = false;

    const teardown = () => {
      const had = ms !== null;
      ms = null; sb = null; queue = []; queuedBytes = 0; playing = false;
      const video = videoRef.current;
      if (video && had) { video.removeAttribute("src"); video.load(); }
    };
    const restart = () => { teardown(); ws?.close(); };

    const play = () => {
      const video = videoRef.current;
      if (!video) return;
      if (video.buffered.length > 0) {
        const edge = video.buffered.end(video.buffered.length - 1);
        if (edge - video.currentTime > 3) video.currentTime = Math.max(0, edge - 0.5);
      }
      video.muted = true;
      if (video.paused) video.play().catch(() => {});
    };

    const pump = () => {
      if (!sb || sb.updating || ms?.readyState !== "open" || queue.length === 0) return;
      const next = queue.shift()!;
      queuedBytes -= next.byteLength;
      try { sb.appendBuffer(next); } catch { restart(); }
    };

    const enqueue = (data: ArrayBuffer) => {
      queue.push(data);
      queuedBytes += data.byteLength;
      if (isVideoQueueOverLimit(queue.length, queuedBytes)) restart();
      else pump();
    };

    const startMedia = () => {
      const video = videoRef.current;
      if (!video || !MediaSourceImpl) return;
      const source = new MediaSourceImpl();
      ms = source;
      (video as HTMLVideoElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
      video.src = URL.createObjectURL(source);
      source.addEventListener("sourceopen", () => {
        if (ms !== source) return;
        if (!MediaSourceImpl!.isTypeSupported(mime)) { stopped = true; setState("unsupported"); ws?.close(); return; }
        try {
          const buffer = source.addSourceBuffer(mime);
          buffer.mode = "sequence"; // live joins start mid-stream: let MSE number the frames
          sb = buffer;
          buffer.addEventListener("updateend", () => { if (sb === buffer) { pump(); play(); } });
          buffer.addEventListener("error", () => { if (sb === buffer) restart(); });
          pump();
          playing = true;
          setState("playing");
          play();
        } catch { restart(); }
      }, { once: true });
      source.addEventListener("sourceclose", () => { if (ms === source) restart(); });
    };

    const connect = () => {
      if (stopped) return;
      setState(s => (s === "offline" ? s : "connecting"));
      const socket = new WebSocket(getWatchWsUrl(eventId, camera.id));
      ws = socket;
      socket.binaryType = "arraybuffer";
      const keepAlive = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "hello" })); }, 1_500);
      socket.onopen = () => socket.send(JSON.stringify({ type: "hello" }));
      socket.onmessage = (e) => {
        if (ws !== socket) return;
        let msg: Record<string, unknown> | null = null;
        if (typeof e.data === "string") {
          try { msg = JSON.parse(e.data); } catch { /* not JSON */ }
        } else if (new Uint8Array(e.data as ArrayBuffer)[0] === 0x7b) {
          try { msg = JSON.parse(new TextDecoder().decode(e.data as ArrayBuffer)); } catch { /* video data */ }
        }
        if (msg) {
          if (msg.type === "heartbeat") { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "pong" })); }
          else if (msg.type === "init") { mime = String(msg.mimeType ?? mime); teardown(); }
          else if (msg.type === "reconnecting") { teardown(); setState("reconnecting"); }
          else if (msg.type === "offline" || msg.type === "ended") { teardown(); setState("offline"); }
          return;
        }
        if (!ms) startMedia();
        enqueue(e.data as ArrayBuffer);
      };
      socket.onclose = () => {
        clearInterval(keepAlive);
        if (ws !== socket || stopped) return;
        teardown();
        reconnectTimer = setTimeout(connect, 3_000);
      };
    };

    // A frozen picture: reconnect for a clean live edge.
    const stallTimer = setInterval(() => {
      const video = videoRef.current;
      if (!video || !playing) return;
      if (isPlaybackStalled("playing", video.paused, video.currentTime, lastTime)) restart();
      else lastTime = video.currentTime;
    }, 4_000);

    connect();
    return () => {
      stopped = true;
      clearInterval(stallTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const socket = ws;
      ws = null;
      socket?.close();
      teardown();
    };
  }, [eventId, camera.id]);

  return (
    <div className="relative flex min-h-[12rem] items-center justify-center bg-black" data-side-camera={camera.id}>
      <video ref={videoRef} className="h-full max-h-[80vh] w-full object-contain" playsInline muted />
      <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white/80">
        <span className={`h-1.5 w-1.5 rounded-full ${state === "playing" ? "bg-red-500" : "bg-amber-400"}`} />
        {camera.name}
      </div>
      <div className="absolute right-2 top-2 flex gap-1">
        <button onClick={onMakeMain} title="Make this the main camera (with sound)" aria-label={`Make ${camera.name} the main camera`}
          className="rounded-full border border-white/20 bg-black/60 p-1.5 text-white/70 hover:bg-black/80 hover:text-white">
          <Maximize2 size={13} />
        </button>
        <button onClick={onRemove} title="Stop watching this camera" aria-label={`Stop watching ${camera.name}`}
          className="rounded-full border border-white/20 bg-black/60 p-1.5 text-white/70 hover:bg-black/80 hover:text-white">
          <X size={13} />
        </button>
      </div>
      {state !== "playing" && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/40">
          <Radio size={28} className={state === "offline" || state === "unsupported" ? "" : "animate-pulse"} />
          <p className="text-[11px] font-heading uppercase tracking-widest">
            {state === "offline" ? "Camera offline" : state === "reconnecting" ? "Reconnecting…" : state === "unsupported" ? "Can't play here" : "Connecting…"}
          </p>
        </div>
      )}
    </div>
  );
}
