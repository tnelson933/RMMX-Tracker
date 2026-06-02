import { createContext, useContext, useRef, useState, useCallback, useEffect } from "react";

export type BroadcastState = "idle" | "live" | "error" | "stopped";

interface BroadcastContextValue {
  broadcastState: BroadcastState;
  errorMsg: string;
  micEnabled: boolean;
  camEnabled: boolean;
  duration: number;
  activeEventId: number | null;
  is360: boolean;

  startBroadcast: (eventId: number, deviceId: string) => Promise<void>;
  stopBroadcast: () => void;
  toggleMic: () => void;
  toggleCam: () => void;
  toggleIs360: () => void;
  getLiveStream: () => MediaStream | null;
}

const BroadcastContext = createContext<BroadcastContextValue | null>(null);

export function useBroadcast() {
  const ctx = useContext(BroadcastContext);
  if (!ctx) throw new Error("useBroadcast must be used within BroadcastProvider");
  return ctx;
}

function getWsUrl(eventId: number): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/video/broadcast/${eventId}`;
}

export function BroadcastProvider({ children }: { children: React.ReactNode }) {
  const [broadcastState, setBroadcastState] = useState<BroadcastState>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);
  const [duration, setDuration] = useState(0);
  const [activeEventId, setActiveEventId] = useState<number | null>(null);
  const [is360, setIs360] = useState(false);
  const is360Ref = useRef(false);
  is360Ref.current = is360;

  const liveStreamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Tracks whether the user explicitly pressed the 360° toggle before going live.
  // When true, the manual choice wins over auto-detection.
  const is360ManuallySetRef = useRef(false);

  const stopBroadcast = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;

    liveStreamRef.current?.getTracks().forEach(t => t.stop());
    liveStreamRef.current = null;

    wsRef.current?.close();
    wsRef.current = null;

    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }

    setBroadcastState("stopped");
    setDuration(0);
    setActiveEventId(null);
    setIs360(false);
    is360ManuallySetRef.current = false;
  }, []);

  const startBroadcast = useCallback(async (eventId: number, deviceId: string) => {
    setErrorMsg("");

    let stream: MediaStream;
    try {
      // Cap at 1920px wide so 360° cameras output 1920×960 (2:1) instead of 4K/5.7K native.
      // No height constraint — lets 360° cameras keep their native 2:1 aspect ratio.
      stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId
          ? { deviceId: { exact: deviceId }, width: { ideal: 1920, max: 1920 } }
          : { width: { ideal: 1920, max: 1920 } },
        audio: true,
      });
    } catch (err: any) {
      const msg = err?.name === "NotAllowedError"
        ? "Mic/camera access denied. Please allow access and try again."
        : "Could not access camera or microphone.";
      setErrorMsg(msg);
      setBroadcastState("error");
      return;
    }

    // Auto-detect 360° from the video track's actual aspect ratio (equirectangular = ~2:1).
    // Skip auto-detection if the user explicitly pressed the 360° toggle before going live.
    if (!is360ManuallySetRef.current) {
      const videoTrack = stream.getVideoTracks()[0];
      const settings = videoTrack?.getSettings();
      if (settings?.width && settings?.height) {
        const autoIs360 = settings.width / settings.height > 1.8;
        is360Ref.current = autoIs360;
        setIs360(autoIs360);
      }
    }

    liveStreamRef.current = stream;
    setActiveEventId(eventId);

    const ws = new WebSocket(getWsUrl(eventId));
    wsRef.current = ws;

    ws.onopen = () => {
      const mimeType = [
        'video/webm; codecs="vp9,opus"',
        'video/webm; codecs="vp8,opus"',
        'video/webm',
      ].find(m => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';

      ws.send(JSON.stringify({ type: "init", mimeType, is360: is360Ref.current }));

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
  }, [stopBroadcast]);

  const toggleMic = useCallback(() => {
    const audio = liveStreamRef.current?.getAudioTracks()[0];
    if (audio) { audio.enabled = !audio.enabled; setMicEnabled(audio.enabled); }
  }, []);

  const toggleCam = useCallback(() => {
    const video = liveStreamRef.current?.getVideoTracks()[0];
    if (video) { video.enabled = !video.enabled; setCamEnabled(video.enabled); }
  }, []);

  const toggleIs360 = useCallback(() => {
    if (broadcastState !== "live") {
      is360ManuallySetRef.current = true;
      setIs360(v => !v);
    }
  }, [broadcastState]);

  const getLiveStream = useCallback(() => liveStreamRef.current, []);

  // Expose via context value below
  useEffect(() => {
    return () => { stopBroadcast(); };
  }, [stopBroadcast]);

  return (
    <BroadcastContext.Provider value={{
      broadcastState,
      errorMsg,
      micEnabled,
      camEnabled,
      duration,
      activeEventId,
      is360,
      startBroadcast,
      stopBroadcast,
      toggleMic,
      toggleCam,
      toggleIs360,
      getLiveStream,
    }}>
      {children}
    </BroadcastContext.Provider>
  );
}

export function useLiveStream() {
  const liveStreamRef = useRef<MediaStream | null>(null);
  return liveStreamRef;
}
