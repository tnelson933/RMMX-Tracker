import { Router } from "express";
import { compareStandings } from "../lib/lapScoring";
import { asc, eq, gt, and, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { buildLeaderboard, formatLapTime, publishTimingSnapshot, startSharedAnnouncer } from "./timing";
import {
  usersTable,
  eventsTable,
  checkinsTable,
  rfidAssignmentsTable,
  registrationsTable,
  ridersTable,
  riderTranspondersTable,
  lapCrossingsTable,
  splitCrossingsTable,
  raceResultsTable,
  motosTable,
  clubsTable,
  seriesTable,
  seriesPointsTable,
  pointsTablesTable,
  practiceSessionsTable,
  practiceCrossingsTable,
  practiceSplitCrossingsTable,
  discountCategoriesTable,
  compCodesTable,
  riderAccountsTable,
  riderPushTokensTable,
  eventPublicationTable,
  eventReaderAssignmentsTable,
  teamMembersTable,
  enduroTimeChecksTable,
  enduroCheckpointArrivalsTable,
  liabilityWaiverSignaturesTable,
  addonPaymentsTable,
  clubSellItemsTable,
} from "@workspace/db";
import { canonicalizeCrossingTimestamp } from "../lib/crossingTimestamp";
import { resolveSyncUser, canReceivePasswordHashes, type SyncUser } from "../lib/offlineSyncAccess";
import { clubSettingsTable, readersTable, tracksTable, trackCoursePointsTable } from "@workspace/db";
import { sendLiabilityWaiverConfirmation } from "../lib/email";
import { checkAcknowledgement, checkBrands, checkDefaultClasses, checkPdfUrl, checkWaiverFields } from "../lib/clubSettingsInput";
import { recomputeEnduroPositionsForEvent } from "./enduro-scoring";
import { syncEventPublication } from "../lib/resultsVisibility";
import { notifyFollowersOfResults } from "../lib/riderCareer";
import { alertFollowersUpNext, alertFollowersMotoStarted } from "../lib/raceStartAlerts";
import { sendRaceDayStats } from "../lib/raceDayStats";
import { queueRaceGasCredits } from "../lib/raceGasCredits";
import { teamMemberRiderId } from "../lib/teams";
import { practiceCourseFor, resolveTrackId } from "../lib/trackCourse";
import { rentalTranspondersTable } from "@workspace/db";
import { newOrgPushContext, ORG_PUSH_CAPABILITY, pushOrgAfterEvents, pushOrgBeforeEvents, usableCategoryId, usableScoringTableId, type OrgPushContext } from "../lib/desktopOrgPush";
import { rentalsOut } from "./rental-transponders";
import { recalculateSeriesPoints, scoreMotoPoints } from "./results";
import { motoNeedsScoringAfterPush, positionsNeedSorting } from "../lib/motoPoints";
import { rescoreUsers } from "./points-tables";

const router = Router();

/** Older desktop releases still send the retired "mylaps" name for active timing. */
const currentTimingTechnology = (value: unknown) => (String(value) === "mylaps" ? "active_transponder" : String(value));

// ─── Auth helper ─────────────────────────────────────────────────────────────

/** Session or Bearer offline-sync-token caller, limited to users allowed to use offline sync. */
async function resolveClubUser(req: any, _clubId: number): Promise<SyncUser | null> {
  return resolveSyncUser(req);
}

function toDate(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

function firstDefined(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

// ─── POST /clubs/:clubId/desktop-push ────────────────────────────────────────
// Receives batched writes from the Electron desktop app's write queue.

router.post("/clubs/:clubId/desktop-push", async (req, res) => {
  const clubId = Number(req.params.clubId);
  if (isNaN(clubId)) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });

  const user = await resolveClubUser(req, clubId);
  if (!user || user.clubId !== clubId) {
    return res.status(403).json({ error: "This club isn't on your account. Sign in with an organizer account for this club." });
  }

  const payload = req.body as Record<string, Record<string, unknown>[]>;
  const results: Record<string, number> = {};
  let total = 0;
  const affectedMotoIds = new Set<number>();
  const startedMotoIds = new Set<number>();
  // Races the desktop finished in this push, by event (latest finish time): the
  // next race is up next, so followers of its riders get a race start alert.
  const finishedRaceByEvent = new Map<number, Date>();
  // Events whose motos were finalized or reopened on the desktop.
  const finalizeEventIds = new Set<number>();
  const eventIdRemaps: Array<{ localId: number; cloudId: number }> = [];
  const motoIdRemaps: Array<{ localId: number; cloudId: number }> = [];
  // Desktop ids that had to be replaced in the cloud (id collision with another
  // club's row). Child rows in the same push are rewritten through these maps.
  const eventIdMap = new Map<number, number>();
  const motoIdMap = new Map<number, number>();
  const mapEventId = (raw: unknown) => { const n = Number(raw); return eventIdMap.get(n) ?? n; };
  const mapMotoId = (raw: unknown) => { const n = Number(raw); return motoIdMap.get(n) ?? n; };
  // Rows that were NOT applied, reported back so they aren't silently lost.
  const skipped: Record<string, Array<{ id: number | null; reason: string }>> = {};
  const skip = (table: string, row: { id?: unknown }, reason: string) => {
    const id = row.id != null && Number(row.id) > 0 ? Number(row.id) : null;
    (skipped[table] ??= []).push({ id, reason });
  };
  // Tables that received explicit (desktop-supplied) ids; their serial sequences
  // are advanced at the end so later cloud inserts don't hit duplicate keys.
  const explicitIdTables = new Set<string>();
  // Follow-up work done after the transaction commits.
  let pushedEnduroEventIds = new Set<number>();
  // Club setup pushed from the desktop (profile, scoring tables, series, discounts, sell items, rentals).
  let org: OrgPushContext | null = null;
  let pushedWaiverEmails: Array<{ to: string; signerName: string; eventId: number; signedAt: Date; contentHash: string; waiverSnapshot: string }> = [];

  await db.transaction(async (tx) => {
    const clubEventCache = new Map<number, boolean>();
    /** The event exists and belongs to the pushing club. */
    const isClubEvent = async (eventId: number): Promise<boolean> => {
      if (!eventId) return false;
      const cached = clubEventCache.get(eventId);
      if (cached !== undefined) return cached;
      const [ev] = await tx.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
      const ok = !!ev && ev.clubId === clubId;
      clubEventCache.set(eventId, ok);
      return ok;
    };
    /** The moto exists and belongs to this (club-owned) event. */
    const motoInEvent = async (motoId: number, eventId: number): Promise<boolean> => {
      const [m] = await tx.select({ eventId: motosTable.eventId }).from(motosTable).where(eq(motosTable.id, motoId));
      return !!m && m.eventId === eventId;
    };
    /** True when no row (of any club) already uses this id, so the desktop id can be kept. */
    const idIsFree = async (table: any, id: number): Promise<boolean> => {
      const [row] = await tx.select({ id: table.id }).from(table).where(eq(table.id, id));
      return !row;
    };
    // Order matters: events (incl. id-collision remaps) first, then motos, so child
    // rows created on the desktop in the same push find their parents and can be
    // rewritten through the remaps instead of being dropped.
    // ── event deletes (deletions made on desktop) ────────────────────────────
    const deletes = (payload["_deletes"] ?? {}) as unknown as Record<string, unknown>;
    const eventIdsToDelete = ((deletes["events"] ?? []) as unknown[]).map(Number).filter(Boolean);
    let eventsDeleted = 0;
    for (const eventId of eventIdsToDelete) {
      const [ev] = await tx.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
      if (!ev || ev.clubId !== clubId) { skip("events_deleted", { id: eventId }, "event not found for this club"); continue; }
      // Signed liability waivers are kept, so an event that has any is not deleted.
      const [signedWaiver] = await tx.select({ id: liabilityWaiverSignaturesTable.id })
        .from(liabilityWaiverSignaturesTable).where(eq(liabilityWaiverSignaturesTable.eventId, eventId)).limit(1);
      if (signedWaiver) { skip("events_deleted", { id: eventId }, "event has signed liability waivers"); continue; }
      // An event with a finished race keeps its results (same rule as the website's delete).
      const [finishedRace] = await tx.select({ id: motosTable.id }).from(motosTable)
        .where(and(eq(motosTable.eventId, eventId), eq(motosTable.status, "completed"))).limit(1);
      if (finishedRace) { skip("events_deleted", { id: eventId }, "event has a finished race"); continue; }
      await tx.delete(eventReaderAssignmentsTable).where(eq(eventReaderAssignmentsTable.eventId, eventId));
      await tx.delete(enduroCheckpointArrivalsTable).where(eq(enduroCheckpointArrivalsTable.eventId, eventId));
      await tx.delete(enduroTimeChecksTable).where(eq(enduroTimeChecksTable.eventId, eventId));
      await tx.delete(raceResultsTable).where(eq(raceResultsTable.eventId, eventId));
      await tx.delete(splitCrossingsTable).where(eq(splitCrossingsTable.eventId, eventId));
      await tx.delete(lapCrossingsTable).where(eq(lapCrossingsTable.eventId, eventId));
      await tx.delete(motosTable).where(eq(motosTable.eventId, eventId));
      await tx.delete(checkinsTable).where(eq(checkinsTable.eventId, eventId));
      await tx.delete(registrationsTable).where(eq(registrationsTable.eventId, eventId));
      await tx.delete(rfidAssignmentsTable).where(eq(rfidAssignmentsTable.eventId, eventId));
      await tx.delete(compCodesTable).where(eq(compCodesTable.eventId, eventId));
      await tx.delete(eventPublicationTable).where(eq(eventPublicationTable.eventId, eventId));
      await tx.delete(eventsTable).where(eq(eventsTable.id, eventId));
      clubEventCache.delete(eventId);
      eventsDeleted++;
    }
    if (eventsDeleted > 0) {
      results["events_deleted"] = eventsDeleted;
      total += eventsDeleted;
    }

    // ── tracks (Track Library rows made, edited or removed on the desktop) ────
    // Before events, so an event pushed with a new track finds it. Safe to
    // repeat: a track is matched by its id, else by its name in this club.
    for (const trackId of ((deletes["tracks"] ?? []) as unknown[]).map(Number).filter(Boolean)) {
      const [row] = await tx.select({ id: tracksTable.id }).from(tracksTable)
        .where(and(eq(tracksTable.id, trackId), eq(tracksTable.clubId, clubId)));
      if (!row) continue; // already removed
      // Same as DELETE /tracks/:id: its events and practices keep their course copy.
      await tx.update(eventsTable).set({ trackId: null, courseSource: "custom" })
        .where(and(eq(eventsTable.trackId, trackId), eq(eventsTable.clubId, clubId)));
      await tx.update(practiceSessionsTable).set({ trackId: null })
        .where(and(eq(practiceSessionsTable.trackId, trackId), eq(practiceSessionsTable.clubId, clubId)));
      await tx.delete(tracksTable).where(eq(tracksTable.id, trackId));
      results["tracks_deleted"] = (results["tracks_deleted"] ?? 0) + 1;
      total++;
    }
    let tracksUpserted = 0;
    for (const t of (payload["tracks"] ?? []) as Array<Record<string, unknown>>) {
      const trackId = Number(t.id);
      const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "") || null;
      const name = text(t.name, 120);
      if (!trackId || !name) { skip("tracks", t as { id?: unknown }, "missing id or name"); continue; }
      const fields = { name, address: text(t.address, 200), city: text(t.city, 80), state: text(t.state, 40), zip: text(t.zip, 20) };
      const clubTracks = await tx.select({ id: tracksTable.id, name: tracksTable.name }).from(tracksTable).where(eq(tracksTable.clubId, clubId));
      const sameName = clubTracks.find(c => c.name.toLowerCase() === name.toLowerCase());
      const sameId = clubTracks.find(c => c.id === trackId);
      if (sameId) {
        if (sameName && sameName.id !== trackId) { skip("tracks", t as { id?: unknown }, "another track in the library already has this name"); continue; }
        await tx.update(tracksTable).set(fields).where(eq(tracksTable.id, trackId));
      } else if (sameName) {
        // The same track was added on the website too: keep that one, with the desktop's address.
        await tx.update(tracksTable).set(fields).where(eq(tracksTable.id, sameName.id));
      } else if (await idIsFree(tracksTable, trackId)) {
        await tx.insert(tracksTable).values({ id: trackId, clubId, ...fields }).onConflictDoNothing();
        explicitIdTables.add("tracks");
      } else {
        await tx.insert(tracksTable).values({ clubId, ...fields });
      }
      tracksUpserted++;
    }
    if (tracksUpserted > 0) { results["tracks"] = tracksUpserted; total += tracksUpserted; }

    // ── club_settings (Club Settings saved on the desktop; one row, id = club id) ─
    for (const row of (payload["club_settings"] ?? []) as Array<Record<string, unknown>>) {
      if (Number(row.id) !== clubId) { skip("club_settings", row as { id?: unknown }, "settings belong to another club"); continue; }
      const json = (v: unknown) => { if (typeof v !== "string") return v ?? null; try { return JSON.parse(v); } catch { return null; } };
      // The same checks as PUT /clubs/:clubId/settings; a value that fails one is left as it is.
      const checked: Array<[string, { ok: true; value: unknown } | { ok: false; error: string }]> = [
        ["riderAcknowledgement", checkAcknowledgement(row.rider_acknowledgement ?? null)],
        ["waiverPdfUrl", checkPdfUrl(row.waiver_pdf_url ?? null, "acknowledgement form")],
        ["liabilityWaiverText", checkAcknowledgement(row.liability_waiver_text ?? null)],
        ["liabilityWaiverPdfUrl", checkPdfUrl(row.liability_waiver_pdf_url ?? null, "liability waiver")],
        ["liabilityWaiverFields", checkWaiverFields(json(row.liability_waiver_fields))],
        ["defaultClasses", checkDefaultClasses(json(row.default_classes) ?? [])],
        ["brandContingencies", checkBrands(json(row.brand_contingencies) ?? [])],
      ];
      const set: Record<string, unknown> = {
        trackName: typeof row.track_name === "string" && row.track_name.trim() ? row.track_name.trim().slice(0, 120) : null,
      };
      for (const [key, result] of checked) if (result.ok) set[key] = result.value;
      await tx.insert(clubSettingsTable).values({ clubId, ...set } as any)
        .onConflictDoUpdate({ target: clubSettingsTable.clubId, set: set as any });
      results["club_settings"] = 1;
      total++;
    }

    // ── club setup that events refer to (scoring tables, discount categories…) ─
    const orgPush = newOrgPushContext({ tx, clubId, user, payload, deletes, results, skip, mapEventId });
    org = orgPush;
    await pushOrgBeforeEvents(orgPush);

    // ── events (full field updates made on desktop) ───────────────────────────
    // Desktop queue sends raw SQLite rows (snake_case).  Accept every field the
    // organizer can edit in the desktop app so changes like race date, name, and
    // location survive the next sync-pull.
    const events = (payload["events"] ?? []) as Array<Record<string, unknown>>;

    let eventsUpserted = 0;
    for (const e of events) {
      const eventId = Number(e.id);
      if (!eventId) { skip("events", e, "missing id"); continue; }
      // The event's scoring table and entry-fee category, under their cloud ids.
      // undefined: not one this club can use (left as the cloud has it).
      const scoringTableRef = e.scoring_table_id === undefined ? undefined : await usableScoringTableId(orgPush, e.scoring_table_id);
      const feeCategoryRef = e.entry_fee_category_id === undefined ? undefined : await usableCategoryId(orgPush, e.entry_fee_category_id);

      // Helper: parse a SQLite JSON string stored in e into the proper JS type.
      const parseEventFields = () => {
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
        return { raceClasses, raceClassLimits, purchaseOptions };
      };

      /**
       * Event fields the desktop learned to save later. Each is applied only when
       * the desktop's row carries a value, so an older desktop (or a column it has
       * not pulled yet) never blanks what the cloud has.
       */
      const extraEventFields = (): Record<string, unknown> => {
        const out: Record<string, unknown> = {};
        const json = (v: unknown): unknown => {
          if (typeof v !== "string") return v;
          try { return JSON.parse(v); } catch { return undefined; }
        };
        const money = (v: unknown) => (v === "" ? null : Number(v) || null);
        if (e.end_date !== undefined) out.endDate = e.end_date ? String(e.end_date).substring(0, 10) : null;
        if (e.race_style != null) out.raceStyle = String(e.race_style);
        if (e.rfid_sticker_fee !== undefined) out.rfidStickerFee = e.rfid_sticker_fee == null ? null : money(e.rfid_sticker_fee);
        if (e.early_bird_fee !== undefined) out.earlyBirdFee = e.early_bird_fee == null ? null : money(e.early_bird_fee);
        if (e.early_bird_ends_at !== undefined) out.earlyBirdEndsAt = e.early_bird_ends_at ? String(e.early_bird_ends_at).substring(0, 10) : null;
        for (const [col, key] of [
          ["require_waiver", "requireWaiver"], ["require_liability_waiver", "requireLiabilityWaiver"],
          ["require_transponder", "requireTransponder"], ["group_race", "groupRace"],
          ["quick_checkin_enabled", "quickCheckinEnabled"],
        ] as const) {
          if (e[col] != null) out[key] = !!Number(e[col]) || e[col] === true;
        }
        if (e.riders_per_group != null) out.ridersPerGroup = Number(e.riders_per_group) || null;
        for (const [col, key] of [
          ["race_class_details", "raceClassDetails"], ["race_class_series_map", "raceClassSeriesMap"],
          ["class_order", "classOrder"], ["contingency_brands", "contingencyBrands"],
          ["quick_checkin_requirements", "quickCheckinRequirements"],
        ] as const) {
          if (e[col] == null) continue;
          const parsed = json(e[col]);
          if (parsed !== undefined && parsed !== null && typeof parsed === "object") out[key] = parsed;
        }
        if (e.street_address != null) out.streetAddress = String(e.street_address);
        if (e.zip != null) out.zip = String(e.zip);
        if (e.track_lat != null && Number.isFinite(Number(e.track_lat))) out.trackLat = Number(e.track_lat);
        if (e.track_lng != null && Number.isFinite(Number(e.track_lng))) out.trackLng = Number(e.track_lng);
        return out;
      };

      const buildEventValues = (withId: number | null) => {
        const { raceClasses, raceClassLimits, purchaseOptions } = parseEventFields();
        const row: Record<string, unknown> = {
          ...(withId !== null ? { id: withId } : {}),
          clubId,
          name:                     e.name       != null ? String(e.name)       : "Untitled Event",
          date:                     e.date       != null ? String(e.date)       : new Date().toISOString().slice(0, 10),
          state:                    e.state      != null ? String(e.state)      : "",
          location:                 e.location   != null ? String(e.location)   : null,
          trackName:                e.track_name != null ? String(e.track_name) : null,
          status:                   e.status     != null ? String(e.status)     : "draft",
          raceClasses,
          raceClassLimits,
          purchaseOptions,
          paymentEnabled:           !!e.payment_enabled,
          requireAma:               !!e.require_ama,
          entryFee:                 e.entry_fee             != null ? Number(e.entry_fee)             || null : null,
          maxRiders:                e.max_riders            != null ? Number(e.max_riders)            || null : null,
          timingTechnology:         e.timing_technology     != null ? currentTimingTechnology(e.timing_technology) : "rfid",
          transponderRentalEnabled: !!e.transponder_rental_enabled,
          transponderRentalFee:     e.transponder_rental_fee != null ? Number(e.transponder_rental_fee) || null : null,
          noDuplicateBibs:          !!e.no_duplicate_bibs,
          requireClubId:            !!e.require_club_id,
          scoringTableId:           scoringTableRef ?? null,
          entryFeeCategoryId:       feeCategoryRef ?? null,
          minLapMs:                 e.min_lap_ms            != null ? Number(e.min_lap_ms)            || null : null,
          registrationOpen:         e.registration_open  != null ? String(e.registration_open)  : null,
          registrationClose:        e.registration_close != null ? String(e.registration_close) : null,
          imageUrl:                 e.image_url   != null ? String(e.image_url)   : null,
          amaEventId:               e.ama_event_id != null ? String(e.ama_event_id) : null,
          ...extraEventFields(),
        };
        return { row, ...parseEventFields() };
      };

      const [event] = await tx
        .select({ clubId: eventsTable.clubId })
        .from(eventsTable)
        .where(eq(eventsTable.id, eventId));

      if (!event) {
        // New event created on desktop — insert into cloud with the desktop's id.
        // onConflictDoUpdate handles idempotent retries after a partial failure.
        // setWhere ensures we never overwrite another club's event in a race.
        const { row, raceClasses, raceClassLimits, purchaseOptions } = buildEventValues(eventId);
        await tx.insert(eventsTable).values(row as any)
          .onConflictDoUpdate({
            target: eventsTable.id,
            set: {
              name:                     row.name                     as string,
              date:                     row.date                     as string,
              state:                    row.state                    as string,
              location:                 row.location                 as string | null,
              trackName:                row.trackName                as string | null,
              status:                   row.status                   as string,
              raceClasses,
              raceClassLimits,
              purchaseOptions,
              paymentEnabled:           row.paymentEnabled           as boolean,
              requireAma:               row.requireAma               as boolean,
              entryFee:                 row.entryFee                 as number | null,
              maxRiders:                row.maxRiders                as number | null,
              timingTechnology:         row.timingTechnology         as string,
              transponderRentalEnabled: row.transponderRentalEnabled as boolean,
              transponderRentalFee:     row.transponderRentalFee     as number | null,
              noDuplicateBibs:          row.noDuplicateBibs          as boolean,
              requireClubId:            row.requireClubId            as boolean,
              scoringTableId:           row.scoringTableId           as number | null,
              entryFeeCategoryId:       row.entryFeeCategoryId       as number | null,
              minLapMs:                 row.minLapMs                 as number | null,
              registrationOpen:         row.registrationOpen         as string | null,
              registrationClose:        row.registrationClose        as string | null,
              imageUrl:                 row.imageUrl                 as string | null,
              amaEventId:               row.amaEventId               as string | null,
              ...extraEventFields(),
            } as any,
            setWhere: eq(eventsTable.clubId, clubId),
          });
        explicitIdTables.add("events");
        clubEventCache.delete(eventId);
        eventsUpserted++;
        continue;
      }

      if (event.clubId !== clubId) {
        // ID collision: this exact id belongs to a different club in the cloud.
        // Let Postgres assign a fresh id so neither club's event is lost.
        // Return the mapping so the desktop can update its local SQLite.
        const { row } = buildEventValues(null);
        const [remapped] = await tx
          .insert(eventsTable)
          .values(row as any)
          .returning({ id: eventsTable.id });
        if (remapped?.id) {
          eventIdRemaps.push({ localId: eventId, cloudId: remapped.id });
          eventIdMap.set(eventId, remapped.id);
          req.log.info({ clubId, localId: eventId, cloudId: remapped.id }, "event id collision — remapped");
          eventsUpserted++;
        }
        continue;
      }

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
      if (e.date     != null) updateSet.date      = String(e.date).substring(0, 10);
      if (e.location != null) updateSet.location  = String(e.location);
      if (e.state    != null) updateSet.state     = String(e.state);
      if (e.track_name != null) updateSet.trackName = String(e.track_name);
      if (e.registration_open  != null) updateSet.registrationOpen  = String(e.registration_open);
      if (e.registration_close != null) updateSet.registrationClose = String(e.registration_close);
      if (e.payment_enabled != null) updateSet.paymentEnabled = !!e.payment_enabled;
      if (e.require_ama     != null) updateSet.requireAma     = !!e.require_ama;
      if (e.entry_fee  != null) updateSet.entryFee  = Number(e.entry_fee) || null;
      if (e.max_riders != null) updateSet.maxRiders = Number(e.max_riders) || null;
      if (e.timing_technology != null) updateSet.timingTechnology = currentTimingTechnology(e.timing_technology);
      if (e.transponder_rental_enabled != null) updateSet.transponderRentalEnabled = !!e.transponder_rental_enabled;
      if (e.transponder_rental_fee != null) updateSet.transponderRentalFee = Number(e.transponder_rental_fee) || null;
      if (e.no_duplicate_bibs != null) updateSet.noDuplicateBibs = !!e.no_duplicate_bibs;
      if (e.require_club_id != null) updateSet.requireClubId = !!e.require_club_id;
      // Like the other event fields, only a value is applied: an empty one never
      // blanks what the website has (it may have been set there since the last pull).
      if (scoringTableRef != null) updateSet.scoringTableId = scoringTableRef;
      if (feeCategoryRef != null) updateSet.entryFeeCategoryId = feeCategoryRef;
      if (e.min_lap_ms != null) updateSet.minLapMs = Number(e.min_lap_ms) || null;
      if (e.image_url  != null) updateSet.imageUrl  = String(e.image_url);
      if (e.ama_event_id != null) updateSet.amaEventId = String(e.ama_event_id);
      if (e.race_style !== undefined) {
        updateSet.raceStyle = e.race_style === null ? null : String(e.race_style);
      }
      Object.assign(updateSet, extraEventFields());

      if (Object.keys(updateSet).length === 0) continue;

      await tx
        .update(eventsTable)
        .set(updateSet as any)
        .where(eq(eventsTable.id, eventId));
      eventsUpserted++;
    }
    results["events"] = eventsUpserted;
    total += eventsUpserted;

    // ── motos (status / start / complete / reorder updates) ───────────────────
    const motos = (payload["motos"] ?? []) as Array<{
      id?: unknown;
      event_id?: unknown;
      eventId?: unknown;
      name?: unknown;
      type?: unknown;
      race_class?: unknown;
      raceClass?: unknown;
      moto_number?: unknown;
      motoNumber?: unknown;
      status?: unknown;
      started_at?: unknown;
      startedAt?: unknown;
      completed_at?: unknown;
      completedAt?: unknown;
      lineup?: unknown;
      lap_count?: unknown;
      lapCount?: unknown;
      time_limit_ms?: unknown;
      timeLimitMs?: unknown;
      plus_laps?: unknown;
      plusLaps?: unknown;
      time_expired_at?: unknown;
      timeExpiredAt?: unknown;
      scheduled_time?: unknown;
      scheduledTime?: unknown;
      staggered_group_id?: unknown;
      staggeredGroupId?: unknown;
      staggered_order?: unknown;
      staggeredOrder?: unknown;
      results_finalized_at?: unknown;
      resultsFinalizedAt?: unknown;
    }>;

    let motosUpserted = 0;
    for (const m of motos) {
      const rawMoto = m as Record<string, unknown>;
      const eventId  = mapEventId(firstDefined(rawMoto, "event_id", "eventId"));
      let clientId = m.id != null && Number(m.id) > 0 ? Number(m.id) : undefined;
      if (!eventId) { skip("motos", m, "missing event_id"); continue; }

      if (!await isClubEvent(eventId)) { skip("motos", m, "event not found for this club"); continue; }

      const rawMotoNumber = firstDefined(rawMoto, "moto_number", "motoNumber");
      const motoNumber  = rawMotoNumber != null ? Number(rawMotoNumber) : 0;
      const incomingStatus = m.status !== undefined ? String(m.status) : undefined;
      const rawStartedAt = firstDefined(rawMoto, "started_at", "startedAt");
      const rawCompletedAt = firstDefined(rawMoto, "completed_at", "completedAt");
      const rawLapCount = firstDefined(rawMoto, "lap_count", "lapCount");
      const rawTimeLimitMs = firstDefined(rawMoto, "time_limit_ms", "timeLimitMs");
      const rawPlusLaps = firstDefined(rawMoto, "plus_laps", "plusLaps");
      const rawTimeExpiredAt = firstDefined(rawMoto, "time_expired_at", "timeExpiredAt");
      const rawScheduledTime = firstDefined(rawMoto, "scheduled_time", "scheduledTime");
      const rawStaggeredGroupId = firstDefined(rawMoto, "staggered_group_id", "staggeredGroupId");
      const rawStaggeredOrder = firstDefined(rawMoto, "staggered_order", "staggeredOrder");
      // Combined start (classes sharing a gate). Older desktops don't send it: leave it alone then.
      const rawCombinedStart = firstDefined(rawMoto, "combined_start", "combinedStart");
      const rawPausedAt = firstDefined(rawMoto, "paused_at", "pausedAt");
      const rawTotalPausedMs = firstDefined(rawMoto, "total_paused_ms", "totalPausedMs");
      const rawResultsFinalizedAt = firstDefined(rawMoto, "results_finalized_at", "resultsFinalizedAt");
      const requestedLapCount = rawLapCount === undefined ? undefined : (rawLapCount === null ? null : Number(rawLapCount));
      const requestedTimeLimitMs = rawTimeLimitMs === undefined ? undefined : (rawTimeLimitMs === null ? null : Number(rawTimeLimitMs));
      const requestedPlusLaps = rawPlusLaps === undefined ? undefined : (rawPlusLaps === null ? null : Number(rawPlusLaps));

      let timingError: string | null = null;
      if (requestedLapCount !== undefined && requestedLapCount !== null && (!Number.isInteger(requestedLapCount) || requestedLapCount <= 0)) {
        timingError = "lapCount must be a positive integer";
      } else if (requestedTimeLimitMs !== undefined && requestedTimeLimitMs !== null && (!Number.isInteger(requestedTimeLimitMs) || requestedTimeLimitMs <= 0)) {
        timingError = "timeLimitMs must be a positive integer";
      } else if (requestedLapCount != null && requestedTimeLimitMs != null) {
        timingError = "lapCount and timeLimitMs are mutually exclusive";
      } else if (requestedPlusLaps !== undefined && requestedPlusLaps !== null && (!Number.isInteger(requestedPlusLaps) || requestedPlusLaps < 0)) {
        timingError = "plusLaps must be a nonnegative integer for a timed race";
      }

      const timeExpiredAt = rawTimeExpiredAt === undefined || rawTimeExpiredAt === null
        ? rawTimeExpiredAt
        : toDate(rawTimeExpiredAt);
      if (rawTimeExpiredAt !== undefined && rawTimeExpiredAt !== null && timeExpiredAt === null) {
        timingError = "timeExpiredAt must be a valid date";
      }
      if (timingError) {
        req.log.warn({ clubId, motoId: clientId, error: timingError }, "desktop-push skipped invalid moto");
        skip("motos", m, timingError);
        continue;
      }

      // Prefer lookup by id — this is stable across drag-and-drop reorders.
      // Falling back to (eventId, motoNumber) when there is no client id is
      // safe for legacy payloads; it must NOT be used when clientId is present
      // because after a reorder the moto_number has changed on desktop but the
      // cloud still holds the old value, so the lookup would find the wrong row.
      let existing: {
        id: number;
        status: string;
        lapCount: number | null;
        timeLimitMs: number | null;
        plusLaps: number | null;
      } | undefined;
      // Set when the desktop's moto id belongs to another club's moto (offline id collision).
      let collidedLocalId: number | undefined;
      if (clientId) {
        const [byId] = await tx
          .select({
            id: motosTable.id,
            status: motosTable.status,
            lapCount: motosTable.lapCount,
            timeLimitMs: motosTable.timeLimitMs,
            plusLaps: motosTable.plusLaps,
            eventClubId: eventsTable.clubId,
          })
          .from(motosTable)
          .innerJoin(eventsTable, eq(eventsTable.id, motosTable.eventId))
          .where(eq(motosTable.id, clientId));
        if (byId && byId.eventClubId !== clubId) {
          // Never update another club's moto. Re-use this event's moto with the same
          // number if an earlier push already remapped it; otherwise insert a new one
          // without the id and report the remap.
          collidedLocalId = clientId;
          clientId = undefined;
          [existing] = await tx
            .select({
              id: motosTable.id,
              status: motosTable.status,
              lapCount: motosTable.lapCount,
              timeLimitMs: motosTable.timeLimitMs,
              plusLaps: motosTable.plusLaps,
            })
            .from(motosTable)
            .where(and(eq(motosTable.eventId, eventId), eq(motosTable.motoNumber, motoNumber)));
        } else if (byId) {
          existing = byId;
        } else if (!await idIsFree(motosTable, clientId)) {
          collidedLocalId = clientId;
          clientId = undefined;
        }
      } else {
        [existing] = await tx
          .select({
            id: motosTable.id,
            status: motosTable.status,
            lapCount: motosTable.lapCount,
            timeLimitMs: motosTable.timeLimitMs,
            plusLaps: motosTable.plusLaps,
          })
          .from(motosTable)
          .where(and(eq(motosTable.eventId, eventId), eq(motosTable.motoNumber, motoNumber)));
      }

      let resultingLapCount = requestedLapCount === undefined ? existing?.lapCount ?? null : requestedLapCount;
      let resultingTimeLimitMs = requestedTimeLimitMs === undefined ? existing?.timeLimitMs ?? null : requestedTimeLimitMs;
      if (requestedLapCount != null) resultingTimeLimitMs = null;
      if (requestedTimeLimitMs != null) resultingLapCount = null;
      const resultingPlusLaps = resultingTimeLimitMs !== null
        ? (requestedPlusLaps === undefined
            ? (requestedTimeLimitMs != null ? 1 : existing?.plusLaps ?? 1)
            : requestedPlusLaps ?? 1)
        : null;
      if (resultingPlusLaps !== null && (!Number.isInteger(resultingPlusLaps) || resultingPlusLaps < 0)) {
        req.log.warn(
          { clubId, motoId: clientId, error: "Enter extra laps as a whole number (0 or more)." },
          "desktop-push skipped invalid moto",
        );
        continue;
      }
      if (requestedPlusLaps != null && resultingTimeLimitMs === null) {
        req.log.warn(
          { clubId, motoId: clientId, error: "Extra laps only apply to timed races. Set a time limit first, or remove the extra laps." },
          "desktop-push skipped invalid moto",
        );
        continue;
      }

      if (existing) {
        if (existing.status !== "in_progress" && incomingStatus === "in_progress") {
          startedMotoIds.add(existing.id);
        }
        if (existing.status !== "completed" && incomingStatus === "completed") {
          const finishedAt = rawCompletedAt != null ? toDate(rawCompletedAt) : new Date();
          const prev = finishedRaceByEvent.get(eventId);
          if (finishedAt && (!prev || finishedAt > prev)) finishedRaceByEvent.set(eventId, finishedAt);
        }
        let lineup: number[] | undefined;
        if (m.lineup !== undefined) {
          try { lineup = JSON.parse(String(m.lineup)) as number[]; } catch { lineup = []; }
        }
        const updateSet: Record<string, unknown> = {};
        if (m.status              !== undefined) updateSet.status       = String(m.status);
        if (rawStartedAt          !== undefined) updateSet.startedAt    = rawStartedAt === null ? null : toDate(rawStartedAt);
        if (rawCompletedAt        !== undefined) updateSet.completedAt  = rawCompletedAt === null ? null : toDate(rawCompletedAt);
        if (rawMotoNumber         != null)  updateSet.motoNumber        = motoNumber;
        if (m.name                != null)  updateSet.name              = String(m.name);
        if (rawLapCount !== undefined || rawTimeLimitMs !== undefined || rawPlusLaps !== undefined) {
          updateSet.lapCount = resultingLapCount;
          updateSet.timeLimitMs = resultingTimeLimitMs;
          updateSet.plusLaps = resultingPlusLaps;
        }
        if (rawTimeExpiredAt      !== undefined) updateSet.timeExpiredAt = timeExpiredAt;
        if (rawScheduledTime      !== undefined) updateSet.scheduledTime = rawScheduledTime === null ? null : String(rawScheduledTime);
        if (lineup !== undefined)           updateSet.lineup            = lineup;
        if (rawStaggeredGroupId   != null)  updateSet.staggeredGroupId  = Number(rawStaggeredGroupId);
        else if (rawStaggeredGroupId === null) updateSet.staggeredGroupId = null;
        if (rawStaggeredOrder     != null)  updateSet.staggeredOrder    = Number(rawStaggeredOrder);
        else if (rawStaggeredOrder === null)    updateSet.staggeredOrder = null;
        if (rawCombinedStart !== undefined) updateSet.combinedStart = rawCombinedStart === true || Number(rawCombinedStart) === 1;
        if (rawPausedAt !== undefined) updateSet.pausedAt = rawPausedAt === null ? null : toDate(rawPausedAt);
        if (rawTotalPausedMs != null && Number.isFinite(Number(rawTotalPausedMs))) {
          updateSet.totalPausedMs = Math.max(0, Math.round(Number(rawTotalPausedMs)));
        }
        // Finalized on the desktop (official results) or reopened there.
        if (rawResultsFinalizedAt !== undefined) {
          updateSet.resultsFinalizedAt = rawResultsFinalizedAt === null ? null : toDate(rawResultsFinalizedAt);
          finalizeEventIds.add(eventId);
        }
        if (Object.keys(updateSet).length > 0) {
          await tx
            .update(motosTable)
            .set(updateSet as any)
            .where(eq(motosTable.id, existing.id));
        }
        affectedMotoIds.add(existing.id);
        if (collidedLocalId) {
          motoIdMap.set(collidedLocalId, existing.id);
          motoIdRemaps.push({ localId: collidedLocalId, cloudId: existing.id });
        }
      } else {
        let lineup: number[] = [];
        try { lineup = JSON.parse(String(m.lineup ?? "[]")) as number[]; } catch { /* ignore */ }

        const [inserted] = await tx.insert(motosTable).values({
          ...(clientId ? { id: clientId } : {}),
          eventId,
          name:             m.name != null ? String(m.name) : "",
          type:             m.type != null ? String(m.type) : "moto",
          raceClass:        firstDefined(rawMoto, "race_class", "raceClass") != null ? String(firstDefined(rawMoto, "race_class", "raceClass")) : "",
          motoNumber,
          scheduledTime:    rawScheduledTime != null ? String(rawScheduledTime) : null,
          lineup,
          lapCount:         resultingLapCount,
          timeLimitMs:      resultingTimeLimitMs,
          plusLaps:         resultingPlusLaps,
          timeExpiredAt:    timeExpiredAt === undefined ? null : timeExpiredAt,
          status:           String(m.status ?? "scheduled"),
          startedAt:        rawStartedAt == null ? null : toDate(rawStartedAt),
          completedAt:      rawCompletedAt == null ? null : toDate(rawCompletedAt),
          staggeredGroupId: rawStaggeredGroupId != null ? Number(rawStaggeredGroupId) : null,
          staggeredOrder:   rawStaggeredOrder    != null ? Number(rawStaggeredOrder)    : null,
          combinedStart:    rawCombinedStart === true || Number(rawCombinedStart) === 1,
          pausedAt:         rawPausedAt == null ? null : toDate(rawPausedAt),
          totalPausedMs:    rawTotalPausedMs != null && Number.isFinite(Number(rawTotalPausedMs))
            ? Math.max(0, Math.round(Number(rawTotalPausedMs))) : 0,
          resultsFinalizedAt: rawResultsFinalizedAt == null ? null : toDate(rawResultsFinalizedAt),
        }).returning({ id: motosTable.id });
        if (rawResultsFinalizedAt != null) finalizeEventIds.add(eventId);
        if (clientId) explicitIdTables.add("motos");
        if (inserted) {
          affectedMotoIds.add(inserted.id);
          if (incomingStatus === "in_progress") startedMotoIds.add(inserted.id);
          if (collidedLocalId) {
            motoIdMap.set(collidedLocalId, inserted.id);
            motoIdRemaps.push({ localId: collidedLocalId, cloudId: inserted.id });
            req.log.info({ clubId, localId: collidedLocalId, cloudId: inserted.id }, "moto id collision — remapped");
          }
        }
      }
      motosUpserted++;
    }
    results["motos"] = motosUpserted;
    total += motosUpserted;

    // ── lap_crossings ─────────────────────────────────────────────────────────
    const crossings = (payload["lap_crossings"] ?? []) as Array<{
      id?: unknown;
      event_id: unknown;
      moto_id: unknown;
      rfid_number: unknown;
      crossing_time: unknown;
      created_at?: unknown;
      lap_number: unknown;
      lap_time_ms: unknown;
      rider_id?: unknown;
      reader_id?: unknown;
      antenna_id?: unknown;
    }>;

    let crossingsUpserted = 0;
    const previousImportedCrossing = new Map<string, Date>();
    const repairedImportedLaps = new Map<string, number[]>();
    const skewedImportedRiders = new Set<string>();
    const orderedCrossings = [...crossings].sort((a, b) =>
      Number(a.moto_id) - Number(b.moto_id)
      || String(a.rfid_number ?? "").localeCompare(String(b.rfid_number ?? ""))
      || Number(a.lap_number) - Number(b.lap_number)
      || Number(a.id ?? 0) - Number(b.id ?? 0));
    for (const c of orderedCrossings) {
      const eventId = mapEventId(c.event_id);
      const motoId  = mapMotoId(c.moto_id);
      if (!eventId || !motoId) { skip("lap_crossings", c, "missing event_id or moto_id"); continue; }

      if (!await isClubEvent(eventId)) { skip("lap_crossings", c, "event not found for this club"); continue; }
      if (!await motoInEvent(motoId, eventId)) { skip("lap_crossings", c, "moto not found in this event"); continue; }

      const rfidNumber = String(c.rfid_number ?? "");
      const lapNumber  = Number(c.lap_number);
      if (!rfidNumber || !lapNumber) { skip("lap_crossings", c, "missing rfid_number or lap_number"); continue; }

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

      const cloudReceivedAt = new Date();
      const localReceivedAt = toDate(c.created_at);
      const sourceReceivedAt = localReceivedAt
        && localReceivedAt.getTime() <= cloudReceivedAt.getTime() + 5 * 60 * 1000
        ? localReceivedAt
        : cloudReceivedAt;
      const suppliedCrossingTime = toDate(c.crossing_time);
      const hadFutureClockSkew = !suppliedCrossingTime
        || suppliedCrossingTime.getTime() > sourceReceivedAt.getTime() + 5 * 60 * 1000;
      const crossingTime = canonicalizeCrossingTimestamp(c.crossing_time, sourceReceivedAt, {
        source: "desktop_sync",
        motoId,
        rfidNumber,
      });
      const crossingKey = `${motoId}:${rfidNumber}`;
      let importedLapTimeMs = Number(c.lap_time_ms);
      if (hadFutureClockSkew) {
        let previousTime = previousImportedCrossing.get(crossingKey);
        if (!previousTime && lapNumber === 1) {
          const [moto] = await tx
            .select({ startedAt: motosTable.startedAt })
            .from(motosTable)
            .where(eq(motosTable.id, motoId));
          previousTime = moto?.startedAt ?? undefined;
        }
        if (previousTime) {
          const delta = crossingTime.getTime() - previousTime.getTime();
          if (Number.isFinite(delta) && delta >= 0) importedLapTimeMs = delta;
        }
      }
      previousImportedCrossing.set(crossingKey, crossingTime);
      if (c.rider_id != null) {
        const riderKey = `${motoId}:${Number(c.rider_id)}`;
        const riderLaps = repairedImportedLaps.get(riderKey) ?? [];
        riderLaps.push(importedLapTimeMs);
        repairedImportedLaps.set(riderKey, riderLaps);
        if (hadFutureClockSkew) skewedImportedRiders.add(riderKey);
      }

      if (existing) {
        await tx
          .update(lapCrossingsTable)
          .set({
            lapTimeMs:   importedLapTimeMs,
            crossingTime,
            // Always carry riderId forward so a re-sync of a manual crossing
            // does not lose the rider association (rider name would show as the
            // raw rfidNumber on the crossings feed if riderId is dropped).
            ...(c.rider_id != null ? { riderId: Number(c.rider_id) } : {}),
          })
          .where(eq(lapCrossingsTable.id, existing.id));
      } else {
        const requestedId = c.id != null && Number(c.id) > 0 ? Number(c.id) : undefined;
        const clientId = requestedId && await idIsFree(lapCrossingsTable, requestedId) ? requestedId : undefined;
        if (clientId) explicitIdTables.add("lap_crossings");
        await tx.insert(lapCrossingsTable).values({
          ...(clientId ? { id: clientId } : {}),
          eventId,
          motoId,
          riderId:      c.rider_id != null   ? Number(c.rider_id)   : null,
          rfidNumber,
          crossingTime,
          lapNumber,
          lapTimeMs:    importedLapTimeMs,
          readerId:     c.reader_id  != null ? String(c.reader_id)  : null,
          antennaId:    c.antenna_id != null ? Number(c.antenna_id) : null,
        });
      }
      crossingsUpserted++;
      affectedMotoIds.add(motoId);
    }
    results["lap_crossings"] = crossingsUpserted;
    total += crossingsUpserted;

    // ── split_crossings (course split reads on the desktop: sector times) ─────
    // Insert-only and idempotent on the table's own key (moto, tag, split, lap),
    // so a retried push, or a split the cloud already has, is stored once.
    const splitRows = (payload["split_crossings"] ?? []) as Array<Record<string, unknown>>;
    let splitsUpserted = 0;
    for (const c of splitRows) {
      const eventId = mapEventId(c.event_id);
      const motoId = mapMotoId(c.moto_id);
      if (!eventId || !motoId) { skip("split_crossings", c, "missing event_id or moto_id"); continue; }
      if (!await isClubEvent(eventId)) { skip("split_crossings", c, "event not found for this club"); continue; }
      if (!await motoInEvent(motoId, eventId)) { skip("split_crossings", c, "moto not found in this event"); continue; }
      const rfidNumber = String(c.rfid_number ?? "");
      const splitSequence = Number(c.split_sequence);
      const lapNumber = Number(c.lap_number);
      const crossingTime = toDate(c.crossing_time);
      if (!rfidNumber || !Number.isInteger(splitSequence) || splitSequence < 1 || !Number.isInteger(lapNumber) || lapNumber < 1 || !crossingTime) {
        skip("split_crossings", c, "missing rfid_number, split_sequence, lap_number or crossing_time");
        continue;
      }
      let riderId: number | null = c.rider_id != null && Number(c.rider_id) > 0 ? Number(c.rider_id) : null;
      if (riderId) {
        const [rider] = await tx.select({ id: ridersTable.id }).from(ridersTable).where(eq(ridersTable.id, riderId));
        if (!rider) riderId = null;
      }
      const requestedId = c.id != null && Number(c.id) > 0 ? Number(c.id) : undefined;
      const clientId = requestedId && await idIsFree(splitCrossingsTable, requestedId) ? requestedId : undefined;
      const inserted = await tx.insert(splitCrossingsTable).values({
        ...(clientId ? { id: clientId } : {}),
        eventId,
        motoId,
        assignmentId: c.assignment_id != null ? Number(c.assignment_id) || null : null,
        readerId: c.reader_id != null ? Number(c.reader_id) || null : null,
        splitSequence,
        label: c.label != null ? String(c.label) : null,
        riderId,
        rfidNumber,
        lapNumber,
        crossingTime,
      }).onConflictDoNothing().returning({ id: splitCrossingsTable.id });
      if (inserted.length > 0) {
        if (clientId) explicitIdTables.add("split_crossings");
        affectedMotoIds.add(motoId);
      }
      splitsUpserted++;
    }
    results["split_crossings"] = splitsUpserted;
    total += splitsUpserted;

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
      const eventId = mapEventId(r.event_id);
      const motoId  = mapMotoId(r.moto_id);
      const riderId = Number(r.rider_id);
      if (!eventId || !motoId || !riderId) { skip("race_results", r, "missing event_id, moto_id or rider_id"); continue; }

      if (!await isClubEvent(eventId)) { skip("race_results", r, "event not found for this club"); continue; }
      if (!await motoInEvent(motoId, eventId)) { skip("race_results", r, "moto not found in this event"); continue; }

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
      const repairedKey = `${motoId}:${riderId}`;
      if (skewedImportedRiders.has(repairedKey)) {
        const repaired = repairedImportedLaps.get(repairedKey) ?? [];
        if (repaired.length && repaired.every(value => Number.isFinite(value) && value >= 0)) {
          lapTimes = repaired;
          r.total_time = formatLapTime(repaired.reduce((sum, value) => sum + value, 0));
        }
      }

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
        const requestedId = r.id != null && Number(r.id) > 0 ? Number(r.id) : undefined;
        const clientId = requestedId && await idIsFree(raceResultsTable, requestedId) ? requestedId : undefined;
        if (clientId) explicitIdTables.add("race_results");
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

    // ── moto_race_snapshot (a lap or result was deleted on the desktop) ───────
    // The desktop sends the race's current laps and which riders still have a
    // result; the cloud's copy is made to match, so a removed lap or result
    // doesn't come back on the desktop's next download. Applied after the
    // upserts above, which hold the latest values of the rows that remain.
    const motoSnapshots = (payload["moto_race_snapshot"] ?? []) as Array<Record<string, unknown>>;
    let snapshotsApplied = 0;
    for (const snap of motoSnapshots) {
      const motoId = mapMotoId(snap.moto_id);
      const eventId = mapEventId(snap.event_id);
      if (!motoId || !eventId || !await isClubEvent(eventId) || !await motoInEvent(motoId, eventId)) {
        skip("moto_race_snapshot", { id: snap.id }, "moto not found for this club"); continue;
      }
      const keepRiders = new Set((Array.isArray(snap.result_rider_ids) ? snap.result_rider_ids : []).map(Number).filter(Boolean));
      const cloudResults = await tx.select({ id: raceResultsTable.id, riderId: raceResultsTable.riderId })
        .from(raceResultsTable).where(eq(raceResultsTable.motoId, motoId));
      const gone = cloudResults.filter(r => !keepRiders.has(r.riderId)).map(r => r.id);
      if (gone.length > 0) await tx.delete(raceResultsTable).where(inArray(raceResultsTable.id, gone));

      const laps = (Array.isArray(snap.lap_crossings) ? snap.lap_crossings : []) as Array<Record<string, unknown>>;
      await tx.delete(lapCrossingsTable).where(eq(lapCrossingsTable.motoId, motoId));
      for (const c of laps) {
        const rfidNumber = String(c.rfid_number ?? "");
        const crossingTime = toDate(c.crossing_time);
        if (!rfidNumber || !crossingTime) continue;
        const requestedId = c.id != null && Number(c.id) > 0 ? Number(c.id) : undefined;
        const clientId = requestedId && await idIsFree(lapCrossingsTable, requestedId) ? requestedId : undefined;
        if (clientId) explicitIdTables.add("lap_crossings");
        await tx.insert(lapCrossingsTable).values({
          ...(clientId ? { id: clientId } : {}),
          eventId,
          motoId,
          riderId:     c.rider_id != null ? Number(c.rider_id) : null,
          rfidNumber,
          crossingTime,
          lapNumber:   Number(c.lap_number) || 0,
          lapTimeMs:   Number(c.lap_time_ms) || 0,
          readerId:    c.reader_id != null ? String(c.reader_id) : null,
          antennaId:   c.antenna_id != null ? Number(c.antenna_id) : null,
        });
      }
      snapshotsApplied++;
      affectedMotoIds.add(motoId);
      finalizeEventIds.add(eventId);
    }
    if (snapshotsApplied > 0) { results["moto_race_snapshot"] = snapshotsApplied; total += snapshotsApplied; }

    // ── motos deleted on the desktop ─────────────────────────────────────────
    // Same rule as the website's own delete: a finished race with results stays.
    let motosDeleted = 0;
    for (const rawId of ((deletes["motos"] ?? []) as unknown[]).map(Number).filter(Boolean)) {
      const motoId = mapMotoId(rawId);
      const [moto] = await tx.select({ id: motosTable.id, eventId: motosTable.eventId, status: motosTable.status })
        .from(motosTable).where(eq(motosTable.id, motoId));
      if (!moto) continue; // already gone
      if (!await isClubEvent(moto.eventId)) { skip("motos_deleted", { id: rawId }, "moto not found for this club"); continue; }
      if (moto.status === "completed") {
        const [kept] = await tx.select({ id: raceResultsTable.id }).from(raceResultsTable).where(eq(raceResultsTable.motoId, motoId)).limit(1);
        if (kept) { skip("motos_deleted", { id: rawId }, "race is finished and has results"); continue; }
      }
      await tx.delete(splitCrossingsTable).where(eq(splitCrossingsTable.motoId, motoId));
      await tx.delete(lapCrossingsTable).where(eq(lapCrossingsTable.motoId, motoId));
      await tx.delete(raceResultsTable).where(eq(raceResultsTable.motoId, motoId));
      await tx.delete(motosTable).where(eq(motosTable.id, motoId));
      affectedMotoIds.delete(motoId);
      finalizeEventIds.add(moto.eventId);
      motosDeleted++;
    }
    if (motosDeleted > 0) { results["motos_deleted"] = motosDeleted; total += motosDeleted; }

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
      const eventId = mapEventId(c.event_id);
      const riderId = Number(c.rider_id);
      if (!eventId || !riderId) { skip("checkins", c, "missing event_id or rider_id"); continue; }

      if (!await isClubEvent(eventId)) { skip("checkins", c, "event not found for this club"); continue; }

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
        const requestedId = c.id != null && Number(c.id) > 0 ? Number(c.id) : undefined;
        const clientId = requestedId && await idIsFree(checkinsTable, requestedId) ? requestedId : undefined;
        if (clientId) explicitIdTables.add("checkins");
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
      const eid = mapEventId(reg.event_id);
      const rid = Number(reg.rider_id);
      if (!eid || !rid) continue;
      if (await isClubEvent(eid)) batchRiderIdSet.add(rid);
    }

    let ridersUpserted = 0;
    for (const r of riders) {
      const riderId = Number(r.id);
      if (!riderId) { skip("riders", r, "missing id"); continue; }

      // Allow if already on cloud roster OR arriving with a valid club registration
      if (!cloudRiderIdSet.has(riderId) && !batchRiderIdSet.has(riderId)) { skip("riders", r, "rider not linked to this club"); continue; }

      const [existing] = await tx
        .select({ id: ridersTable.id })
        .from(ridersTable)
        .where(eq(ridersTable.id, riderId));

      if (existing) {
        // Safety: only update a rider whose ID is already on THIS club's cloud roster.
        // If the rider ID exists in cloud but belongs to a different club (ID collision
        // from offline auto-increment), skip the update to prevent cross-club corruption.
        if (!cloudRiderIdSet.has(riderId)) { skip("riders", r, "rider id belongs to another club"); continue; }

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
        explicitIdTables.add("riders");
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
      mylaps_transponder_number?: unknown;
      transponder_rental?: unknown;
      rfid_sticker_purchased?: unknown;
      rm_trackr_purchased?: unknown;
      rm_trackr_fulfilled_at?: unknown;
      rm_trackr_transponder?: unknown;
      transponder_returned?: unknown;
      refund_verified_at?: unknown;
      team_name?: unknown;
      cash_tendered?: unknown;
      cash_change?: unknown;
    }>;

    // Race-day fields set on the desktop (check-in add-ons, rentals, refunds).
    // Purchase flags and one-time stamps only ever move forward from a push, so
    // a desktop row pulled before an online purchase can't undo it.
    const isTrue = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
    const raceDayRegistrationFields = (r: (typeof regs)[number]) => {
      const set: Record<string, unknown> = {};
      if (isTrue(r.transponder_rental)) set.transponderRental = true;
      if (isTrue(r.rfid_sticker_purchased)) set.rfidStickerPurchased = true;
      if (isTrue(r.rm_trackr_purchased)) set.rmTrackrPurchased = true;
      const fulfilledAt = r.rm_trackr_fulfilled_at != null ? toDate(r.rm_trackr_fulfilled_at) : null;
      if (fulfilledAt) {
        set.rmTrackrFulfilledAt = fulfilledAt;
        if (r.rm_trackr_transponder != null) set.rmTrackrTransponder = String(r.rm_trackr_transponder);
      }
      if (r.transponder_returned !== undefined && r.transponder_returned !== null) {
        set.transponderReturned = isTrue(r.transponder_returned);
      }
      const refundVerifiedAt = r.refund_verified_at != null ? toDate(r.refund_verified_at) : null;
      if (refundVerifiedAt) set.refundVerifiedAt = refundVerifiedAt;
      if (r.mylaps_transponder_number != null && String(r.mylaps_transponder_number).trim()) {
        set.myLapsTransponderNumber = String(r.mylaps_transponder_number);
      }
      // Cash taken at the desktop's gate: what was handed over and the change given.
      if (r.cash_tendered != null && r.cash_tendered !== "" && Number.isFinite(Number(r.cash_tendered))) {
        set.cashTendered = Number(r.cash_tendered).toFixed(2);
        if (r.cash_change != null && Number.isFinite(Number(r.cash_change))) set.cashChange = Number(r.cash_change).toFixed(2);
      }
      // Group race teams registered on the desktop.
      if (r.team_name != null && String(r.team_name).trim()) set.teamName = String(r.team_name).trim().slice(0, 80);
      return set;
    };

    let regsUpserted = 0;
    // Desktop registration id → cloud id (they differ when the desktop's id was taken),
    // so waiver signatures below link to the right entry.
    const regIdMap = new Map<number, number>();
    for (const r of regs) {
      const eventId = mapEventId(r.event_id);
      const riderId = Number(r.rider_id);
      if (!eventId || !riderId) { skip("registrations", r, "missing event_id or rider_id"); continue; }

      if (!await isClubEvent(eventId)) { skip("registrations", r, "event not found for this club"); continue; }

      // Registration rows are class entries: match the pushed row by id when it
      // is this event's row for this rider, otherwise fall back to (event, rider,
      // class). Without the class, a rider's second class entry made offline
      // overwrote the first one (the 450 A entry was lost into the 250 B row).
      const pushedClass = r.race_class != null ? String(r.race_class) : null;
      const requestedRegId = r.id != null && Number(r.id) > 0 ? Number(r.id) : undefined;
      let [existing] = requestedRegId
        ? await tx
            .select({ id: registrationsTable.id })
            .from(registrationsTable)
            .where(
              and(
                eq(registrationsTable.id, requestedRegId),
                eq(registrationsTable.eventId, eventId),
                eq(registrationsTable.riderId, riderId),
              ),
            )
        : [];
      if (!existing) {
        [existing] = await tx
          .select({ id: registrationsTable.id })
          .from(registrationsTable)
          .where(
            and(
              eq(registrationsTable.eventId, eventId),
              eq(registrationsTable.riderId, riderId),
              ...(pushedClass != null ? [eq(registrationsTable.raceClass, pushedClass)] : []),
            ),
          );
      }

      if (existing) {
        if (requestedRegId) regIdMap.set(requestedRegId, existing.id);
        await tx
          .update(registrationsTable)
          .set({
            // A cancellation (void) made online stays void; the desktop's copy may be older.
            status:        r.status        != null ? sql`case when ${registrationsTable.status} = 'void' then 'void' else ${String(r.status)} end` : undefined,
            paymentStatus: r.payment_status != null ? String(r.payment_status) : undefined,
            bibNumber:     r.bib_number    != null ? String(r.bib_number)     : undefined,
            bikeBrand:     r.bike_brand    != null ? String(r.bike_brand)     : undefined,
            amountPaid:    r.amount_paid   != null ? String(r.amount_paid)    : undefined,
            paymentMethod: r.payment_method != null ? String(r.payment_method) : undefined,
            ...raceDayRegistrationFields(r),
          })
          .where(eq(registrationsTable.id, existing.id));
      } else {
        const requestedId = r.id != null && Number(r.id) > 0 ? Number(r.id) : undefined;
        const clientId = requestedId && await idIsFree(registrationsTable, requestedId) ? requestedId : undefined;
        if (clientId) explicitIdTables.add("registrations");
        const [insertedReg] = await tx.insert(registrationsTable).values({
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
          ...raceDayRegistrationFields(r),
        }).returning({ id: registrationsTable.id });
        if (requestedRegId && insertedReg) regIdMap.set(requestedRegId, insertedReg.id);
      }
      regsUpserted++;
    }
    results["registrations"] = regsUpserted;
    total += regsUpserted;

    // ── addon_payments (cash add-ons taken at desktop check-in; insert-only) ───
    // The registration flags above say the rider has the item; this is the
    // payment itself, so check-in shows it paid and the event report totals it.
    const ADDON_ITEMS = new Set(["transponder_rental", "rm_trackr", "rfid_sticker"]);
    /** The cloud registration a desktop row belongs to: pushed now, its own id, or the rider's entry. */
    const cloudRegistrationId = async (pushedId: unknown, eventId: number, riderId: unknown): Promise<number | null> => {
      const id = Number(pushedId);
      if (id > 0) {
        const mapped = regIdMap.get(id);
        if (mapped) return mapped;
        const [own] = await tx.select({ id: registrationsTable.id }).from(registrationsTable)
          .where(and(eq(registrationsTable.id, id), eq(registrationsTable.eventId, eventId)));
        if (own) return own.id;
      }
      const rider = Number(riderId);
      if (!(rider > 0)) return null;
      const [byRider] = await tx.select({ id: registrationsTable.id }).from(registrationsTable)
        .where(and(eq(registrationsTable.eventId, eventId), eq(registrationsTable.riderId, rider)))
        .orderBy(registrationsTable.id).limit(1);
      return byRider?.id ?? null;
    };
    const addonRows = (payload["addon_payments"] ?? []) as Array<Record<string, unknown>>;
    let addonsInserted = 0;
    for (const a of addonRows) {
      const eventId = mapEventId(a.event_id);
      const uid = a.uid != null ? String(a.uid).trim() : "";
      const item = String(a.item ?? "");
      const amount = Number(a.amount);
      if (!eventId || !uid || !ADDON_ITEMS.has(item) || !Number.isFinite(amount) || amount < 0) { skip("addon_payments", a as { id?: unknown }, "missing payment fields"); continue; }
      // Card payments are taken by the cloud itself; the desktop only ever takes cash.
      if (a.method !== "cash" || a.status !== "paid") { skip("addon_payments", a as { id?: unknown }, "only paid cash add-ons are accepted from the desktop"); continue; }
      if (!await isClubEvent(eventId)) { skip("addon_payments", a as { id?: unknown }, "event not found for this club"); continue; }
      const registrationId = await cloudRegistrationId(a.registration_id, eventId, a.rider_id);
      if (!registrationId) { skip("addon_payments", a as { id?: unknown }, "registration not found in this event"); continue; }
      const money = (v: unknown) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v).toFixed(2) : null);
      await tx.insert(addonPaymentsTable).values({
        eventId, registrationId, item, method: "cash", status: "paid",
        amount: amount.toFixed(2),
        quantity: Math.max(1, Math.trunc(Number(a.quantity)) || 1),
        cashTendered: money(a.cash_tendered), cashChange: money(a.cash_change),
        paidAt: toDate(a.paid_at) ?? toDate(a.created_at) ?? new Date(),
        desktopRef: `${clubId}:${uid}`.slice(0, 120),
      }).onConflictDoNothing();
      addonsInserted++;
    }
    results["addon_payments"] = addonsInserted;
    total += addonsInserted;

    // ── team_members (group race rosters and tags entered at desktop check-in) ─
    const teamRows = (payload["team_members"] ?? []) as Array<Record<string, unknown>>;
    let teamsUpserted = 0;
    for (const m of teamRows) {
      const eventId = mapEventId(m.event_id);
      const position = Math.trunc(Number(m.position));
      const firstName = m.first_name != null ? String(m.first_name).trim() : "";
      const lastName = m.last_name != null ? String(m.last_name).trim() : "";
      if (!eventId || !(position >= 1) || !firstName || !lastName) { skip("team_members", m as { id?: unknown }, "missing team member fields"); continue; }
      if (!await isClubEvent(eventId)) { skip("team_members", m as { id?: unknown }, "event not found for this club"); continue; }
      const registrationId = await cloudRegistrationId(m.registration_id, eventId, m.captain_rider_id);
      if (!registrationId) { skip("team_members", m as { id?: unknown }, "team registration not found in this event"); continue; }
      const tag = (v: unknown) => (v != null && String(v).trim() ? String(v).trim().slice(0, 64) : null);
      const [existing] = await tx.select({ id: teamMembersTable.id, riderId: teamMembersTable.riderId }).from(teamMembersTable)
        .where(and(eq(teamMembersTable.registrationId, registrationId), eq(teamMembersTable.position, position)));
      // Each member is linked to a rider profile, as when a team registers on the
      // website: the captain is the entry's rider; team mates are matched by email
      // and name, or get a new profile. Their saved numbers then pre-fill at check-in.
      const memberEmail = m.email != null && String(m.email).trim() ? String(m.email).trim().toLowerCase() : null;
      const memberRiderId = async (): Promise<number | null> => {
        if (position === 1) {
          const [reg] = await tx.select({ riderId: registrationsTable.riderId }).from(registrationsTable).where(eq(registrationsTable.id, registrationId));
          return reg?.riderId ?? null;
        }
        return memberEmail ? await teamMemberRiderId({ firstName, lastName, email: memberEmail }) : null;
      };
      if (existing) {
        // The desktop's row is a deliberate edit at check-in (rows it only pulled are never pushed).
        await tx.update(teamMembersTable).set({
          ...(existing.riderId == null ? { riderId: await memberRiderId() } : {}),
          firstName, lastName,
          rfidNumber: tag(m.rfid_number), trackrNumber: tag(m.trackr_number),
          updatedAt: new Date(),
        }).where(eq(teamMembersTable.id, existing.id));
      } else {
        await tx.insert(teamMembersTable).values({
          eventId, registrationId, position, firstName, lastName,
          riderId: await memberRiderId(),
          email: memberEmail,
          rfidNumber: tag(m.rfid_number), trackrNumber: tag(m.trackr_number),
          trackrChoice: m.trackr_choice != null ? String(m.trackr_choice) : null,
          rfidPurchased: isTrue(m.rfid_purchased),
        }).onConflictDoNothing();
      }
      teamsUpserted++;
    }
    results["team_members"] = teamsUpserted;
    total += teamsUpserted;

    // ── rfid_assignments (transponder assignment at event) ────────────────────
    const rfidAssigns = (payload["rfid_assignments"] ?? []) as Array<{
      id?: unknown;
      rider_id: unknown;
      event_id: unknown;
      rfid_number?: unknown;
      expires_at?: unknown;
    }>;

    let rfidUpserted = 0;
    for (const a of rfidAssigns) {
      const riderId    = Number(a.rider_id);
      const eventId    = mapEventId(a.event_id);
      const rfidNumber = String(a.rfid_number ?? "");
      if (!riderId || !eventId || !rfidNumber) { skip("rfid_assignments", a, "missing rider_id, event_id or rfid_number"); continue; }

      if (!await isClubEvent(eventId)) { skip("rfid_assignments", a, "event not found for this club"); continue; }

      const [existing] = await tx
        .select({ id: rfidAssignmentsTable.id })
        .from(rfidAssignmentsTable)
        .where(
          and(
            eq(rfidAssignmentsTable.riderId,  riderId),
            eq(rfidAssignmentsTable.eventId,  eventId),
          ),
        );

      // Rental transponders carry an expiry; a plain assignment clears it.
      const expiresAt = a.expires_at != null ? toDate(a.expires_at) : null;
      if (existing) {
        await tx
          .update(rfidAssignmentsTable)
          .set({ rfidNumber, expiresAt })
          .where(eq(rfidAssignmentsTable.id, existing.id));
      } else {
        const requestedId = a.id != null && Number(a.id) > 0 ? Number(a.id) : undefined;
        const clientId = requestedId && await idIsFree(rfidAssignmentsTable, requestedId) ? requestedId : undefined;
        if (clientId) explicitIdTables.add("rfid_assignments");
        await tx.insert(rfidAssignmentsTable).values({
          ...(clientId ? { id: clientId } : {}),
          riderId,
          eventId,
          rfidNumber,
          expiresAt,
        });
      }
      rfidUpserted++;
    }
    results["rfid_assignments"] = rfidUpserted;
    total += rfidUpserted;

    // ── practice_sessions (create / start / stop on desktop) ─────────────────
    const practiceSessions = (payload["practice_sessions"] ?? []) as Array<Record<string, unknown>>;

    let practiceSessionsUpserted = 0;
    for (const s of practiceSessions) {
      const sessionId = Number(s.id);
      if (!sessionId) { skip("practice_sessions", s, "missing id"); continue; }

      const [existing] = await tx
        .select({ id: practiceSessionsTable.id, clubId: practiceSessionsTable.clubId })
        .from(practiceSessionsTable)
        .where(eq(practiceSessionsTable.id, sessionId));

      if (existing) {
        if (existing.clubId !== clubId) { skip("practice_sessions", s, "session id belongs to another club"); continue; }
        const updateSet: Record<string, unknown> = {};
        if (s.status      != null) updateSet.status     = String(s.status);
        if (s.name        != null) updateSet.name        = String(s.name);
        if (s.venue_name  != null) updateSet.venueName   = String(s.venue_name).trim() || null;
        if (s.debounce_ms != null) updateSet.debounceMs  = Number(s.debounce_ms);
        if (s.started_at  != null) updateSet.startedAt   = toDate(s.started_at);
        if (s.ended_at    != null) updateSet.endedAt     = toDate(s.ended_at);
        if (Object.keys(updateSet).length === 0) continue;
        await tx
          .update(practiceSessionsTable)
          .set(updateSet as any)
          .where(eq(practiceSessionsTable.id, sessionId));
      } else {
        // The library track and its course, as when a practice starts on the website.
        const practiceTrackId = await resolveTrackId(clubId, s.track_id, s.venue_name);
        const insertRow: Record<string, unknown> = {
          id:         sessionId,
          clubId,
          trackId:    practiceTrackId,
          course:     await practiceCourseFor(practiceTrackId),
          name:       s.name        != null ? String(s.name)        : "Practice",
          venueName:  s.venue_name  != null ? String(s.venue_name).trim() || null : null,
          status:     s.status      != null ? String(s.status)      : "idle",
          debounceMs: s.debounce_ms != null ? Number(s.debounce_ms) : 10000,
          startedAt:  toDate(s.started_at),
          endedAt:    toDate(s.ended_at),
        };
        await tx
          .insert(practiceSessionsTable)
          .values(insertRow as any)
          .onConflictDoNothing();
        explicitIdTables.add("practice_sessions");
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
      if (!sessionId || !rfidNumber) { skip("practice_crossings", c, "missing session_id or rfid_number"); continue; }

      // Scope check: session must belong to this club
      const [session] = await tx
        .select({ clubId: practiceSessionsTable.clubId })
        .from(practiceSessionsTable)
        .where(eq(practiceSessionsTable.id, sessionId));
      if (!session || session.clubId !== clubId) { skip("practice_crossings", c, "session not found for this club"); continue; }

      // Crossings are immutable — skip if already on cloud. Only a row in this same
      // session counts; an id held by another club's crossing is an offline id
      // collision, so the crossing is inserted with a fresh id instead.
      let keepId = !!crossingId;
      if (crossingId) {
        const [existingCrossing] = await tx
          .select({ id: practiceCrossingsTable.id, sessionId: practiceCrossingsTable.sessionId })
          .from(practiceCrossingsTable)
          .where(eq(practiceCrossingsTable.id, crossingId));
        if (existingCrossing && existingCrossing.sessionId === sessionId) { practiceCrossingsUpserted++; continue; }
        if (existingCrossing) keepId = false;
      }
      if (keepId) explicitIdTables.add("practice_crossings");

      const insertRow: Record<string, unknown> = {
        ...(keepId ? { id: crossingId } : {}),
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

    // ── practice_split_crossings (split reads during a desktop practice) ──────
    // Insert-only, idempotent on (session, tag, split, lap).
    const practiceSplitRows = (payload["practice_split_crossings"] ?? []) as Array<Record<string, unknown>>;
    let practiceSplitsUpserted = 0;
    for (const c of practiceSplitRows) {
      const sessionId = Number(c.session_id);
      const rfidNumber = String(c.rfid_number ?? "");
      const splitSequence = Number(c.split_sequence);
      const lapNumber = Number(c.lap_number);
      const crossingTime = toDate(c.crossing_time);
      if (!sessionId || !rfidNumber || !Number.isInteger(splitSequence) || splitSequence < 1 || !Number.isInteger(lapNumber) || lapNumber < 1 || !crossingTime) {
        skip("practice_split_crossings", c, "missing session_id, rfid_number, split_sequence, lap_number or crossing_time");
        continue;
      }
      const [session] = await tx
        .select({ clubId: practiceSessionsTable.clubId })
        .from(practiceSessionsTable)
        .where(eq(practiceSessionsTable.id, sessionId));
      if (!session || session.clubId !== clubId) { skip("practice_split_crossings", c, "session not found for this club"); continue; }
      let riderId: number | null = c.rider_id != null && Number(c.rider_id) > 0 ? Number(c.rider_id) : null;
      if (riderId) {
        const [rider] = await tx.select({ id: ridersTable.id }).from(ridersTable).where(eq(ridersTable.id, riderId));
        if (!rider) riderId = null;
      }
      const requestedId = c.id != null && Number(c.id) > 0 ? Number(c.id) : undefined;
      const clientId = requestedId && await idIsFree(practiceSplitCrossingsTable, requestedId) ? requestedId : undefined;
      const inserted = await tx.insert(practiceSplitCrossingsTable).values({
        ...(clientId ? { id: clientId } : {}),
        sessionId,
        readerId: c.reader_id != null ? Number(c.reader_id) || null : null,
        splitSequence,
        label: c.label != null ? String(c.label) : null,
        riderId,
        rfidNumber,
        lapNumber,
        crossingTime,
      }).onConflictDoNothing().returning({ id: practiceSplitCrossingsTable.id });
      if (inserted.length > 0 && clientId) explicitIdTables.add("practice_split_crossings");
      practiceSplitsUpserted++;
    }
    results["practice_split_crossings"] = practiceSplitsUpserted;
    total += practiceSplitsUpserted;

    // ── liability_waiver_signatures (signed at desktop check-in) ──────────────
    // Legal records: insert-only, never updated or deleted from a push. A retry
    // after a lost response finds the same signature and doesn't duplicate it.
    const waiverSignatures = (payload["liability_waiver_signatures"] ?? []) as Array<Record<string, unknown>>;
    const signedWaiverEmails: Array<{ to: string; signerName: string; eventId: number; signedAt: Date; contentHash: string; waiverSnapshot: string }> = [];
    let waiversInserted = 0;
    for (const w of waiverSignatures) {
      const eventId = mapEventId(w.event_id);
      const signerName = w.signer_name != null ? String(w.signer_name).trim() : "";
      const signerEmail = w.signer_email != null ? String(w.signer_email).trim().toLowerCase() : "";
      const waiverSnapshot = w.waiver_snapshot != null ? String(w.waiver_snapshot) : "";
      const contentHash = w.waiver_content_hash != null ? String(w.waiver_content_hash) : "";
      const signedAt = toDate(w.signed_at);
      if (!eventId || !signerName || !signerEmail || !waiverSnapshot || !contentHash || !signedAt) {
        skip("liability_waiver_signatures", w as { id?: unknown }, "missing signature fields");
        continue;
      }
      if (!await isClubEvent(eventId)) { skip("liability_waiver_signatures", w as { id?: unknown }, "event not found for this club"); continue; }
      const [already] = await tx
        .select({ id: liabilityWaiverSignaturesTable.id })
        .from(liabilityWaiverSignaturesTable)
        .where(and(
          eq(liabilityWaiverSignaturesTable.eventId, eventId),
          eq(liabilityWaiverSignaturesTable.signerEmail, signerEmail),
          eq(liabilityWaiverSignaturesTable.signedAt, signedAt),
          eq(liabilityWaiverSignaturesTable.waiverContentHash, contentHash),
        ))
        .limit(1);
      if (already) { waiversInserted++; continue; }
      const requestedId = w.id != null && Number(w.id) > 0 ? Number(w.id) : undefined;
      const clientId = requestedId && await idIsFree(liabilityWaiverSignaturesTable, requestedId) ? requestedId : undefined;
      if (clientId) explicitIdTables.add("liability_waiver_signatures");
      let fieldLayout: unknown = w.field_layout ?? null;
      if (typeof fieldLayout === "string") { try { fieldLayout = JSON.parse(fieldLayout); } catch { fieldLayout = null; } }
      const isGuardian = w.signer_type === "guardian";
      // The entry it belongs to: remapped if pushed now, else kept only if it's this event's.
      let registrationId: number | null = null;
      if (w.registration_id != null) {
        const pushedId = Number(w.registration_id);
        registrationId = regIdMap.get(pushedId) ?? null;
        if (registrationId == null) {
          const [own] = await tx.select({ id: registrationsTable.id }).from(registrationsTable)
            .where(and(eq(registrationsTable.id, pushedId), eq(registrationsTable.eventId, eventId)));
          registrationId = own?.id ?? null;
        }
      }
      await tx.insert(liabilityWaiverSignaturesTable).values({
        ...(clientId ? { id: clientId } : {}),
        clubId,
        eventId,
        registrationId,
        signerName,
        signerEmail,
        signerIp: w.signer_ip != null ? String(w.signer_ip) : null,
        signerUserAgent: w.signer_user_agent != null ? String(w.signer_user_agent) : null,
        consentToEsign: true,
        waiverContentHash: contentHash,
        waiverSnapshot,
        fieldLayout: fieldLayout as any,
        signerType: isGuardian ? "guardian" : "self",
        minorRiderName: isGuardian && w.minor_rider_name != null ? String(w.minor_rider_name) : null,
        signedAt,
      });
      signedWaiverEmails.push({ to: signerEmail, signerName, eventId, signedAt, contentHash, waiverSnapshot });
      waiversInserted++;
    }
    results["liability_waiver_signatures"] = waiversInserted;
    total += waiversInserted;

    // ── event_enduro_setup (time checks + penalty config + reader assignments) ─
    // One snapshot per event, saved as a whole on the desktop. Applied like the
    // cloud's own PUT handlers: replace the event's rows, keeping desktop ids
    // when they are free so later arrivals and assignments still match.
    const enduroSetups = (payload["event_enduro_setup"] ?? []) as Array<Record<string, unknown>>;
    const enduroEventIds = new Set<number>();
    // Desktop time-check id → cloud id, for arrivals pushed in the same batch.
    const timeCheckIdMap = new Map<number, number>();
    for (const setup of enduroSetups) {
      const eventId = mapEventId(setup.event_id ?? setup.id);
      if (!eventId || !await isClubEvent(eventId)) { skip("event_enduro_setup", { id: setup.id }, "event not found for this club"); continue; }
      const checks = Array.isArray(setup.time_checks) ? setup.time_checks as Array<Record<string, unknown>> : [];
      const assignments = Array.isArray(setup.reader_assignments) ? setup.reader_assignments as Array<Record<string, unknown>> : [];

      const existingChecks = await tx.select({ id: enduroTimeChecksTable.id })
        .from(enduroTimeChecksTable).where(eq(enduroTimeChecksTable.eventId, eventId));
      const existingCheckIds = new Set(existingChecks.map((c) => c.id));
      const incomingCheckIds = new Set(checks.map((c) => Number(c.id)).filter((n) => n > 0));
      const removedCheckIds = [...existingCheckIds].filter((id) => !incomingCheckIds.has(id));
      if (removedCheckIds.length > 0) {
        const [withArrivals] = await tx.select({ id: enduroCheckpointArrivalsTable.id })
          .from(enduroCheckpointArrivalsTable)
          .where(inArray(enduroCheckpointArrivalsTable.timeCheckId, removedCheckIds)).limit(1);
        if (withArrivals) { skip("event_enduro_setup", { id: setup.id }, "time checks with recorded arrivals can't be removed"); continue; }
      }

      // Reader assignments first (they reference time checks), then checks.
      // Desktop releases before the course map don't send its finish/split rows;
      // keep the cloud's course map unless this snapshot says it carries one.
      const includesCourse = setup.course_rows_included === true;
      await tx.delete(eventReaderAssignmentsTable).where(includesCourse
        ? eq(eventReaderAssignmentsTable.eventId, eventId)
        : and(
          eq(eventReaderAssignmentsTable.eventId, eventId),
          sql`not (${eventReaderAssignmentsTable.motoId} is null and ${eventReaderAssignmentsTable.role} in ('finish', 'split'))`,
        ));
      if (removedCheckIds.length > 0) {
        await tx.delete(enduroTimeChecksTable).where(inArray(enduroTimeChecksTable.id, removedCheckIds));
      }
      const checkIdMap = new Map<number, number>();
      for (const c of checks) {
        const localId = Number(c.id);
        let targets: unknown = c.targets ?? [];
        if (typeof targets === "string") { try { targets = JSON.parse(targets); } catch { targets = []; } }
        const values = {
          eventId,
          checkNumber: Number(c.check_number) || 0,
          name: c.name != null && String(c.name).trim() ? String(c.name).trim() : "Time Check",
          targets: (Array.isArray(targets) ? targets : []) as any,
        };
        if (existingCheckIds.has(localId)) {
          await tx.update(enduroTimeChecksTable).set(values).where(eq(enduroTimeChecksTable.id, localId));
          checkIdMap.set(localId, localId);
          continue;
        }
        const keepId = localId > 0 && await idIsFree(enduroTimeChecksTable, localId);
        if (keepId) explicitIdTables.add("enduro_time_checks");
        const [ins] = await tx.insert(enduroTimeChecksTable)
          .values({ ...(keepId ? { id: localId } : {}), ...values })
          .returning({ id: enduroTimeChecksTable.id });
        checkIdMap.set(localId, ins.id);
      }
      for (const [localId, cloudId] of checkIdMap) timeCheckIdMap.set(localId, cloudId);

      const clubReaderIds = new Set((await tx.select({ id: readersTable.id })
        .from(readersTable).where(eq(readersTable.clubId, clubId))).map((r) => r.id));
      for (const a of assignments) {
        const readerId = Number(a.reader_id);
        if (!clubReaderIds.has(readerId)) { skip("event_enduro_setup", { id: setup.id }, `reader ${readerId} does not belong to this club`); continue; }
        const role = ["start", "finish", "split", "time_check"].includes(String(a.role)) ? String(a.role) as "start" | "finish" | "split" | "time_check" : "start";
        const motoId = a.moto_id != null ? mapMotoId(a.moto_id) : null;
        const isCourseRow = a.moto_id == null && (role === "finish" || role === "split");
        if (isCourseRow && !includesCourse) continue;
        const timeCheckId = a.time_check_id != null ? checkIdMap.get(Number(a.time_check_id)) ?? null : null;
        await tx.insert(eventReaderAssignmentsTable).values({
          eventId,
          readerId,
          antennaId: a.antenna_id != null ? Number(a.antenna_id) : null,
          role,
          motoId: motoId && await motoInEvent(motoId, eventId) ? motoId : null,
          timeCheckId,
          sequence: a.sequence != null && Number.isInteger(Number(a.sequence)) ? Number(a.sequence) : null,
          label: typeof a.label === "string" && a.label.trim() ? a.label.trim().slice(0, 60) : null,
        });
      }

      let penaltyConfig: unknown = setup.enduro_penalty_config ?? null;
      if (typeof penaltyConfig === "string") { try { penaltyConfig = JSON.parse(penaltyConfig); } catch { penaltyConfig = null; } }
      await tx.update(eventsTable)
        .set({ enduroPenaltyConfig: (penaltyConfig && typeof penaltyConfig === "object" ? penaltyConfig : null) as any })
        .where(eq(eventsTable.id, eventId));
      enduroEventIds.add(eventId);
    }
    results["event_enduro_setup"] = enduroEventIds.size;
    total += enduroEventIds.size;

    // ── enduro_checkpoint_arrivals (manual arrivals recorded on the desktop) ──
    const arrivals = (payload["enduro_checkpoint_arrivals"] ?? []) as Array<Record<string, unknown>>;
    let arrivalsUpserted = 0;
    for (const a of arrivals) {
      const eventId = mapEventId(a.event_id);
      const timeCheckId = timeCheckIdMap.get(Number(a.time_check_id)) ?? Number(a.time_check_id);
      const riderId = Number(a.rider_id);
      const arrivalTime = toDate(a.arrival_time);
      if (!eventId || !timeCheckId || !riderId || !arrivalTime) { skip("enduro_checkpoint_arrivals", a as { id?: unknown }, "missing arrival fields"); continue; }
      if (!await isClubEvent(eventId)) { skip("enduro_checkpoint_arrivals", a as { id?: unknown }, "event not found for this club"); continue; }
      const [check] = await tx.select({ id: enduroTimeChecksTable.id }).from(enduroTimeChecksTable)
        .where(and(eq(enduroTimeChecksTable.id, timeCheckId), eq(enduroTimeChecksTable.eventId, eventId)));
      if (!check) { skip("enduro_checkpoint_arrivals", a as { id?: unknown }, "time check not found for this event"); continue; }
      const recordedBy = a.recorded_by != null ? String(a.recorded_by) : "manual";
      const requestedId = a.id != null && Number(a.id) > 0 ? Number(a.id) : undefined;
      const [existingArrival] = await tx.select({ id: enduroCheckpointArrivalsTable.id })
        .from(enduroCheckpointArrivalsTable)
        .where(and(eq(enduroCheckpointArrivalsTable.timeCheckId, timeCheckId), eq(enduroCheckpointArrivalsTable.riderId, riderId)));
      if (existingArrival) {
        await tx.update(enduroCheckpointArrivalsTable).set({ arrivalTime, recordedBy })
          .where(eq(enduroCheckpointArrivalsTable.id, existingArrival.id));
      } else {
        const keepId = requestedId && await idIsFree(enduroCheckpointArrivalsTable, requestedId) ? requestedId : undefined;
        if (keepId) explicitIdTables.add("enduro_checkpoint_arrivals");
        await tx.insert(enduroCheckpointArrivalsTable).values({
          ...(keepId ? { id: keepId } : {}),
          eventId, timeCheckId, riderId, arrivalTime, recordedBy,
        });
      }
      enduroEventIds.add(eventId);
      arrivalsUpserted++;
    }
    const arrivalDeletes = ((deletes["enduro_checkpoint_arrivals"] ?? []) as unknown[]).map(Number).filter(Boolean);
    for (const arrivalId of arrivalDeletes) {
      const [row] = await tx.select({ id: enduroCheckpointArrivalsTable.id, eventId: enduroCheckpointArrivalsTable.eventId })
        .from(enduroCheckpointArrivalsTable).where(eq(enduroCheckpointArrivalsTable.id, arrivalId));
      // Already gone (or never synced): nothing to delete.
      if (!row) continue;
      if (!await isClubEvent(row.eventId)) { skip("enduro_checkpoint_arrivals_deleted", { id: arrivalId }, "arrival not found for this club"); continue; }
      await tx.delete(enduroCheckpointArrivalsTable).where(eq(enduroCheckpointArrivalsTable.id, arrivalId));
      enduroEventIds.add(row.eventId);
      arrivalsUpserted++;
    }
    results["enduro_checkpoint_arrivals"] = arrivalsUpserted;
    total += arrivalsUpserted;
    pushedEnduroEventIds = enduroEventIds;
    pushedWaiverEmails = signedWaiverEmails;

    // ── club setup that refers to events and riders (series, codes, rentals) ───
    await pushOrgAfterEvents(orgPush, rentalsOut);

    // Explicit-id inserts don't advance serial sequences; move each one past the
    // highest id so the next cloud-side insert doesn't collide.
    for (const table of explicitIdTables) {
      await tx.execute(sql.raw(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1))`,
      ));
    }
  });

  // Recalculate positions from actual performance data and broadcast leaderboards.
  // Runs after the transaction commits so readers see the committed rows.
  // Fire-and-forget: don't let errors fail the push response.
  // Official vs unofficial results follow the desktop's finalize state.
  if (finalizeEventIds.size > 0) {
    setImmediate(() => {
      void (async () => {
        for (const eventId of finalizeEventIds) {
          try {
            if (await syncEventPublication(eventId)) {
              void notifyFollowersOfResults(eventId);
              void sendRaceDayStats(eventId).catch(() => {});
              void queueRaceGasCredits(eventId);
            }
          } catch (err) {
            req.log.warn({ err, eventId }, "desktop-push: results publication sync failed");
          }
        }
      })();
    });
  }

  // Follower "about to start their race" pushes. Each skips races finished or
  // started too long ago (a late sync after the laptop was offline), and the
  // per-rider-per-moto claim keeps re-syncs from sending twice.
  if (finishedRaceByEvent.size > 0 || startedMotoIds.size > 0) {
    setImmediate(() => {
      void (async () => {
        for (const [eventId, finishedAt] of finishedRaceByEvent) await alertFollowersUpNext(eventId, finishedAt);
        for (const motoId of startedMotoIds) await alertFollowersMotoStarted(motoId);
      })();
    });
  }

  if (affectedMotoIds.size > 0) {
    setImmediate(() => {
      void (async () => {
        for (const motoId of affectedMotoIds) {
          try {
            // Re-sort positions: most laps first, then shortest total time —
            // matches supercross / AMA time+laps convention and overrides whatever
            // the desktop app sent so the cloud is always the authoritative source.
            // Only for motocross motos timed from laps: enduro tests are placed by
            // pass time (recomputed separately), and results entered by hand
            // (no lap data) keep the positions the desktop sent. DNF/DNS go last.
            const [syncedMoto] = await db.select({ type: motosTable.type, status: motosTable.status }).from(motosTable).where(eq(motosTable.id, motoId));
            const allResults = await db
              .select()
              .from(raceResultsTable)
              .where(eq(raceResultsTable.motoId, motoId));
            const hasLapData = allResults.some(r => Array.isArray(r.lapTimes) && (r.lapTimes as unknown[]).length > 0);
            // A complete order from the desktop (1, 2, 3 … with no gaps) is kept: it is
            // the desktop's own laps-then-time order, or a place the organizer corrected
            // by hand there. Only an incomplete order is worked out again here.
            if (allResults.length > 0 && syncedMoto?.type !== "enduro_test" && hasLapData
              && positionsNeedSorting(allResults.map(r => r.position))) {
              const sorted = allResults
                .map((r) => {
                  const laps = Array.isArray(r.lapTimes) ? (r.lapTimes as number[]) : [];
                  return {
                    id: r.id,
                    laps: laps.length,
                    totalMs: laps.reduce((s: number, t: unknown) => s + (typeof t === "number" ? t : 0), 0),
                    out: !!(r.dnf || r.dns),
                  };
                })
                .sort(compareStandings);
              for (let i = 0; i < sorted.length; i++) {
                await db
                  .update(raceResultsTable)
                  .set({ position: i + 1 })
                  .where(eq(raceResultsTable.id, sorted[i].id));
              }
            }
            // The push carries finishing order, not points: score the finished race
            // here (event table, club Auto DNF) so results, the event overall and
            // series standings have points, as when a race finishes on the website.
            if (motoNeedsScoringAfterPush(syncedMoto)) await scoreMotoPoints(motoId);
            const snapshot = await buildLeaderboard(motoId);
            if (snapshot) {
              if (startedMotoIds.has(motoId)) await startSharedAnnouncer(snapshot);
              publishTimingSnapshot(snapshot);
            }
          } catch { /* ignore — broadcast is best-effort */ }
        }
      })();
    });
  }

  // Enduro standings reflect pushed time checks / arrivals (as the cloud's own
  // handlers do after each change), and signers of waivers taken at desktop
  // check-in get the same confirmation email as online signers.
  for (const eventId of pushedEnduroEventIds) {
    recomputeEnduroPositionsForEvent(eventId).catch(() => {});
  }
  if (pushedWaiverEmails.length > 0) {
    const eventNames = new Map<number, string>();
    for (const w of pushedWaiverEmails) {
      if (!eventNames.has(w.eventId)) {
        const [ev] = await db.select({ name: eventsTable.name }).from(eventsTable).where(eq(eventsTable.id, w.eventId));
        eventNames.set(w.eventId, ev?.name ?? "");
      }
      sendLiabilityWaiverConfirmation({
        to: w.to,
        signerName: w.signerName,
        eventName: eventNames.get(w.eventId) ?? "",
        signedAt: w.signedAt.toISOString(),
        contentHash: w.contentHash,
        waiverSnapshot: w.waiverSnapshot,
      }).catch(() => {});
    }
  }

  // Standings follow series and scoring tables changed on the desktop, as after the website's own edits.
  const pushedOrg = org as OrgPushContext | null;
  if (pushedOrg) {
    if (pushedOrg.seriesToRecalculate.size > 0) {
      void recalculateSeriesPoints([...pushedOrg.seriesToRecalculate]).catch(err => req.log.warn({ err }, "desktop-push: series recalculation failed"));
    }
    for (const t of pushedOrg.rescoredTables) rescoreUsers(t.tableId, t.clubId);
  }

  const skippedCount = Object.values(skipped).reduce((n, rows) => n + rows.length, 0);
  if (skippedCount > 0) req.log.warn({ clubId, skipped }, "desktop-push skipped rows");
  req.log.info({ clubId, results, total, eventIdRemaps, motoIdRemaps, skippedCount }, "desktop-push complete");
  // Backward compatible: older desktops read only idRemaps.events. `skipped` lists rows
  // (by desktop id, per table) that were not applied; `idRemaps.motos` lists moto ids
  // that collided with another club's moto and were given a new cloud id.
  // `capabilities` tells the desktop which newer tables this cloud stores; the other
  // idRemaps keys are club-setup rows saved under a different id (lib/desktopOrgPush.ts).
  return res.json({
    ok: true, results, total,
    idRemaps: { events: eventIdRemaps, motos: motoIdRemaps, ...(pushedOrg?.remaps ?? {}) },
    skipped,
    capabilities: [ORG_PUSH_CAPABILITY],
  });
});

// ─── POST /clubs/:clubId/sync-pull ────────────────────────────────────────────
// Returns ALL current club rows on every call.  No id-watermark filtering so
// that edits to existing rows made via the web portal are always applied to the
// desktop (club tables have `created_at` only, no `updated_at`).
// All queries are scoped to events owned by this club — no cross-club leaks.
// Riders are filtered to those with a registration for a club event. Their
// complete registration/profile lookup data is returned to the club's own
// desktop, including contact details needed for on-site registration.
// The client sends `lastPulledAt` per table for future server-side optimisation;
// the server currently ignores it and always returns the full set.

router.post("/clubs/:clubId/sync-pull", async (req, res) => {
  const clubId = Number(req.params.clubId);
  if (isNaN(clubId)) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });

  const user = await resolveClubUser(req, clubId);
  if (!user || user.clubId !== clubId) {
    return res.status(403).json({ error: "This club isn't on your account. Sign in with an organizer account for this club." });
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
    tourCompleted: usersTable.tourCompleted,
    permissions:  usersTable.permissions,
    createdAt:    usersTable.createdAt,
  }).from(usersTable).where(eq(usersTable.clubId, clubId));
  // Staff sync tokens only get their own password hash, never the organizer's or other staff's.
  if (!canReceivePasswordHashes(user)) {
    for (const u of clubUsers) if (u.id !== user.id) u.passwordHash = null;
  }

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
  // Split reads (sector times) of those practices.
  const practiceSplitCrossings =
    practiceSessionIds.length > 0
      ? await db
          .select()
          .from(practiceSplitCrossingsTable)
          .where(inArray(practiceSplitCrossingsTable.sessionId, practiceSessionIds))
      : [];

  // Club waiver texts/PDFs for offline check-in (desktop table keys rows by id).
  const [clubSettingsRow] = await db.select().from(clubSettingsTable).where(eq(clubSettingsTable.clubId, clubId));
  const clubSettings = clubSettingsRow ? [{ id: clubId, ...clubSettingsRow }] : [];
  // Signed liability waivers, so desktop check-in knows who has signed.
  const liabilityWaiverSignatures = await db
    .select()
    .from(liabilityWaiverSignaturesTable)
    .where(eq(liabilityWaiverSignaturesTable.clubId, clubId));
  // The club's Sell Items prices (Admin → Sell Items), so desktop check-in charges the same offline.
  const clubSellItems = await db.select().from(clubSellItemsTable).where(eq(clubSellItemsTable.clubId, clubId));
  // The rental transponder inventory (Admin → Rentals). Its presence also tells the
  // desktop this cloud sends the whole club setup, so rows missing here were removed.
  const rentalTransponders = await db.select().from(rentalTranspondersTable).where(eq(rentalTranspondersTable.clubId, clubId));
  // The club's readers (never their tokens): the desktop matches its own reader
  // connections to them, so enduro gates and course-map splits work offline.
  const readers = await db.select({
    id: readersTable.id, clubId: readersTable.clubId, name: readersTable.name, type: readersTable.type,
    hardwareAddress: readersTable.hardwareAddress, connection: readersTable.connection,
    activeTimingConfig: readersTable.activeTimingConfig, createdAt: readersTable.createdAt,
  }).from(readersTable).where(eq(readersTable.clubId, clubId));
  // The Track Library with each track's course map (finish first, then splits in
  // order), as GET /tracks returns it.
  const clubTracks = await db.select().from(tracksTable).where(eq(tracksTable.clubId, clubId));
  const trackPoints = clubTracks.length === 0 ? [] : await db.select().from(trackCoursePointsTable)
    .where(inArray(trackCoursePointsTable.trackId, clubTracks.map(t => t.id)));
  const tracks = clubTracks.map(t => ({
    ...t,
    course: trackPoints
      .filter(p => p.trackId === t.id)
      .sort((a, b) => (a.role === "finish" ? -1 : 0) - (b.role === "finish" ? -1 : 0) || (a.sequence ?? 0) - (b.sequence ?? 0))
      .map(p => ({ readerId: p.readerId, role: p.role, sequence: p.sequence, label: p.label })),
  }));
  // Riders the club added itself (Riders tab) who haven't entered an event yet.
  const directRiderIds = (await db.select({ id: ridersTable.id }).from(ridersTable).where(eq(ridersTable.clubId, clubId))).map(r => r.id);

  if (clubEvents.length === 0) {
    return res.json({
      tracks,
      clubSettings,
      clubSellItems,
      rentalTransponders,
      readers,
      addonPayments: [],
      teamMembers: [],
      liabilityWaiverSignatures,
      enduroTimeChecks: [],
      enduroCheckpointArrivals: [],
      eventReaderAssignments: [],
      registrations: [], checkins: [], riders: [], riderTransponders: [],
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
      splitCrossings: [],
      practiceSplitCrossings,
      riderAccounts: [],
      riderPushTokens: [],
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
  const [enduroTimeChecks, enduroCheckpointArrivals, eventReaderAssignments, teamMembers] = await Promise.all([
    db.select().from(enduroTimeChecksTable).where(inArray(enduroTimeChecksTable.eventId, clubEventIds)),
    db.select().from(enduroCheckpointArrivalsTable).where(inArray(enduroCheckpointArrivalsTable.eventId, clubEventIds)),
    db.select().from(eventReaderAssignmentsTable).where(inArray(eventReaderAssignmentsTable.eventId, clubEventIds)),
    // Group race rosters: every team member's tags, so the desktop times teams offline.
    db.select().from(teamMembersTable).where(inArray(teamMembersTable.eventId, clubEventIds)),
  ]);
  // Course split reads (sector times), so the desktop shows the same sectors as the website.
  const splitCrossings = await db.select().from(splitCrossingsTable).where(inArray(splitCrossingsTable.eventId, clubEventIds));
  // Paid check-in add-ons, so the desktop shows them paid and totals them in the event report.
  const addonPayments = await db.select().from(addonPaymentsTable)
    .where(and(inArray(addonPaymentsTable.eventId, clubEventIds), eq(addonPaymentsTable.status, "paid")));

  // Riders: return only riders who have a registration for a club event. This
  // remains club-scoped while supplying the complete profile used by desktop
  // registration lookup and rider population.
  // Plus riders the club added itself, and the profile fields GET /riders returns,
  // so the desktop's rider list and rider page match the website's.
  // Also riders who were checked in or have a result at a club event without an
  // entry, so results and standings never show "Rider #7" offline.
  const regRiderIds = [...new Set([
    ...registrations.map((r) => r.riderId), ...directRiderIds,
    ...checkins.map((c) => c.riderId), ...raceResults.map((r) => r.riderId),
    // Group race team mates: their saved numbers pre-fill the team screen.
    ...teamMembers.map((t) => t.riderId),
  ].filter((id): id is number => id != null))];
  const ridersWithEmail =
    regRiderIds.length > 0
      ? await db
          .select({
            id:         ridersTable.id,
            clubId: ridersTable.clubId,
            skillLevel: ridersTable.skillLevel,
            raceTypes: ridersTable.raceTypes,
            aiMaintenanceSuggestions: ridersTable.aiMaintenanceSuggestions,
            bio: ridersTable.bio,
            plateColor: ridersTable.plateColor,
            profileVisibility: ridersTable.profileVisibility,
            avatarUrl: ridersTable.avatarUrl,
            coverUrl: ridersTable.coverUrl,
            createdAt: ridersTable.createdAt,
            firstName:  ridersTable.firstName,
            lastName:   ridersTable.lastName,
            rfidNumber: ridersTable.rfidNumber,
            mylapsTransponderId: ridersTable.mylapsTransponderId,
            email:      ridersTable.email,
            phone: ridersTable.phone,
            dateOfBirth: ridersTable.dateOfBirth,
            emergencyContact: ridersTable.emergencyContact,
            emergencyPhone: ridersTable.emergencyPhone,
            streetAddress: ridersTable.streetAddress,
            city: ridersTable.city,
            homeState: ridersTable.homeState,
            zip: ridersTable.zip,
            bibNumber: ridersTable.bibNumber,
            amaNumber: ridersTable.amaNumber,
            bikeManufacturer: ridersTable.bikeManufacturer,
            bikeModel: ridersTable.bikeModel,
            bikeYear: ridersTable.bikeYear,
            sponsors: ridersTable.sponsors,
          })
          .from(ridersTable)
          .where(inArray(ridersTable.id, regRiderIds))
      : [];

  const riders = ridersWithEmail;
  // Every transponder these riders own (several RM TrackRs / stickers per rider),
  // so the offline server times any of them. The desktop replaces each pulled
  // rider's list with this one unless it has an unpushed edit of its own.
  const riderTransponders = regRiderIds.length > 0
    ? await db.select({
        riderId: riderTranspondersTable.riderId,
        transponderNumber: riderTranspondersTable.transponderNumber,
        kind: riderTranspondersTable.kind,
        label: riderTranspondersTable.label,
        createdAt: riderTranspondersTable.createdAt,
      }).from(riderTranspondersTable)
        .where(inArray(riderTranspondersTable.riderId, regRiderIds))
        .orderBy(asc(riderTranspondersTable.id))
    : [];

  // Push tokens: resolve rider emails → rider_accounts → rider_push_tokens
  // so the desktop can send notifications without round-tripping to the cloud.
  const riderEmails = ridersWithEmail
    .map((r) => (r.email ?? "").toLowerCase())
    .filter((e) => e.length > 0);

  let riderAccounts: Array<{ id: number; email: string }> = [];
  let riderPushTokens: Array<{ id: number; riderAccountId: number; expoPushToken: string }> = [];

  if (riderEmails.length > 0) {
    riderAccounts = await db
      .select({ id: riderAccountsTable.id, email: riderAccountsTable.email })
      .from(riderAccountsTable)
      // Only accounts that verified their email own riders (lib/riderAccess.ts).
      .where(and(inArray(riderAccountsTable.email, riderEmails), isNotNull(riderAccountsTable.emailVerifiedAt)));

    const accountIds = riderAccounts.map((a) => a.id);
    if (accountIds.length > 0) {
      riderPushTokens = await db
        .select({
          id:              riderPushTokensTable.id,
          riderAccountId:  riderPushTokensTable.riderAccountId,
          expoPushToken:   riderPushTokensTable.expoPushToken,
        })
        .from(riderPushTokensTable)
        .where(inArray(riderPushTokensTable.riderAccountId, accountIds));
    }
  }

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
    registrations, checkins, rfidAssignments, riders, riderTransponders, events,
    motos, lapCrossings, raceResults, users: clubUsers,
    clubs: clubRow ? [clubRow] : [],
    pointsTables,
    series: clubSeries,
    seriesPoints,
    discountCategories,
    compCodes,
    practiceSessions,
    practiceCrossings,
    splitCrossings,
    practiceSplitCrossings,
    riderAccounts,
    riderPushTokens,
    clubSettings,
    liabilityWaiverSignatures,
    enduroTimeChecks,
    enduroCheckpointArrivals,
    eventReaderAssignments,
    teamMembers,
    clubSellItems,
    rentalTransponders,
    readers,
    addonPayments,
    tracks,
    // Whether each event's results are official (GET /events/:id "published").
    eventPublication: await db.select().from(eventPublicationTable).where(inArray(eventPublicationTable.eventId, clubEventIds)),
  });
});

export default router;
