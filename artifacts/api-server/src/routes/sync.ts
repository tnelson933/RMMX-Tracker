import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  usersTable,
  eventsTable,
  checkinsTable,
  rfidAssignmentsTable,
  registrationsTable,
  ridersTable,
} from "@workspace/db";

const router = Router();

// ─── Types ────────────────────────────────────────────────────────────────────

interface SyncCheckin {
  id: number;
  eventId: number;
  riderId: number;
  raceClass: string;
  bibNumber?: string | null;
  checkedIn: boolean | number;
  checkedInAt?: string | null;
  rfidNumber?: string | null;
  rfidLinked: boolean | number;
}

interface SyncRfidAssignment {
  id: number;
  riderId: number;
  eventId?: number | null;
  rfidNumber: string;
  assignedAt?: string | null;
}

interface SyncRegistration {
  id: number;
  eventId: number;
  riderId: number;
  raceClass: string;
  status?: string | null;
  bibNumber?: string | null;
}

interface SyncRider {
  id: number;
  rfidNumber?: string | null;
}

interface SyncWatermarks {
  checkins?: number;
  rfid_assignments?: number;
  registrations?: number;
  riders?: number;
  [key: string]: number | undefined;
}

// ─── POST /clubs/:clubId/sync ─────────────────────────────────────────────────

router.post("/clubs/:clubId/sync", async (req, res) => {
  const clubId = Number(req.params.clubId);
  if (isNaN(clubId)) {
    return res.status(400).json({ error: "Invalid clubId" });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req.session as any).userId as number | undefined;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const [user] = await db
    .select({ id: usersTable.id, clubId: usersTable.clubId })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!user || user.clubId !== clubId) {
    return res.status(403).json({ error: "Access denied" });
  }

  const {
    watermarks = {} as SyncWatermarks,
    checkins   = [] as SyncCheckin[],
    rfidAssignments = [] as SyncRfidAssignment[],
    registrations   = [] as SyncRegistration[],
    riders          = [] as SyncRider[],
  } = req.body as {
    watermarks?: SyncWatermarks;
    checkins?: SyncCheckin[];
    rfidAssignments?: SyncRfidAssignment[];
    registrations?: SyncRegistration[];
    riders?: SyncRider[];
  };

  const results = {
    checkinsUpdated:       0,
    checkinsInserted:      0,
    rfidUpserted:          0,
    registrationsUpdated:  0,
    registrationsInserted: 0,
    ridersUpdated:         0,
    skipped:               0,
  };

  // Verify all event IDs in the payload belong to this club
  const allEventIds = [
    ...new Set([
      ...checkins.map((c) => c.eventId),
      ...rfidAssignments.filter((r) => r.eventId).map((r) => r.eventId as number),
      ...registrations.map((r) => r.eventId),
    ].filter(Boolean)),
  ];

  if (allEventIds.length > 0) {
    const ownedEvents = await db
      .select({ id: eventsTable.id })
      .from(eventsTable)
      .where(eq(eventsTable.clubId, clubId));
    const ownedSet = new Set(ownedEvents.map((e) => e.id));
    const unauthorized = allEventIds.filter((id) => !ownedSet.has(id));
    if (unauthorized.length > 0) {
      return res.status(403).json({
        error: `Event IDs not owned by this club: ${unauthorized.join(", ")}`,
      });
    }
  }

  const checkinWatermark      = watermarks["checkins"]          ?? 0;
  const rfidWatermark         = watermarks["rfid_assignments"]   ?? 0;
  const registrationWatermark = watermarks["registrations"]      ?? 0;
  const riderWatermark        = watermarks["riders"]             ?? 0;

  await db.transaction(async (tx) => {

    // ── Checkins ──────────────────────────────────────────────────────────────
    for (const c of checkins) {
      const checkedIn  = Boolean(c.checkedIn);
      const rfidLinked = Boolean(c.rfidLinked);
      const checkedInAt = c.checkedInAt ? new Date(c.checkedInAt) : null;

      if (c.id <= checkinWatermark) {
        // Cloud-originated row — UPDATE in place
        await tx
          .update(checkinsTable)
          .set({
            checkedIn,
            checkedInAt,
            rfidNumber: c.rfidNumber ?? null,
            rfidLinked,
            bibNumber:  c.bibNumber  ?? null,
          })
          .where(eq(checkinsTable.id, c.id));
        results.checkinsUpdated++;
      } else {
        // Locally-created row — find by natural key, then INSERT or UPDATE
        const [existing] = await tx
          .select({ id: checkinsTable.id })
          .from(checkinsTable)
          .where(
            and(
              eq(checkinsTable.eventId, c.eventId),
              eq(checkinsTable.riderId, c.riderId),
            ),
          );

        if (existing) {
          await tx
            .update(checkinsTable)
            .set({
              checkedIn,
              checkedInAt,
              rfidNumber: c.rfidNumber ?? null,
              rfidLinked,
              bibNumber:  c.bibNumber  ?? null,
            })
            .where(eq(checkinsTable.id, existing.id));
          results.checkinsUpdated++;
        } else {
          await tx.insert(checkinsTable).values({
            eventId:    c.eventId,
            riderId:    c.riderId,
            raceClass:  c.raceClass,
            bibNumber:  c.bibNumber  ?? null,
            checkedIn,
            checkedInAt,
            rfidNumber: c.rfidNumber ?? null,
            rfidLinked,
          });
          results.checkinsInserted++;
        }
      }
    }

    // ── RFID Assignments ──────────────────────────────────────────────────────
    // Always upsert by natural key (rider_id, event_id) — avoids ID conflicts
    for (const r of rfidAssignments) {
      if (r.id <= rfidWatermark) {
        // Cloud-originated — UPDATE rfid_number by id
        await tx
          .update(rfidAssignmentsTable)
          .set({ rfidNumber: r.rfidNumber })
          .where(eq(rfidAssignmentsTable.id, r.id));
        results.rfidUpserted++;
      } else {
        // Locally-created — find by (rider_id, event_id), INSERT or UPDATE
        const conditions = r.eventId != null
          ? and(
              eq(rfidAssignmentsTable.riderId, r.riderId),
              eq(rfidAssignmentsTable.eventId, r.eventId),
            )
          : eq(rfidAssignmentsTable.riderId, r.riderId);

        const [existing] = await tx
          .select({ id: rfidAssignmentsTable.id })
          .from(rfidAssignmentsTable)
          .where(conditions!);

        if (existing) {
          await tx
            .update(rfidAssignmentsTable)
            .set({ rfidNumber: r.rfidNumber })
            .where(eq(rfidAssignmentsTable.id, existing.id));
        } else {
          await tx.insert(rfidAssignmentsTable).values({
            riderId:    r.riderId,
            rfidNumber: r.rfidNumber,
            eventId:    r.eventId ?? null,
            assignedAt: r.assignedAt ? new Date(r.assignedAt) : new Date(),
          });
        }
        results.rfidUpserted++;
      }
    }

    // ── Registrations ─────────────────────────────────────────────────────────
    for (const r of registrations) {
      if (r.id <= registrationWatermark) {
        // Cloud-originated — UPDATE only race-day fields (bib + status)
        await tx
          .update(registrationsTable)
          .set({
            bibNumber: r.bibNumber ?? null,
            status:    r.status    ?? "confirmed",
          })
          .where(eq(registrationsTable.id, r.id));
        results.registrationsUpdated++;
      } else {
        // Locally-created walk-in — INSERT if not already present by (event, rider, class)
        const [existing] = await tx
          .select({ id: registrationsTable.id })
          .from(registrationsTable)
          .where(
            and(
              eq(registrationsTable.eventId,   r.eventId),
              eq(registrationsTable.riderId,   r.riderId),
              eq(registrationsTable.raceClass, r.raceClass),
            ),
          );

        if (existing) {
          await tx
            .update(registrationsTable)
            .set({
              bibNumber: r.bibNumber ?? null,
              status:    r.status    ?? "confirmed",
            })
            .where(eq(registrationsTable.id, existing.id));
          results.registrationsUpdated++;
        } else {
          await tx.insert(registrationsTable).values({
            eventId:   r.eventId,
            riderId:   r.riderId,
            raceClass: r.raceClass,
            bibNumber: r.bibNumber ?? null,
            status:    r.status    ?? "confirmed",
          });
          results.registrationsInserted++;
        }
      }
    }

    // ── Riders ────────────────────────────────────────────────────────────────
    // Only update rfid_number for cloud-originated riders (no local rider creation)
    for (const r of riders) {
      if (r.id > riderWatermark) {
        results.skipped++;
        continue;
      }
      if (r.rfidNumber !== undefined) {
        await tx
          .update(ridersTable)
          .set({ rfidNumber: r.rfidNumber ?? null })
          .where(eq(ridersTable.id, r.id));
        results.ridersUpdated++;
      } else {
        results.skipped++;
      }
    }
  });

  const syncedAt = new Date().toISOString();

  req.log.info({ clubId, results }, "local-mode sync complete");

  return res.json({ ok: true, syncedAt, results });
});

export default router;
