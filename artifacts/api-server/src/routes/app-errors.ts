import { Router, type Request } from "express";
import { logger } from "../lib/logger";
import { parseAppErrorReport, ReportRateLimiter, UpdateErrorCounter } from "../lib/appErrorReport";

const router = Router();

// 20 reports a minute per address. The app itself sends at most 10 per session.
const limiter = new ReportRateLimiter(20, 60_000);
const perUpdate = new UpdateErrorCounter();

/** Rate-limit key only (never logged): proxy address plus Cloudflare's visitor address. */
function clientKey(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  return `${req.ip ?? "unknown"}|${typeof cf === "string" ? cf.trim() : ""}`;
}

// Rider app JS error reports (rider-app lib/errorReport.ts). Public: errors can
// happen before sign-in. One structured log line per report, no database.
router.post("/app-errors", (req, res) => {
  if (!limiter.allow(clientKey(req))) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ error: "Too many reports" });
    return;
  }
  const declared = Number(req.headers["content-length"]);
  const parsed = parseAppErrorReport(req.body, Number.isFinite(declared) ? declared : undefined);
  if (!parsed.ok) {
    res.status(parsed.status).json({ error: parsed.error });
    return;
  }
  const r = parsed.report;
  const updateErrorCount = perUpdate.increment(r.updateId);
  // `name` is pino's logger-name key, so the error name is logged as errorName.
  const { name: errorName, ...rest } = r;
  const fields = { event: "rider_app_error", requestId: (req as any).id, updateErrorCount, errorName, ...rest };
  if (r.fatal) logger.error(fields, "rider_app_error");
  else logger.warn(fields, "rider_app_error");
  res.status(204).end();
});

export default router;
