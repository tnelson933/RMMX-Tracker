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

export default app;
