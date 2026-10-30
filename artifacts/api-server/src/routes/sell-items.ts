import { Router, type Response } from "express";
import { db, clubSellItemsTable, usersTable } from "@workspace/db";
import { and, eq, max } from "drizzle-orm";
import { listClubSellItems, parseSellItemName, parseSellItemPrice } from "../lib/sellItems";

/**
 * Admin → Sell Items: what the club sells to riders. The RM TrackR Transponder
 * and RFID Tag are always listed (their price can change, they can't be renamed
 * or removed); clubs add their own items for event purchase options.
 */
const router = Router();

async function clubIdFor(req: any, res: Response): Promise<number | null> {
  const staffClubId = res.locals?.staffClubId;
  if (typeof staffClubId === "number") return staffClubId;
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Please sign in again." }); return null; }
  const [user] = await db.select({ clubId: usersTable.clubId, role: usersTable.role }).from(usersTable).where(eq(usersTable.id, userId));
  if (user?.clubId) return user.clubId;
  // Platform admins pick the club.
  const requested = Number(req.query.clubId ?? req.body?.clubId);
  if (user?.role === "super_admin" && Number.isInteger(requested) && requested > 0) return requested;
  res.status(400).json({ error: "Choose a club first." });
  return null;
}

// GET /sell-items — the club's items (RM TrackR and RFID Tag first)
router.get("/sell-items", async (req, res) => {
  const clubId = await clubIdFor(req, res);
  if (clubId == null) return;
  return res.json(await listClubSellItems(clubId));
});

// POST /sell-items — add a custom item { name, price }
router.post("/sell-items", async (req, res) => {
  const clubId = await clubIdFor(req, res);
  if (clubId == null) return;
  const name = parseSellItemName(req.body?.name);
  if ("error" in name) return res.status(400).json({ error: name.error });
  const price = parseSellItemPrice(req.body?.price);
  if ("error" in price) return res.status(400).json({ error: price.error });
  if (price.price == null) return res.status(400).json({ error: "Enter a price for the item." });
  const [{ last } = { last: 0 }] = await db.select({ last: max(clubSellItemsTable.sortOrder) }).from(clubSellItemsTable)
    .where(eq(clubSellItemsTable.clubId, clubId));
  const [item] = await db.insert(clubSellItemsTable)
    .values({ clubId, kind: "custom", name: name.name, price: price.price.toFixed(2), sortOrder: (last ?? 0) + 1 })
    .returning();
  return res.status(201).json({ id: item.id, kind: item.kind, name: item.name, price: Number(item.price), hidden: item.hidden });
});

// PATCH /sell-items/:id — { name? (custom only), price?, hidden? }
router.patch("/sell-items/:id", async (req, res) => {
  const clubId = await clubIdFor(req, res);
  if (clubId == null) return;
  const id = Number(req.params.id);
  const [item] = await db.select().from(clubSellItemsTable)
    .where(and(eq(clubSellItemsTable.id, id), eq(clubSellItemsTable.clubId, clubId)));
  if (!item) return res.status(404).json({ error: "That item wasn't found. Refresh the page and try again." });
  const updates: Partial<typeof clubSellItemsTable.$inferInsert> = {};
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
    updates.hidden = req.body.hidden;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "Nothing to change." });
  const [updated] = await db.update(clubSellItemsTable).set(updates).where(eq(clubSellItemsTable.id, id)).returning();
  return res.json({ id: updated.id, kind: updated.kind, name: updated.name, price: updated.price == null ? null : Number(updated.price), hidden: updated.hidden });
});

// DELETE /sell-items/:id — remove a custom item (events that offer it keep it)
router.delete("/sell-items/:id", async (req, res) => {
  const clubId = await clubIdFor(req, res);
  if (clubId == null) return;
  const id = Number(req.params.id);
  const [item] = await db.select({ kind: clubSellItemsTable.kind }).from(clubSellItemsTable)
    .where(and(eq(clubSellItemsTable.id, id), eq(clubSellItemsTable.clubId, clubId)));
  if (!item) return res.status(404).json({ error: "That item wasn't found. Refresh the page and try again." });
  if (item.kind !== "custom") return res.status(400).json({ error: "The RM TrackR Transponder and RFID Tag can't be removed. Hide them instead." });
  await db.delete(clubSellItemsTable).where(eq(clubSellItemsTable.id, id));
  return res.status(204).end();
});

export default router;
