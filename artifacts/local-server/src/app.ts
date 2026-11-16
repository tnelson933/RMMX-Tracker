import express from "express";
import cors from "cors";
import session from "express-session";
import path from "path";
import router from "./routes/index";
import { initDb } from "./db-init";
import { corsOptionsFor } from "./lib/request-origin";
import { CLOUD_URL } from "./lib/cloud-url";

initDb();

const app = express();

// Only reflect CORS for the app's own origin (the desktop renderer or a LAN
// device that opened this server) and loopback dev origins. Other web pages in
// a browser on the timing laptop get no CORS headers.
app.use(cors((req, callback) => callback(null, corsOptionsFor(req))));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionSecret =
  process.env.SESSION_SECRET ?? "local-race-server-dev-secret";

app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
    },
  }),
);

app.use("/api", router);

// Redirect shareable links to the cloud URL so they work when opened on the
// local machine (where VITE_CLOUD_URL may not be baked into the build).
const cloudUrl = CLOUD_URL;
if (cloudUrl) {
  app.get("/register/:id", (req, res) => {
    res.redirect(302, `${cloudUrl}/register/${req.params.id}`);
  });
  // Widget embed previews and standalone links must load from the cloud so
  // that (a) promoters get the correct embeddable URL and (b) the iframe
  // preview inside the organizer portal shows live cloud data.
  app.get("/widget/series/:seriesId", (req, res) => {
    res.redirect(302, `${cloudUrl}/widget/series/${req.params.seriesId}`);
  });
  app.get("/widget/:eventId", (req, res) => {
    res.redirect(302, `${cloudUrl}/widget/${req.params.eventId}`);
  });
}

const staticDir = process.env.STATIC_FILES_DIR;
if (staticDir) {
  const resolvedStatic = path.resolve(staticDir);
  app.use(express.static(resolvedStatic));
  app.use((_req, res) => {
    res.sendFile(path.join(resolvedStatic, "index.html"));
  });
}

// Last-resort error handler, with the website's wording. Without it Express
// answers a failed request (a file over the upload limit, a body that isn't
// valid JSON, an error thrown in a route) with an HTML page full of file paths,
// which the pages can't read: they would show "upload failed" or nothing at all.
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  const status = typeof err?.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status >= 500) console.error("[local-server] unhandled error:", err);
  res.status(status).json({
    error: status === 500
      ? "Something went wrong on our end. Please try again in a minute. If it keeps happening, ask the AI Assistant for help."
      : status === 413
        ? "That's too much to send at once. Use a smaller file or fewer items, then try again."
        : typeof err?.type === "string"
          ? "Some of the information sent wasn't valid. Check what you entered and try again."
          : err?.message ?? "That didn't work. Please try again.",
  });
});

export default app;
