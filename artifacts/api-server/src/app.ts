import express, { type Express } from "express";
import { randomBytes } from "node:crypto";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import ConnectPgSimple from "connect-pg-simple";
import { pool } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";
import { WebhookHandlers } from "./webhookHandlers";
import { accessControlMiddleware } from "./middleware/accessControl";

const app: Express = express();
// The Replit/deployment proxy terminates TLS before requests reach Express.
// Trust it so secure organizer sessions can be created and forwarded correctly.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(cors({
  origin: true,
  credentials: true,
}));

// Artifact workflow readiness probes the service root. Keep it lightweight so
// the API remains routable to the website after restarts and publishes.
app.get("/", (_req, res) => {
  res.status(200).json({ status: "ok", service: "race-platform-api" });
});

// Stripe webhook — must be registered BEFORE express.json() to receive raw Buffer
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) { res.status(400).json({ error: "Missing stripe-signature" }); return; }
    const sig = Array.isArray(signature) ? signature[0] : signature;
    try {
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      res.status(200).json({ received: true });
    } catch (err: any) {
      logger.error({ err: err?.message }, "Stripe webhook error");
      res.status(400).json({ error: "Webhook processing error" });
    }
  }
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Never fall back to a known secret: anyone could forge session cookies with it.
// Without SESSION_SECRET we use a random per-process secret, so sessions stop
// surviving restarts (everyone signs in again) but cannot be forged.
let sessionSecret = process.env.SESSION_SECRET ?? "";
if (!sessionSecret) {
  logger.error("SESSION_SECRET is not set; using a random secret. Sessions will not survive restarts.");
  sessionSecret = randomBytes(48).toString("hex");
} else if (sessionSecret.length < 32) {
  logger.warn("SESSION_SECRET is shorter than 32 characters; use a long random value.");
}
const PgSession = ConnectPgSimple(session);

app.use(
  session({
    store: new PgSession({
      pool: pool as any,
      tableName: "session",
      createTableIfMissing: true,
      errorLog: (...args) => logger.error({ args }, "Session store error"),
    }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      // COOKIE_SECURE=false allows a plain-HTTP test server (no domain/TLS yet).
      secure: process.env.COOKIE_SECURE
        ? process.env.COOKIE_SECURE === "true"
        : process.env.NODE_ENV === "production",
      httpOnly: true,
      // No global maxAge — login route sets it based on rememberMe choice
    },
  })
);

app.use("/api", accessControlMiddleware, router);

export default app;
