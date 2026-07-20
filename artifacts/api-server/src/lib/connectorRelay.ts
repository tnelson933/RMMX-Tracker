/**
 * RM Connect relay — WebSocket command channel between the cloud and the
 * lightweight "RM Connect" tray app running at the track.
 *
 * The connector app opens:  wss://<cloud>/api/connector/ws?token=<readerToken>
 * The reader token (same UUID used by the HTTP ingest endpoint) authenticates
 * the connection and resolves the club.
 *
 * Message flow:
 *   cloud → connector:  { type: "start_moto",  motoId, eventId, motoName, motoType }
 *                       { type: "stop_moto",   motoId, eventId }
 *                       { type: "ping" }
 *   connector → cloud:  { type: "status", hardware, connected, detail? }
 *                       { type: "pong" }
 *
 * Tag crossings do NOT travel over this socket — the connector posts them to
 * the existing HTTP ingest endpoint (POST /api/timing/readers/:token/crossing)
 * so all routing/parity logic stays in one place.
 */
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { db } from "@workspace/db";
import { readersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export interface ConnectorStatus {
  readerId: number;
  readerName: string;
  readerType: string;
  connectedAt: string;
  /** Last hardware status reported by the connector app */
  hardware: {
    kind: "impinj" | "mylaps" | null;
    connected: boolean;
    detail: string | null;
    lastReadAt: string | null;
    readCount: number;
  };
}

interface ConnectorConn {
  ws: WebSocket;
  clubId: number;
  status: ConnectorStatus;
  alive: boolean;
}

// clubId → set of live connector connections
const connectors = new Map<number, Set<ConnectorConn>>();

function addConn(conn: ConnectorConn): void {
  let set = connectors.get(conn.clubId);
  if (!set) {
    set = new Set();
    connectors.set(conn.clubId, set);
  }
  set.add(conn);
}

function removeConn(conn: ConnectorConn): void {
  const set = connectors.get(conn.clubId);
  if (!set) return;
  set.delete(conn);
  if (set.size === 0) connectors.delete(conn.clubId);
}

/**
 * Broadcast a command to every connector connected for a club.
 * Returns the number of sockets the message was sent to.
 */
export function sendConnectorCommand(
  clubId: number,
  command: Record<string, unknown>,
): number {
  const set = connectors.get(clubId);
  if (!set || set.size === 0) return 0;

  const payload = JSON.stringify(command);
  let sent = 0;
  for (const conn of set) {
    if (conn.ws.readyState === WebSocket.OPEN) {
      try {
        conn.ws.send(payload);
        sent++;
      } catch {
        // Socket died mid-send — cleanup happens on 'close'
      }
    }
  }
  return sent;
}

/** Live connector connections for a club (for the organizer UI). */
export function getConnectorStatus(clubId: number): ConnectorStatus[] {
  const set = connectors.get(clubId);
  if (!set) return [];
  return [...set].map((c) => c.status);
}

export function attachConnectorWebSocket(httpServer: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = req.url ?? "";
    if (!url.startsWith("/api/connector/ws")) return;

    const token = new URL(url, "http://localhost").searchParams.get("token");
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // Resolve the reader token → club before accepting the upgrade
    db.select()
      .from(readersTable)
      .where(eq(readersTable.token, token))
      .then(([reader]) => {
        if (!reader) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket as any, head, (ws) => {
          const conn: ConnectorConn = {
            ws,
            clubId: reader.clubId,
            alive: true,
            status: {
              readerId: reader.id,
              readerName: reader.name,
              readerType: reader.type,
              connectedAt: new Date().toISOString(),
              hardware: {
                kind: null,
                connected: false,
                detail: null,
                lastReadAt: null,
                readCount: 0,
              },
            },
          };

          addConn(conn);
          logger.info(
            { clubId: reader.clubId, readerId: reader.id },
            "Connector app connected",
          );

          // Mark reader as seen
          db.update(readersTable)
            .set({ lastSeenAt: new Date() })
            .where(eq(readersTable.id, reader.id))
            .catch(() => {});

          ws.on("message", (data) => {
            let msg: any;
            try {
              msg = JSON.parse(data.toString());
            } catch {
              return;
            }
            if (msg?.type === "status") {
              conn.status.hardware = {
                kind: msg.hardware === "mylaps" ? "mylaps" : msg.hardware === "impinj" ? "impinj" : null,
                connected: !!msg.connected,
                detail: typeof msg.detail === "string" ? msg.detail.slice(0, 200) : null,
                lastReadAt: typeof msg.lastReadAt === "string" ? msg.lastReadAt.slice(0, 40) : conn.status.hardware.lastReadAt,
                readCount: Number.isFinite(msg.readCount) && Number(msg.readCount) >= 0 ? Math.floor(Number(msg.readCount)) : conn.status.hardware.readCount,
              };
            } else if (msg?.type === "pong") {
              conn.alive = true;
            }
          });

          ws.on("close", () => {
            removeConn(conn);
            logger.info(
              { clubId: reader.clubId, readerId: reader.id },
              "Connector app disconnected",
            );
          });

          ws.on("error", () => {
            removeConn(conn);
          });
        });
      })
      .catch((err) => {
        logger.error({ err }, "Connector WS auth lookup failed");
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
      });
  });

  // Liveness sweep — drop dead sockets so status stays accurate
  setInterval(() => {
    for (const set of connectors.values()) {
      for (const conn of set) {
        if (conn.ws.readyState !== WebSocket.OPEN) {
          removeConn(conn);
          continue;
        }
        if (!conn.alive) {
          conn.ws.terminate();
          removeConn(conn);
          continue;
        }
        conn.alive = false;
        try {
          conn.ws.send(JSON.stringify({ type: "ping" }));
        } catch {
          // handled by close event
        }
      }
    }
  }, 30_000).unref();

  logger.info("Connector WebSocket relay attached");
}
