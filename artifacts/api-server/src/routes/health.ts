import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Railway's deploy healthcheck. Stays instant and database-free so a slow
// database can't fail a deploy; use /healthz/deep for an external monitor.
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

const DB_TIMEOUT_MS = 2_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const hits = new Map<string, { windowStart: number; count: number }>();

/** True when this caller may run another deep check (30 a minute per IP). */
export function allowDeepCheck(ip: string, nowMs = Date.now()): boolean {
  const entry = hits.get(ip);
  if (!entry || nowMs - entry.windowStart >= RATE_WINDOW_MS) {
    if (hits.size > 5_000) hits.clear();
    hits.set(ip, { windowStart: nowMs, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_MAX;
}

async function checkDatabase(): Promise<{ ok: boolean; ms: number }> {
  const started = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("timeout")), DB_TIMEOUT_MS); }),
    ]);
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    logger.warn({ event: "healthz_deep_db_failed", err: err instanceof Error ? err.message : String(err), ms: Date.now() - started }, "deep health: database check failed");
    return { ok: false, ms: Date.now() - started };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// For an external uptime monitor: ok/fail and timing per dependency, nothing else.
router.get("/healthz/deep", async (req, res) => {
  if (!allowDeepCheck(req.ip ?? "unknown")) {
    res.status(429).json({ status: "rate_limited" });
    return;
  }
  const database = await checkDatabase();
  const ok = database.ok;
  res.setHeader("Cache-Control", "no-store");
  res.status(ok ? 200 : 503).json({ ok, status: ok ? "ok" : "degraded", checks: { database } });
});

export default router;
