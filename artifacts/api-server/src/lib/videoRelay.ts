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
 * Returns the set of newly graduated viewers so the caller can add them to
 * state.viewers AFTER the live-forward loop runs.  This prevents the keyframe
 * from being sent a second time — the double-send would corrupt the MSE
 * sequence-mode timeline and could leave the client showing a black frame.
 *
 * Total bytes burst per viewer: ≤ 2 × ~35 KB = ~70 KB, sent as two separate
 * send() calls, not one large burst.  This keeps us well within the Replit
 * proxy's per-connection buffer limits.
 */
function flushPendingViewers(state: StreamState, keyframeChunk: Buffer): Set<WebSocket> {
  const graduated = new Set<WebSocket>();
  if (state.pendingViewers.size === 0) return graduated;

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

    graduated.add(pending);
  }

  state.pendingViewers.clear();
  if (graduated.size > 0) {
    logger.info({ eventId: (state as any).eventId, count: graduated.size }, "Pending viewers graduated via keyframe");
  }
  // NOTE: do NOT call state.viewers.add() here.  The caller must add them
  // AFTER the live-forward loop so this keyframe isn't forwarded a second time.
  return graduated;
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

    let justGraduated = new Set<WebSocket>();

    if (!state.initSegment) {
      // First binary chunk: EBML header + Tracks + first I-frame.
      // Store as initSegment AND as lastKeyframeChunk (it always contains a keyframe).
      state.initSegment = chunk;
      state.lastKeyframeChunk = chunk;
      state.gopTail = [];
      // Flush any viewers who joined before the stream started.
      // keyframeChunk === initSegment here, so flushPendingViewers sends it once.
      justGraduated = flushPendingViewers(state, chunk);
    } else if (containsKeyframe(chunk)) {
      // New I-frame: start of a fresh GOP.
      const prevTailLen = state.gopTail.length;
      state.lastKeyframeChunk = chunk;
      state.gopTail = [];
      logger.info({ eventId, chunkSize: chunk.length, prevGopTailFrames: prevTailLen }, "Periodic keyframe detected — GOP boundary");
      // Flush pending viewers exactly at this keyframe boundary — their
      // decoder will have initSegment (codec setup) + this I-frame, and
      // every P-frame that follows will reference exactly this I-frame.
      justGraduated = flushPendingViewers(state, chunk);
    } else {
      state.gopTail.push(chunk);
      // Keep enough P-frames to cover up to ~30 s at 500 ms timeslices.
      // With videoKeyFrameIntervalDuration: 2_000 the tail should stay at 4 frames,
      // but a larger cap protects against missed keyframe detection.
      if (state.gopTail.length > 60) {
        state.gopTail.shift();
      }
    }

    // Forward to ACTIVE viewers only — pending viewers are waiting for their keyframe.
    // justGraduated are NOT in state.viewers yet, so they don't receive this chunk again.
    for (const viewer of state.viewers) {
      if (viewer.readyState === WebSocket.OPEN) {
        viewer.send(chunk, { binary: true });
      }
    }

    // Graduate newly flushed viewers AFTER the live-forward loop.
    // They already received initSegment + keyframe from flushPendingViewers.
    // Their first live chunk will be the NEXT broadcast message — a P-frame
    // that correctly references the keyframe they just received.
    for (const ws of justGraduated) {
      state.viewers.add(ws);
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
      // Always send the JSON init message first so the client knows the mimeType
      // and format flags before any binary data arrives.
      ws.send(JSON.stringify({ type: "init", mimeType: state.mimeType, is360: state.is360, isDualFisheye: state.isDualFisheye }));

      if (state.initSegment) {
        // The broadcaster is already mid-stream — graduate this viewer immediately.
        //
        // VP9 P-frames form a CHAIN: each P-frame references the previously decoded
        // frame, not the keyframe directly.  Sending only initSegment + lastKeyframeChunk
        // is not enough — the live P-frames that follow reference frames in the gopTail
        // (P-frames between the last keyframe and the current live edge).  Without the
        // full chain the decoder cannot reconstruct anything → video freezes at first frame.
        //
        // We therefore send:  initSegment → lastKeyframeChunk → gopTail (in order).
        // The gopTail brings the decoder to the same state as the broadcaster, so the
        // very next live P-frame is decodable.
        try {
          if (state.initSegment !== state.lastKeyframeChunk) {
            ws.send(state.initSegment, { binary: true });
          }
          if (state.lastKeyframeChunk) {
            ws.send(state.lastKeyframeChunk, { binary: true });
          }
          for (const frame of state.gopTail) {
            ws.send(frame, { binary: true });
          }
          state.viewers.add(ws);
          logger.info({
            eventId,
            viewers: state.viewers.size,
            gopTailFrames: state.gopTail.length,
            separateKeyframe: state.initSegment !== state.lastKeyframeChunk,
          }, "Viewer graduated immediately (stream already live)");
        } catch (err) {
          logger.error({ eventId, err: err instanceof Error ? err.message : String(err) }, "Immediate graduation error — falling back to pending queue");
          state.pendingViewers.add(ws);
          schedulePendingFlush();
        }
      } else {
        // No data yet — broadcaster just connected but hasn't sent the first chunk.
        // Park this viewer until the initSegment arrives (normally < 500 ms).
        state.pendingViewers.add(ws);
        schedulePendingFlush();
      }
    } else {
      ws.send(JSON.stringify({ type: "offline" }));
    }

    startHeartbeat();
  }, 150);

  function schedulePendingFlush() {
    pendingFlushTimer = setTimeout(() => {
      try {
        pendingFlushTimer = null;
        logger.warn({ eventId, hasInit: !!state.initSegment, hasKeyframe: !!state.lastKeyframeChunk }, "Pending viewer flushed via 2s fallback (no initSegment from broadcaster)");

        if (!state.pendingViewers.has(ws)) return;
        if (ws.readyState !== WebSocket.OPEN) {
          state.pendingViewers.delete(ws);
          return;
        }
        if (state.initSegment) {
          ws.send(state.initSegment, { binary: true });
          if (state.lastKeyframeChunk && state.lastKeyframeChunk !== state.initSegment) {
            ws.send(state.lastKeyframeChunk, { binary: true });
          }
          for (const frame of state.gopTail) {
            ws.send(frame, { binary: true });
          }
        }
        state.pendingViewers.delete(ws);
        state.viewers.add(ws);
      } catch (err) {
        logger.error({ eventId, err: err instanceof Error ? err.message : String(err) }, "Pending viewer fallback error — removing from pending");
        state.pendingViewers.delete(ws);
      }
    }, 2_000);
  }

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
