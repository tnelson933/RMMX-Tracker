import { createContext, useContext, useRef, useState, useCallback, useEffect } from "react";
import { CameraBroadcaster, type CameraSnapshot } from "@/lib/cameraBroadcaster";

export type { BroadcastState, CameraSnapshot } from "@/lib/cameraBroadcaster";

// Live cameras for the whole organizer app, so streams keep running while the
// organizer moves between pages. Each camera is its own CameraBroadcaster.

interface BroadcastContextValue {
  /** Cameras going live, live, reconnecting, or stopped with an error. */
  cameras: CameraSnapshot[];
  /** Ticks every second while anything is live, for duration displays. */
  now: number;
  startCamera: (eventId: number, opts: { cameraId: string; name: string; deviceId: string }) => void;
  stopCamera: (key: string) => void;
  stopAll: () => void;
  /** Clears a camera that stopped with an error. */
  dismissCamera: (key: string) => void;
  toggleMic: (key: string) => void;
  toggleCam: (key: string) => void;
  getStream: (key: string) => MediaStream | null;
}

const BroadcastContext = createContext<BroadcastContextValue | null>(null);

export function useBroadcast() {
  const ctx = useContext(BroadcastContext);
  if (!ctx) throw new Error("useBroadcast must be used within BroadcastProvider");
  return ctx;
}

export const isStreaming = (c: CameraSnapshot) => c.state === "starting" || c.state === "live" || c.state === "reconnecting";

export function BroadcastProvider({ children }: { children: React.ReactNode }) {
  const sessions = useRef(new Map<string, CameraBroadcaster>());
  const [cameras, setCameras] = useState<CameraSnapshot[]>([]);
  const [now, setNow] = useState(Date.now());

  const publish = useCallback(() => {
    setCameras(Array.from(sessions.current.values(), s => s.snapshot).filter(c => c.state !== "stopped"));
  }, []);

  const startCamera = useCallback((eventId: number, opts: { cameraId: string; name: string; deviceId: string }) => {
    const key = `${eventId}:${opts.cameraId}`;
    sessions.current.get(key)?.stop();
    const fisheye = (() => { try { return localStorage.getItem("broadcast.dualFisheye") === "true"; } catch { return false; } })();
    const session = new CameraBroadcaster({ eventId, ...opts, isDualFisheye: fisheye }, () => publish());
    sessions.current.set(key, session);
    publish();
    void session.start();
  }, [publish]);

  const stopCamera = useCallback((key: string) => {
    sessions.current.get(key)?.stop();
    sessions.current.delete(key);
    publish();
  }, [publish]);

  const stopAll = useCallback(() => {
    for (const s of sessions.current.values()) s.stop();
    sessions.current.clear();
    publish();
  }, [publish]);

  const dismissCamera = useCallback((key: string) => {
    const s = sessions.current.get(key);
    if (s && !isStreaming(s.snapshot)) { sessions.current.delete(key); publish(); }
  }, [publish]);

  const toggleMic = useCallback((key: string) => sessions.current.get(key)?.toggleMic(), []);
  const toggleCam = useCallback((key: string) => sessions.current.get(key)?.toggleCam(), []);
  const getStream = useCallback((key: string) => sessions.current.get(key)?.mediaStream ?? null, []);

  const anyLive = cameras.some(isStreaming);
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyLive]);

  // Leaving the app ends every stream cleanly.
  useEffect(() => () => {
    for (const s of sessions.current.values()) s.stop();
  }, []);

  return (
    <BroadcastContext.Provider value={{ cameras, now, startCamera, stopCamera, stopAll, dismissCamera, toggleMic, toggleCam, getStream }}>
      {children}
    </BroadcastContext.Provider>
  );
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
