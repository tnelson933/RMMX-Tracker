import { createHmac } from "node:crypto";
import { db, clubsTable, eventsTable, motosTable, raceGasCreditsTable, raceGasSettingsTable, raceResultsTable, ridersTable } from "@workspace/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Race Gas: Rocky Mountain ATV gives every rider who races an event a website
 * credit. The internal template ("Race gas example file.xlsx") needs, for each
 * rider, all of: first name (as on their RM account), last name, mailing
 * address, city, state, zip and email.
 *
 * Riders are gathered as their races finish (a rider counts once they've
 * started a finished, non-practice race), then sent to the CRM endpoint set on
 * the admin's Race Gas page. Each credit has a stable id, so it's never given
 * twice; a rider missing a required field waits as "missing info".
 */

export const RACE_GAS_FIELDS = [
  ["firstName", "First name"],
  ["lastName", "Last name"],
  ["streetAddress", "Mailing address"],
  ["city", "City"],
  ["state", "State"],
  ["zip", "Zipcode"],
  ["email", "Email address"],
] as const;

type RaceGasFields = Record<(typeof RACE_GAS_FIELDS)[number][0], string | null>;

/** Labels of the template fields this rider is missing. */
export function missingRaceGasFields(r: RaceGasFields): string[] {
  return RACE_GAS_FIELDS.filter(([key]) => !String(r[key] ?? "").trim()).map(([, label]) => label);
}

/** The credit's id in the CRM: the same rider and event always give the same id. */
export function raceGasCreditId(eventId: number, riderId: number): string {
  return `rmroost-race-gas-${eventId}-${riderId}`;
}

/** "Organization - Event - Month-Day-Year", as the template asks (e.g. "Ridersclub-Hareandhound-04-10-2018"). */
export function raceGasFileName(clubName: string, eventName: string, date: string): string {
  const [y, m, d] = String(date).slice(0, 10).split("-");
  const part = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "").trim() || "Event";
  return `${part(clubName)}-${part(eventName)}-${m}-${d}-${y}`;
}

export async function raceGasSettings() {
  const [row] = await db.select().from(raceGasSettingsTable).where(eq(raceGasSettingsTable.id, 1));
  return row ?? { id: 1, enabled: false, endpointUrl: null, apiKey: null, amount: "15", updatedAt: new Date() };
}

/**
 * Add (or refresh) a credit for every rider who has raced this event so far.
 * Sent credits are never changed. Returns how many riders have a credit.
 */
export async function gatherRaceGasCredits(eventId: number): Promise<number> {
  const [event] = await db.select({ status: eventsTable.status }).from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!event || event.status === "draft") return 0;

  // Raced = has a result in a finished race that isn't practice, and didn't "not start".
  const raced = await db.selectDistinct({ riderId: raceResultsTable.riderId })
    .from(raceResultsTable)
    .innerJoin(motosTable, eq(raceResultsTable.motoId, motosTable.id))
    .where(and(
      eq(raceResultsTable.eventId, eventId),
      eq(motosTable.status, "completed"),
      ne(motosTable.type, "practice"),
      eq(raceResultsTable.dns, false),
    ));
  if (raced.length === 0) return 0;

  const riders = await db.select({
    id: ridersTable.id, firstName: ridersTable.firstName, lastName: ridersTable.lastName,
    streetAddress: ridersTable.streetAddress, city: ridersTable.city, state: ridersTable.homeState,
    zip: ridersTable.zip, email: ridersTable.email,
  }).from(ridersTable).where(inArray(ridersTable.id, raced.map(r => r.riderId)));

  const { amount } = await raceGasSettings();
  for (const r of riders) {
    const fields: RaceGasFields = {
      firstName: r.firstName?.trim() || null, lastName: r.lastName?.trim() || null,
      streetAddress: r.streetAddress?.trim() || null, city: r.city?.trim() || null,
      state: r.state?.trim().toUpperCase() || null, zip: r.zip?.trim() || null, email: r.email?.trim().toLowerCase() || null,
    };
    const missing = missingRaceGasFields(fields);
    const status = missing.length ? "missing_info" : "ready";
    await db.insert(raceGasCreditsTable)
      .values({ eventId, riderId: r.id, ...fields, amount: String(amount), status, missingFields: missing })
      .onConflictDoUpdate({
        target: [raceGasCreditsTable.eventId, raceGasCreditsTable.riderId],
        // Profile fixes are picked up; a sent credit is left alone.
        set: { ...fields, missingFields: missing, updatedAt: new Date(),
          status: sql`case when ${raceGasCreditsTable.status} = 'sent' then 'sent' when ${missing.length > 0} then 'missing_info' when ${raceGasCreditsTable.status} = 'failed' then 'failed' else 'ready' end` },
      });
  }
  return riders.length;
}

/** What the CRM receives for one event (also the shape of the downloaded file's rows). */
export interface RaceGasPayload {
  source: "rm-roost";
  event: { id: number; name: string; date: string; club: string; fileName: string };
  credits: Array<{
    creditId: string; amount: number; firstName: string; lastName: string; mailingAddress: string;
    city: string; state: string; zipcode: string; email: string; riderId: number;
  }>;
}

/**
 * Send this event's ready (and previously failed) credits to the CRM, if
 * sending is turned on. A 2xx answer marks them sent, unless the CRM lists
 * per-credit failures ({ results: [{ creditId, ok, error }] }).
 */
export async function sendRaceGasCredits(eventId: number): Promise<{ sent: number; failed: number; skipped?: string }> {
  const settings = await raceGasSettings();
  if (!settings.enabled || !settings.endpointUrl) return { sent: 0, failed: 0, skipped: "sending is off" };

  const [event] = await db.select({ id: eventsTable.id, name: eventsTable.name, date: eventsTable.date, club: clubsTable.name })
    .from(eventsTable).leftJoin(clubsTable, eq(eventsTable.clubId, clubsTable.id)).where(eq(eventsTable.id, eventId));
  if (!event) return { sent: 0, failed: 0, skipped: "no event" };
  const pending = await db.select().from(raceGasCreditsTable)
    .where(and(eq(raceGasCreditsTable.eventId, eventId), inArray(raceGasCreditsTable.status, ["ready", "failed"])));
  if (pending.length === 0) return { sent: 0, failed: 0 };

  const payload: RaceGasPayload = {
    source: "rm-roost",
    event: { id: event.id, name: event.name, date: String(event.date).slice(0, 10), club: event.club ?? "", fileName: raceGasFileName(event.club ?? "", event.name, String(event.date)) },
    credits: pending.map(c => ({
      creditId: raceGasCreditId(eventId, c.riderId), amount: Number(c.amount), riderId: c.riderId,
      firstName: c.firstName ?? "", lastName: c.lastName ?? "", mailingAddress: c.streetAddress ?? "",
      city: c.city ?? "", state: c.state ?? "", zipcode: c.zip ?? "", email: c.email ?? "",
    })),
  };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "RM-Roost-RaceGas/1" };
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
    headers["X-RM-Roost-Signature"] = `sha256=${createHmac("sha256", settings.apiKey).update(body).digest("hex")}`;
  }

  const ids = pending.map(c => c.id);
  try {
    const res = await fetch(settings.endpointUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`CRM answered ${res.status}`);
    const answer = await res.json().catch(() => null) as { results?: Array<{ creditId: string; ok: boolean; error?: string }> } | null;
    const failedIds = new Map((answer?.results ?? []).filter(r => r.ok === false).map(r => [r.creditId, r.error ?? "Rejected by the CRM"]));
    let sent = 0;
    for (const c of pending) {
      const error = failedIds.get(raceGasCreditId(eventId, c.riderId));
      await db.update(raceGasCreditsTable)
        .set(error ? { status: "failed", lastError: error.slice(0, 500), updatedAt: new Date() } : { status: "sent", sentAt: new Date(), lastError: null, updatedAt: new Date() })
        .where(eq(raceGasCreditsTable.id, c.id));
      if (!error) sent++;
    }
    logger.info({ eventId, sent, failed: pending.length - sent }, "[race-gas] credits sent");
    return { sent, failed: pending.length - sent };
  } catch (err: any) {
    const message = String(err?.message ?? err).slice(0, 500);
    await db.update(raceGasCreditsTable).set({ status: "failed", lastError: message, updatedAt: new Date() }).where(inArray(raceGasCreditsTable.id, ids));
    logger.warn({ eventId, err: message }, "[race-gas] send failed; will retry");
    return { sent: 0, failed: pending.length };
  }
}

/** Gather then send; for the race-finished and results-official hooks. Never throws. */
export async function queueRaceGasCredits(eventId: number): Promise<void> {
  try {
    await gatherRaceGasCredits(eventId);
    await sendRaceGasCredits(eventId);
  } catch (err: any) {
    logger.warn({ eventId, err: err?.message }, "[race-gas] gather/send failed");
  }
}

/** Retry anything still waiting (CRM was down), every 15 minutes. */
export function startRaceGasRetries(): void {
  setInterval(async () => {
    try {
      const settings = await raceGasSettings();
      if (!settings.enabled || !settings.endpointUrl) return;
      const waiting = await db.selectDistinct({ eventId: raceGasCreditsTable.eventId }).from(raceGasCreditsTable)
        .where(inArray(raceGasCreditsTable.status, ["ready", "failed"]));
      for (const { eventId } of waiting) await sendRaceGasCredits(eventId);
    } catch (err: any) {
      logger.warn({ err: err?.message }, "[race-gas] retry pass failed");
    }
  }, 15 * 60_000).unref();
}
