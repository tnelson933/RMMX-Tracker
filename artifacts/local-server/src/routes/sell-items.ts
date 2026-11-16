import { Router } from "express";
import { getDb } from "../db";
import { clubSellItems, ensureBuiltInSellItems, eventAddonSales, eventSellPrices } from "../lib/addons";
import { newDesktopId } from "../lib/desktop-ids";
import { cloudReachable } from "../lib/cloud-proxy";

/**
 * Sell Items and add-on sales that must answer offline. Prices come from the
 * club's Sell Items (kept here and synced with the cloud); sales from the local ledger.
 */

const router = Router();

const signedIn = (req: any, res: any): boolean => {
  if ((req.session as any)?.userId) return true;
  res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  return false;
};

// What check-in can sell at this event, and for how much.
router.get("/events/:eventId/sell-prices", (req, res) => {
  if (!signedIn(req, res)) return;
  const prices = eventSellPrices(Number(req.params.eventId));
  if (!prices) return res.status(404).json({ error: "This event couldn't be found. It may have been deleted. Go back to Events and open it again." });
  return res.json(prices);
});

// Event report: rentals and RM TrackR / RFID tag sales, with what was collected by cash and card.
router.get("/events/:eventId/addon-sales", (req, res) => {
  if (!signedIn(req, res)) return;
  const sales = eventAddonSales(Number(req.params.eventId));
  if (!sales) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  return res.json(sales);
});

// ── Admin → Sell Items ───────────────────────────────────────────────────────
// Same routes, checks and messages as the website (api-server routes/sell-items.ts).
// Changes are saved here and sync with the cloud both ways.

const MAX_SELL_ITEM_PRICE = 100_000;

/** A price from the form: 0 to 100,000 with at most two decimals; "" or null clears it. */
function parseSellItemPrice(value: unknown): { price: number | null } | { error: string } {
  if (value === null || value === undefined || value === "") return { price: null };
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n < 0 || n > MAX_SELL_ITEM_PRICE) return { error: "Enter a price from $0 to $100,000." };
  if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return { error: "Prices can have at most two decimal places." };
  return { price: Math.round(n * 100) / 100 };
}

/** An item name: 1 to 60 characters after trimming. */
function parseSellItemName(value: unknown): { name: string } | { error: string } {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!name) return { error: "Enter a name for the item." };
  if (name.length > 60) return { error: "Keep the name to 60 characters or fewer." };
  return { name };
}

function sellItemsClub(req: any, res: any): number | null {
  const userId = (req.session as any)?.userId;
  if (!userId) { res.status(401).json({ error: "Please sign in again." }); return null; }
  const user = getDb().prepare("SELECT club_id FROM users WHERE id = ?").get(userId) as { club_id: number | null } | undefined;
  if (user?.club_id) return user.club_id;
  res.status(400).json({ error: "Choose a club first." });
  return null;
}

type SellItemRow = { id: number; kind: string; name: string; price: string | number | null; hidden: number };
const sellItemJson = (r: SellItemRow) => ({ id: r.id, kind: r.kind, name: r.name, price: r.price == null || r.price === "" ? null : Number(r.price), hidden: r.hidden === 1 });

// The club's items (RM TrackR and RFID Tag first).
router.get("/sell-items", (req, res) => {
  const clubId = sellItemsClub(req, res);
  if (clubId == null) return;
  ensureBuiltInSellItems(clubId);
  return res.json(clubSellItems(clubId));
});

// Add a custom item { name, price }.
router.post("/sell-items", (req, res) => {
  const clubId = sellItemsClub(req, res);
  if (clubId == null) return;
  const name = parseSellItemName(req.body?.name);
  if ("error" in name) return res.status(400).json({ error: name.error });
  const price = parseSellItemPrice(req.body?.price);
  if ("error" in price) return res.status(400).json({ error: price.error });
  if (price.price == null) return res.status(400).json({ error: "Enter a price for the item." });
  const db = getDb();
  const { last } = db.prepare("SELECT MAX(sort_order) AS last FROM club_sell_items WHERE club_id = ?").get(clubId) as { last: number | null };
  const id = newDesktopId(db, "club_sell_items");
  db.prepare("INSERT INTO club_sell_items (id, club_id, kind, name, price, hidden, sort_order, created_at) VALUES (?, ?, 'custom', ?, ?, 0, ?, datetime('now'))")
    .run(id, clubId, name.name, price.price.toFixed(2), (last ?? 0) + 1);
  return res.status(201).json(sellItemJson(db.prepare("SELECT * FROM club_sell_items WHERE id = ?").get(id) as SellItemRow));
});

// { name? (custom only), price?, hidden? }
router.patch("/sell-items/:id", (req, res) => {
  const clubId = sellItemsClub(req, res);
  if (clubId == null) return;
  const db = getDb();
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM club_sell_items WHERE id = ? AND club_id = ?").get(id, clubId) as SellItemRow | undefined;
  if (!item) return res.status(404).json({ error: "That item wasn't found. Refresh the page and try again." });
  const updates: Record<string, string | number | null> = {};
  if (req.body?.name !== undefined) {
    if (item.kind !== "custom") return res.status(400).json({ error: "The RM TrackR Transponder and RFID Tag can't be renamed." });
    const name = parseSellItemName(req.body.name);
    if ("error" in name) return res.status(400).json({ error: name.error });
    updates.name = name.name;
  }
  if (req.body?.price !== undefined) {
    const price = parseSellItemPrice(req.body.price);
    if ("error" in price) return res.status(400).json({ error: price.error });
    if (price.price == null && item.kind !== "rfid_tag") return res.status(400).json({ error: "Enter a price for the item." });
    updates.price = price.price == null ? null : price.price.toFixed(2);
  }
  if (req.body?.hidden !== undefined) {
    if (typeof req.body.hidden !== "boolean") return res.status(400).json({ error: "Choose whether to show or hide the item." });
    updates.hidden = req.body.hidden ? 1 : 0;
  }
  const names = Object.keys(updates);
  if (names.length === 0) return res.status(400).json({ error: "Nothing to change." });
  db.prepare(`UPDATE club_sell_items SET ${names.map(n => `${n} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(updates), id);
  return res.json(sellItemJson(db.prepare("SELECT * FROM club_sell_items WHERE id = ?").get(id) as SellItemRow));
});

// Remove a custom item (events that offer it keep it).
router.delete("/sell-items/:id", (req, res) => {
  const clubId = sellItemsClub(req, res);
  if (clubId == null) return;
  const db = getDb();
  const id = Number(req.params.id);
  const item = db.prepare("SELECT kind FROM club_sell_items WHERE id = ? AND club_id = ?").get(id, clubId) as { kind: string } | undefined;
  if (!item) return res.status(404).json({ error: "That item wasn't found. Refresh the page and try again." });
  if (item.kind !== "custom") return res.status(400).json({ error: "The RM TrackR Transponder and RFID Tag can't be removed. Hide them instead." });
  db.prepare("DELETE FROM club_sell_items WHERE id = ?").run(id);
  return res.status(204).end();
});

// RM Connect connections for the club. The desktop drives its readers itself and
// never uses RM Connect, so with no internet the honest answer is "none" (the
// course map, Reader Setup and the timing status ask every few seconds and
// would otherwise get an error each time). Online, the cloud's answer is shown.
router.get("/readers/connector-status", async (req, res, next) => {
  if (!signedIn(req, res)) return;
  if (await cloudReachable()) return next();
  return res.json([]);
});

// The club's readers (for the course map and enduro gate pickers). Online the
// cloud answers; offline, the last pulled copy. Adding or changing readers needs the cloud.
router.get("/readers", async (req, res, next) => {
  if (!signedIn(req, res)) return;
  if (await cloudReachable()) return next();
  const user = getDb().prepare("SELECT club_id FROM users WHERE id = ?").get((req.session as any).userId) as { club_id: number | null } | undefined;
  if (!user?.club_id) return res.json([]);
  const rows = getDb().prepare("SELECT * FROM readers WHERE club_id = ? ORDER BY name COLLATE NOCASE").all(user.club_id) as Array<Record<string, any>>;
  return res.json(rows.map(r => ({
    id: r.id, clubId: r.club_id, name: r.name,
    type: r.type === "mylaps" || r.type === "active_transponder" ? "active_transponder" : "rfid",
    token: null, hardwareAddress: r.hardware_address ?? null, connection: r.connection ?? null,
    activeTimingConfig: (() => { try { return r.active_timing_config ? JSON.parse(r.active_timing_config) : null; } catch { return null; } })(),
    lastSeenAt: null, createdAt: r.created_at ?? null,
  })));
});

export default router;
