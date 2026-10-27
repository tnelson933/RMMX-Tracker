import {
  db, raceResultsTable, motosTable, eventsTable, eventPublicationTable, clubsTable,
  ridersTable, riderFollowsTable, riderPushTokensTable,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { computeCareerStats, cumulativeMs, type CareerStats } from "./careerStats";
import { sendPushNotifications } from "./push";
import { logger } from "./logger";

const FINISH_SENTINEL = 999;

/**
 * Career stats for a rider. `publishedOnly` limits to events whose results are
 * published: required for anything shown to people other than the rider's own
 * accounts (followers), since publication is separate from race status.
 */
export async function loadCareerStats(riderId: number, publishedOnly: boolean): Promise<CareerStats> {
  const where = publishedOnly
    ? and(eq(raceResultsTable.riderId, riderId), eq(eventPublicationTable.published, true))
    : eq(raceResultsTable.riderId, riderId);
  const rows = await db
    .select({
      motoId: raceResultsTable.motoId, motoType: motosTable.type, motoName: motosTable.name,
      position: raceResultsTable.position, dnf: raceResultsTable.dnf, dns: raceResultsTable.dns,
      lapTimes: raceResultsTable.lapTimes, eventId: raceResultsTable.eventId, eventName: eventsTable.name,
      raceStyle: eventsTable.raceStyle,
    })
    .from(raceResultsTable)
    .leftJoin(motosTable, eq(raceResultsTable.motoId, motosTable.id))
    .leftJoin(eventsTable, eq(raceResultsTable.eventId, eventsTable.id))
    .leftJoin(eventPublicationTable, eq(eventPublicationTable.eventId, raceResultsTable.eventId))
    .where(where);

  const motoIds = [...new Set(rows.map(r => r.motoId))];
  const field = motoIds.length
    ? await db.select({ motoId: raceResultsTable.motoId, lapTimes: raceResultsTable.lapTimes })
        .from(raceResultsTable).where(inArray(raceResultsTable.motoId, motoIds))
    : [];
  const fieldByMoto = new Map<number, number[][]>();
  for (const f of field) {
    const cum = cumulativeMs((f.lapTimes as unknown[]) ?? []);
    if (!cum) continue;
    if (!fieldByMoto.has(f.motoId)) fieldByMoto.set(f.motoId, []);
    fieldByMoto.get(f.motoId)!.push(cum);
  }
  return computeCareerStats(rows.map(r => ({
    motoId: r.motoId, motoType: r.motoType, position: r.position, dnf: r.dnf, dns: r.dns,
    lapTimes: (r.lapTimes as unknown[]) ?? [], eventId: r.eventId,
    eventName: r.eventName ?? `Event ${r.eventId}`, motoName: r.motoName ?? "Moto", raceStyle: r.raceStyle,
  })), fieldByMoto);
}

export interface FeedItem {
  riderId: number;
  riderName: string;
  eventId: number;
  eventName: string;
  eventDate: string;
  raceClass: string;
  publishedAt: string | null;
  bestPosition: number | null;
  motos: Array<{ motoName: string; position: number | null; dnf: boolean; dns: boolean }>;
}

/** Published results for these riders, newest event first, one item per rider + event + class. */
export async function loadResultsFeed(riderIds: number[], limit = 30): Promise<FeedItem[]> {
  if (riderIds.length === 0) return [];
  const rows = await db
    .select({
      riderId: raceResultsTable.riderId, firstName: ridersTable.firstName, lastName: ridersTable.lastName,
      eventId: raceResultsTable.eventId, eventName: eventsTable.name, eventDate: eventsTable.date,
      raceClass: raceResultsTable.raceClass, publishedAt: eventPublicationTable.publishedAt,
      motoName: motosTable.name, motoNumber: motosTable.motoNumber, motoType: motosTable.type,
      position: raceResultsTable.position, dnf: raceResultsTable.dnf, dns: raceResultsTable.dns,
    })
    .from(raceResultsTable)
    .innerJoin(eventPublicationTable, and(eq(eventPublicationTable.eventId, raceResultsTable.eventId), eq(eventPublicationTable.published, true)))
    .innerJoin(ridersTable, eq(ridersTable.id, raceResultsTable.riderId))
    .leftJoin(eventsTable, eq(eventsTable.id, raceResultsTable.eventId))
    .leftJoin(motosTable, eq(motosTable.id, raceResultsTable.motoId))
    .where(inArray(raceResultsTable.riderId, riderIds))
    .orderBy(desc(eventsTable.date), motosTable.motoNumber);

  const items = new Map<string, FeedItem>();
  for (const r of rows) {
    if (r.motoType === "practice") continue;
    const key = `${r.riderId}:${r.eventId}:${r.raceClass}`;
    if (!items.has(key)) {
      if (items.size >= limit) continue;
      items.set(key, {
        riderId: r.riderId, riderName: `${r.firstName} ${r.lastName}`.trim(), eventId: r.eventId,
        eventName: r.eventName ?? `Event ${r.eventId}`, eventDate: String(r.eventDate ?? "").slice(0, 10),
        raceClass: r.raceClass, publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
        bestPosition: null, motos: [],
      });
    }
    const item = items.get(key)!;
    const finished = !r.dnf && !r.dns && r.position > 0 && r.position < FINISH_SENTINEL;
    item.motos.push({ motoName: r.motoName ?? "Moto", position: finished ? r.position : null, dnf: r.dnf, dns: r.dns });
    if (finished && (item.bestPosition == null || r.position < item.bestPosition)) item.bestPosition = r.position;
  }
  return [...items.values()];
}

/** Riders who have at least one published result, matched by name, for "find riders to follow". */
export async function searchPublicRiders(q: string, limit = 20) {
  const term = `%${q.trim().toLowerCase()}%`;
  const rows = await db
    .select({
      id: ridersTable.id, firstName: ridersTable.firstName, lastName: ridersTable.lastName,
      lastRaced: sql<string>`max(${eventsTable.date})`,
      clubName: sql<string>`max(${clubsTable.name})`,
    })
    .from(ridersTable)
    .innerJoin(raceResultsTable, eq(raceResultsTable.riderId, ridersTable.id))
    .innerJoin(eventPublicationTable, and(eq(eventPublicationTable.eventId, raceResultsTable.eventId), eq(eventPublicationTable.published, true)))
    .innerJoin(eventsTable, eq(eventsTable.id, raceResultsTable.eventId))
    .leftJoin(clubsTable, eq(clubsTable.id, eventsTable.clubId))
    .where(sql`lower(${ridersTable.firstName} || ' ' || ${ridersTable.lastName}) like ${term}`)
    .groupBy(ridersTable.id)
    .orderBy(desc(sql`max(${eventsTable.date})`))
    .limit(limit);
  return rows.map(r => ({
    id: r.id, name: `${r.firstName} ${r.lastName}`.trim(),
    lastRaced: r.lastRaced ? String(r.lastRaced).slice(0, 10) : null, clubName: r.clubName ?? null,
  }));
}

/**
 * Push "results are in" to accounts following riders in this event. Fire-and-forget:
 * called when an event's results go from unpublished to published.
 */
export async function notifyFollowersOfResults(eventId: number): Promise<void> {
  try {
    const [event] = await db.select({ name: eventsTable.name }).from(eventsTable).where(eq(eventsTable.id, eventId));
    const results = await db
      .select({ riderId: raceResultsTable.riderId, firstName: ridersTable.firstName, lastName: ridersTable.lastName,
        raceClass: raceResultsTable.raceClass, position: raceResultsTable.position, dnf: raceResultsTable.dnf, dns: raceResultsTable.dns })
      .from(raceResultsTable).innerJoin(ridersTable, eq(ridersTable.id, raceResultsTable.riderId))
      .where(eq(raceResultsTable.eventId, eventId));
    if (results.length === 0) return;

    const best = new Map<number, { name: string; raceClass: string; position: number | null }>();
    for (const r of results) {
      const pos = !r.dnf && !r.dns && r.position > 0 && r.position < FINISH_SENTINEL ? r.position : null;
      const cur = best.get(r.riderId);
      if (!cur) best.set(r.riderId, { name: `${r.firstName} ${r.lastName}`.trim(), raceClass: r.raceClass, position: pos });
      else if (pos != null && (cur.position == null || pos < cur.position)) cur.position = pos;
    }
    const follows = await db.select({ accountId: riderFollowsTable.riderAccountId, riderId: riderFollowsTable.riderId })
      .from(riderFollowsTable).where(inArray(riderFollowsTable.riderId, [...best.keys()]));
    if (follows.length === 0) return;

    const byAccount = new Map<number, number[]>();
    for (const f of follows) byAccount.set(f.accountId, [...(byAccount.get(f.accountId) ?? []), f.riderId]);
    const tokens = await db.select({ accountId: riderPushTokensTable.riderAccountId, token: riderPushTokensTable.expoPushToken })
      .from(riderPushTokensTable).where(inArray(riderPushTokensTable.riderAccountId, [...byAccount.keys()]));

    const eventName = event?.name ?? "the race";
    const messages = tokens.map(t => {
      const riders = (byAccount.get(t.accountId) ?? []).map(id => best.get(id)!).filter(Boolean);
      const body = riders.length === 1
        ? `${riders[0].name} ${riders[0].position ? `finished P${riders[0].position}` : "raced"} in ${riders[0].raceClass} at ${eventName}.`
        : `${riders.length} riders you follow have results from ${eventName}.`;
      return { to: t.token, title: "Results are in 🏁", body, data: { type: "follow-results", eventId } };
    });
    if (messages.length) await sendPushNotifications(messages);
  } catch (err) {
    logger.error({ err, eventId }, "notifyFollowersOfResults failed");
  }
}
