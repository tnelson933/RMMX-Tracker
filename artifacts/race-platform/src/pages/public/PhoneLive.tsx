import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "wouter";
import { RefreshCw, Radio, Square } from "lucide-react";
import { getPublicOrigin } from "@/lib/publicOrigin";
import { CameraBroadcaster, supportedBroadcastMime, type CameraSnapshot } from "@/lib/cameraBroadcaster";
import { RiderLapTimes, RiderRaceHeader, useRiderRace } from "@/components/RiderRaceOverlay";

/**
 * A rider going live from their phone. Shown only inside the rider app (its
 * Go Live screen), which passes a broadcast ticket in the URL fragment, never
 * sent to a server: #ticket=…&name=…&audio=1. The app shows the preview, the
 * rider taps Go live, and followers get a push once the stream is up
 * (api-server lib/riderLiveAlerts.ts). State changes go back to the app.
 */

type Facing = "environment" | "user";

function hashParams(): URLSearchParams {
  return new URLSearchParams(window.location.hash.replace(/^#/, ""));
}

function tellApp(msg: Record<string, unknown>) {
  const rn = (window as unknown as { ReactNativeWebView?: { postMessage(s: string): void } }).ReactNativeWebView;
  rn?.postMessage(JSON.stringify(msg));
}

function elapsed(since: number | null, now: number): string {
  if (!since) return "0:00";
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export default function PhoneLive() {
  const { riderId: raw } = useParams<{ riderId: string }>();
  const riderId = Number(raw);
  const params = useMemo(hashParams, []);
  const ticket = params.get("ticket") ?? "";
  const name = params.get("name") ?? "";
  const audio = params.get("audio") === "1";

  const videoRef = useRef<HTMLVideoElement>(null);
  const previewRef = useRef<MediaStream | null>(null);
  const broadcasterRef = useRef<CameraBroadcaster | null>(null);
  const [facing, setFacing] = useState<Facing>("environment");
  const [snap, setSnap] = useState<CameraSnapshot | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [now, setNow] = useState(Date.now());

  const supported = !!supportedBroadcastMime(false);
  const race = useRiderRace(riderId, ticket || null);
  const live = snap && (snap.state === "live" || snap.state === "reconnecting" || snap.state === "starting");

  const socketUrl = useMemo(() => {
    const origin = getPublicOrigin();
    const proto = origin.startsWith("https:") ? "wss:" : "ws:";
    return `${proto}//${origin.replace(/^https?:\/\//, "")}/api/video/rider/${riderId}/broadcast?${new URLSearchParams({ ticket })}`;
  }, [riderId, ticket]);

  // Camera preview before going live (the broadcaster opens its own when it starts).
  useEffect(() => {
    if (!supported || live) return;
    let cancelled = false;
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: false })
      .then(stream => {
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        previewRef.current = stream;
        setPreviewError("");
        if (videoRef.current) { videoRef.current.srcObject = stream; void videoRef.current.play().catch(() => {}); }
      })
      .catch(() => setPreviewError("Allow camera access for RM Roost in your phone's Settings, then try again."));
    return () => {
      cancelled = true;
      previewRef.current?.getTracks().forEach(t => t.stop());
      previewRef.current = null;
    };
  }, [facing, supported, live]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(t); broadcasterRef.current?.stop(); };
  }, []);

  const goLive = async () => {
    previewRef.current?.getTracks().forEach(t => t.stop());
    previewRef.current = null;
    const b = new CameraBroadcaster(
      { eventId: -riderId, cameraId: "phone", name: "Phone", deviceId: "", socketUrl, facingMode: facing, audio },
      s => {
        setSnap(s);
        tellApp({ type: "live-state", state: s.state, error: s.errorMsg });
      },
    );
    broadcasterRef.current = b;
    await b.start();
    if (videoRef.current && b.mediaStream) {
      videoRef.current.srcObject = b.mediaStream;
      void videoRef.current.play().catch(() => {});
    }
  };

  const stop = () => {
    broadcasterRef.current?.stop();
    broadcasterRef.current = null;
    tellApp({ type: "live-state", state: "stopped" });
  };

  const message = !ticket || !Number.isInteger(riderId) || riderId <= 0
    ? "Open Go Live from the RM Roost app."
    : !supported
      ? "Live video needs iOS 18.4 or later on iPhone. Update your phone, then try again."
      : snap?.state === "error" ? snap.errorMsg : previewError;

  return (
    <div className="fixed inset-0 flex flex-col bg-black text-white select-none">
      <video ref={videoRef} playsInline muted autoPlay
        className={`absolute inset-0 h-full w-full object-cover ${facing === "user" ? "-scale-x-100" : ""}`} />

      <div className="relative z-10 flex items-center gap-2 p-4" style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}>
        {live ? (
          <span className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider ${snap?.state === "live" ? "bg-[#B30000]" : "bg-amber-600"}`}>
            <span className="h-2 w-2 rounded-full bg-white" />
            {snap?.state === "live" ? `Live ${elapsed(snap.liveSince, now)}` : snap?.state === "starting" ? "Starting…" : "Reconnecting…"}
          </span>
        ) : (
          <span className="rounded-full bg-black/60 px-3 py-1 text-xs font-bold uppercase tracking-wider">Preview</span>
        )}
        {name && <span className="truncate rounded-full bg-black/60 px-3 py-1 text-xs font-semibold">{name}</span>}
        {!audio && <span className="rounded-full bg-black/60 px-3 py-1 text-xs">No sound</span>}
      </div>

      <RiderRaceHeader race={race} />

      {message && (
        <div className="relative z-10 mx-4 mt-3 rounded-xl bg-black/75 p-4 text-center text-sm">{message}</div>
      )}
      {snap?.state === "reconnecting" && (
        <div className="relative z-10 mx-4 rounded-xl bg-black/75 p-3 text-center text-sm">
          Weak signal. Reconnecting; your followers will see the video again when it's back.
        </div>
      )}

      <RiderLapTimes race={race} className="relative mt-auto ml-4 self-start" />
      <div className={`relative z-10 ${race?.bestLap || race?.lastLaps.length ? "" : "mt-auto "}flex items-center justify-center gap-6 p-6`} style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}>
        {!live && (
          <button type="button" aria-label="Switch camera" disabled={!supported}
            onClick={() => setFacing(f => (f === "environment" ? "user" : "environment"))}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-black/60 disabled:opacity-40">
            <RefreshCw size={20} />
          </button>
        )}
        {live ? (
          <button type="button" onClick={stop}
            className="flex items-center gap-2 rounded-full bg-white px-7 py-4 font-heading text-base font-extrabold uppercase text-[#242424]">
            <Square size={16} fill="currentColor" /> End live video
          </button>
        ) : (
          <button type="button" onClick={goLive} disabled={!supported || !ticket || !!previewError}
            className="flex items-center gap-2 rounded-full bg-[#B30000] px-8 py-4 font-heading text-base font-extrabold uppercase disabled:opacity-40">
            <Radio size={18} /> Go live
          </button>
        )}
        {!live && <span className="h-12 w-12" aria-hidden />}
      </div>
    </div>
  );
}
