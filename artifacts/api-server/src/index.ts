import http from "http";
import { startRentalSweeper } from "./lib/rentalTransponders";
import app from "./app";
import { logger } from "./lib/logger";
import { attachVideoWebSocket } from "./lib/videoRelay";
import { attachConnectorWebSocket } from "./lib/connectorRelay";
import { normalizeEventStates } from "./normalizeStateMigration";
import { startEventStatusSweeper } from "./lib/eventStatus";
import { startQuickCheckinNotifier } from "./lib/quickCheckinNotifier";
import { startRaceClock } from "./lib/raceClock";
import { startPaymentSweeper } from "./lib/paymentSweeper";

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
attachConnectorWebSocket(httpServer);

httpServer.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  normalizeEventStates().catch(err => logger.error({ err }, "normalizeEventStates failed"));
  // Close registration and advance event statuses on schedule, not only when a page is opened.
  startEventStatusSweeper();
  // Race-morning push for events with Quick Check-In (7 AM–6 PM at each track).
  startQuickCheckinNotifier();
  // Timed races: drop the flag and close finished races on the server clock.
  startRaceClock();
  // Card payments the rider's browser and Stripe's webhook both missed.
  startPaymentSweeper();
  startRentalSweeper();
});
