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
  motosTable,
  eventReaderAssignmentsTable,
  type TimeCheckTarget,
  type EnduroPenaltyConfig,
} from "@workspace/db/schema";
import { eq, asc, and, inArray } from "drizzle-orm";
import { computeEnduroPenalty, recomputeEnduroPositionsForEvent } from "./enduro-scoring";
import { callerOwnsClub } from "../middleware/accessControl";
import { eventTimeZone } from "@workspace/api-zod";

const router = Router();

/**
 * Authorizes the request against the event's owning club and returns true if the
 * caller may read/write this event's time checks. Sends the error response itself.
 */
async function authEvent(req: any, res: Response, eventId: number): Promise<boolean> {
  const userId = (req.session as any)?.userId;
  if (!userId) {
    res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
    return false;
  }
  const [ev] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!ev) {
    res.status(404).json({ error: "This event couldn't be found. It may have been deleted. Go back to Events and open it again." });
    return false;
  }
  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, userId));
  const staffClubId = res.locals.staffClubId;
  const restrictClub = typeof staffClubId === "number" ? staffClubId : user?.clubId ?? null;
  if (restrictClub !== null && restrictClub !== ev.clubId) {
    res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });
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
  const timezone = typeof r.timezone === "string" && r.timezone.trim()
    ? r.timezone.trim()
    : null;
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    } catch {
      return null;
    }
  }
  return { earlySecPerMin, lateSecPerMin, earlyDqMinutes, lateDqMinutes, timezone };
}

// GET /events/:eventId/time-checks — list time checks ordered by checkNumber
router.get("/events/:eventId/time-checks", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });
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
  if (!eventId) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });
  if (!(await authEvent(req, res, eventId))) return;

  const body = req.body as { timeChecks?: unknown; penaltyConfig?: unknown };
  if (!Array.isArray(body?.timeChecks)) {
    return res.status(400).json({ error: "Add at least one time check." });
  }

  const incoming = body.timeChecks.map((tc: any, i: number) => ({
    eventId,
    checkNumber: Number.isFinite(Number(tc?.checkNumber)) ? Number(tc.checkNumber) : i + 1,
    name: typeof tc?.name === "string" && tc.name.trim() ? tc.name.trim() : `Time Check ${i + 1}`,
    targets: sanitizeTargets(tc?.targets),
  }));

  const penaltyConfig = sanitizePenaltyConfig(body.penaltyConfig);
  // Class start times are wall-clock times at the track: without a chosen
  // timezone they'd be read in the server's zone (UTC when hosted).
  if (penaltyConfig && !penaltyConfig.timezone) {
    const [ev] = await db.select({ state: eventsTable.state, trackLat: eventsTable.trackLat, trackLng: eventsTable.trackLng })
      .from(eventsTable).where(eq(eventsTable.id, eventId));
    if (ev) penaltyConfig.timezone = eventTimeZone(ev);
  }

  // Update checks in place (matched by check number) so their ids stay the
  // same: recorded arrivals and placed time-check readers keep pointing at
  // them. A check that has arrivals can't be removed.
  const existing = await db.select({ id: enduroTimeChecksTable.id, checkNumber: enduroTimeChecksTable.checkNumber })
    .from(enduroTimeChecksTable).where(eq(enduroTimeChecksTable.eventId, eventId));
  const keep = new Set(incoming.map(tc => tc.checkNumber));
  const removing = existing.filter(e => !keep.has(e.checkNumber));
  if (removing.length > 0) {
    const [withArrivals] = await db.select({ timeCheckId: enduroCheckpointArrivalsTable.timeCheckId })
      .from(enduroCheckpointArrivalsTable)
      .where(inArray(enduroCheckpointArrivalsTable.timeCheckId, removing.map(r => r.id)))
      .limit(1);
    if (withArrivals) {
      const check = removing.find(r => r.id === withArrivals.timeCheckId);
      return res.status(409).json({
        error: `Time check ${check?.checkNumber ?? ""} already has rider arrivals, so it can't be removed. Keep it, or clear its arrivals first.`,
      });
    }
  }

  const saved = await db.transaction(async (tx) => {
    for (const tc of incoming) {
      const match = existing.find(e => e.checkNumber === tc.checkNumber);
      if (match) {
        await tx.update(enduroTimeChecksTable)
          .set({ name: tc.name, targets: tc.targets })
          .where(eq(enduroTimeChecksTable.id, match.id));
      } else {
        await tx.insert(enduroTimeChecksTable).values(tc);
      }
    }
    if (removing.length > 0) {
      const ids = removing.map(r => r.id);
      // Readers placed on a removed check are taken off it.
      await tx.delete(eventReaderAssignmentsTable)
        .where(and(eq(eventReaderAssignmentsTable.eventId, eventId), inArray(eventReaderAssignmentsTable.timeCheckId, ids)));
      await tx.delete(enduroTimeChecksTable).where(inArray(enduroTimeChecksTable.id, ids));
    }
    // Save penalty config to the event (null clears it)
    await tx
      .update(eventsTable)
      .set({ enduroPenaltyConfig: penaltyConfig as any })
      .where(eq(eventsTable.id, eventId));
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
  if (!eventId || !checkId) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });
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
  if (!eventId || !checkId) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });
  if (!(await authEvent(req, res, eventId))) return;

  const { riderId, arrivalTime } = req.body as { riderId?: unknown; arrivalTime?: unknown };
  if (!riderId || !arrivalTime) return res.status(400).json({ error: "Pick a rider and enter an arrival time." });

  const parsedArrival = new Date(arrivalTime as string);
  if (isNaN(parsedArrival.getTime())) return res.status(400).json({ error: "Enter a valid arrival time." });

  const [check] = await db
    .select({ id: enduroTimeChecksTable.id })
    .from(enduroTimeChecksTable)
    .where(and(eq(enduroTimeChecksTable.id, checkId), eq(enduroTimeChecksTable.eventId, eventId)));
  if (!check) return res.status(404).json({ error: "This time check couldn't be found. It may have been deleted. Refresh the page and try again." });

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
  if (!eventId || !checkId || !riderId) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });
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

  if (deleted.length === 0) return res.status(404).json({ error: "This arrival couldn't be found. It may have been deleted. Refresh the page and try again." });

  // Recompute enduro standings so DQ/penalty status is removed immediately.
  recomputeEnduroPositionsForEvent(eventId).catch(() => {});

  return res.json({ ok: true });
});

// GET /events/:eventId/penalty-summary — compute per-rider penalty totals.
// Accessible to authenticated event organizers OR when event results are published.
router.get("/events/:eventId/penalty-summary", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });

  // The owning club (or a super admin) always sees it; everyone else — anonymous,
  // riders, other clubs' organizers/staff — only once results are published.
  const [owner] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!owner) return res.status(404).json({ error: "This event couldn't be found. It may have been deleted. Go back to Events and open it again." });
  if (!callerOwnsClub(res, owner.clubId)) {
    // Public once a test has finished (marked unofficial until finalized).
    const [finished] = await db.select({ id: motosTable.id }).from(motosTable)
      .where(and(eq(motosTable.eventId, eventId), eq(motosTable.status, "completed"))).limit(1);
    if (!finished) return res.status(403).json({ error: "There are no results for this yet. Check back after the race." });
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
