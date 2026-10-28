import { useState, useRef, useEffect, useCallback } from "react";
import { Video, VideoOff, Mic, MicOff, Radio, AlertCircle, Loader2, Plus, X, Copy, Check, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useBroadcast, isStreaming, formatDuration, type CameraSnapshot } from "@/contexts/BroadcastContext";
import { supportedBroadcastMime, UNSUPPORTED_BROWSER_MESSAGE } from "@/lib/cameraBroadcaster";
import { usePublicOrigin } from "@/lib/publicOrigin";

// Race-day camera panel: one card per camera on this device. Each camera goes
// live on its own; viewers on the watch page switch between every live camera
// of the event, including ones streaming from other phones or laptops.

type Slot = { slot: number; name: string; deviceId: string };
const MAX_SLOTS = 4;

function readJson<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; }
}
function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

/** A short random tag for this browser, so its cameras don't collide with another device's. */
function deviceTag(): string {
  let tag = "";
  try { tag = localStorage.getItem("broadcast.deviceTag") ?? ""; } catch {}
  if (!/^[a-z0-9]{4}$/.test(tag)) {
    tag = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
    try { localStorage.setItem("broadcast.deviceTag", tag); } catch {}
  }
  return tag;
}

export function LiveBroadcast({ eventId }: { eventId: number }) {
  const { cameras, now, startCamera, stopCamera, dismissCamera, toggleMic, toggleCam, getStream } = useBroadcast();
  const publicOrigin = usePublicOrigin();
  const supported = supportedBroadcastMime() !== null;

  // In the desktop app without cloud sync there is nowhere to send video.
  const isLocalHost = typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const cloudUnconfigured = isLocalHost &&
    (publicOrigin === window.location.origin || publicOrigin.startsWith("http://localhost") || publicOrigin.startsWith("http://127.0.0.1"));

  const storageKey = `broadcast.cameras.${eventId}`;
  const [slots, setSlots] = useState<Slot[]>(() => readJson<Slot[]>(storageKey, []).length
    ? readJson<Slot[]>(storageKey, [])
    : [{ slot: 1, name: "", deviceId: "" }]);
  useEffect(() => { writeJson(storageKey, slots); }, [storageKey, slots]);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [permission, setPermission] = useState<"requesting" | "granted" | "denied">("requesting");

  const loadDevices = useCallback(async () => {
    const all = await navigator.mediaDevices.enumerateDevices();
    const videos = all.filter(d => d.kind === "videoinput" && d.deviceId);
    setDevices(videos);
    return videos;
  }, []);

  // Ask once for camera access so device names show, then list the cameras.
  useEffect(() => {
    if (!supported || !navigator.mediaDevices) { setPermission("denied"); return; }
    let cancelled = false;
    (async () => {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        probe.getTracks().forEach(t => t.stop());
        if (cancelled) return;
        const videos = await loadDevices();
        setPermission("granted");
        // Give cameras without a saved device the next unused one.
        setSlots(prev => {
          const used = new Set(prev.map(s => s.deviceId).filter(id => videos.some(v => v.deviceId === id)));
          return prev.map(s => {
            if (videos.some(v => v.deviceId === s.deviceId)) return s;
            const free = videos.find(v => !used.has(v.deviceId)) ?? videos[0];
            if (free) used.add(free.deviceId);
            return { ...s, deviceId: free?.deviceId ?? "" };
          });
        });
      } catch {
        if (!cancelled) setPermission("denied");
      }
    })();
    const onChange = () => { void loadDevices(); };
    navigator.mediaDevices?.addEventListener?.("devicechange", onChange);
    return () => { cancelled = true; navigator.mediaDevices?.removeEventListener?.("devicechange", onChange); };
  }, [supported, loadDevices]);

  const tag = deviceTag();
  const cameraIdFor = (slot: number) => `${tag}-${slot}`;
  const sessionFor = (slot: number) => cameras.find(c => c.key === `${eventId}:${cameraIdFor(slot)}`);

  const addSlot = () => {
    setSlots(prev => {
      const next = Math.max(0, ...prev.map(s => s.slot)) + 1;
      const used = new Set(prev.map(s => s.deviceId));
      const free = devices.find(d => !used.has(d.deviceId));
      return [...prev, { slot: next, name: "", deviceId: free?.deviceId ?? devices[0]?.deviceId ?? "" }];
    });
  };

  const watchUrl = `${publicOrigin}/watch/${eventId}`;
  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    navigator.clipboard?.writeText(watchUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };

  const liveCount = slots.filter(s => { const c = sessionFor(s.slot); return c && isStreaming(c); }).length;

  return (
    <div className="space-y-4">
      {!supported ? (
        <Notice>{UNSUPPORTED_BROWSER_MESSAGE}</Notice>
      ) : cloudUnconfigured ? (
        <Notice>Live streaming needs cloud sync. Go to Settings → Cloud Sync to set it up.</Notice>
      ) : permission === "denied" ? (
        <Notice>Camera access is blocked. Allow the camera in the browser's site settings, then reload this page.</Notice>
      ) : null}

      <div className="flex items-center gap-2 flex-wrap text-sm">
        <span className="text-muted-foreground">Viewers watch at</span>
        <a href={watchUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline inline-flex items-center gap-1 break-all">
          {watchUrl.replace(/^https?:\/\//, "")} <ExternalLink size={12} />
        </a>
        <button onClick={copyLink} className="p-1 rounded text-muted-foreground hover:text-foreground" title="Copy link">
          {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {slots.map(s => (
          <CameraCard
            key={s.slot}
            slot={s}
            devices={devices}
            session={sessionFor(s.slot)}
            now={now}
            disabled={!supported || cloudUnconfigured || permission !== "granted"}
            canRemove={slots.length > 1}
            onChange={patch => setSlots(prev => prev.map(x => x.slot === s.slot ? { ...x, ...patch } : x))}
            onRemove={() => setSlots(prev => prev.filter(x => x.slot !== s.slot))}
            onGoLive={() => startCamera(eventId, {
              cameraId: cameraIdFor(s.slot),
              name: s.name.trim() || `Camera ${s.slot}`,
              deviceId: s.deviceId,
            })}
            onStop={key => stopCamera(key)}
            onDismiss={key => dismissCamera(key)}
            toggleMic={toggleMic}
            toggleCam={toggleCam}
            getStream={getStream}
          />
        ))}
      </div>

      <div className="flex items-start gap-3 flex-wrap">
        {slots.length < MAX_SLOTS && devices.length > 1 && (
          <Button variant="outline" size="sm" onClick={addSlot} disabled={permission !== "granted"} className="gap-1.5">
            <Plus size={14} /> Add a camera on this computer
          </Button>
        )}
        <p className="text-xs text-muted-foreground flex-1 min-w-56">
          {liveCount > 1 ? `${liveCount} cameras are live from this device. ` : ""}
          Another camera elsewhere on the track? Sign in on that phone (Chrome on Android) or laptop, open this event's
          Race Day page and go live there. Viewers can switch between all of the event's cameras.
        </p>
      </div>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm bg-amber-50 text-amber-900 border border-amber-200 rounded-lg px-3 py-2.5">
      <AlertCircle size={15} className="mt-0.5 flex-shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function CameraCard({
  slot, devices, session, now, disabled, canRemove,
  onChange, onRemove, onGoLive, onStop, onDismiss, toggleMic, toggleCam, getStream,
}: {
  slot: Slot;
  devices: MediaDeviceInfo[];
  session: CameraSnapshot | undefined;
  now: number;
  disabled: boolean;
  canRemove: boolean;
  onChange: (patch: Partial<Slot>) => void;
  onRemove: () => void;
  onGoLive: () => void;
  onStop: (key: string) => void;
  onDismiss: (key: string) => void;
  toggleMic: (key: string) => void;
  toggleCam: (key: string) => void;
  getStream: (key: string) => MediaStream | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streaming = !!session && isStreaming(session);
  const live = session?.state === "live";
  const reconnecting = session?.state === "reconnecting";
  const starting = session?.state === "starting";

  // Show the live stream while streaming, otherwise a local preview of the chosen camera.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let preview: MediaStream | null = null;
    let cancelled = false;
    const show = (stream: MediaStream | null) => {
      video.srcObject = stream;
      if (stream) { video.muted = true; video.play().catch(() => {}); }
    };

    if (streaming && session) {
      show(getStream(session.key));
    } else if (!disabled && slot.deviceId) {
      navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: slot.deviceId }, width: { ideal: 640 } }, audio: false })
        .then(stream => {
          if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
          preview = stream;
          show(stream);
        })
        .catch(() => show(null));
    } else {
      show(null);
    }
    return () => {
      cancelled = true;
      preview?.getTracks().forEach(t => t.stop());
    };
    // The live stream object appears once the camera opens ("starting" → "live").
  }, [streaming, session?.state, session?.key, slot.deviceId, disabled, getStream]);

  const deviceLabel = (d: MediaDeviceInfo, i: number) => d.label || `Camera ${i + 1}`;

  return (
    <div className="rounded-xl border bg-background overflow-hidden">
      <div className="relative bg-black aspect-video">
        <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
        {!slot.deviceId && !streaming && (
          <div className="absolute inset-0 flex items-center justify-center text-white/50"><VideoOff size={28} /></div>
        )}
        {session && !session.camEnabled && streaming && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70"><VideoOff size={28} className="text-white/40" /></div>
        )}
        <div className="absolute top-2 left-2">
          {live ? (
            <span className="flex items-center gap-1.5 bg-red-600 text-white text-xs font-bold px-2.5 py-1 rounded-full shadow">
              <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
              LIVE · {formatDuration(now - (session?.liveSince ?? now))}
            </span>
          ) : reconnecting ? (
            <span className="flex items-center gap-1.5 bg-amber-500 text-white text-xs font-bold px-2.5 py-1 rounded-full shadow">
              <Loader2 size={10} className="animate-spin" /> RECONNECTING
            </span>
          ) : starting ? (
            <span className="flex items-center gap-1.5 bg-black/70 text-white text-xs font-bold px-2.5 py-1 rounded-full">
              <Loader2 size={10} className="animate-spin" /> STARTING
            </span>
          ) : (
            <span className="bg-black/60 text-white/70 text-xs font-bold px-2.5 py-1 rounded-full font-heading uppercase tracking-wider">Preview</span>
          )}
        </div>
        {canRemove && !streaming && (
          <button onClick={onRemove} className="absolute top-2 right-2 p-1 rounded-full bg-black/60 text-white/80 hover:text-white" title="Remove this camera">
            <X size={14} />
          </button>
        )}
      </div>

      <div className="p-3 space-y-2.5">
        <div className="flex gap-2">
          <Input
            value={slot.name}
            onChange={e => onChange({ name: e.target.value.slice(0, 40) })}
            placeholder={`Camera name, e.g. "Finish line"`}
            disabled={streaming}
            className="h-9"
          />
        </div>
        {devices.length > 0 && !streaming && (
          <Select value={slot.deviceId} onValueChange={deviceId => onChange({ deviceId })} disabled={disabled}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Choose a camera…" /></SelectTrigger>
            <SelectContent>
              {devices.map((d, i) => <SelectItem key={d.deviceId} value={d.deviceId}>{deviceLabel(d, i)}</SelectItem>)}
            </SelectContent>
          </Select>
        )}

        {session?.errorMsg && (
          <div className={`flex items-start gap-2 text-sm rounded-lg px-3 py-2 ${session.state === "error" ? "bg-destructive/10 text-destructive" : "bg-amber-50 text-amber-900"}`}>
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
            <span className="flex-1">{session.errorMsg}</span>
            {session.state === "error" && (
              <button onClick={() => onDismiss(session.key)} className="opacity-70 hover:opacity-100" title="Dismiss"><X size={14} /></button>
            )}
          </div>
        )}

        {!streaming ? (
          <Button
            onClick={onGoLive}
            disabled={disabled || !slot.deviceId}
            className="w-full font-heading uppercase tracking-wider gap-2 bg-red-600 hover:bg-red-700 text-white"
          >
            <Radio size={16} /> Go Live
          </Button>
        ) : (
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => toggleMic(session!.key)} disabled={starting}
              className={session!.micEnabled ? "text-foreground" : "text-destructive"} title={session!.micEnabled ? "Mute mic" : "Unmute mic"}>
              {session!.micEnabled ? <Mic size={16} /> : <MicOff size={16} />}
              <span className="ml-1.5 text-xs">{session!.micEnabled ? "Mic on" : "Muted"}</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => toggleCam(session!.key)} disabled={starting}
              className={session!.camEnabled ? "text-foreground" : "text-destructive"} title={session!.camEnabled ? "Hide camera" : "Show camera"}>
              {session!.camEnabled ? <Video size={16} /> : <VideoOff size={16} />}
              <span className="ml-1.5 text-xs">{session!.camEnabled ? "Cam on" : "Cam off"}</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => onStop(session!.key)}
              className="ml-auto font-heading uppercase text-xs text-destructive border-destructive/40 hover:bg-destructive/10">
              End
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
