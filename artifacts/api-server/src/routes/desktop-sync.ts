import { Router } from "express";
import { eq, gt, and, inArray, isNull, or } from "drizzle-orm";
import { db } from "@workspace/db";
import { sseBroadcast, buildLeaderboard } from "./timing";
import {
  usersTable,
  eventsTable,
  checkinsTable,
  rfidAssignmentsTable,
  registrationsTable,
  ridersTable,
  lapCrossingsTable,
  raceResultsTable,
  motosTable,
  clubsTable,
  seriesTable,
  seriesPointsTable,
  pointsTablesTable,
  practiceSessionsTable,
  practiceCrossingsTable,
  discountCategoriesTable,
  compCodesTable,
} from "@workspace/db";

const router = Router();

// ─── Auth helper ─────────────────────────────────────────────────────────────

async function resolveClubUser(
  req: any,
  clubId: number,
): Promise<{ id: number; clubId: number | null } | null> {
  const sessionUserId = (req.session as any).userId as number | undefined;
  if (sessionUserId) {
    const [user] = await db
      .select({ id: usersTable.id, clubId: usersTable.clubId })
      .from(usersTable)
      .where(eq(usersTable.id, sessionUserId));
    return user ?? null;
  }

  const authHeader = (req.headers.authorization ?? "") as string;
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (!token) return null;

  const [user] = await db
    .select({ id: usersTable.id, clubId: usersTable.clubId })
    .from(usersTable)
    .where(eq((usersTable as any).offlineSyncToken, token));
  return user ?? null;
}

function toDate(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

// ─── POST /clubs/:clubId/desktop-push ────────────────────────────────────────
// Receives batched writes from the Electron desktop app's write queue.

router.post("/clubs/:clubId/desktop-push", async (req, res) => {
  const clubId = Number(req.params.clubId);
  if (isNaN(clubId)) return res.status(400).json({ error: "Invalid clubId" });

  const user = await resolveClubUser(req, clubId);
  if (!user || user.clubId !== clubId) {
    return res.status(403).json({ error: "Access denied" });
  }

  const payload = req.body as Record<string, Record<string, unknown>[]>;
  const results: Record<string, number> = {};
  let total = 0;
  const affectedMotoIds = new Set<number>();

  await db.transaction(async (tx) => {
    // ── lap_crossings ─────────────────────────────────────────────────────────
    const crossings = (payload["lap_crossings"] ?? []) as Array<{
      id?: unknown;
      event_id: unknown;
      moto_id: unknown;
      rfid_number: unknown;
      crossing_time: unknown;
      lap_number: unknown;
      lap_time_ms: unknown;
      rider_id?: unknown;
      reader_id?: unknown;
      antenna_id?: unknown;
    }>;

    let crossingsUpserted = 0;
    for (const c of crossings) {
      const eventId = Number(c.event_id);
      const motoId  = Number(c.moto_id);
      if (!eventId || !motoId) continue;

      const [event] = await tx
        .select({ clubId: eventsTable.clubId })
        .from(eventsTable)
        .where(eq(eventsTable.id, eventId));
      if (!event || event.clubId !== clubId) continue;

      const rfidNumber = String(c.rfid_number ?? "");
      const lapNumber  = Number(c.lap_number);
      if (!rfidNumber || !lapNumber) continue;

      const [existing] = await tx
        .select({ id: lapCrossingsTable.id })
        .from(lapCrossingsTable)
        .where(
          and(
            eq(lapCrossingsTable.motoId, motoId),
            eq(lapCrossingsTable.rfidNumber, rfidNumber),
            eq(lapCrossingsTable.lapNumber, lapNumber),
          ),
        );

      const crossingTime = toDate(c.crossing_time) ?? new Date();

      if (existing) {
        await tx
          .update(lapCrossingsTable)
          .set({ lapTimeMs: Number(c.lap_time_ms), crossingTime })
          .where(eq(lapCrossingsTable.id, existing.id));
      } else {
        const clientId = c.id != null && Number(c.id) > 0 ? Number(c.id) : undefined;
        await tx.insert(lapCrossingsTable).values({
          ...(clientId ? { id: clientId } : {}),
          eventId,
          motoId,
          riderId:      c.rider_id != null   ? Number(c.rider_id)   : null,
          rfidNumber,
          crossingTime,
          lapNumber,
          lapTimeMs:    Number(c.lap_time_ms),
          readerId:     c.reader_id  != null ? String(c.reader_id)  : null,
          antennaId:    c.antenna_id != null ? Number(c.antenna_id) : null,
        });
      }
      crossingsUpserted++;
      affectedMotoIds.add(motoId);
    }
    results["lap_crossings"] = crossingsUpserted;
    total += crossingsUpserted;

    // ── race_results ──────────────────────────────────────────────────────────
    const raceResults = (payload["race_results"] ?? []) as Array<{
      id?: unknown;
      event_id?: unknown;
      moto_id: unknown;
      rider_id: unknown;
      race_class?: unknown;
      position?: unknown;
      bib_number?: unknown;
      lap_times?: unknown;
      total_time?: unknown;
      dnf?: unknown;
      dns?: unknown;
    }>;

    let resultsUpserted = 0;
    for (const r of raceResults) {
      const eventId = Number(r.event_id);
      const motoId  = Number(r.moto_id);
      const riderId = Number(r.rider_id);
      if (!eventId || !motoId || !riderId) continue;

      const [event] = await tx
        .select({ clubId: eventsTable.clubId })
        .from(eventsTable)
        .where(eq(eventsTable.id, eventId));
      if (!event || event.clubId !== clubId) continue;

      const [existing] = await tx
        .select({ id: raceResultsTable.id })
        .from(raceResultsTable)
        .where(
          and(
            eq(raceResultsTable.motoId,  motoId),
            eq(raceResultsTable.riderId, riderId),
          ),
        );

      let lapTimes: number[] = [];
      try {
        lapTimes = JSON.parse(String(r.lap_times ?? "[]")) as number[];
      } catch { /* ignore */ }

      if (existing) {
        await tx
          .update(raceResultsTable)
          .set({
            position:  r.position != null ? Number(r.position) : 999,
            lapTimes,
            totalTime: r.total_time != null ? String(r.total_time) : null,
            dnf:       Boolean(r.dnf),
            dns:       Boolean(r.dns),
          })
          .where(eq(raceResultsTable.id, existing.id));
      } else {
        const clientId = r.id != null && Number(r.id) > 0 ? Number(r.id) : undefined;
        await tx.insert(raceResultsTable).values({
          ...(clientId ? { id: clientId } : {}),
          eventId,
          motoId,
          riderId,
          raceClass: r.race_class != null ? String(r.race_class) : "",
          position:  r.position  != null ? Number(r.position) : 999,
          bibNumber: r.bib_number != null ? String(r.bib_number) : null,
          lapTimes,
          totalTime: r.total_time != null ? String(r.total_time) : null,
          dnf:       Boolean(r.dnf),
          dns:       Boolean(r.dns),
        });
      }
      resultsUpserted++;
      affectedMotoIds.add(motoId);
    }
    results["race_results"] = resultsUpserted;
    total += resultsUpserted;

    // ── motos (status / start / complete updates) ─────────────────────────────
    const motos = (payload["motos"] ?? []) as Array<{
      id?: unknown;
      event_id?: unknown;
      name?: unknown;
      type?: unknown;
      race_class?: unknown;
      moto_number?: unknown;
      status?: unknown;
      started_at?: unknown;
      completed_at?: unknown;
      lineup?: unknown;
      lap_count?: unknown;
      scheduled_time?: unknown;
    }>;

    let motosUpserted = 0;
    for (const m of motos) {
      const eventId    = Number(m.event_id);
      const motoNumber = Number(m.moto_number ?? 0);
      if (!eventId) continue;

      const [event] = await tx
        .select({ clubId: eventsTable.clubId })
        .from(eventsTable)
        .where(eq(eventsTable.id, eventId));
      if (!event || event.clubId !== clubId) continue;

      const [existing] = await tx
        .select({ id: motosTable.id })
        .from(motosTable)
        .where(
          and(
            eq(motosTable.eventId, eventId),
            eq(motosTable.motoNumber, motoNumber),
          ),
        );

      const status      = String(m.status ?? "scheduled") as "scheduled" | "in_progress" | "completed";
      const startedAt   = toDate(m.started_at);
      const completedAt = toDate(m.completed_at);

      if (existing) {
        await tx
          .update(motosTable)
          .set({ status, startedAt, completedAt })
          .where(eq(motosTable.id, existing.id));
        affectedMotoIds.add(existing.id);
      } else {
        let lineup: number[] = [];
        try { lineup = JSON.parse(String(m.lineup ?? "[]")) as number[]; } catch { /* ignore */ }

        const clientId = m.id != null && Number(m.id) > 0 ? Number(m.id) : undefined;
        await tx.insert(motosTable).values({
          ...(clientId ? { id: clientId } : {}),
          eventId,
          name:          m.name != null ? String(m.name) : "",
          type:          m.type != null ? String(m.type) : "moto",
          raceClass:     m.race_class != null ? String(m.race_class) : "",
          motoNumber,
          scheduledTime: m.scheduled_time != null ? String(m.scheduled_time) : null,
          lineup,
          lapCount:      m.lap_count != null ? Number(m.lap_count) : null,
          status,
          startedAt,
          completedAt,
        });
        if (clientId) affectedMotoIds.add(clientId);
      }
      motosUpserted++;
    }
    results["motos"] = motosUpserted;
    total += motosUpserted;

    // ── checkins ──────────────────────────────────────────────────────────────
    const checkins = (payload["checkins"] ?? []) as Array<{
      id?: unknown;
      event_id: unknown;
      rider_id: unknown;
      race_class?: unknown;
      bib_number?: unknown;
      checked_in?: unknown;
      checked_in_at?: unknown;
      rfid_number?: unknown;
      rfid_linked?: unknown;
    }>;

    let checkinsUpserted = 0;
    for (const c of checkins) {
      const eventId = Number(c.event_id);
      const riderId = Number(c.rider_id);
      if (!eventId || !riderId) continue;

      const [event] = await tx
        .select({ clubId: eventsTable.clubId })
        .from(eventsTable)
        .where(eq(eventsTable.id, eventId));
      if (!event || event.clubId !== clubId) continue;

      const [existing] = await tx
        .select({ id: checkinsTable.id })
        .from(checkinsTable)
        .where(
          and(
            eq(checkinsTable.eventId, eventId),
            eq(checkinsTable.riderId, riderId),
          ),
        );

      const checkedIn   = Boolean(c.checked_in);
      const rfidLinked  = Boolean(c.rfid_linked);
      const checkedInAt = toDate(c.checked_in_at);

      if (existing) {
        await tx
          .update(checkinsTable)
          .set({
            checkedIn, checkedInAt,
            rfidNumber: c.rfid_number != null ? String(c.rfid_number) : null,
            rfidLinked,
            bibNumber:  c.bib_number != null ? String(c.bib_number) : null,
          })
          .where(eq(checkinsTable.id, existing.id));
      } else {
        const clientId = c.id != null && Number(c.id) > 0 ? Number(c.id) : undefined;
        await tx.insert(checkinsTable).values({
          ...(clientId ? { id: clientId } : {}),
          eventId,
          riderId,
          raceClass:  c.race_class != null ? String(c.race_class) : "",
          bibNumber:  c.bib_number != null ? String(c.bib_number) : null,
          checkedIn,
          checkedInAt,
          rfidNumber: c.rfid_number != null ? String(c.rfid_number) : null,
          rfidLinked,
        });
      }
      checkinsUpserted++;
    }
    results["checkins"] = checkinsUpserted;
    total += checkinsUpserted;

    // ── riders (gate-created riders / profile edits) ─────────────────────────
    // Process BEFORE registrations so FK constraint is satisfied when a new
    // rider and their registration arrive together in the same push batch.
    const riders = (payload["riders"] ?? []) as Array<{
      id?: unknown;
      first_name?: unknown;
      last_name?: unknown;
      rfid_number?: unknown;
    }>;

    // Authorization set 1: rider IDs already linked to this club in cloud DB.
    const cloudRiderRows = await tx
      .selectDistinct({ riderId: registrationsTable.riderId })
      .from(registrationsTable)
      .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
      .where(eq(eventsTable.clubId, clubId));
    const cloudRiderIdSet = new Set(cloudRiderRows.map((r) => r.riderId));

    // Authorization set 2: rider IDs in THIS BATCH paired with a club event.
    // This allows walk-up riders created offline to sync before their
    // registrations are inserted (prevents FK violation and "new rider blocked"
    // scenario where the rider has no cloud registration yet).
    const incomingRegs = (payload["registrations"] ?? []) as Array<{
      event_id: unknown;
      rider_id: unknown;
    }>;
    const batchRiderIdSet = new Set<number>();
    for (const reg of incomingRegs) {
      const eid = Number(reg.event_id);
      const rid = Number(reg.rider_id);
      if (!eid || !rid) continue;
      const [evt] = await tx
        .select({ clubId: eventsTable.clubId })
        .from(eventsTable)
        .where(eq(eventsTable.id, eid));
      if (evt && evt.clubId === clubId) batchRiderIdSet.add(rid);
    }

    let ridersUpserted = 0;
    for (const r of riders) {
      const riderId = Number(r.id);
      if (!riderId) continue;

      // Allow if already on cloud roster OR arriving with a valid club registration
      if (!cloudRiderIdSet.has(riderId) && !batchRiderIdSet.has(riderId)) continue;

      const [existing] = await tx
        .select({ id: ridersTable.id })
        .from(ridersTable)
        .where(eq(ridersTable.id, riderId));

      if (existing) {
        // Safety: only update a rider whose ID is already on THIS club's cloud roster.
        // If the rider ID exists in cloud but belongs to a different club (ID collision
        // from offline auto-increment), skip the update to prevent cross-club corruption.
        if (!cloudRiderIdSet.has(riderId)) continue;

        await tx
          .update(ridersTable)
          .set({
            firstName:  r.first_name  != null ? String(r.first_name)  : undefined,
            lastName:   r.last_name   != null ? String(r.last_name)   : undefined,
            rfidNumber: r.rfid_number != null ? String(r.rfid_number) : undefined,
          })
          .where(eq(ridersTable.id, riderId));
      } else {
        // New rider — insert with the client-provided ID.
        // ON CONFLICT DO NOTHING guards against the rare race condition where
        // another transaction inserts the same rider ID concurrently.
        await tx.insert(ridersTable).values({
          id:         riderId,
          firstName:  r.first_name  != null ? String(r.first_name)  : "",
          lastName:   r.last_name   != null ? String(r.last_name)   : "",
          rfidNumber: r.rfid_number != null ? String(r.rfid_number) : null,
        }).onConflictDoNothing();
      }
      ridersUpserted++;
    }
    results["riders"] = ridersUpserted;
    total += ridersUpserted;

    // ── registrations (walk-up / on-site edits) ───────────────────────────────
    // Processed AFTER riders so FK is satisfied for new walk-up registrations.
    const regs = incomingRegs as Array<{
      id?: unknown;
      event_id: unknown;
      rider_id: unknown;
      race_class?: unknown;
      status?: unknown;
      payment_status?: unknown;
      bib_number?: unknown;
      bike_brand?: unknown;
      amount_paid?: unknown;
      payment_method?: unknown;
    }>;

    let regsUpserted = 0;
    for (const r of regs) {
      const eventId = Number(r.event_id);
      const riderId = Number(r.rider_id);
      if (!eventId || !riderId) continue;

      const [event] = await tx
        .select({ clubId: eventsTable.clubId })
        .from(eventsTable)
        .where(eq(eventsTable.id, eventId));
      if (!event || event.clubId !== clubId) continue;

      const [existing] = await tx
        .select({ id: registrationsTable.id })
        .from(registrationsTable)
        .where(
          and(
            eq(registrationsTable.eventId, eventId),
            eq(registrationsTable.riderId, riderId),
          ),
        );

      if (existing) {
        await tx
          .update(registrationsTable)
          .set({
            status:        r.status        != null ? String(r.status)         : undefined,
            paymentStatus: r.payment_status != null ? String(r.payment_status) : undefined,
            bibNumber:     r.bib_number    != null ? String(r.bib_number)     : undefined,
            bikeBrand:     r.bike_brand    != null ? String(r.bike_brand)     : undefined,
            amountPaid:    r.amount_paid   != null ? String(r.amount_paid)    : undefined,
            paymentMethod: r.payment_method != null ? String(r.payment_method) : undefined,
          })
          .where(eq(registrationsTable.id, existing.id));
      } else {
        const clientId = r.id != null && Number(r.id) > 0 ? Number(r.id) : undefined;
        await tx.insert(registrationsTable).values({
          ...(clientId ? { id: clientId } : {}),
          eventId,
          riderId,
          raceClass:     r.race_class     != null ? String(r.race_class)     : "",
          status:        (r.status        != null ? String(r.status)         : "confirmed") as "pending" | "confirmed" | "cancelled",
          paymentStatus: (r.payment_status != null ? String(r.payment_status) : "unpaid")   as "unpaid"  | "paid"      | "refunded",
          bibNumber:     r.bib_number     != null ? String(r.bib_number)     : null,
          bikeBrand:     r.bike_brand     != null ? String(r.bike_brand)     : null,
          amountPaid:    r.amount_paid    != null ? String(r.amount_paid)    : null,
          paymentMethod: r.payment_method != null ? String(r.payment_method) : null,
        });
      }
      regsUpserted++;
    }
    results["registrations"] = regsUpserted;
    total += regsUpserted;

    // ── rfid_assignments (transponder assignment at event) ────────────────────
    const rfidAssigns = (payload["rfid_assignments"] ?? []) as Array<{
      id?: unknown;
      rider_id: unknown;
      event_id: unknown;
      rfid_number?: unknown;
    }>;

    let rfidUpserted = 0;
    for (const a of rfidAssigns) {
      const riderId    = Number(a.rider_id);
      const eventId    = Number(a.event_id);
      const rfidNumber = String(a.rfid_number ?? "");
      if (!riderId || !eventId || !rfidNumber) continue;

      const [event] = await tx
        .select({ clubId: eventsTable.clubId })
        .from(eventsTable)
        .where(eq(eventsTable.id, eventId));
      if (!event || event.clubId !== clubId) continue;

      const [existing] = await tx
        .select({ id: rfidAssignmentsTable.id })
        .from(rfidAssignmentsTable)
        .where(
          and(
            eq(rfidAssignmentsTable.riderId,  riderId),
            eq(rfidAssignmentsTable.eventId,  eventId),
          ),
        );

      if (existing) {
        await tx
          .update(rfidAssignmentsTable)
          .set({ rfidNumber })
          .where(eq(rfidAssignmentsTable.id, existing.id));
      } else {
        const clientId = a.id != null && Number(a.id) > 0 ? Number(a.id) : undefined;
        await tx.insert(rfidAssignmentsTable).values({
          ...(clientId ? { id: clientId } : {}),
          riderId,
          eventId,
          rfidNumber,
        });
      }
      rfidUpserted++;
    }
    results["rfid_assignments"] = rfidUpserted;
    total += rfidUpserted;

    // ── events (full field updates made on desktop) ───────────────────────────
    // Desktop queue sends raw SQLite rows (snake_case).  Accept every field the
    // organizer can edit in the desktop app so changes like race date, name, and
    // location survive the next sync-pull.
    const events = (payload["events"] ?? []) as Array<Record<string, unknown>>;

    let eventsUpserted = 0;
    for (const e of events) {
      const eventId = Number(e.id);
      if (!eventId) continue;

      const [event] = await tx
        .select({ clubId: eventsTable.clubId })
        .from(eventsTable)
        .where(eq(eventsTable.id, eventId));

      if (!event) {
        // New event created on desktop — insert it into cloud, scoped to this club.
        const rawClasses = e.race_classes ?? e.classes ?? null;
        let raceClasses: string[] = [];
        try { raceClasses = JSON.parse(String(rawClasses ?? "[]")) as string[]; } catch { /* ignore */ }

        let raceClassLimits: Record<string, number | null> = {};
        if (e.race_class_limits != null) {
          try { raceClassLimits = JSON.parse(String(e.race_class_limits)) as Record<string, number | null>; } catch { /* ignore */ }
        }
        let purchaseOptions: unknown[] = [];
        if (e.purchase_options != null) {
          try { purchaseOptions = JSON.parse(String(e.purchase_options)) as unknown[]; } catch { /* ignore */ }
        }

        const insertRow: Record<string, unknown> = {
          id: eventId,
          clubId,
          name:          e.name     != null ? String(e.name)     : "Untitled Event",
          date:          e.date     != null ? String(e.date)     : new Date().toISOString().slice(0, 10),
          state:         e.state    != null ? String(e.state)    : "",
          location:      e.location != null ? String(e.location) : null,
          trackName:     e.track_name != null ? String(e.track_name) : null,
          status:        e.status   != null ? String(e.status)   : "draft",
          raceClasses,
          raceClassLimits,
          purchaseOptions,
          paymentEnabled:             !!e.payment_enabled,
          requireAma:                 !!e.require_ama,
          entryFee:                   e.entry_fee     != null ? Number(e.entry_fee)     || null : null,
          maxRiders:                  e.max_riders    != null ? Number(e.max_riders)    || null : null,
          timingTechnology:           e.timing_technology != null ? String(e.timing_technology) : "rfid",
          transponderRentalEnabled:   !!e.transponder_rental_enabled,
          transponderRentalFee:       e.transponder_rental_fee != null ? Number(e.transponder_rental_fee) || null : null,
          noDuplicateBibs:            !!e.no_duplicate_bibs,
          requireClubId:              !!e.require_club_id,
          scoringTableId:             e.scoring_table_id      != null ? Number(e.scoring_table_id)      || null : null,
          entryFeeCategoryId:         e.entry_fee_category_id != null ? Number(e.entry_fee_category_id) || null : null,
          minLapMs:                   e.min_lap_ms    != null ? Number(e.min_lap_ms)    || null : null,
          registrationOpen:           e.registration_open  != null ? String(e.registration_open)  : null,
          registrationClose:          e.registration_close != null ? String(e.registration_close) : null,
          imageUrl:                   e.image_url    != null ? String(e.image_url)    : null,
          amaEventId:                 e.ama_event_id != null ? String(e.ama_event_id) : null,
        };
        await tx.insert(eventsTable).values(insertRow as any).onConflictDoNothing();
        eventsUpserted++;
        continue;
      }

      if (event.clubId !== clubId) continue;

      // Prefer `race_classes` (canonical queue key); fall back to `classes`.
      const rawClasses = e.race_classes ?? e.classes ?? null;
      let raceClasses: string[] | undefined;
      if (rawClasses != null) {
        try { raceClasses = JSON.parse(String(rawClasses)) as string[]; } catch { /* ignore */ }
      }

      // race_class_limits and purchase_options are stored as JSON strings in SQLite.
      let raceClassLimits: Record<string, number | null> | undefined;
      if (e.race_class_limits != null) {
        try { raceClassLimits = JSON.parse(String(e.race_class_limits)) as Record<string, number | null>; } catch { /* ignore */ }
      }
      let purchaseOptions: unknown[] | undefined;
      if (e.purchase_options != null) {
        try { purchaseOptions = JSON.parse(String(e.purchase_options)) as unknown[]; } catch { /* ignore */ }
      }

      // Build the update set — only include fields present in this row so that
      // a partial push (e.g. status-only) doesn't null-out unrelated columns.
      const updateSet: Record<string, unknown> = {};
      if (e.status   != null) updateSet.status   = String(e.status) as "draft" | "registration_open" | "race_day" | "completed";
      if (raceClasses)        updateSet.raceClasses = raceClasses;
      if (raceClassLimits)    updateSet.raceClassLimits = raceClassLimits;
      if (purchaseOptions)    updateSet.purchaseOptions = purchaseOptions;
      if (e.name     != null) updateSet.name      = String(e.name);
      if (e.date     != null) updateSet.date      = String(e.date);
      if (e.location != null) updateSet.location  = String(e.location);
      if (e.state    != null) updateSet.state     = String(e.state);
      if (e.track_name != null) updateSet.trackName = String(e.track_name);
      if (e.registration_open  != null) updateSet.registrationOpen  = String(e.registration_open);
      if (e.registration_close != null) updateSet.registrationClose = String(e.registration_close);
      if (e.payment_enabled != null) updateSet.paymentEnabled = !!e.payment_enabled;
      if (e.require_ama     != null) updateSet.requireAma     = !!e.require_ama;
      if (e.entry_fee  != null) updateSet.entryFee  = Number(e.entry_fee) || null;
      if (e.max_riders != null) updateSet.maxRiders = Number(e.max_riders) || null;
      if (e.timing_technology != null) updateSet.timingTechnology = String(e.timing_technology);
      if (e.transponder_rental_enabled != null) updateSet.transponderRentalEnabled = !!e.transponder_rental_enabled;
      if (e.transponder_rental_fee != null) updateSet.transponderRentalFee = Number(e.transponder_rental_fee) || null;
      if (e.no_duplicate_bibs != null) updateSet.noDuplicateBibs = !!e.no_duplicate_bibs;
      if (e.require_club_id != null) updateSet.requireClubId = !!e.require_club_id;
      if (e.scoring_table_id != null) updateSet.scoringTableId = Number(e.scoring_table_id) || null;
      if (e.entry_fee_category_id != null) updateSet.entryFeeCategoryId = Number(e.entry_fee_category_id) || null;
      if (e.min_lap_ms != null) updateSet.minLapMs = Number(e.min_lap_ms) || null;
      if (e.image_url  != null) updateSet.imageUrl  = String(e.image_url);
      if (e.ama_event_id != null) updateSet.amaEventId = String(e.ama_event_id);

      if (Object.keys(updateSet).length === 0) continue;

      await tx
        .update(eventsTable)
        .set(updateSet as any)
        .where(eq(eventsTable.id, eventId));
      eventsUpserted++;
    }
    results["events"] = eventsUpserted;
    total += eventsUpserted;

    // ── practice_sessions (create / start / stop on desktop) ─────────────────
    const practiceSessions = (payload["practice_sessions"] ?? []) as Array<Record<string, unknown>>;

    let practiceSessionsUpserted = 0;
    for (const s of practiceSessions) {
      const sessionId = Number(s.id);
      if (!sessionId) continue;

      const [existing] = await tx
        .select({ id: practiceSessionsTable.id, clubId: practiceSessionsTable.clubId })
        .from(practiceSessionsTable)
        .where(eq(practiceSessionsTable.id, sessionId));

      if (existing) {
        if (existing.clubId !== clubId) continue;
        const updateSet: Record<string, unknown> = {};
        if (s.status      != null) updateSet.status     = String(s.status);
        if (s.name        != null) updateSet.name        = String(s.name);
        if (s.debounce_ms != null) updateSet.debounceMs  = Number(s.debounce_ms);
        if (s.started_at  != null) updateSet.startedAt   = toDate(s.started_at);
        if (s.ended_at    != null) updateSet.endedAt     = toDate(s.ended_at);
        if (Object.keys(updateSet).length === 0) continue;
        await tx
          .update(practiceSessionsTable)
          .set(updateSet as any)
          .where(eq(practiceSessionsTable.id, sessionId));
      } else {
        const insertRow: Record<string, unknown> = {
          id:         sessionId,
          clubId,
          name:       s.name        != null ? String(s.name)        : "Practice",
          status:     s.status      != null ? String(s.status)      : "idle",
          debounceMs: s.debounce_ms != null ? Number(s.debounce_ms) : 10000,
          startedAt:  toDate(s.started_at),
          endedAt:    toDate(s.ended_at),
        };
        await tx
          .insert(practiceSessionsTable)
          .values(insertRow as any)
          .onConflictDoNothing();
      }
      practiceSessionsUpserted++;
    }
    results["practice_sessions"] = practiceSessionsUpserted;
    total += practiceSessionsUpserted;

    // ── practice_crossings (RFID reads during practice — insert-only) ─────────
    const practiceCrossingsPayload = (payload["practice_crossings"] ?? []) as Array<Record<string, unknown>>;

    let practiceCrossingsUpserted = 0;
    for (const c of practiceCrossingsPayload) {
      const crossingId = Number(c.id);
      const sessionId  = Number(c.session_id);
      const rfidNumber = String(c.rfid_number ?? "");
      if (!sessionId || !rfidNumber) continue;

      // Scope check: session must belong to this club
      const [session] = await tx
        .select({ clubId: practiceSessionsTable.clubId })
        .from(practiceSessionsTable)
        .where(eq(practiceSessionsTable.id, sessionId));
      if (!session || session.clubId !== clubId) continue;

      // Crossings are immutable — skip if already on cloud
      if (crossingId) {
        const [existingCrossing] = await tx
          .select({ id: practiceCrossingsTable.id })
          .from(practiceCrossingsTable)
          .where(eq(practiceCrossingsTable.id, crossingId));
        if (existingCrossing) { practiceCrossingsUpserted++; continue; }
      }

      const insertRow: Record<string, unknown> = {
        ...(crossingId ? { id: crossingId } : {}),
        sessionId,
        rfidNumber,
        riderId:     c.rider_id    != null ? Number(c.rider_id)    : null,
        riderName:   c.rider_name  != null ? String(c.rider_name)  : null,
        bibNumber:   c.bib_number  != null ? String(c.bib_number)  : null,
        crossingTime: toDate(c.crossing_time) ?? new Date(),
        lapNumber:   c.lap_number  != null ? Number(c.lap_number)  : 0,
        lapTimeMs:   c.lap_time_ms != null ? Number(c.lap_time_ms) : null,
      };
      await tx
        .insert(practiceCrossingsTable)
        .values(insertRow as any)
        .onConflictDoNothing();
      practiceCrossingsUpserted++;
    }
    results["practice_crossings"] = practiceCrossingsUpserted;
    total += practiceCrossingsUpserted;
  });

  // Broadcast updated leaderboard to any SSE subscribers watching affected motos.
  // Runs after the transaction commits so readers see the committed rows.
  // Fire-and-forget: don't let broadcast errors fail the push response.
  if (affectedMotoIds.size > 0) {
    setImmediate(() => {
      void (async () => {
        for (const motoId of affectedMotoIds) {
          try {
            const snapshot = await buildLeaderboard(motoId);
            if (snapshot) sseBroadcast(motoId, snapshot);
          } catch { /* ignore — broadcast is best-effort */ }
        }
      })();
    });
  }

  req.log.info({ clubId, results, total }, "desktop-push complete");
  return res.json({ ok: true, results, total });
});

// ─── POST /clubs/:clubId/sync-pull ────────────────────────────────────────────
// Returns ALL current club rows on every call.  No id-watermark filtering so
// that edits to existing rows made via the web portal are always applied to the
// desktop (club tables have `created_at` only, no `updated_at`).
// All queries are scoped to events owned by this club — no cross-club leaks.
// Riders are filtered to those with a registration for a club event and return
// only id/firstName/lastName/rfidNumber (no email/phone PII).
// The client sends `lastPulledAt` per table for future server-side optimisation;
// the server currently ignores it and always returns the full set.

router.post("/clubs/:clubId/sync-pull", async (req, res) => {
  const clubId = Number(req.params.clubId);
  if (isNaN(clubId)) return res.status(400).json({ error: "Invalid clubId" });

  const user = await resolveClubUser(req, clubId);
  if (!user || user.clubId !== clubId) {
    return res.status(403).json({ error: "Access denied" });
  }

  // Always fetch users first — they must be returned even when the club has
  // no events yet, so the desktop can authenticate locally on first sync.
  const clubUsers = await db.select({
    id:           usersTable.id,
    email:        usersTable.email,
    passwordHash: usersTable.passwordHash,
    name:         usersTable.name,
    role:         usersTable.role,
    clubId:       usersTable.clubId,
    createdAt:    usersTable.createdAt,
  }).from(usersTable).where(eq(usersTable.clubId, clubId));

  // Fetch all events for this club — used to scope every subsequent query
  const clubEvents = await db
    .select({ id: eventsTable.id })
    .from(eventsTable)
    .where(eq(eventsTable.clubId, clubId));

  // Fetch club record + scoring tables + series (needed even when no events)
  const [clubRow] = await db
    .select()
    .from(clubsTable)
    .where(eq(clubsTable.id, clubId));

  const pointsTables = await db
    .select()
    .from(pointsTablesTable)
    .where(or(isNull(pointsTablesTable.clubId), eq(pointsTablesTable.clubId, clubId)));

  const clubSeries = await db
    .select()
    .from(seriesTable)
    .where(eq(seriesTable.clubId, clubId));

  const discountCategories = await db
    .select()
    .from(discountCategoriesTable)
    .where(eq(discountCategoriesTable.clubId, clubId));

  const compCodes = await db
    .select()
    .from(compCodesTable)
    .where(eq(compCodesTable.clubId, clubId));

  const practiceSessions = await db
    .select()
    .from(practiceSessionsTable)
    .where(eq(practiceSessionsTable.clubId, clubId));

  const practiceSessionIds = practiceSessions.map((s) => s.id);
  const practiceCrossings =
    practiceSessionIds.length > 0
      ? await db
          .select()
          .from(practiceCrossingsTable)
          .where(inArray(practiceCrossingsTable.sessionId, practiceSessionIds))
      : [];

  if (clubEvents.length === 0) {
    return res.json({
      registrations: [], checkins: [], riders: [],
      rfidAssignments: [], events: [], motos: [],
      lapCrossings: [], raceResults: [], users: clubUsers,
      clubs: clubRow ? [clubRow] : [],
      pointsTables,
      series: clubSeries,
      seriesPoints: [],
      discountCategories,
      compCodes,
      practiceSessions,
      practiceCrossings,
    });
  }

  const clubEventIds = clubEvents.map((e) => e.id);

  // Return ALL rows for each table scoped to club events (no row-count cap).
  // Full-pull approach ensures edits to existing rows are always applied.
  const [
    registrations, checkins, rfidAssignments, events, motos,
    lapCrossings, raceResults,
  ] = await Promise.all([
    db.select().from(registrationsTable).where(
      inArray(registrationsTable.eventId, clubEventIds),
    ),
    db.select().from(checkinsTable).where(
      inArray(checkinsTable.eventId, clubEventIds),
    ),
    db.select().from(rfidAssignmentsTable).where(
      inArray(rfidAssignmentsTable.eventId, clubEventIds),
    ),
    db.select().from(eventsTable).where(eq(eventsTable.clubId, clubId)),
    db.select().from(motosTable).where(
      inArray(motosTable.eventId, clubEventIds),
    ),
    db.select().from(lapCrossingsTable).where(
      inArray(lapCrossingsTable.eventId, clubEventIds),
    ),
    db.select().from(raceResultsTable).where(
      inArray(raceResultsTable.eventId, clubEventIds),
    ),
  ]);

  // Riders: only return riders who have a registration for a club event.
  // Return minimal fields (no email/phone) to avoid cross-club PII exposure.
  const regRiderIds = [...new Set(registrations.map((r) => r.riderId))];
  const riders =
    regRiderIds.length > 0
      ? await db
          .select({
            id:         ridersTable.id,
            firstName:  ridersTable.firstName,
            lastName:   ridersTable.lastName,
            rfidNumber: ridersTable.rfidNumber,
          })
          .from(ridersTable)
          .where(inArray(ridersTable.id, regRiderIds))
      : [];

  // Series points for all club series
  const seriesIds = clubSeries.map((s) => s.id);
  const seriesPoints =
    seriesIds.length > 0
      ? await db
          .select()
          .from(seriesPointsTable)
          .where(inArray(seriesPointsTable.seriesId, seriesIds))
      : [];

  return res.json({
    registrations, checkins, rfidAssignments, riders, events,
    motos, lapCrossings, raceResults, users: clubUsers,
    clubs: clubRow ? [clubRow] : [],
    pointsTables,
    series: clubSeries,
    seriesPoints,
    discountCategories,
    compCodes,
    practiceSessions,
    practiceCrossings,
  });
});

export default router;
