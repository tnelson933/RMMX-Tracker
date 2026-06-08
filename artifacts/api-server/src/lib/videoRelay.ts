import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Server } from "http";
import { logger } from "./logger";

interface StreamState {
  broadcasterWs: WebSocket | null;
  viewers: Set<WebSocket>;
  // WebM initialization segment (first chunk from broadcaster — contains EBML header + Tracks
  // element + first Cluster with the broadcast's very first I-frame).
  // Must be sent to every viewer before any cluster chunks so the decoder can initialize.
  initSegment: Buffer | null;
  // Most recent chunk that contained a VP8/VP9 keyframe (I-frame).
  // Kept separate from initSegment because VP8 produces a new I-frame every ~2-4 seconds.
  // Late joiners receive initSegment + lastKeyframeChunk + gopTail so their decoder
  // always has a valid reference frame for the live P-frames that follow.
  lastKeyframeChunk: Buffer | null;
  // P-frame chunks since the last keyframe (current GOP tail).
  // Combined with initSegment + lastKeyframeChunk these form a decodable "bootstrap bundle"
  // for late joiners — all P-frames here reference the I-frame in lastKeyframeChunk.
  gopTail: Buffer[];
  mimeType: string;
  live: boolean;
  startedAt: Date | null;
  is360: boolean;
  isDualFisheye: boolean;
}

// eventId → stream state
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

    // Parse VINT-encoded element size (leading-one-bit determines width)
    if (pos >= buf.length) continue;
    const sb = buf[pos];
    let sizeLen: number;
    if      ((sb & 0x80) !== 0) sizeLen = 1;
    else if ((sb & 0x40) !== 0) sizeLen = 2;
    else if ((sb & 0x20) !== 0) sizeLen = 3;
    else if ((sb & 0x10) !== 0) sizeLen = 4;
    else continue; // wider VINT not expected in normal WebM
    pos += sizeLen;

    // Parse VINT-encoded track number (usually 1 byte: 0x81 = track 1)
    if (pos >= buf.length) continue;
    const tb = buf[pos];
    if      ((tb & 0x80) !== 0) pos += 1;
    else if ((tb & 0x40) !== 0) pos += 2;
    else if ((tb & 0x20) !== 0) pos += 3;
    else continue;

    // Skip 2-byte timecode
    pos += 2;

    // Flags byte: bit 7 (0x80) = keyframe
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

    // /api/video/broadcast/:eventId  — organizer side
    const broadcastMatch = url.match(/^\/api\/video\/broadcast\/(\d+)/);
    // /api/video/watch/:eventId      — viewer side
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

function handleBroadcaster(ws: WebSocket, eventId: number) {
  const state = getOrCreate(eventId);

  // Kick any existing broadcaster
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

  // Server→broadcaster heartbeat — the broadcaster sends video chunks every 500 ms
  // which keeps the broadcaster→server proxy direction alive, but the server never
  // sends anything back. The Replit proxy enforces a per-direction idle timeout on
  // application data; without this heartbeat the server→broadcaster direction goes
  // silent and the proxy kills the connection after ~20–30 s, cutting off the stream.
  // The broadcaster client silently ignores these heartbeat messages.
  const broadcasterHeartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "heartbeat" }));
    }
  }, 1_000);

  ws.on("message", (data: Buffer | string, isBinary: boolean) => {
    // Normalise to Buffer regardless of frame type.
    // The Replit proxy converts text WebSocket frames to binary, so we cannot rely
    // on !isBinary / typeof data === "string" to detect JSON control messages.
    // Instead, detect JSON by the opening '{' byte (0x7b).
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
          // Reset segments when broadcaster announces a new stream
          state.initSegment = null;
          state.lastKeyframeChunk = null;
          state.gopTail = [];
          // Notify all current viewers of the new mime type and format flags
          const initMsg = JSON.stringify({ type: "init", mimeType: state.mimeType, is360: state.is360, isDualFisheye: state.isDualFisheye });
          for (const viewer of state.viewers) {
            if (viewer.readyState === WebSocket.OPEN) {
              viewer.send(initMsg);
            }
          }
        }
        return; // consumed as JSON control message
      } catch {
        // Not valid JSON — fall through and treat as binary video data
      }
    }

    // ── Binary frame = video chunk ────────────────────────────────────────────

    // First binary chunk is the WebM initialization segment (EBML header + Tracks +
    // first Cluster with the broadcast's first I-frame). Store it as both the
    // initSegment AND as the initial lastKeyframeChunk.
    if (!state.initSegment) {
      state.initSegment = chunk;
      state.lastKeyframeChunk = chunk; // initSegment always contains the first I-frame
      state.gopTail = [];
    } else {
      // Subsequent chunks: detect keyframes and maintain the current GOP window.
      // A keyframe chunk starts a new GOP — reset gopTail and store as lastKeyframeChunk.
      // P-frame chunks belong to the current GOP — append to gopTail.
      //
      // Late joiners receive: initSegment + lastKeyframeChunk + gopTail
      // This guarantees their decoder has a valid I-frame reference for all
      // the P-frames in the live stream, eliminating the "immediately frozen" symptom.
      if (containsKeyframe(chunk)) {
        state.lastKeyframeChunk = chunk;
        state.gopTail = [];
      } else {
        // Cap GOP tail at 16 chunks (~8 s) as a safety valve against very long GOPs.
        state.gopTail.push(chunk);
        if (state.gopTail.length > 16) {
          state.gopTail.shift();
        }
      }
    }

    // Forward to all viewers
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

    // Notify viewers stream ended
    const endMsg = JSON.stringify({ type: "ended" });
    for (const viewer of state.viewers) {
      if (viewer.readyState === WebSocket.OPEN) {
        viewer.send(endMsg);
      }
    }
  });

  ws.on("error", (err) => {
    clearInterval(broadcasterHeartbeat);
    logger.error({ eventId, err: err.message }, "Broadcaster WebSocket error");
  });
}

function handleViewer(ws: WebSocket, eventId: number) {
  const state = getOrCreate(eventId);
  state.viewers.add(ws);

  logger.info({ eventId, viewers: state.viewers.size }, "Viewer connected");

  // Application-level heartbeat to keep the Replit proxy from closing idle
  // connections. The proxy has a ~2-second per-direction idle timeout on
  // application data; protocol-level ws.ping() does NOT count.
  //
  // The viewer client sends a {"type":"hello"} immediately on ws.onopen to
  // establish the client→server direction right away. Then, each time it
  // receives a heartbeat it replies with {"type":"pong"}, maintaining both
  // directions continuously. We send the first heartbeat 500 ms after the
  // initial message (not 1500 ms) so the client can pong back well before the
  // 2-second proxy deadline. Subsequent heartbeats fire every 1000 ms.
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let firstHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  const startHeartbeat = () => {
    if (heartbeatInterval || firstHeartbeatTimer) return;
    // First beat sooner — gives client time to pong before the 2-second proxy timeout
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
    }, 500);
  };

  const stopHeartbeat = () => {
    if (firstHeartbeatTimer) { clearTimeout(firstHeartbeatTimer); firstHeartbeatTimer = null; }
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  };

  // Delay initial messages so the Replit proxy relay has time to fully establish
  // the bidirectional pipe before we burst data down it. Without the delay, the
  // proxy can drop the connection on a late-joining viewer who gets init + video
  // data immediately after the WS handshake completes.
  setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) return;

    if (state.live) {
      ws.send(JSON.stringify({ type: "init", mimeType: state.mimeType, is360: state.is360, isDualFisheye: state.isDualFisheye }));

      if (state.initSegment && ws.readyState === WebSocket.OPEN) {
        // ── Late-joiner bootstrap bundle ────────────────────────────────────────
        //
        // The goal: give the viewer's VP8/VP9 decoder a valid I-frame that is as
        // CLOSE to the current live edge as possible, so the P-frames in the live
        // stream can be decoded correctly without error concealment (frozen frames).
        //
        // What we send:
        //   1. initSegment       — WebM EBML header + Tracks + broadcast's first I-frame.
        //                          Required for the decoder to understand the codec and
        //                          initialise the MediaSource.
        //   2. lastKeyframeChunk — The most recent chunk that contained an I-frame.
        //                          Skipped if it's the same object as initSegment (stream
        //                          is still in its first GOP, no more recent I-frame yet).
        //   3. gopTail           — P-frame chunks that arrived after lastKeyframeChunk
        //                          up to the current live edge.  These reference the I-frame
        //                          in lastKeyframeChunk, so the live P-frames that follow
        //                          are decodable immediately.
        //
        // With sb.mode="sequence" on the client the MSE assigns artificial sequential
        // timestamps, so the decoder sees no gap even though initSegment is from t=0
        // and lastKeyframeChunk may be from several minutes into the broadcast.

        ws.send(state.initSegment, { binary: true });

        if (state.lastKeyframeChunk && state.lastKeyframeChunk !== state.initSegment && ws.readyState === WebSocket.OPEN) {
          ws.send(state.lastKeyframeChunk, { binary: true });

          for (const tail of state.gopTail) {
            if (ws.readyState !== WebSocket.OPEN) break;
            ws.send(tail, { binary: true });
          }
        }
      }
    } else {
      ws.send(JSON.stringify({ type: "offline" }));
    }

    // Always start the heartbeat regardless of stream state.
    // The Replit proxy requires bidirectional application-data flow to stay
    // alive — a protocol-level ws.ping() does NOT count. When the stream is
    // live the video chunks reset the proxy timer from the server side, but
    // the CLIENT side is silent unless we send it something to reply to.
    // Heartbeats give the client a cue to send a pong back (see WatchLive.tsx),
    // keeping both directions active and preventing proxy idle-timeouts.
    startHeartbeat();
  }, 150);

  // Handle messages from viewers (only pong keep-alives expected; ignore everything else)
  ws.on("message", (data: Buffer | string) => {
    const chunk: Buffer = typeof data === "string"
      ? Buffer.from(data, "utf8")
      : (Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer));
    if (chunk.length > 0 && chunk[0] === 0x7b) {
      try {
        const msg = JSON.parse(chunk.toString("utf8")) as Record<string, unknown>;
        if (msg.type === "pong" || msg.type === "hello") return; // client keep-alive — no action needed
      } catch { /* ignore */ }
    }
  });

  ws.on("close", () => {
    stopHeartbeat();
    state.viewers.delete(ws);
    logger.info({ eventId, viewers: state.viewers.size }, "Viewer disconnected");
  });

  ws.on("error", (err) => {
    stopHeartbeat();
    logger.error({ eventId, err: err.message }, "Viewer WebSocket error");
    state.viewers.delete(ws);
  });
}
