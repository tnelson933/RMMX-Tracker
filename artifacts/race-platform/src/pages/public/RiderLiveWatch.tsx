import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "wouter";
import { Eye, Radio, Volume2, VolumeX } from "lucide-react";
import { getPublicOrigin } from "@/lib/publicOrigin";
import { useRelayVideo } from "@/lib/useRelayVideo";
import { RiderLapTimes, RiderRaceHeader, useRiderRace } from "@/components/RiderRaceOverlay";

/**
 * Watching a rider's live phone video. Reached only from the rider's profile
 * or the "is racing live" push, never from a public list. The rider app opens
 * this with a watch ticket in the URL fragment (#ticket=…&name=…); signed in
 * on the website, it asks /api/rider/live/:riderId for one.
 */
export default function RiderLiveWatch() {
  const { riderId: raw } = useParams<{ riderId: string }>();
  const riderId = Number(raw);
  const hash = useMemo(() => new URLSearchParams(window.location.hash.replace(/^#/, "")), []);
  const [ticket, setTicket] = useState<string | null>(hash.get("ticket"));
  const [name, setName] = useState(hash.get("name") ?? "");
  const [problem, setProblem] = useState("");
  const [muted, setMuted] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (ticket || !Number.isInteger(riderId) || riderId <= 0) return;
    fetch(`/api/rider/live/${riderId}`, { credentials: "include" })
      .then(async r => {
        const j = await r.json().catch(() => ({}));
        if (r.status === 401) { setProblem("Sign in to your RM Roost rider account to watch."); return; }
        if (!r.ok) { setProblem(j.error ?? "Couldn't load this live video. Try again."); return; }
        setName(j.name ?? "");
        if (!j.canWatch) setProblem("This rider's profile is private. Follow them in the RM Roost app to watch.");
        else setTicket(j.watchTicket);
      })
      .catch(() => setProblem("Couldn't load this live video. Check your connection and try again."));
  }, [riderId, ticket]);

  const wsUrl = useMemo(() => {
    if (!ticket) return null;
    const origin = getPublicOrigin();
    const proto = origin.startsWith("https:") ? "wss:" : "ws:";
    return `${proto}//${origin.replace(/^https?:\/\//, "")}/api/video/rider/${riderId}/watch?${new URLSearchParams({ ticket })}`;
  }, [riderId, ticket]);
  const { state, viewers } = useRelayVideo(videoRef, wsUrl, muted);
  const race = useRiderRace(riderId, ticket);

  const overlay = problem
    || (state === "offline" ? `${name || "This rider"} isn't live right now.`
      : state === "reconnecting" ? "Weak signal at the track. Waiting for the video to come back…"
        : state === "unsupported" ? "This browser can't play live video. Update it, or watch in the RM Roost app."
          : state === "connecting" ? "Connecting…" : "");

  return (
    <div className="fixed inset-0 flex flex-col bg-black text-white">
      <video ref={videoRef} playsInline autoPlay muted className="absolute inset-0 h-full w-full object-contain" />
      <div className="relative z-10 flex items-center gap-2 p-4" style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}>
        {state === "playing" && (
          <span className="flex items-center gap-1.5 rounded-full bg-[#B30000] px-3 py-1 text-xs font-bold uppercase tracking-wider">
            <span className="h-2 w-2 rounded-full bg-white" /> Live
          </span>
        )}
        {name && <span className="truncate rounded-full bg-black/60 px-3 py-1 text-xs font-semibold">{name}</span>}
        {state === "playing" && viewers > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-black/60 px-3 py-1 text-xs"><Eye size={12} /> {viewers}</span>
        )}
      </div>
      {state === "playing" && <RiderRaceHeader race={race} />}
      {overlay && (
        <div className="relative z-10 m-auto flex max-w-xs flex-col items-center gap-3 px-6 text-center text-sm text-white/80">
          <Radio size={30} className={state === "connecting" || state === "reconnecting" ? "animate-pulse" : ""} />
          <p>{overlay}</p>
        </div>
      )}
      {state === "playing" && (
        <div className="absolute bottom-6 left-4" style={{ marginBottom: "env(safe-area-inset-bottom)" }}>
          <RiderLapTimes race={race} />
        </div>
      )}
      {state === "playing" && (
        <button type="button" onClick={() => setMuted(m => !m)} aria-label={muted ? "Turn sound on" : "Turn sound off"}
          className="absolute bottom-6 right-4 z-10 flex items-center gap-2 rounded-full bg-black/70 px-4 py-2.5 text-sm font-semibold"
          style={{ marginBottom: "env(safe-area-inset-bottom)" }}>
          {muted ? <><VolumeX size={16} /> Tap for sound</> : <><Volume2 size={16} /> Sound on</>}
        </button>
      )}
    </div>
  );
}
