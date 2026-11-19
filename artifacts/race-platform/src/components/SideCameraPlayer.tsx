import { useMemo, useRef } from "react";
import { Maximize2, Radio, X } from "lucide-react";
import { getPublicOrigin } from "@/lib/publicOrigin";
import { useRelayVideo } from "@/lib/useRelayVideo";

export type LiveCamera = { id: string; name: string; reconnecting?: boolean };

/** The live video relay for an event; without a camera it picks the first live one. */
export function getWatchWsUrl(eventId: number, cameraId: string | null): string {
  const origin = getPublicOrigin();
  const proto = origin.startsWith("https:") ? "wss:" : "ws:";
  const host = origin.replace(/^https?:\/\//, "");
  return `${proto}//${host}/api/video/watch/${eventId}${cameraId ? `/${encodeURIComponent(cameraId)}` : ""}`;
}

/**
 * A second (third, fourth) camera watched beside the main one on Watch Live.
 * Muted; plays through lib/useRelayVideo.ts, the same relay protocol as the main player.
 * 360° cameras show as the flat video here; make one the main view to split it.
 */
export function SideCameraPlayer({ eventId, camera, onRemove, onMakeMain }: {
  eventId: number;
  camera: LiveCamera;
  onRemove: () => void;
  onMakeMain: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wsUrl = useMemo(() => getWatchWsUrl(eventId, camera.id), [eventId, camera.id]);
  const { state } = useRelayVideo(videoRef, wsUrl, true);

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
