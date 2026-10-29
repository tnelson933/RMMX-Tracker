import { db } from "@workspace/db";
import { motosTable } from "@workspace/db/schema";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { flagTimeFor } from "./lapScoring";
import { logger } from "./logger";

/**
 * The race clock for timed motos runs on the server, not in an organizer's
 * browser: the flag drops at exactly start + limit + red-flag time even when
 * no organizer screen is open, a second tab can't move it, and a laptop clock
 * that runs fast can't end a race early.
 *
 * Each tick:
 *  - drops the flag (timeExpiredAt) on a timed race whose time is up; a timed
 *    practice simply ends;
 *  - closes a flagged race once everyone still racing has taken the checkered
 *    flag, or the grace period after the leader's finish has passed.
 */

const TICK_MS = 1000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function tickRaceClock(nowMs = Date.now()): Promise<void> {
  const { buildLeaderboard, publishTimingSnapshot, completeMotoNow, completeTimedMotoIfFinished, withMotoLock } = await import("../routes/timing");
  const motos = await db.select().from(motosTable).where(and(
    eq(motosTable.status, "in_progress"),
    isNotNull(motosTable.timeLimitMs),
    isNotNull(motosTable.startedAt),
  ));
  for (const moto of motos) {
    if (moto.type === "enduro_test") continue;
    try {
      if (!moto.timeExpiredAt) {
        const flag = flagTimeFor({
          startedAt: moto.startedAt,
          timeLimitMs: moto.timeLimitMs,
          totalPausedMs: moto.totalPausedMs ?? 0,
          pausedAt: moto.pausedAt,
        }, nowMs);
        if (!flag) continue;
        if (moto.type === "practice") {
          await withMotoLock(moto.id, () => completeMotoNow(moto.id));
          continue;
        }
        const [flagged] = await db.update(motosTable)
          .set({ timeExpiredAt: flag })
          .where(and(eq(motosTable.id, moto.id), eq(motosTable.status, "in_progress"), isNull(motosTable.timeExpiredAt)))
          .returning();
        if (flagged) {
          logger.info({ motoId: moto.id, flag: flag.toISOString() }, "Race clock: time is up");
          const snapshot = await buildLeaderboard(moto.id);
          if (snapshot) publishTimingSnapshot(snapshot);
        }
        continue;
      }
      await withMotoLock(moto.id, () => completeTimedMotoIfFinished(moto.id, nowMs));
    } catch (err) {
      logger.warn({ motoId: moto.id, err: err instanceof Error ? err.message : String(err) }, "Race clock tick failed");
    }
  }
}

export function startRaceClock(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    tickRaceClock().catch(() => {}).finally(() => { running = false; });
  }, TICK_MS);
  timer.unref?.();
}

export function stopRaceClock(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
