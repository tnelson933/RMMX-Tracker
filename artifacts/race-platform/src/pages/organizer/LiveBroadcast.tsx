import { useState, useRef, useEffect } from "react";
import { Video, VideoOff, Mic, MicOff, Radio, AlertCircle, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useBroadcast } from "@/contexts/BroadcastContext";

interface LiveBroadcastProps {
  eventId: number;
}

export function LiveBroadcast({ eventId }: LiveBroadcastProps) {
  const { toast } = useToast();
  const {
    broadcastState,
    errorMsg,
    micEnabled,
    camEnabled,
    duration,
    is360,
    startBroadcast,
    stopBroadcast,
    toggleMic,
    toggleCam,
    toggleIs360,
    getLiveStream,
  } = useBroadcast();

  // Device enumeration — local to this UI
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [permissionState, setPermissionState] = useState<"requesting" | "granted" | "denied">("requesting");

  const previewRef = useRef<HTMLVideoElement>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);

  const isLive = broadcastState === "live";

  // On mount: request permission + enumerate devices + start preview
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const initial = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        if (cancelled) { initial.getTracks().forEach(t => t.stop()); return; }

        const all = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) { initial.getTracks().forEach(t => t.stop()); return; }

        const videos = all.filter(d => d.kind === "videoinput");
        setVideoDevices(videos);
        setPermissionState("granted");

        const initialTrack = initial.getVideoTracks()[0];
        const defaultId = initialTrack?.getSettings().deviceId ?? videos[0]?.deviceId ?? "";
        setSelectedDeviceId(defaultId);
        initial.getTracks().forEach(t => t.stop());

        await startPreview(defaultId);
      } catch (err: any) {
        if (cancelled) return;
        const msg = err?.name === "NotAllowedError"
          ? "Camera access was denied. Please allow camera access in your browser settings and reload."
          : "Could not access camera. Make sure a camera is connected.";
        setPermissionState("denied");
        void msg;
      }
    }

    init();
    return () => { cancelled = true; stopPreview(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If already live when this page mounts, attach live stream to preview
  useEffect(() => {
    if (isLive && previewRef.current) {
      const stream = getLiveStream();
      if (stream) {
        previewRef.current.srcObject = stream;
        previewRef.current.muted = true;
        previewRef.current.play().catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive]);

  // Restart preview when camera selection changes (only when not live)
  useEffect(() => {
    if (permissionState !== "granted" || !selectedDeviceId || isLive) return;
    startPreview(selectedDeviceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDeviceId]);

  async function startPreview(deviceId: string) {
    stopPreview();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      previewStreamRef.current = stream;
      if (previewRef.current) {
        previewRef.current.srcObject = stream;
        previewRef.current.muted = true;
        previewRef.current.play().catch(() => {});
      }
    } catch {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        previewStreamRef.current = stream;
        if (previewRef.current) {
          previewRef.current.srcObject = stream;
          previewRef.current.muted = true;
          previewRef.current.play().catch(() => {});
        }
      } catch { /* camera unavailable */ }
    }
  }

  function stopPreview() {
    previewStreamRef.current?.getTracks().forEach(t => t.stop());
    previewStreamRef.current = null;
    if (previewRef.current) previewRef.current.srcObject = null;
  }

  const handleGoLive = async () => {
    // Stop preview stream before starting broadcast
    stopPreview();
    await startBroadcast(eventId, selectedDeviceId);
    // Attach live stream to preview element
    if (previewRef.current) {
      const stream = getLiveStream();
      if (stream) {
        previewRef.current.srcObject = stream;
        previewRef.current.muted = true;
        previewRef.current.play().catch(() => {});
      }
    }
  };

  const handleStop = () => {
    stopBroadcast();
    // Restart local preview after a short delay
    setTimeout(() => {
      if (selectedDeviceId) startPreview(selectedDeviceId);
    }, 300);
  };

  const formatDuration = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  const watchUrl = `${window.location.origin}/watch/${eventId}`;

  return (
    <div className="space-y-4">
      {/* Camera preview */}
      <div className="relative bg-black rounded-xl overflow-hidden aspect-video w-full max-w-xl">
        <video ref={previewRef} className="w-full h-full object-cover" playsInline muted />

        {permissionState === "requesting" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white/60 gap-2 bg-black/80">
            <Video size={32} className="animate-pulse" />
            <span className="text-sm font-heading uppercase tracking-wider">Requesting camera access…</span>
          </div>
        )}
        {permissionState === "denied" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white/60 gap-2 bg-black/90 px-6 text-center">
            <VideoOff size={32} />
            <span className="text-sm font-heading uppercase tracking-wider">Camera access denied</span>
          </div>
        )}
        {!camEnabled && isLive && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70">
            <VideoOff size={32} className="text-white/40" />
          </div>
        )}

        {isLive && (
          <div className="absolute top-3 left-3">
            <span className="flex items-center gap-1.5 bg-red-600 text-white text-xs font-bold px-2.5 py-1 rounded-full shadow">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
              </span>
              LIVE · {formatDuration(duration)}
            </span>
          </div>
        )}
        {!isLive && permissionState === "granted" && (
          <div className="absolute top-3 left-3">
            <span className="bg-black/60 text-white/70 text-xs font-bold px-2.5 py-1 rounded-full font-heading uppercase tracking-wider">
              Preview
            </span>
          </div>
        )}
      </div>

      {/* Camera selector */}
      {permissionState === "granted" && !isLive && videoDevices.length > 0 && (
        <div className="flex items-center gap-3 max-w-xl">
          <label className="text-sm font-medium text-muted-foreground whitespace-nowrap flex items-center gap-1.5">
            <Video size={14} /> Camera
          </label>
          <Select value={selectedDeviceId} onValueChange={setSelectedDeviceId}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Select camera…" />
            </SelectTrigger>
            <SelectContent>
              {videoDevices.map((d, i) => (
                <SelectItem key={d.deviceId} value={d.deviceId}>
                  {d.label || `Camera ${i + 1}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {errorMsg && (
        <div className="flex items-start gap-2 text-destructive text-sm bg-destructive/10 rounded-lg px-3 py-2.5 max-w-xl">
          <AlertCircle size={15} className="mt-0.5 flex-shrink-0" />
          {errorMsg}
        </div>
      )}

      {/* Action controls */}
      <div className="flex items-center gap-2 flex-wrap">
        {!isLive ? (
          <>
            <Button
              onClick={handleGoLive}
              disabled={permissionState !== "granted"}
              className="font-heading uppercase tracking-wider gap-2 bg-red-600 hover:bg-red-700 text-white"
            >
              <Radio size={16} /> Go Live
            </Button>
            <Button
              variant={is360 ? "default" : "outline"}
              size="sm"
              onClick={toggleIs360}
              className={`font-heading uppercase text-xs tracking-wider gap-1.5 ${is360 ? "bg-cyan-600 hover:bg-cyan-700 text-white border-cyan-600" : ""}`}
              title="Enable 360° mode for equirectangular cameras"
            >
              360°
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost" size="sm"
              onClick={toggleMic}
              className={micEnabled ? "text-foreground" : "text-destructive"}
              title={micEnabled ? "Mute mic" : "Unmute mic"}
            >
              {micEnabled ? <Mic size={16} /> : <MicOff size={16} />}
              <span className="ml-1.5 text-xs">{micEnabled ? "Mic on" : "Muted"}</span>
            </Button>
            <Button
              variant="ghost" size="sm"
              onClick={toggleCam}
              className={camEnabled ? "text-foreground" : "text-destructive"}
              title={camEnabled ? "Hide camera" : "Show camera"}
            >
              {camEnabled ? <Video size={16} /> : <VideoOff size={16} />}
              <span className="ml-1.5 text-xs">{camEnabled ? "Cam on" : "Cam off"}</span>
            </Button>
            <Button
              variant="outline" size="sm"
              onClick={handleStop}
              className="font-heading uppercase text-xs text-destructive border-destructive/40 hover:bg-destructive/10 ml-2"
            >
              End Stream
            </Button>
          </>
        )}
      </div>

      {/* Watch link while live */}
      {isLive && (
        <div className="flex items-center gap-3 bg-muted/50 rounded-lg px-3 py-2.5 text-sm max-w-xl">
          <Wifi size={14} className="text-green-500 flex-shrink-0" />
          <span className="text-muted-foreground text-xs flex-1 truncate">
            Viewers watch at: <span className="font-mono">{watchUrl}</span>
          </span>
          <Button
            size="sm" variant="outline"
            className="text-xs font-heading uppercase h-7"
            onClick={() => {
              navigator.clipboard.writeText(watchUrl);
              toast({ title: "Watch link copied!" });
            }}
          >
            Copy
          </Button>
        </div>
      )}
    </div>
  );
}
