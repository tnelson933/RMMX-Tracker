import { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { Maximize2, Radio, Volume2, VolumeX } from "lucide-react";
import { getWatchWsUrl } from "@/components/SideCameraPlayer";
import { useRelayVideo } from "@/lib/useRelayVideo";

/**
 * The event's live video on its event page: the relay's first live camera,
 * played by lib/useRelayVideo.ts (the same relay protocol as Watch Live).
 * Starts muted, as browsers require; one tap turns the sound on. Camera
 * switching, side-by-side cameras and 360° split views stay on /watch/:eventId.
 * Loaded on demand only while the event is streaming.
 */
export default function EventStreamPlayer({ eventId }: { eventId: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const wsUrl = useMemo(() => getWatchWsUrl(eventId, null), [eventId]);
  const { state } = useRelayVideo(videoRef, wsUrl, muted);

  const message =
    state === "offline" ? "The stream is off right now. It comes back here by itself."
    : state === "reconnecting" ? "The camera lost its connection. Picking it back up…"
    : state === "unsupported" ? "This browser can't play the live video. Live timing below still works."
    : "Connecting to the stream…";

  return (
    <div className="relative aspect-video w-full overflow-hidden bg-black" data-event-stream={state}>
      <video
        ref={videoRef}
        className="h-full w-full object-contain"
        playsInline
        muted
        aria-label="Live race video"
      />
      {state !== "playing" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-white/70">
          <Radio size={32} aria-hidden className={state === "offline" || state === "unsupported" ? "" : "animate-pulse motion-reduce:animate-none"} />
          <p className="max-w-xs text-sm" role="status">{message}</p>
        </div>
      )}
      <div className="absolute bottom-2 right-2 flex gap-2">
        {state === "playing" && (
          <button
            type="button"
            onClick={() => setMuted(m => !m)}
            aria-pressed={!muted}
            aria-label={muted ? "Turn the video sound on" : "Mute the video"}
            className="flex min-h-11 items-center gap-1.5 rounded-full border border-white/25 bg-black/65 px-3 text-xs font-bold uppercase tracking-wider text-white hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            {muted ? <VolumeX size={15} aria-hidden /> : <Volume2 size={15} aria-hidden />}
            {muted ? "Sound off" : "Sound on"}
          </button>
        )}
        <Link
          href={`/watch/${eventId}`}
          className="flex min-h-11 items-center gap-1.5 rounded-full border border-white/25 bg-black/65 px-3 text-xs font-bold uppercase tracking-wider text-white hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <Maximize2 size={14} aria-hidden /> Full view
        </Link>
      </div>
    </div>
  );
}
