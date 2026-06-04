import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Server } from "http";
import { logger } from "./logger";

interface StreamState {
  broadcasterWs: WebSocket | null;
  viewers: Set<WebSocket>;
  // WebM initialization segment (first chunk from broadcaster — contains EBML header + Tracks).
  // Must be sent to every viewer before any cluster chunks so the decoder can initialize.
  initSegment: Buffer | null;
  // Rolling buffer of the last N chunks for late-joiner catch-up
  chunkBuffer: Buffer[];
  mimeType: string;
  live: boolean;
  startedAt: Date | null;
  is360: boolean;
  isDualFisheye: boolean;
}

// Keep only the last few chunks — enough for a smooth late-join start without
// overwhelming the Replit proxy with a large burst when a new viewer connects.
// Keep 10 recent chunks (~5 s at 500 ms/chunk) so late-joining viewers have
// enough context to find a keyframe and start decoding. Combined with
// sb.mode="sequence" on the client side this prevents the timestamp-gap
// decode errors that caused the viewer to cycle every 2-3 seconds.
const MAX_BUFFER_CHUNKS = 10;

// eventId → stream state
const streams = new Map<number, StreamState>();

function getOrCreate(eventId: number): StreamState {
  if (!streams.has(eventId)) {
    streams.set(eventId, {
      broadcasterWs: null,
      viewers: new Set(),
      initSegment: null,
      chunkBuffer: [],
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
  state.chunkBuffer = [];

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
          state.chunkBuffer = [];
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

    // Binary frame = video chunk

    // First binary chunk is the WebM initialization segment (EBML header + Tracks).
    // Store it separately so late-joining viewers always receive it before cluster chunks.
    if (!state.initSegment) {
      state.initSegment = chunk;
    }

    // Buffer recent chunks for late joiners (skip re-buffering the init segment itself)
    if (state.initSegment !== chunk) {
      state.chunkBuffer.push(chunk);
      if (state.chunkBuffer.length > MAX_BUFFER_CHUNKS) {
        state.chunkBuffer.shift();
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
      // Always send the WebM init segment first — without it the decoder cannot
      // parse any of the subsequent cluster chunks (video stays black).
      if (state.initSegment && ws.readyState === WebSocket.OPEN) {
        ws.send(state.initSegment, { binary: true });
      }
      // Do NOT send buffered chunks to late-joining viewers.
      //
      // The buffered chunks are from broadcast time T-5s to T (the last 10 chunks
      // at 500ms each). The initSegment is from broadcast time 0-500ms.  There is
      // a large gap between them (potentially minutes of missing data).  VP8
      // P-frames in the buffered chunks reference I-frames that exist in the
      // middle of that gap — frames we never send.  Chrome's VP8 decoder uses
      // error concealment (shows the last valid decoded frame) for every
      // undecadable P-frame, so the video appears permanently frozen until the
      // next I-frame arrives in the live stream.
      //
      // By sending ONLY the initSegment we give the decoder one valid I-frame
      // (the very first frame of the broadcast) and then the NEXT live chunk from
      // the broadcaster arrives within ≤500ms.  If that chunk starts with an
      // I-frame the video plays immediately.  If not, error concealment lasts
      // at most one VP8 GOP interval (typically ≤2 s) before the next I-frame
      // recovers the decoder — far better than sending 5 s of undecodable data.
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
