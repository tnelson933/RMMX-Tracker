import { db, eventsTable, motosTable, raceResultsTable, registrationsTable, ridersTable } from "@workspace/db";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { brandedEmailHtml, esc } from "./emailLayout";
import { sendEmail } from "./email";
import { logger } from "./logger";

/**
 * "Send me my race day stats" (a checkbox at online registration): once all of
 * an event's results are official (the organizer finalized every race), each
 * opted-in rider who raced gets one email with their results. Sent once per
 * event; nothing for the organizer to do beyond finalizing.
 */

export interface StatsRow {
  motoName: string;
  raceClass: string;
  position: number;
  totalTime: string | null;
  /** Lap times in milliseconds, as stored. */
  lapTimesMs: number[];
  points: number | null;
  dnf: boolean;
  dns: boolean;
}

/** 28000 → "0:28.000"; 75250 → "1:15.250". */
export function formatLap(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const total = Math.round(ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const rest = total % 1000;
  return `${m}:${String(s).padStart(2, "0")}.${String(rest).padStart(3, "0")}`;
}

const ordinal = (n: number) => {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
};

/** The results table for one rider (inline styles for mail apps). */
export function statsTableHtml(rows: StatsRow[]): string {
  const cell = "padding:12px 8px;border-bottom:1px solid #ececec;vertical-align:top;font-family:'Barlow',Arial,sans-serif;";
  const head = "padding:6px 8px 8px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#8c8c8c;border-bottom:2px solid #242424;font-family:'Barlow',Arial,sans-serif;";
  const body = rows.map(r => {
    const finish = r.dns ? "DNS" : r.dnf ? "DNF" : ordinal(r.position);
    const color = r.dns || r.dnf ? "#8c8c8c" : r.position === 1 ? "#B30000" : "#1a1a1a";
    const laps = r.lapTimesMs.filter(ms => ms > 0);
    const best = laps.length ? Math.min(...laps) : null;
    const lapHtml = laps.length
      ? laps.map((ms, i) => `<span style="display:inline-block;margin:2px 4px 2px 0;padding:2px 7px;border-radius:4px;font-size:12px;font-family:monospace;${ms === best ? "background:#B30000;color:#fff;" : "background:#f1f1f1;color:#444;"}">L${i + 1} ${formatLap(ms)}</span>`).join("")
      : `<span style="color:#aaa;font-size:13px">No lap times</span>`;
    return `<tr>
      <td style="${cell}"><div style="font-weight:700;font-size:14px;color:#1a1a1a">${esc(r.motoName)}</div><div style="font-size:11px;color:#8c8c8c;text-transform:uppercase;letter-spacing:.5px">${esc(r.raceClass)}</div></td>
      <td style="${cell}text-align:center"><span style="font-family:'Barlow Condensed',Arial,sans-serif;font-size:22px;font-weight:800;color:${color}">${finish}</span></td>
      <td style="${cell}text-align:center;font-family:monospace;font-size:13px;color:#333">${esc(r.totalTime ?? "—")}${best != null ? `<div style="font-size:11px;color:#8c8c8c;font-family:Arial,sans-serif">Best ${formatLap(best)}</div>` : ""}</td>
      <td style="${cell}text-align:center;font-weight:700;color:#B30000">${r.points ?? 0}</td>
    </tr>
    <tr><td colspan="4" style="padding:0 8px 12px;border-bottom:1px solid #ececec">${lapHtml}</td></tr>`;
  }).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:4px 0 8px;">
    <tr><th align="left" style="${head}">Race</th><th style="${head}">Finish</th><th style="${head}">Time</th><th style="${head}">Pts</th></tr>
    ${body}
  </table>`;
}

function appUrl(): string {
  const domains = process.env.REPLIT_DOMAINS;
  return (process.env.APP_URL ?? (domains ? `https://${domains.split(",")[0]}` : "http://localhost:80")).replace(/\/$/, "");
}

/** "2026-11-13" → "Friday, November 13, 2026" (no timezone shift). */
function longDate(date: string): string {
  const [y, m, d] = String(date).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return String(date);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/**
 * Send the stats emails for an event whose results just became official.
 * Claims the event first, so a second trigger (or finalizing again after a
 * correction) never sends twice. Returns how many were sent.
 */
export async function sendRaceDayStats(eventId: number): Promise<number> {
  const [claimed] = await db.update(eventsTable).set({ statsEmailsSentAt: new Date() })
    .where(and(eq(eventsTable.id, eventId), isNull(eventsTable.statsEmailsSentAt)))
    .returning({ name: eventsTable.name, date: eventsTable.date });
  if (!claimed) return 0;

  const optedIn = await db.select({
    riderId: registrationsTable.riderId,
    email: ridersTable.email,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
  }).from(registrationsTable)
    .innerJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
    .where(and(
      eq(registrationsTable.eventId, eventId),
      eq(registrationsTable.statsEmailOptIn, true),
      ne(registrationsTable.status, "void"),
    ));
  // One email per rider (they may have entered several classes).
  const riders = new Map<number, { email: string; name: string }>();
  for (const r of optedIn) {
    if (r.email && !riders.has(r.riderId)) riders.set(r.riderId, { email: r.email.trim(), name: [r.firstName, r.lastName].filter(Boolean).join(" ") });
  }
  if (riders.size === 0) return 0;

  const results = await db.select({
    riderId: raceResultsTable.riderId,
    motoName: motosTable.name,
    motoNumber: motosTable.motoNumber,
    raceClass: raceResultsTable.raceClass,
    position: raceResultsTable.position,
    totalTime: raceResultsTable.totalTime,
    lapTimes: raceResultsTable.lapTimes,
    points: raceResultsTable.points,
    dnf: raceResultsTable.dnf,
    dns: raceResultsTable.dns,
  }).from(raceResultsTable)
    .innerJoin(motosTable, eq(raceResultsTable.motoId, motosTable.id))
    .where(and(
      eq(raceResultsTable.eventId, eventId),
      inArray(raceResultsTable.riderId, [...riders.keys()]),
      ne(motosTable.type, "practice"),
    ));

  const resultsUrl = `${appUrl()}/results/${eventId}`;
  const date = longDate(claimed.date);
  let sent = 0;
  let attempted = 0;
  for (const [riderId, rider] of riders) {
    const rows: StatsRow[] = results
      .filter(r => r.riderId === riderId)
      .sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0))
      .map(r => ({
        motoName: r.motoName ?? "Race",
        raceClass: r.raceClass,
        position: r.position,
        totalTime: r.totalTime,
        lapTimesMs: Array.isArray(r.lapTimes) ? (r.lapTimes as unknown[]).map(Number).filter(Number.isFinite) : [],
        points: r.points,
        dnf: r.dnf,
        dns: r.dns,
      }));
    if (rows.length === 0) continue; // opted in but didn't race
    attempted++;
    const html = brandedEmailHtml({
      appUrl: appUrl(),
      preheader: `Your official results from ${claimed.name}.`,
      eyebrow: "Race day stats",
      heading: claimed.name,
      paragraphs: [
        `Hi ${esc(rider.name || "rider")},`,
        `Here are your official results from <strong>${esc(claimed.name)}</strong> on ${esc(date)}. Your best lap in each race is highlighted.`,
      ],
      extraHtml: statsTableHtml(rows),
      button: { label: "View full event results", url: resultsUrl },
      note: "You're getting this because you checked \"Send me my race day stats\" when you registered for this event.",
    });
    const result = await sendEmail(rider.email, `Your race day stats: ${claimed.name}`, html);
    if (result.ok) sent++;
    else logger.warn({ eventId, riderId }, "race day stats email not sent");
  }
  logger.info({ eventId, sent, optedIn: riders.size }, "race day stats emails");
  // Nothing went out (email service down or not set up): let the next finalize try again.
  if (sent === 0 && attempted > 0) {
    await db.update(eventsTable).set({ statsEmailsSentAt: null }).where(eq(eventsTable.id, eventId));
  }
  return sent;
}
