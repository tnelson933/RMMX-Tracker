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
 * Detect whether a WebM buffer from Chrome MediaRecorder contains a VP8/VP9
 * keyframe (IDR).
 *
 * IMPORTANT: Do NOT scan all bytes for 0xA3 (SimpleBlock ID).  0xA3 is common
 * in compressed video payloads and produces a 100% false-positive rate — every
 * P-frame chunk incorrectly looks like a keyframe, emptying gopTail constantly
 * and breaking late-joiner graduation.
 *
 * Instead, parse top-down from known EBML structure:
 *
 *   Case 1 — initSegment (EBML magic 1A 45 DF A3):
 *     The first chunk from MediaRecorder always starts with EBML magic and
 *     always contains the codec IDR.  Return true immediately.
 *
 *   Case 2 — Cluster chunk (Cluster ID 1F 43 B6 75):
 *     Chrome MediaRecorder timeslice chunks are individual Clusters.
 *     Parse: Cluster ID (4) → size VINT (1–8) → Timecode element (E7) →
 *     first SimpleBlock (A3) → check flags bit 7.
 *     Only read the first ~128 bytes of the cluster body so we never touch
 *     VP9 payload bytes.
 */
function containsKeyframe(buf: Buffer): boolean {
  if (buf.length < 4) return false;

  // Case 1: initSegment starts with EBML magic and always has a keyframe.
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) {
    return true;
  }

  // Case 2: Cluster chunk — must start with Cluster ID 1F 43 B6 75.
  if (buf[0] !== 0x1F || buf[1] !== 0x43 || buf[2] !== 0xB6 || buf[3] !== 0x75) {
    return false;
  }

  // Skip Cluster ID (4 bytes) + Cluster size VINT (1–8 bytes).
  // Chrome live streams use "unknown" size = 01 FF FF FF FF FF FF FF (8 bytes).
  let pos = 4;
  if (pos >= buf.length) return false;
  const csb = buf[pos];
  let csLen: number;
  if      ((csb & 0x80) !== 0) csLen = 1;
  else if ((csb & 0x40) !== 0) csLen = 2;
  else if ((csb & 0x20) !== 0) csLen = 3;
  else if ((csb & 0x10) !== 0) csLen = 4;
  else if ((csb & 0x08) !== 0) csLen = 5;
  else if ((csb & 0x04) !== 0) csLen = 6;
  else if ((csb & 0x02) !== 0) csLen = 7;
  else if ((csb & 0x01) !== 0) csLen = 8;
  else return false;
  pos += csLen;

  // Scan the first 128 bytes of the cluster body.
  // We expect: optional Timecode (E7), then the first SimpleBlock (A3).
  // Stopping at 128 bytes guarantees we never read VP9 frame payload data.
  const bodyLimit = Math.min(pos + 128, buf.length);

  while (pos + 1 < bodyLimit) {
    const elementId = buf[pos];
    pos++;

    // Parse element size VINT.
    if (pos >= bodyLimit) break;
    const esb = buf[pos];
    let esLen: number;
    if      ((esb & 0x80) !== 0) esLen = 1;
    else if ((esb & 0x40) !== 0) esLen = 2;
    else if ((esb & 0x20) !== 0) esLen = 3;
    else if ((esb & 0x10) !== 0) esLen = 4;
    else return false;  // Unexpectedly large size VINT in the cluster header area

    let dataSize = esb & ~(0x80 >> (esLen - 1));
    for (let k = 1; k < esLen; k++) {
      if (pos + k >= buf.length) return false;
      dataSize = (dataSize << 8) | buf[pos + k];
    }
    pos += esLen;  // pos now points to the first byte of element data

    if (elementId === 0xE7) {
      // Timecode element — skip data bytes and move to next element.
      pos += dataSize;
      continue;
    }

    if (elementId === 0xA3) {
      // SimpleBlock — read track-number VINT + 2-byte relative timecode + flags.
      if (pos >= buf.length) break;
      const tv = buf[pos];
      let tvLen: number;
      if      ((tv & 0x80) !== 0) tvLen = 1;
      else if ((tv & 0x40) !== 0) tvLen = 2;
      else if ((tv & 0x20) !== 0) tvLen = 3;
      else break;
      pos += tvLen + 2;  // skip track VINT + 2-byte relative timecode
      if (pos < buf.length) {
        // Bit 7 of the flags byte = keyframe (IDR) flag.
        return (buf[pos] & 0x80) !== 0;
      }
      break;
    }

    // Any other element (e.g. 0xAB BlockGroup, 0xFB DiscardPadding):
    // skip its data and continue.  Bound-check to avoid runaway advance.
    if (pos + dataSize > buf.length) break;
    pos += dataSize;
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
        const count = state.viewers.size + state.pendingViewers.size;
        ws.send(JSON.stringify({ type: "heartbeat", viewers: count }));
      }
      heartbeatInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          const count = state.viewers.size + state.pendingViewers.size;
          ws.send(JSON.stringify({ type: "heartbeat", viewers: count }));
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
