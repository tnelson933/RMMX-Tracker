import express, { type Express } from "express";
import { randomBytes } from "node:crypto";
import path from "node:path";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import ConnectPgSimple from "connect-pg-simple";
import { pool } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";
import { redactLogUrl } from "./lib/logRedaction";
import { WebhookHandlers, processConnectWebhook } from "./webhookHandlers";
import { accessControlMiddleware } from "./middleware/accessControl";
import { ingestObservationMiddleware } from "./middleware/ingestObservation";
import { noteServerError } from "./lib/serverErrorAlerts";
import { sharePageHandler } from "./routes/share-meta";

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
          url: redactLogUrl(req.url),
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

// Cross-origin browser access (with cookies) only for our own sites. Requests
// without an Origin header (rider app, desktop app and local server, RM Connect,
// curl) aren't browser cross-origin requests and are unaffected. A refused
// origin just gets no Access-Control-Allow-Origin, so its page can't read replies.
const allowedOrigins = buildAllowedOrigins();
const DEV_ORIGIN = /^http:\/\/(rmtracker\.localhost|localhost|127\.0\.0\.1)(:\d+)?$/;
export function isAllowedOrigin(origin: string): boolean {
  if (allowedOrigins.has(origin)) return true;
  return process.env.NODE_ENV !== "production" && DEV_ORIGIN.test(origin);
}
function buildAllowedOrigins(): Set<string> {
  const origins = new Set([
    "https://www.rmroost.com",
    "https://rmroost.com",
    "https://rm-tracker-production-9c47.up.railway.app",
  ]);
  const add = (value: string | undefined) => {
    if (!value) return;
    try { origins.add(new URL(value.includes("://") ? value : `https://${value}`).origin); } catch { /* not a URL */ }
  };
  add(process.env.APP_URL);
  add(process.env.RAILWAY_PUBLIC_DOMAIN);
  // Replit (current production) serves the site from its own domains too.
  for (const d of (process.env.REPLIT_DOMAINS ?? "").split(",")) add(d.trim());
  for (const o of (process.env.CORS_EXTRA_ORIGINS ?? "").split(",")) add(o.trim());
  return origins;
}

app.use(cors({
  origin: (origin, callback) => callback(null, !origin || isAllowedOrigin(origin)),
  credentials: true,
}));

// Standard security headers. No Content-Security-Policy: Stripe, video and
// fonts load from other origins and a strict policy would break them.
// Pages other sites (and the rider app's web build) show in a frame stay
// frameable: the event/series widgets, Watch Live, live leaderboards, the
// rider live/phone camera pages and the in-app PDF viewer.
const FRAMEABLE_PATH = /^\/(widget|watch|live|rider-live|phone-live|pdf-view)(\/|$)/i;
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (!FRAMEABLE_PATH.test(req.path)) {
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  }
  next();
});

// Artifact workflow readiness probes the service root. Keep it lightweight so
// the API remains routable to the website after restarts and publishes.
// When the API also serves the website (WEB_DIST_DIR), "/" is the home page and
// health checks use /api/healthz instead.
if (!process.env.WEB_DIST_DIR) {
  app.get("/", (_req, res) => {
    res.status(200).json({ status: "ok", service: "race-platform-api" });
  });
}

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

// Events from clubs' own Stripe accounts (direct charges), also raw.
app.post(
  "/api/stripe/connect-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) { res.status(400).json({ error: "Missing stripe-signature" }); return; }
    try {
      await processConnectWebhook(req.body as Buffer, Array.isArray(signature) ? signature[0] : signature);
      res.status(200).json({ received: true });
    } catch (err: any) {
      logger.error({ err: err?.message }, "Stripe Connect webhook error");
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
      // Not sent on cross-site POSTs, iframes or fetches (CSRF); still sent when
      // following a link to the site. The web app and its /api are one site.
      sameSite: "lax",
      // No global maxAge — login route sets it based on rememberMe choice
      // (30 days, or a browser-session cookie); the store expires idle sessions.
    },
  })
);

// Ingest observation runs first so it records every caller, including denied ones.
app.use("/api", ingestObservationMiddleware, accessControlMiddleware, router);

// Single-service hosting (Railway): when WEB_DIST_DIR points at the built website,
// the API also serves it, so the site and /api share one origin (what Caddy does in
// deploy/docker-compose.yml). Unset everywhere else, so nothing changes there.
const webDist = process.env.WEB_DIST_DIR;
if (webDist) {
  const indexHtml = path.join(webDist, "index.html");
  // HTML, service worker and manifest must revalidate so installed PWAs pick up new builds.
  const revalidate = new Set(["/index.html", "/sw.js", "/sw-auto-reload.js", "/manifest.webmanifest"]);
  app.use(express.static(webDist, {
    index: false,
    setHeaders(res, filePath) {
      const rel = "/" + path.relative(webDist, filePath).split(path.sep).join("/");
      if (revalidate.has(rel)) res.setHeader("Cache-Control", "no-cache");
      else if (rel.startsWith("/assets/")) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  }));
  // Pages people share get their own link preview (title, description, card picture).
  app.get(/^\/(results|register|watch|live|racer)\/\d{1,9}\/?$/, sharePageHandler(indexHtml));
  // The rider app's one link (QR codes, flyers): each phone to its own store, anything else to /rider-app.
  // Store ids match race-platform/src/lib/appStores.ts (rider-app eas.json / app.json).
  app.get("/get-app", (req, res) => {
    const ua = String(req.headers["user-agent"] ?? "");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "User-Agent");
    if (/android/i.test(ua)) return res.redirect(302, "https://play.google.com/store/apps/details?id=com.rockymountain.riderapp");
    if (/iphone|ipad|ipod/i.test(ua)) return res.redirect(302, "https://apps.apple.com/app/id6791718924");
    return res.redirect(302, "/rider-app");
  });
  // SPA fallback for client-side routes; unknown /api paths still 404 as JSON above.
  app.get(/^(?!\/api(\/|$)).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(indexHtml);
  });
}

// Unknown API paths answer in JSON, like every other API response.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Last-resort error handler. Express 5 routes thrown errors (including async
// ones) here; without it, the default handler returns an HTML page with SQL and
// file paths. Bad input that reaches Postgres is the caller's mistake, not a 500.
const CLIENT_ERROR_PG_CODES = new Set([
  "22P02", // invalid text representation (e.g. "abc" as an id)
  "22007", // invalid datetime format
  "22008", // datetime out of range
  "22003", // numeric value out of range
  "23503", // foreign key violation (referenced record doesn't exist)
  "23502", // not-null violation
]);
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  const pgCode = err?.code ?? err?.cause?.code;
  const clientError = typeof pgCode === "string" && CLIENT_ERROR_PG_CODES.has(pgCode);
  const status = clientError ? 400 : typeof err?.status === "number" && err.status < 500 ? err.status : 500;
  if (status >= 500) {
    (req as any).log?.error({ err }, "Unhandled API error");
    // Route pattern only (never the raw URL: reader tokens and ids live in paths), no bodies.
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : "unmatched";
    logger.error({ event: "server_error", route, method: req.method, status, requestId: (req as any).id }, "server_error");
    noteServerError(`${req.method} ${route}`);
  }
  res.status(status).json({
    error: status === 500
      ? "Something went wrong on our end. Please try again in a minute. If it keeps happening, ask the AI Assistant for help."
      : status === 413
        ? "That's too much to send at once. Use a smaller file or fewer items, then try again."
        // body-parser messages ("Unexpected token … in JSON") are technical, so they never pass through.
        : clientError || typeof err?.type === "string"
          ? "Some of the information sent wasn't valid. Check what you entered and try again."
          : err?.message ?? "That didn't work. Please try again.",
  });
});

export default app;
