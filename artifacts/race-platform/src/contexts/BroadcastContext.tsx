import { createContext, useContext, useRef, useState, useCallback, useEffect } from "react";
import { getPublicOrigin } from "@/lib/publicOrigin";

export type BroadcastState = "idle" | "live" | "reconnecting" | "error" | "stopped";

interface BroadcastContextValue {
  broadcastState: BroadcastState;
  errorMsg: string;
  micEnabled: boolean;
  camEnabled: boolean;
  duration: number;
  activeEventId: number | null;
  is360: boolean;
  isDualFisheye: boolean;

  startBroadcast: (eventId: number, deviceId: string) => Promise<void>;
  stopBroadcast: () => void;
  toggleMic: () => void;
  toggleCam: () => void;
  toggleIs360: () => void;
  toggleIsDualFisheye: () => void;
  getLiveStream: () => MediaStream | null;
}

const BroadcastContext = createContext<BroadcastContextValue | null>(null);

export function useBroadcast() {
  const ctx = useContext(BroadcastContext);
  if (!ctx) throw new Error("useBroadcast must be used within BroadcastProvider");
  return ctx;
}

function getWsUrl(eventId: number): string {
  const origin = getPublicOrigin();
  const proto = origin.startsWith("https:") ? "wss:" : "ws:";
  const host = origin.replace(/^https?:\/\//, "");
  return `${proto}//${host}/api/video/broadcast/${eventId}`;
}

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 1500;

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
  const [isDualFisheye, setIsDualFisheye] = useState(false);
  const isDualFisheyeRef = useRef(false);
  isDualFisheyeRef.current = isDualFisheye;

  const liveStreamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Tracks whether the user explicitly pressed the format toggles before going live.
  // When true, the manual choice wins over auto-detection in startBroadcast.
  const is360ManuallySetRef = useRef(false);
  const isDualFisheyeManuallySetRef = useRef(false);
  // Reconnect state: active=true while live/reconnecting, attempts counts failures,
  // timer holds the pending retry so stopBroadcast can cancel it.
  const reconnectRef = useRef<{
    active: boolean;
    attempts: number;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ active: false, attempts: 0, timer: null });

  const stopBroadcast = useCallback(() => {
    // Disable reconnect before closing so ws.onclose doesn't trigger a retry.
    reconnectRef.current.active = false;
    if (reconnectRef.current.timer) {
      clearTimeout(reconnectRef.current.timer);
      reconnectRef.current.timer = null;
    }

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
    // isDualFisheye preference is intentionally kept — user's fisheye setting
    // persists across broadcast sessions (saved in localStorage).
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

    // Auto-detect camera format from the video track's actual aspect ratio, but respect
    // any manual toggle the user set before going live (isDualFisheyeManuallySetRef /
    // is360ManuallySetRef). Manual choice always wins over auto-detection.
    const videoTrack = stream.getVideoTracks()[0];
    const settings = videoTrack?.getSettings();
    if (settings?.width && settings?.height) {
      const ratio = settings.width / settings.height;
      if (isDualFisheyeManuallySetRef.current) {
        // User explicitly enabled Dual Fisheye — keep it, clear 360°.
        isDualFisheyeRef.current = true;
        is360Ref.current = false;
        setIs360(false);
      } else if (ratio < 0.7) {
        // Unambiguously stacked portrait — auto-confirm dual fisheye.
        isDualFisheyeRef.current = true;
        setIsDualFisheye(true);
        is360Ref.current = false;
        setIs360(false);
      } else if (!is360ManuallySetRef.current) {
        // No manual overrides — auto-detect 360° from ratio.
        const autoIs360 = ratio > 1.8;
        is360Ref.current = autoIs360;
        setIs360(autoIs360);
        isDualFisheyeRef.current = false;
        setIsDualFisheye(false);
      }
      // (If is360ManuallySetRef is true and ratio isn't < 0.7: keep is360 as set.)
    }

    liveStreamRef.current = stream;
    setActiveEventId(eventId);

    // Determine MIME type once — reused for every reconnect attempt so the
    // server always receives a consistent codec declaration.
    const mimeType = [
      'video/webm; codecs="vp9,opus"',
      'video/webm; codecs="vp8,opus"',
      'video/webm',
    ].find(m => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';

    // Arm reconnect tracking.
    reconnectRef.current = { active: true, attempts: 0, timer: null };

    // connectWs opens a WebSocket and wires up handlers.
    // On the first call (isReconnect=false) it also creates the MediaRecorder.
    // On subsequent calls (isReconnect=true) it only replaces the socket —
    // the recorder keeps running uninterrupted, and its ondataavailable handler
    // reads wsRef.current so it automatically routes chunks to the new socket.
    function connectWs(isReconnect: boolean) {
      const ws = new WebSocket(getWsUrl(eventId));
      wsRef.current = ws;

      ws.onopen = () => {
        // Successful (re)connect — reset attempt counter.
        reconnectRef.current.attempts = 0;

        ws.send(JSON.stringify({
          type: "init",
          mimeType,
          is360: is360Ref.current,
          isDualFisheye: isDualFisheyeRef.current,
        }));

        if (!isReconnect) {
          const recorder = new MediaRecorder(stream, {
            mimeType,
            // Lower bitrate keeps chunk sizes small so the Replit proxy can relay
            // them without dropping the WebSocket connection on burst.
            videoBitsPerSecond: 500_000,
            audioBitsPerSecond: 64_000,
            // Force a keyframe every 2 s.  Without this, VP9 MediaRecorder only
            // emits ONE keyframe (the very first chunk = the init segment).  Every
            // subsequent 500 ms timeslice is a P-frame.  The server parks late
            // viewers in a "pending" queue and graduates them on the next keyframe;
            // without periodic keyframes, pending viewers are never graduated and
            // the fallback sends them stale init data that the decoder can't use
            // with the current live P-frames → video starts then immediately freezes.
            // Chrome 94+ honours videoKeyFrameIntervalDuration (milliseconds);
            // older/other browsers silently ignore it.
            videoKeyFrameIntervalDuration: 2_000,
          } as MediaRecorderOptions);
          recorderRef.current = recorder;

          // Use wsRef.current (not the captured ws variable) so that when we
          // reconnect and swap in a new WebSocket, chunks automatically route
          // to the fresh connection without restarting the recorder.
          recorder.ondataavailable = (e) => {
            if (e.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(e.data);
            }
          };

          recorder.onerror = () => {
            setErrorMsg("Recording error. The stream was interrupted.");
            setBroadcastState("error");
            stopBroadcast();
          };

          recorder.start(500);
          timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
        }

        setBroadcastState("live");
      };

      // The server sends {"type":"heartbeat"} every second to keep the
      // server→broadcaster proxy direction alive. Consume silently.
      ws.onmessage = () => {};

      ws.onerror = () => {
        // onclose always fires after onerror — retry logic lives there.
      };

      ws.onclose = () => {
        // If stopBroadcast was called, reconnectRef.current.active is already
        // false — nothing to do.
        if (!reconnectRef.current.active) return;

        const nextAttempt = reconnectRef.current.attempts + 1;
        reconnectRef.current.attempts = nextAttempt;

        if (nextAttempt <= MAX_RECONNECT_ATTEMPTS) {
          // Transient drop — show reconnecting state and schedule a retry.
          setBroadcastState("reconnecting");
          reconnectRef.current.timer = setTimeout(() => {
            if (reconnectRef.current.active) connectWs(true);
          }, RECONNECT_DELAY_MS);
        } else {
          // All retries exhausted — surface the error UI.
          reconnectRef.current.active = false;
          setErrorMsg("Stream connection lost. Please try again.");
          setBroadcastState("error");
          stopBroadcast();
        }
      };
    }

    connectWs(false);
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
      setIs360(v => {
        const next = !v;
        if (next) {
          // Enabling 360° — disable dual fisheye (mutually exclusive)
          setIsDualFisheye(false);
          isDualFisheyeRef.current = false;
        }
        return next;
      });
    }
  }, [broadcastState]);

  const toggleIsDualFisheye = useCallback(() => {
    setIsDualFisheye(v => {
      const next = !v;
      isDualFisheyeManuallySetRef.current = next;
      isDualFisheyeRef.current = next;
      localStorage.setItem("broadcast.dualFisheye", String(next));
      if (next) {
        // Enabling dual fisheye — disable 360° mode (mutually exclusive)
        is360Ref.current = false;
        is360ManuallySetRef.current = false;
        setIs360(false);
      }
      return next;
    });
  }, []);

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
      isDualFisheye,
      startBroadcast,
      stopBroadcast,
      toggleMic,
      toggleCam,
      toggleIs360,
      toggleIsDualFisheye,
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
