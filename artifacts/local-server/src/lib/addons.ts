import { randomUUID } from "crypto";
import { checkinSellPrices, eventTrackrPrice, summarizeAddonSales } from "@workspace/api-zod";
import type { AddonItem, AddonSales, CashTender, MethodTotal, SellItemKind } from "@workspace/api-zod";
import { getDb, paidAddons, parseJsonArr } from "../db";
import { RM_TRACKR_NAME, RM_TRACKR_PRICE } from "./rm-trackr";
import { newDesktopId } from "./desktop-ids";

/**
 * Check-in add-ons on the desktop server: the club's Sell Items prices (pulled
 * from the cloud) and the ledger of what was paid. Mirrors the cloud's
 * lib/sellItems.ts and lib/addonPayments.ts, using the same shared rules.
 */

export interface SellItem { id: number; kind: SellItemKind; name: string; price: number | null; hidden: boolean }

/**
 * The RM TrackR Transponder and RFID Tag always exist, as on the website
 * (created the first time the list is opened). Rows made here for a club that
 * has none yet are not sent to the cloud until the organizer changes one.
 */
export function ensureBuiltInSellItems(clubId: number): void {
  const db = getDb();
  const kinds = new Set((db.prepare("SELECT kind FROM club_sell_items WHERE club_id = ?").all(clubId) as Array<{ kind: string }>).map(r => r.kind));
  const missing = [
    { kind: "rm_trackr", name: RM_TRACKR_NAME, price: RM_TRACKR_PRICE.toFixed(2), sortOrder: 0 },
    { kind: "rfid_tag", name: "RFID Tag", price: null, sortOrder: 1 },
  ].filter(b => !kinds.has(b.kind));
  if (missing.length === 0) return;
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO _cloud_pull_guard VALUES(1)").run();
    try {
      for (const b of missing) {
        db.prepare("INSERT INTO club_sell_items (id, club_id, kind, name, price, hidden, sort_order, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, datetime('now'))")
          .run(newDesktopId(db, "club_sell_items"), clubId, b.kind, b.name, b.price, b.sortOrder);
      }
    } finally {
      db.prepare("DELETE FROM _cloud_pull_guard").run();
    }
  })();
}

/**
 * The club's sell items as last pulled from the cloud. Like the cloud, the RM
 * TrackR Transponder and RFID Tag always exist: until the club sets them up the
 * RM TrackR sells at its standard price and the RFID Tag has none.
 */
export function clubSellItems(clubId: number): SellItem[] {
  const rows = getDb().prepare(
    "SELECT id, kind, name, price, hidden FROM club_sell_items WHERE club_id = ? ORDER BY sort_order, id",
  ).all(clubId) as Array<{ id: number; kind: string; name: string; price: string | number | null; hidden: number }>;
  const items: SellItem[] = rows.map(r => ({
    id: r.id,
    kind: r.kind as SellItemKind,
    name: r.name,
    price: r.price == null || r.price === "" ? null : Number(r.price),
    hidden: r.hidden === 1,
  }));
  if (!items.some(i => i.kind === "rm_trackr")) items.unshift({ id: -1, kind: "rm_trackr", name: RM_TRACKR_NAME, price: RM_TRACKR_PRICE, hidden: false });
  if (!items.some(i => i.kind === "rfid_tag")) items.splice(1, 0, { id: -2, kind: "rfid_tag", name: "RFID Tag", price: null, hidden: false });
  return items;
}

/** What check-in can sell at this event and for how much (same rule as the cloud); null when the event is gone. */
export function eventSellPrices(eventId: number): { rmTrackr: number | null; rfidTag: number | null } | null {
  const event = getDb().prepare("SELECT club_id, purchase_options, rfid_sticker_fee FROM events WHERE id = ?")
    .get(eventId) as { club_id: number; purchase_options: string | null; rfid_sticker_fee: string | number | null } | undefined;
  if (!event) return null;
  return checkinSellPrices(
    { purchaseOptions: parseJsonArr<object>(event.purchase_options), rfidStickerFee: event.rfid_sticker_fee },
    clubSellItems(event.club_id),
  );
}

/** Cash taken at check-in: paid now, at its price. Queued for the cloud by the table's trigger. */
export function recordCashAddon(eventId: number, registrationId: number, item: AddonItem, amount: number, tender: CashTender | null, quantity = 1): void {
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO addon_payments (uid, event_id, registration_id, item, amount, quantity, method, status, cash_tendered, cash_change, created_at, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, 'cash', 'paid', ?, ?, ?, ?)`,
  ).run(randomUUID(), eventId, registrationId, item, Math.round(amount * 100) / 100, quantity, tender?.tendered ?? null, tender?.change ?? null, now, now);
}

type LedgerRow = { registration_id: number; rider_id: number | null; item: string; method: string; amount: number; quantity: number };

function paidLedger(eventId: number): LedgerRow[] {
  return getDb().prepare(
    `SELECT a.registration_id, r.rider_id, a.item, a.method, a.amount, a.quantity
       FROM addon_payments a LEFT JOIN registrations r ON r.id = a.registration_id
      WHERE a.event_id = ? AND a.status = 'paid'`,
  ).all(eventId) as LedgerRow[];
}

/**
 * Which add-ons are paid, per registration. Like the cloud's addonIsPaid: a
 * rental is paid on its own entry; an RM TrackR or RFID tag covers all of the
 * rider's entries at the event.
 */
export function paidAddonsAtEvent(eventId: number): (registrationId: number, riderId: number, column: unknown) => string[] {
  const byReg = new Map<number, Set<string>>();
  const byRider = new Map<number, Set<string>>();
  for (const l of paidLedger(eventId)) {
    if (!byReg.has(l.registration_id)) byReg.set(l.registration_id, new Set());
    byReg.get(l.registration_id)!.add(l.item);
    if (l.rider_id != null && l.item !== "transponder_rental") {
      if (!byRider.has(l.rider_id)) byRider.set(l.rider_id, new Set());
      byRider.get(l.rider_id)!.add(l.item);
    }
  }
  return (registrationId, riderId, column) => [...new Set([
    ...paidAddons(column), ...(byReg.get(registrationId) ?? []), ...(byRider.get(riderId) ?? []),
  ])];
}

/** The event report's rentals and sales section, with what check-in collected by cash and card. */
export function eventAddonSales(eventId: number): (AddonSales & { collectedAtCheckin: Record<"cash" | "card", MethodTotal> }) | null {
  const db = getDb();
  const event = db.prepare("SELECT transponder_rental_fee, rfid_sticker_fee, purchase_options FROM events WHERE id = ?")
    .get(eventId) as { transponder_rental_fee: string | number | null; rfid_sticker_fee: string | number | null; purchase_options: string | null } | undefined;
  if (!event) return null;
  const registrations = db.prepare(
    `SELECT id, transponder_rental, rm_trackr_purchased, rfid_sticker_purchased, payment_status, payment_method
       FROM registrations WHERE event_id = ? AND COALESCE(status, 'confirmed') != 'void'`,
  ).all(eventId) as Array<{ id: number; transponder_rental: number; rm_trackr_purchased: number; rfid_sticker_purchased: number; payment_status: string | null; payment_method: string | null }>;
  const ledger = paidLedger(eventId);
  // Group race teams choose rentals, RM TrackRs and RFID tags per rider.
  const teamGear = db.prepare("SELECT registration_id, trackr_choice, rfid_purchased FROM team_members WHERE event_id = ?")
    .all(eventId) as Array<{ registration_id: number; trackr_choice: string | null; rfid_purchased: number }>;
  const qtyByReg = new Map<number, Partial<Record<AddonItem, number>>>();
  for (const g of teamGear) {
    const q = qtyByReg.get(g.registration_id) ?? {};
    if (g.trackr_choice === "rent") q.transponder_rental = (q.transponder_rental ?? 0) + 1;
    if (g.trackr_choice === "buy") q.rm_trackr = (q.rm_trackr ?? 0) + 1;
    if (g.rfid_purchased === 1) q.rfid_sticker = (q.rfid_sticker ?? 0) + 1;
    qtyByReg.set(g.registration_id, q);
  }
  const sales = summarizeAddonSales({
    registrations: registrations.map(r => ({
      id: r.id, qty: qtyByReg.get(r.id),
      transponderRental: r.transponder_rental === 1, rmTrackrPurchased: r.rm_trackr_purchased === 1, rfidStickerPurchased: r.rfid_sticker_purchased === 1,
      paymentStatus: r.payment_status, paymentMethod: r.payment_method,
    })),
    ledger: ledger.map(l => ({ registrationId: l.registration_id, item: l.item, method: l.method, amount: Number(l.amount), quantity: l.quantity })),
    prices: {
      transponder_rental: event.transponder_rental_fee != null && event.transponder_rental_fee !== "" ? Number(event.transponder_rental_fee) : null,
      rm_trackr: eventTrackrPrice(parseJsonArr<object>(event.purchase_options)) ?? RM_TRACKR_PRICE,
      rfid_sticker: event.rfid_sticker_fee != null && Number(event.rfid_sticker_fee) > 0 ? Number(event.rfid_sticker_fee) : null,
    },
  });
  const collectedAtCheckin: Record<"cash" | "card", MethodTotal> = { cash: { count: 0, total: 0 }, card: { count: 0, total: 0 } };
  for (const l of ledger) {
    const m = l.method === "cash" ? collectedAtCheckin.cash : collectedAtCheckin.card;
    m.count++; m.total = Math.round((m.total + Number(l.amount)) * 100) / 100;
  }
  return { ...sales, collectedAtCheckin };
}
