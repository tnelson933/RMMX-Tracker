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
  offlineRiderIdentitiesTable,
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
  localRiderId?: number;
  cloudRiderId?: number;
  clientIdentity?: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  dateOfBirth?: string | null;
  emergencyContact?: string | null;
  emergencyPhone?: string | null;
  rfidNumber?: string | null;
  streetAddress?: string | null;
  city?: string | null;
  homeState?: string | null;
  zip?: string | null;
  bibNumber?: string | null;
  amaNumber?: string | null;
  bikeManufacturer?: string | null;
  bikeModel?: string | null;
  bikeYear?: string | null;
  sponsors?: string | null;
  mylapsTransponderId?: string | null;
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

  // Accept either a session cookie (browser) or a Bearer sync token (local server).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessionUserId = (req.session as any).userId as number | undefined;
  let user: { id: number; clubId: number | null } | undefined;

  if (sessionUserId) {
    [user] = await db
      .select({ id: usersTable.id, clubId: usersTable.clubId })
      .from(usersTable)
      .where(eq(usersTable.id, sessionUserId));
  } else {
    const authHeader = (req.headers.authorization ?? "") as string;
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    if (!token) return res.status(401).json({ error: "Not authenticated" });
    [user] = await db
      .select({ id: usersTable.id, clubId: usersTable.clubId })
      .from(usersTable)
      .where(eq(usersTable.offlineSyncToken, token));
    if (!user) return res.status(401).json({ error: "Invalid sync token" });
  }

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
  const riderIdMap: Record<string, number> = {};

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

  await db.transaction(async (tx) => {
    // ── Riders first: establish local-ID -> cloud-ID translation before any
    // dependent registration/check-in is interpreted. Never resolve by email:
    // a selected profile is represented by its stable clientIdentity.
    const resolvedRiderIds = new Map<number, number>();
    const riderFields = [
      "firstName", "lastName", "email", "phone", "dateOfBirth", "emergencyContact",
      "emergencyPhone", "rfidNumber", "streetAddress", "city", "homeState", "zip",
      "bibNumber", "amaNumber", "bikeManufacturer", "bikeModel", "bikeYear",
      "sponsors", "mylapsTransponderId",
    ] as const;
    for (const r of riders) {
      const localId = Number(r.localRiderId ?? r.id);
      if (!localId || !r.clientIdentity) { results.skipped++; continue; }

      const [identity] = await tx.select({ riderId: offlineRiderIdentitiesTable.riderId })
        .from(offlineRiderIdentitiesTable)
        .where(and(
          eq(offlineRiderIdentitiesTable.clubId, clubId),
          eq(offlineRiderIdentitiesTable.clientIdentity, r.clientIdentity),
        ));
      let cloudId = identity?.riderId;
      if (!cloudId) {
        // Legacy cloud-origin rider: an ID is valid only when it is already on
        // this club's roster. A numeric collision is never trusted.
        const assertedCloudId = Number(r.cloudRiderId);
        if (assertedCloudId) {
          const [roster] = await tx.select({ id: registrationsTable.riderId })
            .from(registrationsTable)
            .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
            .where(and(eq(registrationsTable.riderId, assertedCloudId), eq(eventsTable.clubId, clubId)));
          cloudId = roster?.id;
        }
      }

      const supplied: Record<string, unknown> = {};
      for (const field of riderFields) {
        // Rider names are NOT NULL in the cloud schema. Empty strings are valid
        // explicit blanks; null cannot be represented for these two fields.
        if (r[field] !== undefined && !((field === "firstName" || field === "lastName") && r[field] === null)) {
          supplied[field] = r[field];
        }
      }
      if (cloudId) {
        // Empty strings and nulls are intentional profile edits; only omitted
        // fields are excluded from the update.
        if (Object.keys(supplied).length) {
          await tx.update(ridersTable).set(supplied as any).where(eq(ridersTable.id, cloudId));
        }
      } else {
        const [created] = await tx.insert(ridersTable).values({
          clubId,
          firstName: r.firstName ?? "",
          lastName: r.lastName ?? "",
          ...Object.fromEntries(Object.entries(supplied).filter(([key]) => key !== "firstName" && key !== "lastName")),
        }).returning({ id: ridersTable.id });
        cloudId = created.id;
      }
      await tx.insert(offlineRiderIdentitiesTable).values({
        clubId, clientIdentity: r.clientIdentity, riderId: cloudId,
      }).onConflictDoNothing();
      resolvedRiderIds.set(localId, cloudId);
      riderIdMap[String(localId)] = cloudId;
      results.ridersUpdated++;
    }
    const cloudRiderId = (id: number) => resolvedRiderIds.get(id) ?? id;

    // ── Checkins ──────────────────────────────────────────────────────────────
    for (const c of checkins) {
      c.riderId = cloudRiderId(Number(c.riderId));
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
      r.riderId = cloudRiderId(Number(r.riderId));
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
      r.riderId = cloudRiderId(Number(r.riderId));
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

  });

  const syncedAt = new Date().toISOString();

  req.log.info({ clubId, results }, "local-mode sync complete");

  return res.json({ ok: true, syncedAt, results, riderIdMap });
});

export default router;
