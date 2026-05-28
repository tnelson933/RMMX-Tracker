import { useState, useRef, useEffect, useCallback } from "react";
import { Video, VideoOff, Mic, MicOff, Radio, AlertCircle, Wifi, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

interface LiveBroadcastProps {
  eventId: number;
}

type BroadcastState = "idle" | "live" | "error" | "stopped";

function getWsUrl(eventId: number): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/video/broadcast/${eventId}`;
}

export function LiveBroadcast({ eventId }: LiveBroadcastProps) {
  const { toast } = useToast();

  // Device enumeration
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [permissionState, setPermissionState] = useState<"requesting" | "granted" | "denied">("requesting");

  // Broadcast state
  const [broadcastState, setBroadcastState] = useState<BroadcastState>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);
  const [duration, setDuration] = useState(0);

  const previewRef = useRef<HTMLVideoElement>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const liveStreamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // On mount: request permission + enumerate devices + start preview
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        // Request permission with default camera first
        const initial = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        if (cancelled) { initial.getTracks().forEach(t => t.stop()); return; }

        // Now we have permission — enumerate with labels
        const all = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) { initial.getTracks().forEach(t => t.stop()); return; }

        const videos = all.filter(d => d.kind === "videoinput");
        setVideoDevices(videos);
        setPermissionState("granted");

        // Use the first device from the initial stream
        const initialTrack = initial.getVideoTracks()[0];
        const defaultId = initialTrack?.getSettings().deviceId ?? videos[0]?.deviceId ?? "";
        setSelectedDeviceId(defaultId);
        initial.getTracks().forEach(t => t.stop());

        // Start preview with selected device
        await startPreview(defaultId);
      } catch (err: any) {
        if (cancelled) return;
        const msg = err?.name === "NotAllowedError"
          ? "Camera access was denied. Please allow camera access in your browser settings and reload."
          : "Could not access camera. Make sure a camera is connected.";
        setErrorMsg(msg);
        setPermissionState("denied");
      }
    }

    init();

    return () => {
      cancelled = true;
      stopPreview();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restart preview when camera selection changes
  useEffect(() => {
    if (permissionState !== "granted" || !selectedDeviceId) return;
    if (broadcastState === "live") return; // don't interrupt an active stream
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
      // Fallback to any camera
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

  const stopBroadcast = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;

    liveStreamRef.current?.getTracks().forEach(t => t.stop());
    liveStreamRef.current = null;

    wsRef.current?.close();
    wsRef.current = null;

    if (timerRef.current) clearInterval(timerRef.current);

    setBroadcastState("stopped");
    setDuration(0);

    // Restart preview after stopping
    if (selectedDeviceId) {
      setTimeout(() => startPreview(selectedDeviceId), 300);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDeviceId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPreview();
      stopBroadcast();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startBroadcast = async () => {
    setErrorMsg("");

    // Stop preview stream (we'll build the live stream separately)
    stopPreview();

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: selectedDeviceId
          ? { deviceId: { exact: selectedDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });
    } catch (err: any) {
      const msg = err?.name === "NotAllowedError"
        ? "Mic/camera access denied. Please allow access and try again."
        : "Could not access camera or microphone.";
      setErrorMsg(msg);
      setBroadcastState("error");
      startPreview(selectedDeviceId);
      return;
    }

    liveStreamRef.current = stream;

    // Show live stream in preview
    if (previewRef.current) {
      previewRef.current.srcObject = stream;
      previewRef.current.muted = true;
      previewRef.current.play().catch(() => {});
    }

    const ws = new WebSocket(getWsUrl(eventId));
    wsRef.current = ws;

    ws.onopen = () => {
      const mimeType = [
        'video/webm; codecs="vp9,opus"',
        'video/webm; codecs="vp8,opus"',
        'video/webm',
      ].find(m => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';

      ws.send(JSON.stringify({ type: "init", mimeType }));

      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 1_500_000,
        audioBitsPerSecond: 64_000,
      });
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(e.data);
        }
      };

      recorder.onerror = () => {
        setErrorMsg("Recording error. The stream was interrupted.");
        setBroadcastState("error");
        stopBroadcast();
      };

      recorder.start(500);
      setBroadcastState("live");
      timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
    };

    ws.onerror = () => {
      setErrorMsg("Connection to the server was lost. Please try again.");
      setBroadcastState("error");
      stopBroadcast();
    };
  };

  const toggleMic = () => {
    const audio = liveStreamRef.current?.getAudioTracks()[0];
    if (audio) { audio.enabled = !audio.enabled; setMicEnabled(audio.enabled); }
  };

  const toggleCam = () => {
    const video = liveStreamRef.current?.getVideoTracks()[0];
    if (video) { video.enabled = !video.enabled; setCamEnabled(video.enabled); }
  };

  const formatDuration = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  const watchUrl = `${window.location.origin}/watch/${eventId}`;
  const isLive = broadcastState === "live";

  return (
    <div className="space-y-4">
      {/* Camera preview */}
      <div className="relative bg-black rounded-xl overflow-hidden aspect-video w-full max-w-xl">
        <video
          ref={previewRef}
          className="w-full h-full object-cover"
          playsInline
          muted
        />

        {/* Overlay when no video yet */}
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

        {/* LIVE badge */}
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

        {/* PREVIEW badge */}
        {!isLive && permissionState === "granted" && (
          <div className="absolute top-3 left-3">
            <span className="bg-black/60 text-white/70 text-xs font-bold px-2.5 py-1 rounded-full font-heading uppercase tracking-wider">
              Preview
            </span>
          </div>
        )}
      </div>

      {/* Camera selector — shown before going live */}
      {permissionState === "granted" && !isLive && videoDevices.length > 0 && (
        <div className="flex items-center gap-3 max-w-xl">
          <label className="text-sm font-medium text-muted-foreground whitespace-nowrap flex items-center gap-1.5">
            <Video size={14} /> Camera
          </label>
          <Select
            value={selectedDeviceId}
            onValueChange={(val) => setSelectedDeviceId(val)}
          >
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

      {/* Error message */}
      {errorMsg && (
        <div className="flex items-start gap-2 text-destructive text-sm bg-destructive/10 rounded-lg px-3 py-2.5 max-w-xl">
          <AlertCircle size={15} className="mt-0.5 flex-shrink-0" />
          {errorMsg}
        </div>
      )}

      {/* Action controls */}
      <div className="flex items-center gap-2 flex-wrap">
        {!isLive ? (
          <Button
            onClick={startBroadcast}
            disabled={permissionState !== "granted"}
            className="font-heading uppercase tracking-wider gap-2 bg-red-600 hover:bg-red-700 text-white"
          >
            <Radio size={16} /> Go Live
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleMic}
              className={micEnabled ? "text-foreground" : "text-destructive"}
              title={micEnabled ? "Mute mic" : "Unmute mic"}
            >
              {micEnabled ? <Mic size={16} /> : <MicOff size={16} />}
              <span className="ml-1.5 text-xs">{micEnabled ? "Mic on" : "Muted"}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleCam}
              className={camEnabled ? "text-foreground" : "text-destructive"}
              title={camEnabled ? "Hide camera" : "Show camera"}
            >
              {camEnabled ? <Video size={16} /> : <VideoOff size={16} />}
              <span className="ml-1.5 text-xs">{camEnabled ? "Cam on" : "Cam off"}</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={stopBroadcast}
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
            size="sm"
            variant="outline"
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
