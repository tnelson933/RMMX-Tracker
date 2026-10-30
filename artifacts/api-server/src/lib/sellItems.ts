import { db, clubSellItemsTable, RM_TRACKR_NAME, RM_TRACKR_OPTION_ID, RM_TRACKR_PRICE } from "@workspace/db";
import type { PurchaseOption } from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";

/**
 * A club's sell items (Admin → Sell Items). The RM TrackR Transponder and RFID
 * Tag always exist (created on first use); clubs set their prices and can add
 * their own items (camping, pit passes…).
 */
export type SellItemKind = "rm_trackr" | "rfid_tag" | "custom";

export const BUILT_IN_SELL_ITEMS: Array<{ kind: Exclude<SellItemKind, "custom">; name: string; price: number | null; sortOrder: number }> = [
  { kind: "rm_trackr", name: RM_TRACKR_NAME, price: RM_TRACKR_PRICE, sortOrder: 0 },
  { kind: "rfid_tag", name: "RFID Tag", price: null, sortOrder: 1 },
];

export const MAX_SELL_ITEM_PRICE = 100_000;

/** A price from the form: a number from 0 to 100,000 with at most two decimals; "" or null clears it. */
export function parseSellItemPrice(value: unknown): { price: number | null } | { error: string } {
  if (value === null || value === undefined || value === "") return { price: null };
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n < 0 || n > MAX_SELL_ITEM_PRICE) return { error: "Enter a price from $0 to $100,000." };
  if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return { error: "Prices can have at most two decimal places." };
  return { price: Math.round(n * 100) / 100 };
}

/** An item name: 1–60 characters after trimming. */
export function parseSellItemName(value: unknown): { name: string } | { error: string } {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!name) return { error: "Enter a name for the item." };
  if (name.length > 60) return { error: "Keep the name to 60 characters or fewer." };
  return { name };
}

/** The club's items, creating the RM TrackR Transponder and RFID Tag the first time. */
export async function listClubSellItems(clubId: number) {
  let items = await db.select().from(clubSellItemsTable)
    .where(eq(clubSellItemsTable.clubId, clubId))
    .orderBy(asc(clubSellItemsTable.sortOrder), asc(clubSellItemsTable.id));
  const missing = BUILT_IN_SELL_ITEMS.filter(b => !items.some(i => i.kind === b.kind));
  if (missing.length > 0) {
    await db.insert(clubSellItemsTable)
      .values(missing.map(b => ({ clubId, kind: b.kind, name: b.name, price: b.price == null ? null : b.price.toFixed(2), sortOrder: b.sortOrder })))
      .onConflictDoNothing();
    items = await db.select().from(clubSellItemsTable)
      .where(eq(clubSellItemsTable.clubId, clubId))
      .orderBy(asc(clubSellItemsTable.sortOrder), asc(clubSellItemsTable.id));
  }
  return items.map(i => ({
    id: i.id,
    kind: i.kind as SellItemKind,
    name: i.name,
    price: i.price == null ? null : Number(i.price),
    hidden: i.hidden,
  }));
}

/** The club's price for a built-in item: RM TrackR falls back to the standard price; RFID Tag may be unset. */
export async function clubBuiltInPrice(clubId: number, kind: Exclude<SellItemKind, "custom">): Promise<number | null> {
  const [row] = await db.select({ price: clubSellItemsTable.price }).from(clubSellItemsTable)
    .where(and(eq(clubSellItemsTable.clubId, clubId), eq(clubSellItemsTable.kind, kind)));
  if (row?.price != null) return Number(row.price);
  return kind === "rm_trackr" ? RM_TRACKR_PRICE : null;
}

/** The RM TrackR price an event already offers, or null when it doesn't offer one. */
export function eventTrackrPrice(options: PurchaseOption[] | null | undefined): number | null {
  const o = Array.isArray(options) ? options.find(x => String(x.id) === RM_TRACKR_OPTION_ID) : undefined;
  return o && Number.isFinite(Number(o.amount)) ? Number(o.amount) : null;
}

/**
 * What check-in can sell at an event, and for how much. The event's own price
 * wins (an RM TrackR purchase option, or its RFID sticker fee); otherwise the
 * club's Sell Items price, unless the club hid the item. Null: not for sale.
 */
export function checkinSellPrices(
  event: { purchaseOptions: PurchaseOption[] | null; rfidStickerFee: string | number | null },
  clubItems: Array<{ kind: SellItemKind; price: number | null; hidden: boolean }>,
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
