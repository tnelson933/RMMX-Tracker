import { db, registrationsTable, RM_TRACKR_OPTION_ID, RM_TRACKR_NAME, RM_TRACKR_PRICE } from "@workspace/db";
import type { PurchaseOption } from "@workspace/db";
import { and, eq, isNull, ne } from "drizzle-orm";

/** True when a list of purchase options includes the RM TrackR. */
export function includesRmTrackr(options: PurchaseOption[] | null | undefined): boolean {
  return Array.isArray(options) && options.some(o => String(o.id) === RM_TRACKR_OPTION_ID);
}

/**
 * Normalize an event's configured purchase options before saving: the RM TrackR
 * always carries its fixed name and standard price, whatever the client sent,
 * and appears at most once.
 */
export function normalizeEventPurchaseOptions(options: unknown): PurchaseOption[] {
  if (!Array.isArray(options)) return [];
  let hasTrackr = false;
  const out: PurchaseOption[] = [];
  for (const o of options as PurchaseOption[]) {
    if (!o || typeof o !== "object") continue;
    if (String(o.id) === RM_TRACKR_OPTION_ID) {
      if (hasTrackr) continue;
      hasTrackr = true;
      out.push({ id: RM_TRACKR_OPTION_ID, name: RM_TRACKR_NAME, amount: RM_TRACKR_PRICE, categoryId: o.categoryId ?? null });
    } else {
      out.push(o);
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
