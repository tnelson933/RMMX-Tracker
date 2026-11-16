import { Router } from "express";
import { getDb } from "../db";
import { clubSellItems, eventAddonSales, eventSellPrices } from "../lib/addons";
import { cloudReachable } from "../lib/cloud-proxy";

/**
 * Sell Items and add-on sales that must answer offline. Prices come from the
 * club's Sell Items as last pulled from the cloud; sales from the local ledger.
 * Changing Sell Items (add, rename, price, hide) is done by the cloud.
 */

const router = Router();

const signedIn = (req: any, res: any): boolean => {
  if ((req.session as any)?.userId) return true;
  res.status(401).json({ error: "Unauthorized" });
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

// The club's items. Online the cloud answers (it holds the latest); offline, the last pulled copy.
router.get("/sell-items", async (req, res, next) => {
  if (!signedIn(req, res)) return;
  if (await cloudReachable()) return next();
  const user = getDb().prepare("SELECT club_id FROM users WHERE id = ?").get((req.session as any).userId) as { club_id: number | null } | undefined;
  if (!user?.club_id) return res.json([]);
  return res.json(clubSellItems(user.club_id));
});

export default router;
