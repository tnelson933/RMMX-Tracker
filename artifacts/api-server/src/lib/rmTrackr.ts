import { db, registrationsTable, RM_TRACKR_OPTION_ID, RM_TRACKR_NAME, RM_TRACKR_PRICE } from "@workspace/db";
import type { PurchaseOption } from "@workspace/db";
import { and, eq, isNull, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";

/** True when a list of purchase options includes the RM TrackR. */
export function includesRmTrackr(options: PurchaseOption[] | null | undefined): boolean {
  return Array.isArray(options) && options.some(o => String(o.id) === RM_TRACKR_OPTION_ID);
}

/**
 * Normalize an event's configured purchase options before saving: keep only
 * `{ id, name, amount }` (the old per-option discount category is dropped), give
 * an option without an id a new one, and make the RM TrackR always carry its
 * fixed name and the given price (the club's Sell Items price, or the price the
 * event already had), whatever the client sent, at most once.
 * Run checkPurchaseOptions (validateInput) first to reject bad names and prices.
 */
export function normalizeEventPurchaseOptions(options: unknown, trackrPrice: number = RM_TRACKR_PRICE): PurchaseOption[] {
  if (!Array.isArray(options)) return [];
  let hasTrackr = false;
  const out: PurchaseOption[] = [];
  for (const o of options as Array<Partial<PurchaseOption> | null>) {
    if (!o || typeof o !== "object") continue;
    if (String(o.id) === RM_TRACKR_OPTION_ID) {
      if (hasTrackr) continue;
      hasTrackr = true;
      out.push({ id: RM_TRACKR_OPTION_ID, name: RM_TRACKR_NAME, amount: trackrPrice });
    } else {
      const id = o.id === undefined || o.id === null || String(o.id) === "" ? randomUUID() : String(o.id);
      out.push({ id, name: String(o.name ?? "").trim(), amount: Number(o.amount) });
    }
  }
  return out;
}

/** Mark every active registration of a rider at an event as having bought an RM TrackR. */
export async function markRmTrackrPurchased(eventId: number, riderId: number): Promise<void> {
  await db.update(registrationsTable)
    .set({ rmTrackrPurchased: true })
    .where(and(
      eq(registrationsTable.eventId, eventId),
      eq(registrationsTable.riderId, riderId),
      ne(registrationsTable.status, "void"),
    ));
}

/**
 * Fulfil a rider's outstanding RM TrackR purchase for an event once staff assign
 * them a transponder. No-op when the rider bought none or it's already fulfilled.
 */
export async function fulfillRmTrackr(eventId: number, riderId: number, transponder: string | null | undefined): Promise<void> {
  const number = transponder?.trim();
  if (!number) return;
  await db.update(registrationsTable)
    .set({ rmTrackrFulfilledAt: new Date(), rmTrackrTransponder: number })
    .where(and(
      eq(registrationsTable.eventId, eventId),
      eq(registrationsTable.riderId, riderId),
      eq(registrationsTable.rmTrackrPurchased, true),
      isNull(registrationsTable.rmTrackrFulfilledAt),
    ));
}
