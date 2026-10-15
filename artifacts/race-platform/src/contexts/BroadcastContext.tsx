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

const MAX_RECONNECT_DELAY_MS = 15_000;

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
    let rotatingRecorder = false;
    let suppressRecorderData = false;

    const sendInit = (ws: WebSocket) => {
      ws.send(JSON.stringify({
        type: "init",
        mimeType,
        is360: is360Ref.current,
        isDualFisheye: isDualFisheyeRef.current,
      }));
    };

    const createRecorder = () => {
      if (!reconnectRef.current.active || !liveStreamRef.current) return;
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 500_000,
        audioBitsPerSecond: 64_000,
        videoKeyFrameIntervalDuration: 2_000,
      } as MediaRecorderOptions);
      recorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (!suppressRecorderData && e.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(e.data);
        }
      };
      recorder.onerror = () => {
        setErrorMsg("Recording error. The stream was interrupted.");
        setBroadcastState("error");
        stopBroadcast();
      };
      recorder.onstop = () => {
        if (!rotatingRecorder) return;
        rotatingRecorder = false;
        suppressRecorderData = false;
        const activeWs = wsRef.current;
        if (activeWs?.readyState === WebSocket.OPEN && reconnectRef.current.active) {
          sendInit(activeWs);
        }
        // Keep capture alive even if the socket disappeared during rotation.
        // A later socket reconnect rotates once more to establish a clean EBML boundary.
        createRecorder();
        if (activeWs?.readyState === WebSocket.OPEN) {
          setErrorMsg("");
          setBroadcastState("live");
        }
      };
      recorder.start(500);
    };

    const rotateRecorder = () => {
      const recorder = recorderRef.current;
      if (rotatingRecorder) return;
      if (recorder?.state === "recording") {
        rotatingRecorder = true;
        suppressRecorderData = true;
        recorder.stop();
        return;
      }
      const activeWs = wsRef.current;
      if (activeWs?.readyState === WebSocket.OPEN) sendInit(activeWs);
      createRecorder();
      if (activeWs?.readyState === WebSocket.OPEN) {
        setErrorMsg("");
        setBroadcastState("live");
      }
    };

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
        if (wsRef.current !== ws || !reconnectRef.current.active) {
          ws.close();
          return;
        }
        // Successful (re)connect — reset attempt counter.
        reconnectRef.current.attempts = 0;

        if (!isReconnect) {
          sendInit(ws);
          createRecorder();
          timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
          setBroadcastState("live");
        } else {
          // A new relay state must always start with a genuine EBML/Tracks
          // segment. Rotate instead of routing mid-GOP chunks from the old recorder.
          rotateRecorder();
        }
      };

      // The server sends {"type":"heartbeat"} every second to keep the
      // server→broadcaster proxy direction alive. Consume silently.
      ws.onmessage = (event) => {
        let message: Record<string, unknown> | null = null;
        try {
          if (typeof event.data === "string") message = JSON.parse(event.data);
          else if (event.data instanceof Blob) {
            event.data.text().then(text => {
              try {
                const parsed = JSON.parse(text) as Record<string, unknown>;
                if (wsRef.current === ws && parsed.type === "request-keyframe") rotateRecorder();
              } catch {}
            });
          }
        } catch {}
        if (wsRef.current === ws && message?.type === "request-keyframe") rotateRecorder();
      };

      ws.onerror = () => {
        // onclose always fires after onerror — retry logic lives there.
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        // If stopBroadcast was called, reconnectRef.current.active is already
        // false — nothing to do.
        if (!reconnectRef.current.active) return;

        const nextAttempt = reconnectRef.current.attempts + 1;
        reconnectRef.current.attempts = nextAttempt;

        // Keep capture and MediaRecorder alive indefinitely. Mobile networks and
        // proxies can be unavailable for longer than a small fixed retry window.
        setErrorMsg("Connection interrupted. Reconnecting while recording continues…");
        setBroadcastState("reconnecting");
        const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** Math.min(nextAttempt - 1, 4));
        reconnectRef.current.timer = setTimeout(() => {
          if (reconnectRef.current.active && wsRef.current === ws) connectWs(true);
        }, delay);
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
