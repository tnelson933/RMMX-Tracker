import { Router, type Response } from "express";
import { db } from "@workspace/db";
import {
  enduroTimeChecksTable,
  eventsTable,
  usersTable,
  ridersTable,
  enduroCheckpointArrivalsTable,
  registrationsTable,
  eventPublicationTable,
  type TimeCheckTarget,
  type EnduroPenaltyConfig,
} from "@workspace/db/schema";
import { eq, asc, and } from "drizzle-orm";
import { computeEnduroPenalty, recomputeEnduroPositionsForEvent } from "./enduro-scoring";

const router = Router();

/**
 * Authorizes the request against the event's owning club and returns true if the
 * caller may read/write this event's time checks. Sends the error response itself.
 */
async function authEvent(req: any, res: Response, eventId: number): Promise<boolean> {
  const userId = (req.session as any)?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  const [ev] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!ev) {
    res.status(404).json({ error: "Event not found" });
    return false;
  }
  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, userId));
  const staffClubId = res.locals.staffClubId;
  const restrictClub = typeof staffClubId === "number" ? staffClubId : user?.clubId ?? null;
  if (restrictClub !== null && restrictClub !== ev.clubId) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

function sanitizeTargets(raw: unknown): TimeCheckTarget[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => {
      const rc = typeof (t as any)?.raceClass === "string" ? (t as any).raceClass.trim() : "";
      const ms = Number((t as any)?.durationMs);
      const startTimeOfDay = typeof (t as any)?.startTimeOfDay === "string" && (t as any).startTimeOfDay.trim()
        ? (t as any).startTimeOfDay.trim()
        : null;
      return {
        raceClass: rc,
        durationMs: Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : 0,
        startTimeOfDay,
      };
    })
    .filter((t) => t.raceClass.length > 0);
}

function sanitizePenaltyConfig(raw: unknown): EnduroPenaltyConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as any;
  const earlySecPerMin = Number(r.earlySecPerMin);
  const lateSecPerMin = Number(r.lateSecPerMin);
  if (!Number.isFinite(earlySecPerMin) || !Number.isFinite(lateSecPerMin)) return null;
  const earlyDqMinutes = r.earlyDqMinutes != null && Number.isFinite(Number(r.earlyDqMinutes))
    ? Number(r.earlyDqMinutes)
    : null;
  const lateDqMinutes = r.lateDqMinutes != null && Number.isFinite(Number(r.lateDqMinutes))
    ? Number(r.lateDqMinutes)
    : null;
  return { earlySecPerMin, lateSecPerMin, earlyDqMinutes, lateDqMinutes };
}

// GET /events/:eventId/time-checks — list time checks ordered by checkNumber
router.get("/events/:eventId/time-checks", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "Invalid eventId" });
  if (!(await authEvent(req, res, eventId))) return;

  const rows = await db
    .select()
    .from(enduroTimeChecksTable)
    .where(eq(enduroTimeChecksTable.eventId, eventId))
    .orderBy(asc(enduroTimeChecksTable.checkNumber));

  return res.json(rows);
});

// PUT /events/:eventId/time-checks — replace ALL time checks for the event + save penalty config
router.put("/events/:eventId/time-checks", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "Invalid eventId" });
  if (!(await authEvent(req, res, eventId))) return;

  const body = req.body as { timeChecks?: unknown; penaltyConfig?: unknown };
  if (!Array.isArray(body?.timeChecks)) {
    return res.status(400).json({ error: "timeChecks array is required" });
  }

  const incoming = body.timeChecks.map((tc: any, i: number) => ({
    eventId,
    checkNumber: Number.isFinite(Number(tc?.checkNumber)) ? Number(tc.checkNumber) : i + 1,
    name: typeof tc?.name === "string" && tc.name.trim() ? tc.name.trim() : `Time Check ${i + 1}`,
    targets: sanitizeTargets(tc?.targets),
  }));

  const penaltyConfig = sanitizePenaltyConfig(body.penaltyConfig);

  // Full replace: wipe existing then re-insert so removed checks are dropped.
  const saved = await db.transaction(async (tx) => {
    await tx.delete(enduroTimeChecksTable).where(eq(enduroTimeChecksTable.eventId, eventId));
    if (incoming.length > 0) {
      await tx.insert(enduroTimeChecksTable).values(incoming);
    }
    // Save penalty config to the event (null clears it)
    await tx
      .update(eventsTable)
      .set({ enduroPenaltyConfig: penaltyConfig as any })
      .where(eq(eventsTable.id, eventId));
    if (incoming.length === 0) return [];
    return tx
      .select()
      .from(enduroTimeChecksTable)
      .where(eq(enduroTimeChecksTable.eventId, eventId))
      .orderBy(asc(enduroTimeChecksTable.checkNumber));
  });

  // Recompute penalty-adjusted standings now that time checks / penalty config may have changed.
  recomputeEnduroPositionsForEvent(eventId).catch(() => {});

  return res.json(saved);
});

// GET /events/:eventId/time-checks/:checkId/arrivals — list arrivals
router.get("/events/:eventId/time-checks/:checkId/arrivals", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const checkId = Number(req.params.checkId);
  if (!eventId || !checkId) return res.status(400).json({ error: "Invalid params" });
  if (!(await authEvent(req, res, eventId))) return;

  const arrivals = await db
    .select({
      id: enduroCheckpointArrivalsTable.id,
      eventId: enduroCheckpointArrivalsTable.eventId,
      timeCheckId: enduroCheckpointArrivalsTable.timeCheckId,
      riderId: enduroCheckpointArrivalsTable.riderId,
      arrivalTime: enduroCheckpointArrivalsTable.arrivalTime,
      recordedBy: enduroCheckpointArrivalsTable.recordedBy,
      createdAt: enduroCheckpointArrivalsTable.createdAt,
      riderName: ridersTable.firstName,
      riderLastName: ridersTable.lastName,
    })
    .from(enduroCheckpointArrivalsTable)
    .leftJoin(ridersTable, eq(enduroCheckpointArrivalsTable.riderId, ridersTable.id))
    .where(
      and(
        eq(enduroCheckpointArrivalsTable.eventId, eventId),
        eq(enduroCheckpointArrivalsTable.timeCheckId, checkId),
      ),
    );

  return res.json(
    arrivals.map((a) => ({
      ...a,
      riderName: a.riderName && a.riderLastName ? `${a.riderName} ${a.riderLastName}` : null,
    })),
  );
});

// POST /events/:eventId/time-checks/:checkId/arrivals — record/upsert manual arrival
router.post("/events/:eventId/time-checks/:checkId/arrivals", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const checkId = Number(req.params.checkId);
  if (!eventId || !checkId) return res.status(400).json({ error: "Invalid params" });
  if (!(await authEvent(req, res, eventId))) return;

  const { riderId, arrivalTime } = req.body as { riderId?: unknown; arrivalTime?: unknown };
  if (!riderId || !arrivalTime) return res.status(400).json({ error: "riderId and arrivalTime are required" });

  const parsedArrival = new Date(arrivalTime as string);
  if (isNaN(parsedArrival.getTime())) return res.status(400).json({ error: "Invalid arrivalTime" });

  const [check] = await db
    .select({ id: enduroTimeChecksTable.id })
    .from(enduroTimeChecksTable)
    .where(and(eq(enduroTimeChecksTable.id, checkId), eq(enduroTimeChecksTable.eventId, eventId)));
  if (!check) return res.status(404).json({ error: "Time check not found" });

  const [arrival] = await db
    .insert(enduroCheckpointArrivalsTable)
    .values({
      eventId,
      timeCheckId: checkId,
      riderId: Number(riderId),
      arrivalTime: parsedArrival,
      recordedBy: "manual",
    })
    .onConflictDoUpdate({
      target: [enduroCheckpointArrivalsTable.timeCheckId, enduroCheckpointArrivalsTable.riderId],
      set: { arrivalTime: parsedArrival, recordedBy: "manual" },
    })
    .returning();

  // Recompute enduro standings so positions immediately reflect the new arrival.
  recomputeEnduroPositionsForEvent(eventId).catch(() => {});

  return res.json(arrival);
});

// DELETE /events/:eventId/time-checks/:checkId/arrivals/:riderId
router.delete("/events/:eventId/time-checks/:checkId/arrivals/:riderId", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const checkId = Number(req.params.checkId);
  const riderId = Number(req.params.riderId);
  if (!eventId || !checkId || !riderId) return res.status(400).json({ error: "Invalid params" });
  if (!(await authEvent(req, res, eventId))) return;

  const deleted = await db
    .delete(enduroCheckpointArrivalsTable)
    .where(
      and(
        eq(enduroCheckpointArrivalsTable.eventId, eventId),
        eq(enduroCheckpointArrivalsTable.timeCheckId, checkId),
        eq(enduroCheckpointArrivalsTable.riderId, riderId),
      ),
    )
    .returning();

  if (deleted.length === 0) return res.status(404).json({ error: "Arrival not found" });

  // Recompute enduro standings so DQ/penalty status is removed immediately.
  recomputeEnduroPositionsForEvent(eventId).catch(() => {});

  return res.json({ ok: true });
});

// GET /events/:eventId/penalty-summary — compute per-rider penalty totals.
// Accessible to authenticated event organizers OR when event results are published.
router.get("/events/:eventId/penalty-summary", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "Invalid eventId" });

  // Allow organizers; fall back to publication check for public access.
  const userId = (req.session as any)?.userId;
  if (userId) {
    // Authenticated — verify the user belongs to the owning club.
    const isOrg = await authEvent(req, res, eventId);
    if (!isOrg) return; // authEvent already sent the error response
  } else {
    // Unauthenticated — require results that are actively published (published=true).
    const [pub] = await db
      .select({ published: eventPublicationTable.published })
      .from(eventPublicationTable)
      .where(eq(eventPublicationTable.eventId, eventId));
    if (!pub?.published) return res.status(403).json({ error: "Results not published" });
  }

  const [event] = await db
    .select({ enduroPenaltyConfig: eventsTable.enduroPenaltyConfig })
    .from(eventsTable)
    .where(eq(eventsTable.id, eventId));

  const config = event?.enduroPenaltyConfig as EnduroPenaltyConfig | null | undefined;
  if (!config) return res.json([]);

  // Load time checks
  const checks = await db
    .select()
    .from(enduroTimeChecksTable)
    .where(eq(enduroTimeChecksTable.eventId, eventId))
    .orderBy(asc(enduroTimeChecksTable.checkNumber));

  if (checks.length === 0) return res.json([]);

  // Load all arrivals for this event with rider info and class
  const arrivals = await db
    .select({
      riderId: enduroCheckpointArrivalsTable.riderId,
      timeCheckId: enduroCheckpointArrivalsTable.timeCheckId,
      arrivalTime: enduroCheckpointArrivalsTable.arrivalTime,
      firstName: ridersTable.firstName,
      lastName: ridersTable.lastName,
      raceClass: registrationsTable.raceClass,
    })
    .from(enduroCheckpointArrivalsTable)
    .leftJoin(ridersTable, eq(enduroCheckpointArrivalsTable.riderId, ridersTable.id))
    .leftJoin(
      registrationsTable,
      and(
        eq(registrationsTable.riderId, enduroCheckpointArrivalsTable.riderId),
        eq(registrationsTable.eventId, eventId),
      ),
    )
    .where(eq(enduroCheckpointArrivalsTable.eventId, eventId));

  // Group arrivals by riderId
  const arrivalsByRider = new Map<number, typeof arrivals>();
  for (const a of arrivals) {
    if (!arrivalsByRider.has(a.riderId)) arrivalsByRider.set(a.riderId, []);
    arrivalsByRider.get(a.riderId)!.push(a);
  }

  const summary = [];

  for (const [riderId, riderArrivals] of arrivalsByRider) {
    const sample = riderArrivals[0];
    const riderName = `${sample.firstName ?? ""} ${sample.lastName ?? ""}`.trim();
    const raceClass = sample.raceClass ?? null;

    let totalPenaltySeconds = 0;
    let disqualified = false;
    const checkDetails = [];

    for (const check of checks) {
      // Find the target for this rider's class
      const targets = Array.isArray(check.targets) ? (check.targets as TimeCheckTarget[]) : [];
      const target = targets.find((t) => t.raceClass === raceClass);
      if (!target || !target.startTimeOfDay) continue;

      const arrival = riderArrivals.find((a) => a.timeCheckId === check.id);

      if (!arrival) {
        checkDetails.push({
          checkId: check.id,
          checkName: check.name,
          diffMinutes: 0,
          penaltySeconds: 0,
          disqualified: false,
          hasArrival: false,
        });
        continue;
      }

      const result = computeEnduroPenalty(arrival.arrivalTime, target, config);
      totalPenaltySeconds += result.penaltySeconds;
      if (result.disqualified) disqualified = true;

      checkDetails.push({
        checkId: check.id,
        checkName: check.name,
        diffMinutes: result.diffMinutes,
        penaltySeconds: result.penaltySeconds,
        disqualified: result.disqualified,
        hasArrival: true,
      });
    }

    summary.push({ riderId, riderName, raceClass, totalPenaltySeconds, disqualified, checkDetails });
  }

  // Sort: non-DQ by total penalty ascending, DQ riders at bottom
  summary.sort((a, b) => {
    if (a.disqualified !== b.disqualified) return a.disqualified ? 1 : -1;
    return a.totalPenaltySeconds - b.totalPenaltySeconds;
  });

  return res.json(summary);
});

export default router;
