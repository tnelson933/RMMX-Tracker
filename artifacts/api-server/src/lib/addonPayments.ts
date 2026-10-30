import { db, addonPaymentsTable, eventsTable, registrationsTable, RM_TRACKR_PRICE } from "@workspace/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { eventTrackrPrice } from "./sellItems";

/**
 * Add-ons paid at check-in (transponder rentals, RM TrackR Transponder and RFID
 * tag sales), recorded apart from the registration's own payment so check-in
 * can show them paid and the event report can total them by cash and card.
 */

export type AddonItem = "transponder_rental" | "rm_trackr" | "rfid_sticker";
export type PayMethod = "cash" | "card";

const FLAG: Record<AddonItem, "transponderRental" | "rmTrackrPurchased" | "rfidStickerPurchased"> = {
  transponder_rental: "transponderRental",
  rm_trackr: "rmTrackrPurchased",
  rfid_sticker: "rfidStickerPurchased",
};

/** Cash taken at check-in: the add-on is paid now. */
export async function recordCashAddon(eventId: number, registrationId: number, item: AddonItem, amount: number): Promise<void> {
  await db.insert(addonPaymentsTable).values({
    eventId, registrationId, item, amount: amount.toFixed(2), method: "cash", status: "paid", paidAt: new Date(),
  });
}

/** A card checkout started at check-in: pending until Stripe confirms it. */
export async function recordCardAddonPending(eventId: number, registrationId: number, item: AddonItem, amount: number, stripeSessionId: string): Promise<void> {
  await db.insert(addonPaymentsTable).values({
    eventId, registrationId, item, amount: amount.toFixed(2), method: "card", status: "pending", stripeSessionId,
  });
}

/**
 * Stripe confirmed a check-in add-on checkout (the check-in page's check and
 * the webhook may both report it): mark its payment paid, once. The caller
 * gives the rider the add-on. Returns false when it isn't a paid add-on session.
 */
export async function confirmAddonPayment(
  session: { id: string; payment_status: string | null; amount_total: number | null; metadata?: Record<string, string> | null },
  eventId: number,
): Promise<boolean> {
  const item = session.metadata?.type as AddonItem | undefined;
  const registrationId = Number(session.metadata?.registrationId);
  if (session.payment_status !== "paid" || !item || !(item in FLAG) || !registrationId) return false;
  const updated = await db.update(addonPaymentsTable).set({ status: "paid", paidAt: new Date() })
    .where(and(eq(addonPaymentsTable.stripeSessionId, session.id), eq(addonPaymentsTable.status, "pending")))
    .returning({ id: addonPaymentsTable.id });
  if (updated.length === 0) {
    // Started before this ledger existed, or already confirmed: record it once.
    const [existing] = await db.select({ id: addonPaymentsTable.id }).from(addonPaymentsTable)
      .where(eq(addonPaymentsTable.stripeSessionId, session.id));
    if (!existing) {
      await db.insert(addonPaymentsTable).values({
        eventId, registrationId, item, method: "card", status: "paid", paidAt: new Date(),
        amount: ((session.amount_total ?? 0) / 100).toFixed(2), stripeSessionId: session.id,
      });
    }
  }
  return true;
}

/** Which add-ons each registration has paid for at check-in. */
export async function paidAddonsByRegistration(registrationIds: number[]): Promise<Map<number, Set<AddonItem>>> {
  const map = new Map<number, Set<AddonItem>>();
  if (registrationIds.length === 0) return map;
  const rows = await db.select({ registrationId: addonPaymentsTable.registrationId, item: addonPaymentsTable.item })
    .from(addonPaymentsTable)
    .where(and(inArray(addonPaymentsTable.registrationId, registrationIds), eq(addonPaymentsTable.status, "paid")));
  for (const r of rows) {
    if (!map.has(r.registrationId)) map.set(r.registrationId, new Set());
    map.get(r.registrationId)!.add(r.item as AddonItem);
  }
  return map;
}

export interface MethodTotal { count: number; total: number }
export interface AddonLine {
  /** Riders who have it (rented or bought). */
  count: number;
  /** Of those, how many are paid, by method; the rest are still owed. */
  cash: MethodTotal;
  card: MethodTotal;
  unpaid: number;
  collected: number;
}
export interface AddonSales {
  rentals: AddonLine;
  rmTrackr: AddonLine;
  rfidTags: AddonLine;
}

export interface SalesInput {
  registrations: Array<{
    id: number;
    transponderRental: boolean;
    rmTrackrPurchased: boolean;
    rfidStickerPurchased: boolean;
    paymentStatus: string | null;
    paymentMethod: string | null;
  }>;
  /** Paid check-in add-ons. */
  ledger: Array<{ registrationId: number; item: string; method: string; amount: number }>;
  /** What each item cost when bought with the registration (counted in its payment). */
  prices: Record<AddonItem, number | null>;
}

/**
 * Totals per add-on. Paid at check-in: from the ledger. Chosen at registration:
 * paid as part of the registration's payment (by its method) once that's paid.
 */
export function summarizeAddonSales({ registrations, ledger, prices }: SalesInput): AddonSales {
  const line = (item: AddonItem): AddonLine => {
    const out: AddonLine = { count: 0, cash: { count: 0, total: 0 }, card: { count: 0, total: 0 }, unpaid: 0, collected: 0 };
    for (const reg of registrations) {
      if (!reg[FLAG[item]]) continue;
      out.count++;
      const atCheckin = ledger.filter(l => l.registrationId === reg.id && l.item === item);
      if (atCheckin.length > 0) {
        for (const l of atCheckin) {
          const m = l.method === "cash" ? out.cash : out.card;
          m.count++; m.total += l.amount;
        }
      } else if (reg.paymentStatus === "paid" && prices[item] != null) {
        const m = reg.paymentMethod === "cash" ? out.cash : out.card;
        m.count++; m.total += prices[item]!;
      } else {
        out.unpaid++;
      }
    }
    out.cash.total = Math.round(out.cash.total * 100) / 100;
    out.card.total = Math.round(out.card.total * 100) / 100;
    out.collected = Math.round((out.cash.total + out.card.total) * 100) / 100;
    return out;
  };
  return { rentals: line("transponder_rental"), rmTrackr: line("rm_trackr"), rfidTags: line("rfid_sticker") };
}

/** The event report's rentals and sales section. */
export async function eventAddonSales(eventId: number): Promise<AddonSales> {
  const [event] = await db.select({
    rentalFee: eventsTable.transponderRentalFee,
    rfidStickerFee: eventsTable.rfidStickerFee,
    purchaseOptions: eventsTable.purchaseOptions,
  }).from(eventsTable).where(eq(eventsTable.id, eventId));
  const registrations = await db.select({
    id: registrationsTable.id,
    transponderRental: registrationsTable.transponderRental,
    rmTrackrPurchased: registrationsTable.rmTrackrPurchased,
    rfidStickerPurchased: registrationsTable.rfidStickerPurchased,
    paymentStatus: registrationsTable.paymentStatus,
    paymentMethod: registrationsTable.paymentMethod,
  }).from(registrationsTable)
    .where(and(eq(registrationsTable.eventId, eventId), ne(registrationsTable.status, "void")));
  const ledger = await db.select({
    registrationId: addonPaymentsTable.registrationId, item: addonPaymentsTable.item,
    method: addonPaymentsTable.method, amount: addonPaymentsTable.amount,
  }).from(addonPaymentsTable)
    .where(and(eq(addonPaymentsTable.eventId, eventId), eq(addonPaymentsTable.status, "paid")));
  return summarizeAddonSales({
    registrations: registrations.map(r => ({ ...r, rmTrackrPurchased: !!r.rmTrackrPurchased, rfidStickerPurchased: !!r.rfidStickerPurchased, transponderRental: !!r.transponderRental })),
    ledger: ledger.map(l => ({ ...l, amount: Number(l.amount) })),
    prices: {
      transponder_rental: event?.rentalFee != null ? Number(event.rentalFee) : null,
      rm_trackr: event ? (eventTrackrPrice(event.purchaseOptions) ?? RM_TRACKR_PRICE) : null,
      rfid_sticker: event?.rfidStickerFee != null && Number(event.rfidStickerFee) > 0 ? Number(event.rfidStickerFee) : null,
    },
  });
}

/** Check-in add-on money collected at an event, by method (for the report's payment totals). */
export async function addonCollected(eventId: number): Promise<Record<PayMethod, MethodTotal>> {
  const rows = await db.select({ method: addonPaymentsTable.method, amount: addonPaymentsTable.amount })
    .from(addonPaymentsTable)
    .where(and(eq(addonPaymentsTable.eventId, eventId), eq(addonPaymentsTable.status, "paid")));
  const out: Record<PayMethod, MethodTotal> = { cash: { count: 0, total: 0 }, card: { count: 0, total: 0 } };
  for (const r of rows) {
    const m = r.method === "cash" ? out.cash : out.card;
    m.count++; m.total = Math.round((m.total + Number(r.amount)) * 100) / 100;
  }
  return out;
}
