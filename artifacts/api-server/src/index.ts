import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { attachVideoWebSocket } from "./lib/videoRelay";
import { ensureSuperAdmin } from "./ensureSuperAdmin";
import { normalizeEventStates } from "./normalizeStateMigration";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const httpServer = http.createServer(app);
attachVideoWebSocket(httpServer);

httpServer.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  ensureSuperAdmin();
  normalizeEventStates().catch(err => logger.error({ err }, "normalizeEventStates failed"));
});
