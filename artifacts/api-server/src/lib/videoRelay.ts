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
}

const MAX_BUFFER_CHUNKS = 30;

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
          // Reset segments when broadcaster announces a new stream
          state.initSegment = null;
          state.chunkBuffer = [];
          // Notify all current viewers of the new mime type
          const initMsg = JSON.stringify({ type: "init", mimeType: state.mimeType });
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
    logger.error({ eventId, err: err.message }, "Broadcaster WebSocket error");
  });
}

function handleViewer(ws: WebSocket, eventId: number) {
  const state = getOrCreate(eventId);
  state.viewers.add(ws);

  logger.info({ eventId, viewers: state.viewers.size }, "Viewer connected");

  // Periodic ping to keep the connection alive through the Replit proxy.
  // The browser WebSocket API responds to protocol-level ping frames automatically.
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 20_000);

  // Send current stream state immediately
  if (state.live) {
    ws.send(JSON.stringify({ type: "init", mimeType: state.mimeType }));
    // Always send the WebM init segment first — without it the decoder cannot
    // parse any of the subsequent cluster chunks (video stays black).
    if (state.initSegment && ws.readyState === WebSocket.OPEN) {
      ws.send(state.initSegment, { binary: true });
    }
    // Then send recent buffered chunks for a near-live start
    for (const chunk of state.chunkBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk, { binary: true });
      }
    }
  } else {
    ws.send(JSON.stringify({ type: "offline" }));
  }

  ws.on("close", () => {
    clearInterval(pingInterval);
    state.viewers.delete(ws);
    logger.info({ eventId, viewers: state.viewers.size }, "Viewer disconnected");
  });

  ws.on("error", (err) => {
    clearInterval(pingInterval);
    logger.error({ eventId, err: err.message }, "Viewer WebSocket error");
    state.viewers.delete(ws);
  });
}
