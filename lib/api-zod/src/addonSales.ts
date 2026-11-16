/**
 * Check-in add-ons (transponder rentals, RM TrackR Transponder and RFID tag
 * sales): the rules shared by the cloud API and the desktop's offline server,
 * so both price, validate and total them the same way. Pure functions only.
 */

export type AddonItem = "transponder_rental" | "rm_trackr" | "rfid_sticker";
export type AddonPayMethod = "cash" | "card";

/** The purchase-option id events use for the RM TrackR Transponder. */
export const RM_TRACKR_PURCHASE_OPTION_ID = "rm-trackr";

const FLAG: Record<AddonItem, "transponderRental" | "rmTrackrPurchased" | "rfidStickerPurchased"> = {
  transponder_rental: "transponderRental",
  rm_trackr: "rmTrackrPurchased",
  rfid_sticker: "rfidStickerPurchased",
};

/** What the rider handed over and the change given back, for a cash payment. */
export interface CashTender { tendered: number; change: number }

/**
 * The amount tendered sent with a cash payment, checked against the amount due.
 * null when none was sent (older screens); an error when it's short or not a number.
 */
export function parseCashTendered(raw: unknown, due: number): CashTender | null | { error: string } {
  if (raw === undefined || raw === null || raw === "") return null;
  const tendered = Number(raw);
  if (!Number.isFinite(tendered) || tendered < 0) return { error: "Enter the amount of cash the rider handed you." };
  if (tendered + 0.005 < due) return { error: `That's $${(due - tendered).toFixed(2)} short of the $${due.toFixed(2)} due.` };
  return { tendered: Math.round(tendered * 100) / 100, change: Math.round((tendered - due) * 100) / 100 };
}

export type SellItemKind = "rm_trackr" | "rfid_tag" | "custom";

/** The RM TrackR price an event already offers, or null when it doesn't offer one. */
export function eventTrackrPrice(options: ReadonlyArray<object> | null | undefined): number | null {
  const o = Array.isArray(options) ? (options as Array<{ id?: unknown; amount?: unknown }>).find(x => String(x.id) === RM_TRACKR_PURCHASE_OPTION_ID) : undefined;
  return o && Number.isFinite(Number(o.amount)) ? Number(o.amount) : null;
}

/**
 * What check-in can sell at an event, and for how much. The event's own price
 * wins (an RM TrackR purchase option, or its RFID sticker fee); otherwise the
 * club's Sell Items price, unless the club hid the item. Null: not for sale.
 */
export function checkinSellPrices(
  event: { purchaseOptions: ReadonlyArray<object> | null; rfidStickerFee: string | number | null },
  clubItems: ReadonlyArray<{ kind: SellItemKind | string; price: number | null; hidden: boolean }>,
): { rmTrackr: number | null; rfidTag: number | null } {
  const club = (kind: SellItemKind) => {
    const item = clubItems.find(i => i.kind === kind);
    return item && !item.hidden ? item.price : null;
  };
  const eventSticker = event.rfidStickerFee != null && Number(event.rfidStickerFee) > 0 ? Number(event.rfidStickerFee) : null;
  return {
    rmTrackr: eventTrackrPrice(event.purchaseOptions) ?? club("rm_trackr"),
    rfidTag: eventSticker ?? club("rfid_tag"),
  };
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
    /** Group races: how many of each the team chose at registration (default 1). */
    qty?: Partial<Record<AddonItem, number>>;
  }>;
  /** Paid check-in add-ons (quantity: how many one payment bought; group race teams buy several). */
  ledger: Array<{ registrationId: number; item: string; method: string; amount: number; quantity?: number }>;
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
      const atCheckin = ledger.filter(l => l.registrationId === reg.id && l.item === item);
      if (atCheckin.length > 0) {
        for (const l of atCheckin) {
          const qty = Math.max(1, l.quantity ?? 1);
          const m = l.method === "cash" ? out.cash : out.card;
          m.count += qty; m.total += l.amount;
          out.count += qty;
        }
      } else if (reg.paymentStatus === "paid" && prices[item] != null) {
        const qty = Math.max(1, reg.qty?.[item] ?? 1);
        out.count += qty;
        const m = reg.paymentMethod === "cash" ? out.cash : out.card;
        m.count += qty; m.total += prices[item]! * qty;
      } else {
        const qty = Math.max(1, reg.qty?.[item] ?? 1);
        out.count += qty;
        out.unpaid += qty;
      }
    }
    out.cash.total = Math.round(out.cash.total * 100) / 100;
    out.card.total = Math.round(out.card.total * 100) / 100;
    out.collected = Math.round((out.cash.total + out.card.total) * 100) / 100;
    return out;
  };
  return { rentals: line("transponder_rental"), rmTrackr: line("rm_trackr"), rfidTags: line("rfid_sticker") };
}
