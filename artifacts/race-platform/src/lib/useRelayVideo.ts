import { useEffect, useRef, useState, type RefObject } from "react";
import { isPlaybackStalled, isVideoQueueOverLimit } from "@/lib/videoPlaybackPolicy";

// iPhones (iOS 17.1+) only offer ManagedMediaSource.
const MediaSourceImpl: typeof MediaSource | undefined = typeof window === "undefined"
  ? undefined
  : (window.MediaSource ?? (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource);

export type RelayVideoState = "connecting" | "playing" | "reconnecting" | "offline" | "unsupported";

/**
 * Plays one camera from the live video relay (api-server lib/videoRelay.ts) in
 * `videoRef`: JSON control frames (heartbeat → pong, init → new format,
 * reconnecting/offline/ended) and WebM chunks fed to a MediaSource in
 * "sequence" mode; reconnects on drops and stalls. `wsUrl` null = not yet known.
 * `muted` can change without reconnecting.
 */
export function useRelayVideo(videoRef: RefObject<HTMLVideoElement | null>, wsUrl: string | null, muted: boolean) {
  const [state, setState] = useState<RelayVideoState>("connecting");
  const [viewers, setViewers] = useState(0);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.muted = muted;
  }, [muted, videoRef]);

  useEffect(() => {
    if (!wsUrl) return;
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
      video.muted = mutedRef.current;
      if (video.paused) {
        video.play().catch(() => {
          // Autoplay with sound blocked: play muted rather than not at all.
          if (!video.muted) { video.muted = true; video.play().catch(() => {}); }
        });
      }
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
      const socket = new WebSocket(wsUrl);
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
          if (msg.type === "heartbeat") {
            if (typeof msg.viewers === "number") setViewers(msg.viewers);
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "pong" }));
          }
          else if (msg.type === "init") { mime = String(msg.mimeType ?? mime); teardown(); }
          else if (msg.type === "reconnecting") { teardown(); setState("reconnecting"); }
          else if (msg.type === "offline" || msg.type === "ended") {
            // Not live (yet, or any more): ask again shortly, so a viewer who opened
            // the page early, or stayed after a stream ended, joins when it starts.
            teardown(); setState("offline");
            socket.close();
          }
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
  }, [wsUrl, videoRef]);

  return { state, viewers };
}
