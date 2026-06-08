import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Server } from "http";
import { logger } from "./logger";

interface StreamState {
  broadcasterWs: WebSocket | null;
  // Viewers actively receiving the live stream
  viewers: Set<WebSocket>;
  // Viewers that have joined but are waiting for the next keyframe before
  // being graduated to the live stream.  They hold the JSON init message but
  // no binary data yet — their MediaSource has not been created.
  pendingViewers: Set<WebSocket>;
  // WebM initialization segment (first chunk from broadcaster — contains EBML
  // header + Tracks element + first Cluster with the broadcast's first I-frame).
  // Must be sent before any cluster chunks so the decoder can initialize.
  initSegment: Buffer | null;
  // Most recent chunk that contained a VP8/VP9 keyframe (I-frame).
  lastKeyframeChunk: Buffer | null;
  // P-frame chunks since the last keyframe (current GOP tail) — kept for
  // future use but NOT sent to late joiners to avoid proxy burst.
  gopTail: Buffer[];
  mimeType: string;
  live: boolean;
  startedAt: Date | null;
  is360: boolean;
  isDualFisheye: boolean;
}

const streams = new Map<number, StreamState>();

/**
 * Scan a WebM buffer for a SimpleBlock element (EBML ID 0xA3) with the
 * keyframe flag set (flags byte bit 7 = 0x80).
 *
 * WebM SimpleBlock layout inside a Cluster:
 *   [0xA3]                    — 1-byte element ID
 *   [size VINT]               — variable-length encoded element size (1–4 bytes)
 *   [track number VINT]       — variable-length track number (1–3 bytes, usually 0x81 for track 1)
 *   [timecode]                — 2 bytes (signed, relative to cluster timecode)
 *   [flags byte]              — bit 7 = keyframe, bits 5-4 = lacing, bit 0 = discardable
 *   [frame payload]           — VP8/VP9 encoded frame data
 */
function containsKeyframe(buf: Buffer): boolean {
  const SIMPLE_BLOCK_ID = 0xA3;

  for (let i = 0; i < buf.length - 6; i++) {
    if (buf[i] !== SIMPLE_BLOCK_ID) continue;

    let pos = i + 1;

    if (pos >= buf.length) continue;
    const sb = buf[pos];
    let sizeLen: number;
    if      ((sb & 0x80) !== 0) sizeLen = 1;
    else if ((sb & 0x40) !== 0) sizeLen = 2;
    else if ((sb & 0x20) !== 0) sizeLen = 3;
    else if ((sb & 0x10) !== 0) sizeLen = 4;
    else continue;
    pos += sizeLen;

    if (pos >= buf.length) continue;
    const tb = buf[pos];
    if      ((tb & 0x80) !== 0) pos += 1;
    else if ((tb & 0x40) !== 0) pos += 2;
    else if ((tb & 0x20) !== 0) pos += 3;
    else continue;

    pos += 2;

    if (pos < buf.length && (buf[pos] & 0x80) !== 0) {
      return true;
    }
  }
  return false;
}

function getOrCreate(eventId: number): StreamState {
  if (!streams.has(eventId)) {
    streams.set(eventId, {
      broadcasterWs: null,
      viewers: new Set(),
      pendingViewers: new Set(),
      initSegment: null,
      lastKeyframeChunk: null,
      gopTail: [],
      mimeType: 'video/webm; codecs="vp8,opus"',
      live: false,
      startedAt: null,
      is360: false,
      isDualFisheye: false,
    });
  }
  return streams.get(eventId)!;
}

export function isEventLive(eventId: number): boolean {
  return streams.get(eventId)?.live ?? false;
}

export function getLiveEvents(): number[] {
  return Array.from(streams.entries())
    .filter(([, s]) => s.live)
    .map(([id]) => id);
}

export function attachVideoWebSocket(httpServer: Server) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = req.url ?? "";

    const broadcastMatch = url.match(/^\/api\/video\/broadcast\/(\d+)/);
    const watchMatch = url.match(/^\/api\/video\/watch\/(\d+)/);

    if (broadcastMatch || watchMatch) {
      wss.handleUpgrade(req, socket as any, head, (ws) => {
        if (broadcastMatch) {
          handleBroadcaster(ws, parseInt(broadcastMatch[1], 10));
        } else if (watchMatch) {
          handleViewer(ws, parseInt(watchMatch[1], 10));
        }
      });
    }
  });

  logger.info("Video WebSocket relay attached");
}

/**
 * Graduate all pending viewers into the live stream.
 *
 * Called every time a keyframe chunk arrives from the broadcaster.
 * Each pending viewer receives exactly two frames:
 *   1. initSegment  — EBML header + Tracks (decoder setup, sent only if different from keyframeChunk)
 *   2. keyframeChunk — fresh I-frame at a clean GOP boundary
 *
 * After this point the viewer is in state.viewers and will receive every
 * subsequent live chunk.  Because we start them exactly at a keyframe, all
 * subsequent P-frames are guaranteed to have their reference I-frame in the
 * viewer's decoder buffer — eliminating the "frozen video" symptom.
 *
 * Total bytes burst per viewer: ≤ 2 × ~35 KB = ~70 KB, sent as two separate
 * send() calls, not one large burst.  This keeps us well within the Replit
 * proxy's per-connection buffer limits.
 */
function flushPendingViewers(state: StreamState, keyframeChunk: Buffer): void {
  if (state.pendingViewers.size === 0) return;

  for (const pending of state.pendingViewers) {
    if (pending.readyState !== WebSocket.OPEN) continue;

    // Send initSegment first so the viewer's MSE can initialize the decoder.
    // Skip this send if keyframeChunk IS the initSegment (i.e. the very first
    // broadcast chunk, which is both the EBML init AND the first keyframe) —
    // we'd otherwise send the same buffer twice.
    if (state.initSegment && state.initSegment !== keyframeChunk) {
      pending.send(state.initSegment, { binary: true });
    }

    // Send the fresh keyframe.  The client will call initMSE on the first
    // binary frame and queue the rest — both sends happen before the MSE
    // sourceopen fires, so both chunks will be flushed in order.
    pending.send(keyframeChunk, { binary: true });

    state.viewers.add(pending);
  }

  state.pendingViewers.clear();
}

function handleBroadcaster(ws: WebSocket, eventId: number) {
  const state = getOrCreate(eventId);

  if (state.broadcasterWs) {
    try { state.broadcasterWs.close(1001, "New broadcaster connected"); } catch {}
  }

  state.broadcasterWs = ws;
  state.live = true;
  state.startedAt = new Date();
  state.initSegment = null;
  state.lastKeyframeChunk = null;
  state.gopTail = [];

  logger.info({ eventId }, "Broadcaster connected");

  const broadcasterHeartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "heartbeat" }));
    }
  }, 1_000);

  ws.on("message", (data: Buffer | string, isBinary: boolean) => {
    const chunk: Buffer = typeof data === "string"
      ? Buffer.from(data, "utf8")
      : (Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer));

    if (chunk.length > 0 && chunk[0] === 0x7b) {
      try {
        const msg = JSON.parse(chunk.toString("utf8")) as Record<string, unknown>;
        if (msg.type === "init" && typeof msg.mimeType === "string") {
          state.mimeType = msg.mimeType;
          state.is360 = msg.is360 === true;
          state.isDualFisheye = msg.isDualFisheye === true;
          state.initSegment = null;
          state.lastKeyframeChunk = null;
          state.gopTail = [];
          // Notify active viewers of format change
          const initMsg = JSON.stringify({ type: "init", mimeType: state.mimeType, is360: state.is360, isDualFisheye: state.isDualFisheye });
          for (const viewer of state.viewers) {
            if (viewer.readyState === WebSocket.OPEN) viewer.send(initMsg);
          }
          // Also re-send to pending viewers so they have the updated mimeType
          for (const pending of state.pendingViewers) {
            if (pending.readyState === WebSocket.OPEN) pending.send(initMsg);
          }
        }
        return;
      } catch {
        // Not valid JSON — fall through and treat as binary video data
      }
    }

    // ── Binary frame = video chunk ──────────────────────────────────────────

    if (!state.initSegment) {
      // First binary chunk: EBML header + Tracks + first I-frame.
      // Store as initSegment AND as lastKeyframeChunk (it always contains a keyframe).
      state.initSegment = chunk;
      state.lastKeyframeChunk = chunk;
      state.gopTail = [];
      // Flush any viewers who joined before the stream started.
      // keyframeChunk === initSegment here, so flushPendingViewers sends it once.
      flushPendingViewers(state, chunk);
    } else if (containsKeyframe(chunk)) {
      // New I-frame: start of a fresh GOP.
      state.lastKeyframeChunk = chunk;
      state.gopTail = [];
      // Flush pending viewers exactly at this keyframe boundary — their
      // decoder will have initSegment (codec setup) + this I-frame, and
      // every P-frame that follows will reference exactly this I-frame.
      flushPendingViewers(state, chunk);
    } else {
      state.gopTail.push(chunk);
      if (state.gopTail.length > 16) {
        state.gopTail.shift();
      }
    }

    // Forward to ACTIVE viewers only — pending viewers are waiting for their keyframe.
    for (const viewer of state.viewers) {
      if (viewer.readyState === WebSocket.OPEN) {
        viewer.send(chunk, { binary: true });
      }
    }
  });

  ws.on("close", () => {
    clearInterval(broadcasterHeartbeat);
    state.live = false;
    state.broadcasterWs = null;
    logger.info({ eventId }, "Broadcaster disconnected — stream ended");

    const endMsg = JSON.stringify({ type: "ended" });
    for (const viewer of state.viewers) {
      if (viewer.readyState === WebSocket.OPEN) viewer.send(endMsg);
    }
    // Also notify pending viewers so they don't wait indefinitely
    for (const pending of state.pendingViewers) {
      if (pending.readyState === WebSocket.OPEN) pending.send(endMsg);
    }
    state.pendingViewers.clear();
  });

  ws.on("error", (err) => {
    clearInterval(broadcasterHeartbeat);
    logger.error({ eventId, err: err.message }, "Broadcaster WebSocket error");
  });
}

function handleViewer(ws: WebSocket, eventId: number) {
  const state = getOrCreate(eventId);
  // Do NOT add to state.viewers yet — the viewer will be graduated when the
  // next keyframe arrives, guaranteeing a clean GOP start point.

  logger.info({ eventId, viewers: state.viewers.size, pending: state.pendingViewers.size + 1 }, "Viewer connected");

  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let firstHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  // Fallback: if no keyframe arrives within 5 s (stalled broadcaster), flush
  // the viewer with the best available data so they aren't waiting forever.
  let pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;

  const startHeartbeat = () => {
    if (heartbeatInterval || firstHeartbeatTimer) return;
    firstHeartbeatTimer = setTimeout(() => {
      firstHeartbeatTimer = null;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "heartbeat" }));
      }
      heartbeatInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "heartbeat" }));
        }
      }, 1_000);
    }, 150);
  };

  const stopHeartbeat = () => {
    if (firstHeartbeatTimer) { clearTimeout(firstHeartbeatTimer); firstHeartbeatTimer = null; }
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  };

  const stopPendingFlush = () => {
    if (pendingFlushTimer) { clearTimeout(pendingFlushTimer); pendingFlushTimer = null; }
  };

  setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) return;

    if (state.live) {
      // Send the JSON init message so the client knows the mimeType and format
      // flags.  Do NOT send any binary data yet — the client defers MediaSource
      // creation until the first binary frame arrives (see WatchLive.tsx), so
      // Chrome can never fire sourceclose on an empty MSE before data arrives.
      ws.send(JSON.stringify({ type: "init", mimeType: state.mimeType, is360: state.is360, isDualFisheye: state.isDualFisheye }));

      // Park this viewer in pendingViewers.  The next keyframe from the
      // broadcaster will call flushPendingViewers() which sends initSegment +
      // keyframe and moves the viewer into state.viewers for live forwarding.
      state.pendingViewers.add(ws);

      // Safety fallback: if the broadcaster hasn't sent a keyframe within 5 s
      // (e.g. broadcaster is paused, very long GOP, or stalled), flush with the
      // best available data so the viewer isn't stuck in "Connecting…" forever.
      pendingFlushTimer = setTimeout(() => {
        pendingFlushTimer = null;
        if (!state.pendingViewers.has(ws)) return; // already flushed normally
        if (ws.readyState !== WebSocket.OPEN) return;

        if (state.initSegment) {
          ws.send(state.initSegment, { binary: true });
          if (state.lastKeyframeChunk && state.lastKeyframeChunk !== state.initSegment) {
            ws.send(state.lastKeyframeChunk, { binary: true });
          }
        }
        state.pendingViewers.delete(ws);
        state.viewers.add(ws);
        logger.warn({ eventId }, "Pending viewer flushed via 5s fallback (no keyframe arrived)");
      }, 5_000);
    } else {
      ws.send(JSON.stringify({ type: "offline" }));
    }

    startHeartbeat();
  }, 150);

  ws.on("message", (data: Buffer | string) => {
    const chunk: Buffer = typeof data === "string"
      ? Buffer.from(data, "utf8")
      : (Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer));
    if (chunk.length > 0 && chunk[0] === 0x7b) {
      try {
        const msg = JSON.parse(chunk.toString("utf8")) as Record<string, unknown>;
        if (msg.type === "pong" || msg.type === "hello") return;
      } catch { /* ignore */ }
    }
  });

  ws.on("close", () => {
    stopHeartbeat();
    stopPendingFlush();
    state.viewers.delete(ws);
    state.pendingViewers.delete(ws);
    logger.info({ eventId, viewers: state.viewers.size }, "Viewer disconnected");
  });

  ws.on("error", (err) => {
    stopHeartbeat();
    stopPendingFlush();
    logger.error({ eventId, err: err.message }, "Viewer WebSocket error");
    state.viewers.delete(ws);
    state.pendingViewers.delete(ws);
  });
}
