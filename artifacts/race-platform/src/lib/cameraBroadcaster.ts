import { getPublicOrigin } from "@/lib/publicOrigin";
import { responseErrorMessage } from "./friendlyErrors";

/**
 * One camera going live: captures it, records WebM with MediaRecorder and sends
 * the recording to the cloud video relay (api-server lib/videoRelay.ts).
 *
 * - Each connection needs a short-lived ticket from POST /api/video/broadcast-ticket
 *   (the organizer's session; the desktop app forwards it to the cloud).
 * - Lost connections retry forever with backoff while recording continues; each
 *   new connection restarts the recorder so the relay gets a clean WebM file.
 * - The relay asks for a restart ("request-keyframe") when a viewer is waiting
 *   and the browser hasn't produced a keyframe recently.
 */

export type BroadcastState = "starting" | "live" | "reconnecting" | "error" | "stopped";

export type CameraSnapshot = {
  key: string;
  eventId: number;
  cameraId: string;
  name: string;
  deviceId: string;
  state: BroadcastState;
  errorMsg: string;
  micEnabled: boolean;
  camEnabled: boolean;
  liveSince: number | null;
  is360: boolean;
  isDualFisheye: boolean;
};

const MAX_RECONNECT_DELAY_MS = 15_000;
const MIME_TYPES = ['video/webm; codecs="vp9,opus"', 'video/webm; codecs="vp8,opus"', "video/webm"];

/** The WebM type this browser can record, or null (e.g. Safari on iPhone). */
export function supportedBroadcastMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return MIME_TYPES.find(m => MediaRecorder.isTypeSupported(m)) ?? null;
}

export const UNSUPPORTED_BROWSER_MESSAGE =
  "This browser can't send live video. Use Chrome or Edge on a laptop, or Chrome on an Android phone.";

function wsUrl(eventId: number, cameraId: string, name: string, ticket: string): string {
  const origin = getPublicOrigin();
  const proto = origin.startsWith("https:") ? "wss:" : "ws:";
  const host = origin.replace(/^https?:\/\//, "");
  const q = new URLSearchParams({ ticket, name });
  return `${proto}//${host}/api/video/broadcast/${eventId}/${cameraId}?${q}`;
}

class TicketError extends Error {}

async function fetchTicket(eventId: number, cameraId: string): Promise<string> {
  // Same origin: the cloud site directly, or the desktop app's cloud pass-through.
  const res = await fetch("/api/video/broadcast-ticket", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventId, cameraId }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new TicketError(body.error === "Event not found"
      ? "This event can't be streamed from this account."
      : "Sign in as the event's organizer to go live.");
  }
  if (!res.ok || typeof body.ticket !== "string") throw new Error(responseErrorMessage(res.status, body));
  return body.ticket;
}

export class CameraBroadcaster {
  readonly key: string;
  private snap: CameraSnapshot;
  private stream: MediaStream | null = null;
  private ws: WebSocket | null = null;
  private recorder: MediaRecorder | null = null;
  private mime = "video/webm";
  private active = false;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private rotating = false;
  private suppressData = false;
  private wakeLock: { release(): Promise<void> } | null = null;

  constructor(
    opts: { eventId: number; cameraId: string; name: string; deviceId: string; is360?: boolean; isDualFisheye?: boolean },
    private readonly onChange: (snap: CameraSnapshot) => void,
  ) {
    this.key = `${opts.eventId}:${opts.cameraId}`;
    this.snap = {
      key: this.key,
      eventId: opts.eventId,
      cameraId: opts.cameraId,
      name: opts.name,
      deviceId: opts.deviceId,
      state: "starting",
      errorMsg: "",
      micEnabled: true,
      camEnabled: true,
      liveSince: null,
      is360: opts.is360 ?? false,
      isDualFisheye: opts.isDualFisheye ?? false,
    };
  }

  get snapshot(): CameraSnapshot { return this.snap; }
  get mediaStream(): MediaStream | null { return this.stream; }

  private update(patch: Partial<CameraSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.onChange(this.snap);
  }

  private fail(message: string) {
    this.shutdown();
    this.update({ state: "error", errorMsg: message, liveSince: null });
  }

  async start(): Promise<void> {
    const mime = supportedBroadcastMime();
    if (!mime) return this.fail(UNSUPPORTED_BROWSER_MESSAGE);
    this.mime = mime;
    this.update({ state: "starting", errorMsg: "" });

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        // 720p keeps the picture sharp at a bitrate a track's cell or Starlink
        // uplink can carry; 360° cameras can go up to 1920 wide (2:1).
        video: this.snap.deviceId
          ? { deviceId: { exact: this.snap.deviceId }, width: { ideal: 1280, max: 1920 } }
          : { width: { ideal: 1280, max: 1920 } },
        audio: true,
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      return this.fail(name === "NotAllowedError"
        ? "Camera or microphone access was blocked. Allow it in the browser's site settings and try again."
        : name === "NotReadableError"
          ? "This camera is in use by another app or another camera on this page."
          : "Couldn't open this camera. Check that it's plugged in.");
    }

    const video = this.stream.getVideoTracks()[0];
    const s = video?.getSettings();
    if (s?.width && s?.height) {
      const ratio = s.width / s.height;
      if (ratio < 0.7) this.snap = { ...this.snap, isDualFisheye: true, is360: false };
      else if (!this.snap.isDualFisheye && !this.snap.is360) this.snap = { ...this.snap, is360: ratio > 1.8 };
    }
    if (video) video.onended = () => { if (this.active) this.fail("The camera was disconnected."); };

    this.active = true;
    void this.keepScreenOn();
    document.addEventListener("visibilitychange", this.onVisibility);
    this.connect(false);
  }

  stop(): void {
    this.shutdown();
    this.update({ state: "stopped", liveSince: null });
  }

  toggleMic(): void {
    const audio = this.stream?.getAudioTracks()[0];
    if (!audio) return;
    audio.enabled = !audio.enabled;
    this.update({ micEnabled: audio.enabled });
  }

  toggleCam(): void {
    const video = this.stream?.getVideoTracks()[0];
    if (!video) return;
    video.enabled = !video.enabled;
    this.update({ camEnabled: video.enabled });
  }

  private shutdown() {
    this.active = false;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    document.removeEventListener("visibilitychange", this.onVisibility);
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      try { recorder.stop(); } catch {}
    }
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    const ws = this.ws;
    this.ws = null;
    if (ws?.readyState === WebSocket.OPEN) {
      // Tell the relay this camera is done, so viewers see "ended" (or switch
      // cameras) instead of waiting for it to come back. A socket another device
      // replaced is ignored by the relay, so this can't end that device's stream.
      try { ws.send(JSON.stringify({ type: "stop" })); } catch {}
      setTimeout(() => ws.close(1000), 200);
    } else {
      ws?.close();
    }
  }

  // Phones turn the screen off after a minute, which stops the camera.
  private async keepScreenOn() {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
      if (this.active && nav.wakeLock && document.visibilityState === "visible") {
        this.wakeLock = await nav.wakeLock.request("screen");
      }
    } catch { /* not supported or not allowed: nothing to do */ }
  }

  private onVisibility = () => {
    if (document.visibilityState === "visible" && this.active) void this.keepScreenOn();
  };

  private sendInit(ws: WebSocket) {
    ws.send(JSON.stringify({ type: "init", mimeType: this.mime, is360: this.snap.is360, isDualFisheye: this.snap.isDualFisheye }));
  }

  private createRecorder() {
    if (!this.active || !this.stream) return;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(this.stream, {
        mimeType: this.mime,
        videoBitsPerSecond: this.snap.is360 || this.snap.isDualFisheye ? 1_800_000 : 1_000_000,
        audioBitsPerSecond: 64_000,
        // A keyframe every 2 s lets viewers join (and recover) within 2 s.
        videoKeyFrameIntervalDuration: 2_000,
      } as MediaRecorderOptions);
    } catch {
      return this.fail(UNSUPPORTED_BROWSER_MESSAGE);
    }
    this.recorder = recorder;
    recorder.ondataavailable = e => {
      if (this.recorder !== recorder || this.suppressData || e.data.size === 0) return;
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(e.data);
    };
    recorder.onerror = () => this.fail("Recording stopped unexpectedly. Try going live again.");
    recorder.onstop = () => {
      if (this.recorder !== recorder || !this.rotating) return;
      this.rotating = false;
      this.suppressData = false;
      this.beginRecording();
    };
    recorder.start(500);
  }

  /** Starts a fresh WebM file on the current socket (after init). */
  private beginRecording() {
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN && this.active) {
      this.sendInit(ws);
      this.createRecorder();
      this.update({ state: "live", errorMsg: "", liveSince: this.snap.liveSince ?? Date.now() });
    } else {
      // No socket right now: keep capturing; the next connection restarts again.
      this.createRecorder();
    }
  }

  private restartRecorder() {
    if (this.rotating) return;
    const recorder = this.recorder;
    if (recorder?.state === "recording") {
      // Drop the old file's unfinished tail; the relay starts over at "init".
      this.rotating = true;
      this.suppressData = true;
      recorder.stop();
      return;
    }
    this.beginRecording();
  }

  private async connect(isReconnect: boolean) {
    if (!this.active) return;
    let ticket: string;
    try {
      ticket = await fetchTicket(this.snap.eventId, this.snap.cameraId);
    } catch (err) {
      if (err instanceof TicketError) return this.fail(err.message);
      return this.scheduleRetry();
    }
    if (!this.active) return;

    const ws = new WebSocket(wsUrl(this.snap.eventId, this.snap.cameraId, this.snap.name, ticket));
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws || !this.active) { ws.close(); return; }
      this.attempts = 0;
      if (!isReconnect && !this.recorder) {
        this.beginRecording();
      } else {
        // The relay starts every connection fresh: give it a new WebM file.
        this.restartRecorder();
      }
    };

    ws.onmessage = async event => {
      let text: string | null = null;
      if (typeof event.data === "string") text = event.data;
      else if (event.data instanceof Blob && event.data.size < 4096) text = await event.data.text();
      if (!text || this.ws !== ws) return;
      try {
        const msg = JSON.parse(text) as { type?: string; message?: string };
        if (msg.type === "request-keyframe") this.restartRecorder();
        else if (msg.type === "error" && msg.message) this.fail(msg.message);
      } catch { /* not JSON */ }
    };

    ws.onclose = event => {
      if (this.ws !== ws || !this.active) return;
      if (event.code === 4001) return this.fail("Another device took over this camera.");
      if (event.code === 4003) return; // "error" message already shown
      this.scheduleRetry();
    };
  }

  private scheduleRetry() {
    if (!this.active) return;
    this.attempts++;
    this.update({ state: "reconnecting", errorMsg: "Connection lost. Reconnecting; the camera keeps recording." });
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** Math.min(this.attempts - 1, 4));
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.connect(true); }, delay);
  }
}
