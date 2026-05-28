import { useState, useRef, useEffect, useCallback } from "react";
import { Video, VideoOff, Mic, MicOff, Radio, AlertCircle, Users, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

interface LiveBroadcastProps {
  eventId: number;
}

type BroadcastState = "idle" | "starting" | "live" | "error" | "stopped";

function getWsUrl(eventId: number): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  return `${proto}//${host}/api/video/broadcast/${eventId}`;
}

export function LiveBroadcast({ eventId }: LiveBroadcastProps) {
  const { toast } = useToast();
  const [state, setState] = useState<BroadcastState>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);
  const [viewerCount] = useState(0);
  const [duration, setDuration] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopBroadcast = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;

    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;

    wsRef.current?.close();
    wsRef.current = null;

    if (timerRef.current) clearInterval(timerRef.current);

    if (videoRef.current) videoRef.current.srcObject = null;

    setState("stopped");
    setDuration(0);
  }, []);

  useEffect(() => {
    return () => { stopBroadcast(); };
  }, [stopBroadcast]);

  const startBroadcast = async () => {
    setState("starting");
    setErrorMsg("");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err: any) {
      const msg = err?.name === "NotAllowedError"
        ? "Camera/microphone access denied. Please allow access in your browser and try again."
        : "Could not access camera or microphone.";
      setErrorMsg(msg);
      setState("error");
      return;
    }

    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.muted = true;
      videoRef.current.play().catch(() => {});
    }

    const ws = new WebSocket(getWsUrl(eventId));
    wsRef.current = ws;

    ws.onopen = () => {
      // Detect best supported mimeType
      const mimeType = [
        'video/webm; codecs="vp9,opus"',
        'video/webm; codecs="vp8,opus"',
        'video/webm',
      ].find(m => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';

      ws.send(JSON.stringify({ type: "init", mimeType }));

      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 1_200_000,
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
        setState("error");
        stopBroadcast();
      };

      recorder.start(500); // 500ms chunks
      setState("live");

      timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
    };

    ws.onerror = () => {
      setErrorMsg("Connection to server lost. Please try again.");
      setState("error");
      stopBroadcast();
    };

    ws.onclose = () => {
      if (state === "live") setState("stopped");
    };
  };

  const toggleMic = () => {
    const audio = streamRef.current?.getAudioTracks()[0];
    if (audio) {
      audio.enabled = !audio.enabled;
      setMicEnabled(audio.enabled);
    }
  };

  const toggleCam = () => {
    const video = streamRef.current?.getVideoTracks()[0];
    if (video) {
      video.enabled = !video.enabled;
      setCamEnabled(video.enabled);
    }
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
      {/* Preview */}
      <div className="relative bg-black rounded-xl overflow-hidden aspect-video w-full max-w-xl">
        <video
          ref={videoRef}
          className="w-full h-full object-cover"
          playsInline
          muted
        />
        {state !== "live" && state !== "starting" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white/60 gap-2">
            <VideoOff size={36} />
            <span className="text-sm font-heading uppercase tracking-wider">
              {state === "idle" ? "Camera preview" :
               state === "stopped" ? "Stream ended" :
               state === "error" ? "Camera error" : ""}
            </span>
          </div>
        )}
        {state === "live" && (
          <div className="absolute top-3 left-3 flex items-center gap-2">
            <span className="flex items-center gap-1.5 bg-red-600 text-white text-xs font-bold px-2.5 py-1 rounded-full shadow">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
              </span>
              LIVE · {formatDuration(duration)}
            </span>
          </div>
        )}
        {!camEnabled && state === "live" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70">
            <VideoOff size={32} className="text-white/40" />
          </div>
        )}
      </div>

      {/* Error */}
      {state === "error" && (
        <div className="flex items-start gap-2 text-destructive text-sm bg-destructive/10 rounded-lg px-3 py-2.5">
          <AlertCircle size={15} className="mt-0.5 flex-shrink-0" />
          {errorMsg}
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center gap-2 flex-wrap">
        {state === "idle" || state === "stopped" || state === "error" ? (
          <Button
            onClick={startBroadcast}
            className="font-heading uppercase tracking-wider gap-2 bg-red-600 hover:bg-red-700 text-white"
          >
            <Radio size={16} /> Go Live
          </Button>
        ) : state === "starting" ? (
          <Button disabled className="font-heading uppercase tracking-wider gap-2">
            <Radio size={16} className="animate-pulse" /> Starting…
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
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleCam}
              className={camEnabled ? "text-foreground" : "text-destructive"}
              title={camEnabled ? "Hide camera" : "Show camera"}
            >
              {camEnabled ? <Video size={16} /> : <VideoOff size={16} />}
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

      {/* Watch link */}
      {state === "live" && (
        <div className="flex items-center gap-3 bg-muted/50 rounded-lg px-3 py-2.5 text-sm">
          <Wifi size={14} className="text-green-500 flex-shrink-0" />
          <span className="text-muted-foreground text-xs flex-1 truncate">Viewers watch at: <span className="font-mono">{watchUrl}</span></span>
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
