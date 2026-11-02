import { eventTimeZone } from "@workspace/api-zod";
import { db, clubsTable, eventsTable, motosTable, usersTable } from "@workspace/db";
import { and, eq, gt, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { brandedEmailHtml, esc } from "./emailLayout";
import { sendEmail } from "./email";
import { logger } from "./logger";

/**
 * Reminds a club's organizers to finalize results: 12 hours after an event
 * ended, if any finished race still isn't finalized, each organizer gets one
 * email with a button straight to Race Day Management (where races are
 * finalized). Sent once per event.
 */

export const REMINDER_DELAY_MS = 12 * 60 * 60 * 1000;
/** Events that ended longer ago than this are left alone (no reminders for old events). */
export const REMINDER_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const POLL_MS = 15 * 60 * 1000;

/** Offset (ms) of a time zone from UTC at an instant. */
function zoneOffsetMs(timeZone: string, at: Date): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant a date (YYYY-MM-DD) ends at the track: midnight after it, local time. */
export function endOfDayAt(date: string, timeZone: string): Date {
  const [y, m, d] = String(date).slice(0, 10).split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0));
  return new Date(guess.getTime() - zoneOffsetMs(timeZone, guess));
}

/**
 * When the event ended: when its last race finished, or (no finish times
 * recorded) the end of its last day at the track.
 */
export function eventEndedAt(event: { date: string; endDate: string | null; state: string | null; trackLat: number | null; trackLng: number | null }, lastRaceFinishedAt: Date | null): Date {
  if (lastRaceFinishedAt) return lastRaceFinishedAt;
  return endOfDayAt(event.endDate ?? event.date, eventTimeZone(event));
}

/** Is the reminder due now? */
export function reminderDue(endedAt: Date, now: Date): boolean {
  const since = now.getTime() - endedAt.getTime();
  return since >= REMINDER_DELAY_MS && since <= REMINDER_LOOKBACK_MS + REMINDER_DELAY_MS;
}

function appUrl(): string {
  const domains = process.env.REPLIT_DOMAINS;
  return (process.env.APP_URL ?? (domains ? `https://${domains.split(",")[0]}` : "http://localhost:80")).replace(/\/$/, "");
}

export function reminderEmailHtml(opts: { organizerName: string; eventName: string; unofficial: number; url: string }): string {
  const races = `${opts.unofficial} race${opts.unofficial === 1 ? "" : "s"}`;
  return brandedEmailHtml({
    appUrl: appUrl(),
    preheader: `${races} at ${opts.eventName} still need finalizing.`,
    eyebrow: "Finalize your results",
    heading: opts.eventName,
    paragraphs: [
      `Hi ${esc(opts.organizerName || "there")},`,
      `${esc(races)} at <strong>${esc(opts.eventName)}</strong> still show as <strong>unofficial</strong>. Review each one on Race Day Management and click <strong>Finalize Race</strong> to make the results official.`,
      `Once every race is finalized, riders see official results, series points update, and riders who asked for their race day stats get them by email.`,
    ],
    button: { label: "Finalize results", url: opts.url },
    note: "You're getting this because you're an organizer for this event's club. It's sent once, 12 hours after the event ended.",
  });
}

/** Send any reminders that are due. Returns how many events were reminded. */
export async function sendDueFinalizeReminders(now = new Date()): Promise<number> {
  // Events with finished races that aren't finalized, not yet reminded.
  const rows = await db.select({
    id: eventsTable.id,
    clubId: eventsTable.clubId,
    name: eventsTable.name,
    date: eventsTable.date,
    endDate: eventsTable.endDate,
    state: eventsTable.state,
    trackLat: eventsTable.trackLat,
    trackLng: eventsTable.trackLng,
    unofficial: sql<number>`count(*) filter (where ${motosTable.resultsFinalizedAt} is null)::int`,
    lastFinished: sql<Date | null>`max(${motosTable.completedAt})`,
  }).from(eventsTable)
    .innerJoin(motosTable, and(eq(motosTable.eventId, eventsTable.id), eq(motosTable.status, "completed"), ne(motosTable.type, "practice")))
    .where(and(isNull(eventsTable.finalizeReminderSentAt), gt(eventsTable.date, new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10))))
    .groupBy(eventsTable.id);

  let reminded = 0;
  for (const e of rows) {
    if (e.unofficial === 0) continue;
    const endedAt = eventEndedAt(
      { date: String(e.date), endDate: e.endDate ? String(e.endDate) : null, state: e.state, trackLat: e.trackLat, trackLng: e.trackLng },
      e.lastFinished ? new Date(e.lastFinished) : null,
    );
    if (!reminderDue(endedAt, now)) continue;
    // Claim it first, so two servers or two sweeps never send twice.
    const [claimed] = await db.update(eventsTable).set({ finalizeReminderSentAt: now })
      .where(and(eq(eventsTable.id, e.id), isNull(eventsTable.finalizeReminderSentAt))).returning({ id: eventsTable.id });
    if (!claimed) continue;

    const organizers = await db.select({ email: usersTable.email, name: usersTable.name }).from(usersTable)
      .where(and(eq(usersTable.clubId, e.clubId), eq(usersTable.role, "club_organizer"), isNotNull(usersTable.email)));
    const [club] = await db.select({ contactEmail: clubsTable.contactEmail }).from(clubsTable).where(eq(clubsTable.id, e.clubId));
    const to = new Map<string, string>();
    for (const o of organizers) if (o.email) to.set(o.email.trim().toLowerCase(), o.name ?? "");
    if (to.size === 0 && club?.contactEmail) to.set(club.contactEmail.trim().toLowerCase(), "");

    const url = `${appUrl()}/events/${e.id}/motos`;
    let sent = 0;
    for (const [email, name] of to) {
      const result = await sendEmail(email, `Finalize your results: ${e.name}`, reminderEmailHtml({ organizerName: name, eventName: e.name, unofficial: e.unofficial, url }));
      if (result.ok) sent++;
    }
    if (sent === 0 && to.size > 0) {
      // Email couldn't go out: try again on a later sweep.
      await db.update(eventsTable).set({ finalizeReminderSentAt: null }).where(eq(eventsTable.id, e.id));
      logger.warn({ eventId: e.id }, "finalize reminder not sent; will retry");
      continue;
    }
    reminded++;
    logger.info({ eventId: e.id, organizers: sent, unofficial: e.unofficial }, "finalize reminder sent");
  }
  return reminded;
}

let timer: NodeJS.Timeout | null = null;
export function startFinalizeReminders(): void {
  if (timer) return;
  const run = () => sendDueFinalizeReminders().catch(err => logger.error({ err: err?.message }, "finalize reminders failed"));
  setTimeout(run, 60_000);
  timer = setInterval(run, POLL_MS);
}
