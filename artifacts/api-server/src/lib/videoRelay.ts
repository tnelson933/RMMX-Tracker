import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { logger } from "./logger";
import { WebmStreamParser } from "./webmStream";

/**
 * Live video relay: browsers record WebM with MediaRecorder and send it here
 * over a WebSocket; viewers receive it over a WebSocket and play it with
 * MediaSource.
 *
 * An event can have several cameras, each with its own broadcaster. The relay
 * reads the WebM structure (lib/webmStream.ts) rather than trusting where the
 * browser happened to slice the recording, so it always knows where a viewer
 * can start: the setup segment ("init"), then the Cluster holding the latest
 * keyframe and everything recorded since. Late joiners start there at once.
 *
 * Broadcasting needs a short-lived ticket from POST /video/broadcast-ticket,
 * which checks the organizer's session. Watching is public.
 */

interface Camera {
  eventId: number;
  cameraId: string;
  name: string;
  broadcasterWs: WebSocket | null;
  viewers: Set<WebSocket>;
  // Viewers waiting for a keyframe before they can start decoding.
  pendingViewers: Set<WebSocket>;
  parser: WebmStreamParser;
  initSegment: Buffer | null;
  // Media since the latest keyframe Cluster, starting with that Cluster.
  gop: Buffer[];
  gopBytes: number;
  gopStartedAt: number;
  keyframeRequested: boolean;
  mimeType: string;
  is360: boolean;
  isDualFisheye: boolean;
  startedAt: Date;
  // Set while the broadcaster's connection dropped and it may come back.
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

export const MAX_VIEWER_BUFFERED_BYTES = 2 * 1024 * 1024;
export const MAX_GOP_BYTES = 6 * 1024 * 1024;
/** Ask the broadcaster for a fresh keyframe when none came for this long. */
export const KEYFRAME_STALE_MS = 6_000;
/** How long a dropped broadcaster has to reconnect before viewers see "ended". */
export const BROADCASTER_GRACE_MS = 30_000;
export const MAX_CAMERAS_PER_EVENT = 8;
const TICKET_TTL_MS = 2 * 60_000;
const DEFAULT_CAMERA = "main";

const cameras = new Map<string, Camera>();
const keyOf = (eventId: number, cameraId: string) => `${eventId}:${cameraId}`;

export function canRelayToViewer(bufferedAmount: number, nextBytes: number): boolean {
  return bufferedAmount + nextBytes <= MAX_VIEWER_BUFFERED_BYTES;
}

export function normalizeCameraId(raw: unknown): string | null {
  if (raw == null || raw === "") return DEFAULT_CAMERA;
  const id = String(raw).toLowerCase();
  return /^[a-z0-9-]{1,24}$/.test(id) ? id : null;
}

export function normalizeCameraName(raw: unknown, cameraId: string): string {
  const name = typeof raw === "string" ? raw.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40) : "";
  return name || (cameraId === DEFAULT_CAMERA ? "Main camera" : "Camera");
}

// ── Broadcast tickets ───────────────────────────────────────────────────────

const ticketSecret = process.env.SESSION_SECRET || randomBytes(32).toString("hex");

function sign(payload: string): string {
  return createHmac("sha256", ticketSecret).update(`video-broadcast:${payload}`).digest("base64url");
}

/** A ticket letting its holder broadcast one camera of one event for 2 minutes. */
export function createBroadcastTicket(eventId: number, cameraId: string, now = Date.now()): string {
  const payload = `${eventId}.${cameraId}.${now + TICKET_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyBroadcastTicket(ticket: string, eventId: number, cameraId: string, now = Date.now()): boolean {
  const parts = ticket.split(".");
  if (parts.length !== 4) return false;
  const [ev, cam, exp, sig] = parts;
  if (ev !== String(eventId) || cam !== cameraId || !(Number(exp) > now)) return false;
  const expected = Buffer.from(sign(`${ev}.${cam}.${exp}`));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ── Status ──────────────────────────────────────────────────────────────────

export type LiveCamera = { id: string; name: string; viewers: number; startedAt: string; reconnecting: boolean };

export function getLiveCameras(eventId: number): LiveCamera[] {
  const list: LiveCamera[] = [];
  for (const cam of cameras.values()) {
    if (cam.eventId !== eventId) continue;
    list.push({
      id: cam.cameraId,
      name: cam.name,
      viewers: cam.viewers.size + cam.pendingViewers.size,
      startedAt: cam.startedAt.toISOString(),
      reconnecting: cam.broadcasterWs === null,
    });
  }
  return list.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function isEventLive(eventId: number): boolean {
  return getLiveCameras(eventId).length > 0;
}

export function getLiveEvents(): number[] {
  return Array.from(new Set(Array.from(cameras.values(), c => c.eventId)));
}

// ── WebSocket plumbing ──────────────────────────────────────────────────────

export function attachVideoWebSocket(httpServer: Server) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "", "http://relay");
    const broadcast = url.pathname.match(/^\/api\/video\/broadcast\/(\d+)(?:\/([^/]+))?\/?$/);
    const watch = url.pathname.match(/^\/api\/video\/watch\/(\d+)(?:\/([^/]+))?\/?$/);
    if (!broadcast && !watch) return;

    const eventId = parseInt((broadcast ?? watch)![1], 10);
    const cameraId = normalizeCameraId((broadcast ?? watch)![2]);
    if (!cameraId) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    if (broadcast) {
      const ticket = url.searchParams.get("ticket") ?? "";
      if (!verifyBroadcastTicket(ticket, eventId, cameraId)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const name = normalizeCameraName(url.searchParams.get("name"), cameraId);
      wss.handleUpgrade(req, socket as any, head, ws => handleBroadcaster(ws, eventId, cameraId, name));
    } else {
      // Without a camera in the path, watch the first live camera.
      const explicit = watch![2] !== undefined;
      wss.handleUpgrade(req, socket as any, head, ws => handleViewer(ws, eventId, explicit ? cameraId : null));
    }
  });

  logger.info("Video WebSocket relay attached");
}

function sendJson(ws: WebSocket, msg: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function cameraList(eventId: number) {
  return getLiveCameras(eventId).map(c => ({ id: c.id, name: c.name, reconnecting: c.reconnecting }));
}

function initMessage(cam: Camera) {
  return { type: "init", mimeType: cam.mimeType, is360: cam.is360, isDualFisheye: cam.isDualFisheye, cameraId: cam.cameraId, cameraName: cam.name };
}

/** Sends `parts` unless the viewer is already too far behind; then drops it. */
function sendOrEvict(cam: Camera, viewer: WebSocket, parts: Buffer[]): boolean {
  if (viewer.readyState !== WebSocket.OPEN) return false;
  const bytes = parts.reduce((sum, p) => sum + p.length, 0);
  if (!canRelayToViewer(viewer.bufferedAmount, bytes)) {
    logger.warn({ eventId: cam.eventId, cameraId: cam.cameraId, bufferedBytes: viewer.bufferedAmount }, "Evicting slow video viewer");
    cam.viewers.delete(viewer);
    cam.pendingViewers.delete(viewer);
    viewer.close(1013, "Viewer too slow");
    return false;
  }
  for (const p of parts) viewer.send(p, { binary: true });
  return true;
}

/** Starts a viewer at the latest keyframe, or parks it until the next one. */
function startViewer(cam: Camera, viewer: WebSocket) {
  if (cam.initSegment && cam.gop.length > 0) {
    cam.pendingViewers.delete(viewer);
    if (sendOrEvict(cam, viewer, [Buffer.concat([cam.initSegment, ...cam.gop])])) cam.viewers.add(viewer);
    return;
  }
  cam.pendingViewers.add(viewer);
  requestKeyframe(cam, "viewer waiting");
}

function requestKeyframe(cam: Camera, reason: string) {
  if (cam.keyframeRequested || !cam.broadcasterWs || !cam.initSegment) return;
  cam.keyframeRequested = true;
  sendJson(cam.broadcasterWs, { type: "request-keyframe" });
  logger.info({ eventId: cam.eventId, cameraId: cam.cameraId, reason }, "Requested broadcaster keyframe");
}

function resetMedia(cam: Camera) {
  cam.parser.reset();
  cam.initSegment = null;
  cam.gop = [];
  cam.gopBytes = 0;
  cam.gopStartedAt = Date.now();
  cam.keyframeRequested = false;
}

function endCamera(cam: Camera, reason: string) {
  if (cam.reconnectTimer) clearTimeout(cam.reconnectTimer);
  cameras.delete(keyOf(cam.eventId, cam.cameraId));
  const msg = { type: "ended", cameras: cameraList(cam.eventId) };
  for (const v of [...cam.viewers, ...cam.pendingViewers]) sendJson(v, msg);
  cam.viewers.clear();
  cam.pendingViewers.clear();
  logger.info({ eventId: cam.eventId, cameraId: cam.cameraId, reason }, "Camera ended");
}

function handleMedia(cam: Camera, chunk: Buffer) {
  let units;
  try {
    units = cam.parser.push(chunk);
  } catch (err) {
    // Unreadable data: start over at the broadcaster's next recorder restart.
    logger.warn({ eventId: cam.eventId, cameraId: cam.cameraId, err: err instanceof Error ? err.message : String(err) }, "Unreadable video data; asking for a restart");
    resetMedia(cam);
    if (cam.broadcasterWs) sendJson(cam.broadcasterWs, { type: "request-keyframe" });
    return;
  }

  // Everything from this slice goes out as one message per viewer (a frame-by-frame
  // stream would be dozens of messages a second). Waiting viewers join at the
  // first keyframe in it.
  const batch: Buffer[] = [];
  let joinAt = -1;
  for (const unit of units) {
    if (unit.kind === "init") {
      cam.initSegment = unit.data;
      cam.gop = [];
      cam.gopBytes = 0;
      cam.gopStartedAt = Date.now();
      // Viewers already playing append the new setup segment and carry on.
      batch.push(unit.data);
      continue;
    }

    if (unit.keyframe) {
      cam.gop = [unit.data];
      cam.gopBytes = unit.data.length;
      cam.gopStartedAt = Date.now();
      cam.keyframeRequested = false;
      if (joinAt < 0) joinAt = batch.length;
    } else if (cam.gop.length > 0) {
      cam.gop.push(unit.data);
      cam.gopBytes += unit.data.length;
      if (cam.gopBytes > MAX_GOP_BYTES) {
        // Too long since a keyframe to replay: late joiners wait for the next one.
        cam.gop = [];
        cam.gopBytes = 0;
      }
    }
    batch.push(unit.data);
  }

  if (batch.length > 0) {
    const message = batch.length === 1 ? batch[0] : Buffer.concat(batch);
    for (const v of [...cam.viewers]) sendOrEvict(cam, v, [message]);
  }
  if (joinAt >= 0 && cam.initSegment && cam.pendingViewers.size > 0) {
    const start = batch.slice(joinAt);
    // An init segment inside the batch already precedes the keyframe.
    const parts = start[0] === cam.initSegment ? start : [cam.initSegment, ...start];
    const message = Buffer.concat(parts);
    for (const v of [...cam.pendingViewers]) {
      cam.pendingViewers.delete(v);
      if (sendOrEvict(cam, v, [message])) cam.viewers.add(v);
    }
  }

  if (cam.initSegment && Date.now() - cam.gopStartedAt > KEYFRAME_STALE_MS) {
    requestKeyframe(cam, "no recent keyframe");
  }
}

function handleBroadcaster(ws: WebSocket, eventId: number, cameraId: string, name: string) {
  const key = keyOf(eventId, cameraId);
  let cam = cameras.get(key);

  if (!cam) {
    const liveHere = getLiveCameras(eventId).length;
    if (liveHere >= MAX_CAMERAS_PER_EVENT) {
      sendJson(ws, { type: "error", message: `This event already has ${MAX_CAMERAS_PER_EVENT} cameras live.` });
      ws.close(4003, "Too many cameras");
      return;
    }
    cam = {
      eventId, cameraId, name,
      broadcasterWs: null,
      viewers: new Set(),
      pendingViewers: new Set(),
      parser: new WebmStreamParser(),
      initSegment: null,
      gop: [],
      gopBytes: 0,
      gopStartedAt: Date.now(),
      keyframeRequested: false,
      mimeType: 'video/webm; codecs="vp8,opus"',
      is360: false,
      isDualFisheye: false,
      startedAt: new Date(),
      reconnectTimer: null,
    };
    cameras.set(key, cam);
  }
  const state = cam;

  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  if (state.broadcasterWs) {
    try { state.broadcasterWs.close(4001, "Another device took over this camera"); } catch {}
  }
  state.broadcasterWs = ws;
  state.name = name;
  resetMedia(state);
  logger.info({ eventId, cameraId }, "Broadcaster connected");

  // Keeps the server→broadcaster direction of proxies alive.
  const heartbeat = setInterval(() => sendJson(ws, { type: "heartbeat" }), 1_000);

  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (state.broadcasterWs !== ws) return;
    const chunk = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);

    // Control messages are JSON. Some proxies turn text frames into binary, so
    // look at the content; WebM never starts with "{".
    if (!isBinary || (chunk.length > 0 && chunk[0] === 0x7b)) {
      let msg: Record<string, unknown> | null = null;
      try { msg = JSON.parse(chunk.toString("utf8")); } catch {}
      if (msg) {
        if (msg.type === "init" && typeof msg.mimeType === "string") {
          const formatChanged = state.mimeType !== msg.mimeType
            || state.is360 !== (msg.is360 === true)
            || state.isDualFisheye !== (msg.isDualFisheye === true);
          state.mimeType = msg.mimeType.slice(0, 100);
          state.is360 = msg.is360 === true;
          state.isDualFisheye = msg.isDualFisheye === true;
          // A new recorder follows: its first bytes are a fresh WebM file.
          resetMedia(state);
          if (formatChanged) {
            // Viewers rebuild their player for the new format, then wait for a keyframe.
            for (const v of [...state.viewers, ...state.pendingViewers]) sendJson(v, initMessage(state));
            for (const v of state.viewers) state.pendingViewers.add(v);
            state.viewers.clear();
          }
        } else if (msg.type === "stop") {
          endCamera(state, "broadcaster stopped");
          state.broadcasterWs = null;
          ws.close(1000, "Stopped");
        }
        return;
      }
      if (!isBinary) return;
    }

    handleMedia(state, chunk);
  });

  const onGone = () => {
    clearInterval(heartbeat);
    if (state.broadcasterWs !== ws) return; // replaced or already stopped
    state.broadcasterWs = null;
    if (cameras.get(key) !== state) return;
    // Keep viewers for a while: phones on a track's cell signal drop often.
    logger.info({ eventId, cameraId }, "Broadcaster dropped; waiting for it to reconnect");
    for (const v of [...state.viewers, ...state.pendingViewers]) sendJson(v, { type: "reconnecting" });
    for (const v of state.viewers) state.pendingViewers.add(v);
    state.viewers.clear();
    resetMedia(state);
    state.reconnectTimer = setTimeout(() => {
      if (state.broadcasterWs === null && cameras.get(key) === state) endCamera(state, "broadcaster did not return");
    }, BROADCASTER_GRACE_MS);
  };
  ws.on("close", onGone);
  ws.on("error", err => {
    logger.warn({ eventId, cameraId, err: err.message }, "Broadcaster WebSocket error");
  });
}

function handleViewer(ws: WebSocket, eventId: number, requestedCamera: string | null) {
  let cam: Camera | undefined;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  // Viewers send "hello" pings to keep proxies open; nothing else is expected.
  ws.on("message", () => {});

  const detach = () => {
    if (heartbeat) clearInterval(heartbeat);
    cam?.viewers.delete(ws);
    cam?.pendingViewers.delete(ws);
  };
  ws.on("close", detach);
  ws.on("error", detach);

  // A short pause lets the browser finish its open handshake before data flows.
  setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const live = getLiveCameras(eventId);
    const id = requestedCamera ?? live[0]?.id;
    cam = id ? cameras.get(keyOf(eventId, id)) : undefined;

    if (!cam) {
      sendJson(ws, { type: "offline", cameras: cameraList(eventId) });
    } else {
      sendJson(ws, initMessage(cam));
      if (cam.broadcasterWs === null) {
        sendJson(ws, { type: "reconnecting" });
        cam.pendingViewers.add(ws);
      } else {
        startViewer(cam, ws);
      }
      logger.info({ eventId, cameraId: cam.cameraId, viewers: cam.viewers.size, pending: cam.pendingViewers.size }, "Viewer connected");
    }

    heartbeat = setInterval(() => {
      const current = cam && cameras.get(keyOf(cam.eventId, cam.cameraId)) === cam ? cam : null;
      sendJson(ws, {
        type: "heartbeat",
        viewers: current ? current.viewers.size + current.pendingViewers.size : 0,
        cameras: cameraList(eventId),
      });
    }, 1_000);
  }, 150);
}
