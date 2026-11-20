import {
  db, raceResultsTable, motosTable, eventsTable, eventPublicationTable, clubsTable,
  ridersTable, riderFollowsTable, riderPushTokensTable, seriesTable, seriesPointsTable,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, ne, notInArray, sql } from "drizzle-orm";
import { computeProfileExtras, type ProfileExtras } from "./riderProfilePlus";
import { computeCareerStats, cumulativeMs, type CareerStats } from "./careerStats";
import { computeResume, effectiveVisibility, type RacerResume } from "./riderResume";
import { visiblePhotos } from "./riderPhotos";
import { sendPushNotifications } from "./push";
import { logger } from "./logger";
import { claimNotification, pendingResultNotifications, releaseNotification } from "./resultsNotify";

const FINISH_SENTINEL = 999;

/**
 * Career stats for a rider. `publishedOnly` limits to events whose results are
 * published: required for anything shown to people other than the rider's own
 * accounts (followers), since publication is separate from race status.
 */
export async function loadCareerStats(riderId: number, publishedOnly: boolean): Promise<CareerStats> {
  return (await loadCareer(riderId, publishedOnly, false)).stats;
}

/** Career stats plus the racer-profile résumé (highlights, badges, seasons, headline). */
export async function loadRacerResume(riderId: number, publishedOnly: boolean): Promise<{ stats: CareerStats; resume: RacerResume; extras: ProfileExtras }> {
  const { stats, resume, extras } = await loadCareer(riderId, publishedOnly, true);
  return { stats, resume: resume!, extras: extras! };
}

async function loadCareer(riderId: number, publishedOnly: boolean, withResume: boolean) {
  const where = publishedOnly
    ? and(eq(raceResultsTable.riderId, riderId), eq(motosTable.status, "completed"))
    : eq(raceResultsTable.riderId, riderId);
  const rows = await db
    .select({
      motoId: raceResultsTable.motoId, motoType: motosTable.type, motoName: motosTable.name,
      position: raceResultsTable.position, dnf: raceResultsTable.dnf, dns: raceResultsTable.dns,
      lapTimes: raceResultsTable.lapTimes, eventId: raceResultsTable.eventId, eventName: eventsTable.name,
      raceStyle: eventsTable.raceStyle, eventDate: eventsTable.date, raceClass: raceResultsTable.raceClass,
      track: sql<string | null>`coalesce(nullif(${eventsTable.trackName}, ''), nullif(${eventsTable.location}, ''))`,
      state: eventsTable.state,
    })
    .from(raceResultsTable)
    .leftJoin(motosTable, eq(raceResultsTable.motoId, motosTable.id))
    .leftJoin(eventsTable, eq(raceResultsTable.eventId, eventsTable.id))
    .leftJoin(eventPublicationTable, eq(eventPublicationTable.eventId, raceResultsTable.eventId))
    .where(where);

  const motoIds = [...new Set(rows.map(r => r.motoId))];
  const field = motoIds.length
    ? await db.select({ motoId: raceResultsTable.motoId, lapTimes: raceResultsTable.lapTimes, dns: raceResultsTable.dns })
        .from(raceResultsTable).where(inArray(raceResultsTable.motoId, motoIds))
    : [];
  const fieldByMoto = new Map<number, number[][]>();
  // Starters per race (everyone who isn't DNS): the field size behind a "big win".
  const startersByMoto = new Map<number, number>();
  for (const f of field) {
    if (!f.dns) startersByMoto.set(f.motoId, (startersByMoto.get(f.motoId) ?? 0) + 1);
    const cum = cumulativeMs((f.lapTimes as unknown[]) ?? []);
    if (!cum) continue;
    if (!fieldByMoto.has(f.motoId)) fieldByMoto.set(f.motoId, []);
    fieldByMoto.get(f.motoId)!.push(cum);
  }
  const stats = computeCareerStats(rows.map(r => ({
    motoId: r.motoId, motoType: r.motoType, position: r.position, dnf: r.dnf, dns: r.dns,
    lapTimes: (r.lapTimes as unknown[]) ?? [], eventId: r.eventId,
    eventName: r.eventName ?? `Event ${r.eventId}`, motoName: r.motoName ?? "Moto", raceStyle: r.raceStyle,
  })), fieldByMoto);
  const resume = withResume
    ? computeResume(rows.map(r => ({
        motoId: r.motoId, motoType: r.motoType, position: r.position, dnf: r.dnf, dns: r.dns,
        lapTimes: (r.lapTimes as unknown[]) ?? [], eventId: r.eventId,
        eventName: r.eventName ?? `Event ${r.eventId}`, eventDate: String(r.eventDate ?? ""),
        raceClass: r.raceClass, track: r.track ?? null,
      })), fieldByMoto, stats)
    : null;
  const extras = withResume
    ? computeProfileExtras(rows.map(r => ({
        motoId: r.motoId, motoType: r.motoType, motoName: r.motoName ?? "Moto", position: r.position, dnf: r.dnf, dns: r.dns,
        eventId: r.eventId, eventName: r.eventName ?? `Event ${r.eventId}`, eventDate: String(r.eventDate ?? ""),
        raceClass: r.raceClass, track: r.track ?? null, state: r.state ?? null,
      })), startersByMoto)
    : null;
  return { stats, resume, extras };
}

export interface FeedItem {
  riderId: number;
  riderName: string;
  eventId: number;
  eventName: string;
  eventDate: string;
  raceClass: string;
  /** Track or venue name, when the event has one. */
  track: string | null;
  publishedAt: string | null;
  /** Every race in this item finalized by the organizer; otherwise unofficial results. */
  official: boolean;
  bestPosition: number | null;
  /** Headshot, only when the profile is public (the feed route adds your own riders' photos). */
  riderAvatarUrl: string | null;
  motos: Array<{ motoName: string; position: number | null; dnf: boolean; dns: boolean }>;
}

/** Published results for these riders, newest event first, one item per rider + event + class. */
export async function loadResultsFeed(riderIds: number[], limit = 30): Promise<FeedItem[]> {
  if (riderIds.length === 0) return [];
  const rows = await db
    .select({
      riderId: raceResultsTable.riderId, firstName: ridersTable.firstName, lastName: ridersTable.lastName,
      dateOfBirth: ridersTable.dateOfBirth, profileVisibility: ridersTable.profileVisibility,
      avatarUrl: ridersTable.avatarUrl, coverUrl: ridersTable.coverUrl,
      eventId: raceResultsTable.eventId, eventName: eventsTable.name, eventDate: eventsTable.date,
      raceClass: raceResultsTable.raceClass, publishedAt: eventPublicationTable.publishedAt,
      motoName: motosTable.name, motoNumber: motosTable.motoNumber, motoType: motosTable.type,
      position: raceResultsTable.position, dnf: raceResultsTable.dnf, dns: raceResultsTable.dns,
      resultsFinalizedAt: motosTable.resultsFinalizedAt,
      track: sql<string | null>`coalesce(nullif(${eventsTable.trackName}, ''), nullif(${eventsTable.location}, ''))`,
    })
    .from(raceResultsTable)
    .leftJoin(eventPublicationTable, eq(eventPublicationTable.eventId, raceResultsTable.eventId))
    .innerJoin(ridersTable, eq(ridersTable.id, raceResultsTable.riderId))
    .leftJoin(eventsTable, eq(eventsTable.id, raceResultsTable.eventId))
    .leftJoin(motosTable, eq(motosTable.id, raceResultsTable.motoId))
    .where(and(inArray(raceResultsTable.riderId, riderIds), eq(motosTable.status, "completed")))
    .orderBy(desc(eventsTable.date), motosTable.motoNumber);

  const today = new Date().toISOString().slice(0, 10);
  const items = new Map<string, FeedItem>();
  for (const r of rows) {
    if (r.motoType === "practice") continue;
    const key = `${r.riderId}:${r.eventId}:${r.raceClass}`;
    if (!items.has(key)) {
      if (items.size >= limit) continue;
      items.set(key, {
        riderId: r.riderId, riderName: `${r.firstName} ${r.lastName}`.trim(), eventId: r.eventId,
        eventName: r.eventName ?? `Event ${r.eventId}`, eventDate: String(r.eventDate ?? "").slice(0, 10),
        raceClass: r.raceClass, track: r.track ?? null, publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
        official: true, bestPosition: null, motos: [],
        riderAvatarUrl: visiblePhotos(r, false, today).avatarUrl,
      });
    }
    const item = items.get(key)!;
    if (r.resultsFinalizedAt == null) item.official = false;
    const finished = !r.dnf && !r.dns && r.position > 0 && r.position < FINISH_SENTINEL;
    item.motos.push({ motoName: r.motoName ?? "Moto", position: finished ? r.position : null, dnf: r.dnf, dns: r.dns });
    if (finished && (item.bestPosition == null || r.position < item.bestPosition)) item.bestPosition = r.position;
  }
  return [...items.values()];
}

/** Riders who have at least one finished-race result, matched by name, for "find riders to follow". */
export async function searchPublicRiders(q: string, limit = 20) {
  const term = `%${q.trim().toLowerCase()}%`;
  const rows = await db
    .select({
      id: ridersTable.id, firstName: ridersTable.firstName, lastName: ridersTable.lastName,
      dateOfBirth: ridersTable.dateOfBirth, profileVisibility: ridersTable.profileVisibility,
      avatarUrl: ridersTable.avatarUrl,
      lastRaced: sql<string>`max(${eventsTable.date})`,
      clubName: sql<string>`max(${clubsTable.name})`,
    })
    .from(ridersTable)
    .innerJoin(raceResultsTable, eq(raceResultsTable.riderId, ridersTable.id))
    // Results are public once the race is finished (unofficial until finalized).
    .innerJoin(motosTable, and(eq(motosTable.id, raceResultsTable.motoId), eq(motosTable.status, "completed")))
    .innerJoin(eventsTable, eq(eventsTable.id, raceResultsTable.eventId))
    .leftJoin(clubsTable, eq(clubsTable.id, eventsTable.clubId))
    .where(sql`lower(${ridersTable.firstName} || ' ' || ${ridersTable.lastName}) like ${term}`)
    .groupBy(ridersTable.id)
    .orderBy(desc(sql`max(${eventsTable.date})`))
    .limit(limit * 2);
  // Private profiles (under-18 by default) aren't listed in search.
  const today = new Date().toISOString().slice(0, 10);
  return rows.filter(r => effectiveVisibility(r, today) === "public").slice(0, limit).map(r => ({
    id: r.id, name: `${r.firstName} ${r.lastName}`.trim(), avatarUrl: r.avatarUrl ?? null,
    lastRaced: r.lastRaced ? String(r.lastRaced).slice(0, 10) : null, clubName: r.clubName ?? null,
  }));
}

/**
 * Followers hear once when an event's results become official. If results are
 * corrected and finalized again, only followers of riders whose place or lap
 * times changed hear again ("Results updated"); lib/resultsNotify.ts keeps the
 * record, so a restart or a second finalize can't repeat a push.
 */
/** The stats run and the follower push start together on first official; anything older is a past event. */
const LEGACY_RESULTS_MS = 10 * 60_000;

export async function notifyFollowersOfResults(eventId: number): Promise<void> {
  try {
    const pending = await pendingResultNotifications(eventId, "follow_push");
    const [event] = await db.select({ name: eventsTable.name, statsSentAt: eventsTable.statsEmailsSentAt })
      .from(eventsTable).where(eq(eventsTable.id, eventId));
    // An event made official before this record existed (its stats run is
    // older than a few minutes, and nobody is recorded): note today's results
    // as told rather than pushing every follower a second time.
    if (pending.sent.size === 0 && event?.statsSentAt && Date.now() - new Date(event.statsSentAt).getTime() > LEGACY_RESULTS_MS) {
      for (const [riderId, fingerprint] of pending.current) await claimNotification(eventId, riderId, "follow_push", fingerprint);
      return;
    }
    const due = [...pending.first, ...pending.changed];
    if (due.length === 0) return;
    const updated = new Set(pending.changed);

    // Finished races only: practice and races still running aren't results.
    const results = await db
      .select({ riderId: raceResultsTable.riderId, firstName: ridersTable.firstName, lastName: ridersTable.lastName,
        raceClass: raceResultsTable.raceClass, position: raceResultsTable.position, dnf: raceResultsTable.dnf, dns: raceResultsTable.dns })
      .from(raceResultsTable).innerJoin(ridersTable, eq(ridersTable.id, raceResultsTable.riderId))
      .innerJoin(motosTable, eq(motosTable.id, raceResultsTable.motoId))
      .where(and(eq(raceResultsTable.eventId, eventId), inArray(raceResultsTable.riderId, due),
        eq(motosTable.status, "completed"), ne(motosTable.type, "practice")));

    const best = new Map<number, { name: string; raceClass: string; position: number | null }>();
    for (const r of results) {
      const pos = !r.dnf && !r.dns && r.position > 0 && r.position < FINISH_SENTINEL ? r.position : null;
      const cur = best.get(r.riderId);
      if (!cur) best.set(r.riderId, { name: `${r.firstName} ${r.lastName}`.trim(), raceClass: r.raceClass, position: pos });
      else if (pos != null && (cur.position == null || pos < cur.position)) { cur.position = pos; cur.raceClass = r.raceClass; }
    }

    // Claim each rider first: a second finalize running now skips them.
    const claimed: number[] = [];
    for (const riderId of best.keys()) {
      if (await claimNotification(eventId, riderId, "follow_push", pending.current.get(riderId)!)) claimed.push(riderId);
    }
    if (claimed.length === 0) return;
    const release = async () => { for (const id of claimed) await releaseNotification(eventId, id, "follow_push", pending.sent.get(id)); };

    try {
      const follows = await db.select({ accountId: riderFollowsTable.riderAccountId, riderId: riderFollowsTable.riderId })
        .from(riderFollowsTable).where(inArray(riderFollowsTable.riderId, claimed));
      if (follows.length === 0) return;
      const byAccount = new Map<number, number[]>();
      for (const f of follows) byAccount.set(f.accountId, [...(byAccount.get(f.accountId) ?? []), f.riderId]);
      const tokens = await db.select({ accountId: riderPushTokensTable.riderAccountId, token: riderPushTokensTable.expoPushToken })
        .from(riderPushTokensTable).where(inArray(riderPushTokensTable.riderAccountId, [...byAccount.keys()]));

      const eventName = event?.name ?? "the race";
      const messages = tokens.map(t => {
        const ids = byAccount.get(t.accountId) ?? [];
        const riders = ids.map(id => best.get(id)!).filter(Boolean);
        const correction = ids.every(id => updated.has(id));
        const body = riders.length === 1
          ? `${riders[0].name} ${riders[0].position ? `${correction ? "now shows" : "finished"} P${riders[0].position}` : "raced"} in ${riders[0].raceClass} at ${eventName}.`
          : `${riders.length} riders you follow have ${correction ? "updated " : ""}results from ${eventName}.`;
        return { to: t.token, title: correction ? "Results updated 🏁" : "Results are in 🏁", body, data: { type: "follow-results", eventId } };
      });
      if (messages.length) {
        const result = await sendPushNotifications(messages);
        // Nothing accepted and it's worth retrying: let a later finalize send it.
        if (result.accepted === 0 && result.results.some(r => r.retryable)) await release();
      }
    } catch (err) {
      await release();
      throw err;
    }
  } catch (err) {
    logger.error({ err, eventId }, "notifyFollowersOfResults failed");
  }
}

// ── Racer profile extras (lib/riderProfilePlus.ts) ────────────────────────────

export interface SeriesStanding {
  seriesId: number;
  seriesName: string;
  raceClass: string;
  position: number;
  points: number;
  riders: number;
}

/** Where the rider stands in each series class they have points in, most recently updated first. */
export async function loadSeriesStandings(riderId: number, limit = 4): Promise<SeriesStanding[]> {
  const mine = await db
    .select({ seriesId: seriesPointsTable.seriesId, raceClass: seriesPointsTable.raceClass, points: seriesPointsTable.totalPoints, seriesName: seriesTable.name })
    .from(seriesPointsTable).innerJoin(seriesTable, eq(seriesTable.id, seriesPointsTable.seriesId))
    .where(eq(seriesPointsTable.riderId, riderId))
    .orderBy(desc(seriesPointsTable.updatedAt)).limit(limit);
  const out: SeriesStanding[] = [];
  for (const m of mine) {
    const [rank] = await db
      .select({
        ahead: sql<number>`count(*) filter (where ${seriesPointsTable.totalPoints} > ${m.points})`,
        riders: sql<number>`count(*)`,
      })
      .from(seriesPointsTable)
      .where(and(eq(seriesPointsTable.seriesId, m.seriesId), eq(seriesPointsTable.raceClass, m.raceClass)));
    out.push({ seriesId: m.seriesId, seriesName: m.seriesName, raceClass: m.raceClass, points: m.points, position: Number(rank?.ahead ?? 0) + 1, riders: Number(rank?.riders ?? 1) });
  }
  return out;
}

const completedRace = and(eq(motosTable.status, "completed"), ne(motosTable.type, "practice"));

/** Riders who lined up in the same races as `mine` most often: [riderId, shared races]. */
export async function loadCommonCompetitors(mine: number[], limit = 40): Promise<Array<{ riderId: number; weight: number }>> {
  if (mine.length === 0) return [];
  const myMotos = db.select({ motoId: raceResultsTable.motoId }).from(raceResultsTable)
    .innerJoin(motosTable, eq(motosTable.id, raceResultsTable.motoId))
    .where(and(inArray(raceResultsTable.riderId, mine), completedRace));
  const rows = await db
    .select({ riderId: raceResultsTable.riderId, shared: sql<number>`count(distinct ${raceResultsTable.motoId})` })
    .from(raceResultsTable)
    .where(and(inArray(raceResultsTable.motoId, myMotos), notInArray(raceResultsTable.riderId, mine)))
    .groupBy(raceResultsTable.riderId)
    .orderBy(desc(sql`count(distinct ${raceResultsTable.motoId})`))
    .limit(limit);
  return rows.map(r => ({ riderId: r.riderId, weight: Number(r.shared) }));
}

/** Riders with the most race wins in the last 12 months: [riderId, wins]. */
export async function loadTopRiders(limit = 40): Promise<Array<{ riderId: number; weight: number }>> {
  const since = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select({ riderId: raceResultsTable.riderId, wins: sql<number>`count(*)` })
    .from(raceResultsTable)
    .innerJoin(motosTable, eq(motosTable.id, raceResultsTable.motoId))
    .innerJoin(eventsTable, eq(eventsTable.id, raceResultsTable.eventId))
    .where(and(completedRace, eq(raceResultsTable.position, 1), eq(raceResultsTable.dnf, false), eq(raceResultsTable.dns, false),
      gte(sql`${eventsTable.date}::text`, since)))
    .groupBy(raceResultsTable.riderId)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
  return rows.map(r => ({ riderId: r.riderId, weight: Number(r.wins) }));
}

/** Riders from these home states who have raced, most recent first. */
export async function loadRidersNear(states: string[], limit = 40): Promise<Array<{ riderId: number; weight: number }>> {
  const codes = [...new Set(states.map(s => s.trim().toUpperCase()).filter(s => /^[A-Z]{2}$/.test(s)))];
  if (codes.length === 0) return [];
  const rows = await db
    .select({ riderId: ridersTable.id, last: sql<string>`max(${eventsTable.date}::text)` })
    .from(ridersTable)
    .innerJoin(raceResultsTable, eq(raceResultsTable.riderId, ridersTable.id))
    .innerJoin(motosTable, and(eq(motosTable.id, raceResultsTable.motoId), completedRace))
    .innerJoin(eventsTable, eq(eventsTable.id, raceResultsTable.eventId))
    .where(inArray(sql`upper(${ridersTable.homeState})`, codes))
    .groupBy(ridersTable.id)
    .orderBy(desc(sql`max(${eventsTable.date}::text)`))
    .limit(limit);
  // Newest first: weight falls with rank.
  return rows.map((r, i) => ({ riderId: r.riderId, weight: rows.length - i }));
}
