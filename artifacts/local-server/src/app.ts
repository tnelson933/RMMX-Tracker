import express from "express";
import cors from "cors";
import session from "express-session";
import path from "path";
import router from "./routes/index";

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);

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

const staticDir = process.env.STATIC_FILES_DIR;
if (staticDir) {
  const resolvedStatic = path.resolve(staticDir);
  app.use(express.static(resolvedStatic));
  app.use((_req, res) => {
    res.sendFile(path.join(resolvedStatic, "index.html"));
  });
}

export default app;
