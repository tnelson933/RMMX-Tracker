import { Router } from "express";
import { db, riderMobileTokensTable } from "@workspace/db";
import { eventsTable } from "@workspace/db/schema";
import { createWatchTicket, premiumEnforced, premiumRequired, riderAccess } from "../lib/premium";
import { eq } from "drizzle-orm";
import {
  createBroadcastTicket,
  getLiveCameras,
  getLiveEvents,
  isEventLive,
  normalizeCameraId,
} from "../lib/videoRelay";
import { callerOwnsClub } from "../middleware/accessControl";

const router = Router();

// GET /video/status/:eventId — is this event streaming live, and on which cameras?
router.get("/video/status/:eventId", (req, res) => {
  const eventId = parseInt(req.params.eventId, 10);
  if (isNaN(eventId)) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });
  const cameras = getLiveCameras(eventId).map(({ id, name, reconnecting }) => ({ id, name, reconnecting }));
  return res.json({ live: isEventLive(eventId), cameras });
});

// GET /video/live-events — list of currently live event IDs
router.get("/video/live-events", (_req, res) => {
  return res.json({ liveEventIds: getLiveEvents() });
});

// POST /video/broadcast-ticket — lets this organizer's browser go live with one
// camera of one of their club's events. The desktop app reaches this through its
// cloud pass-through, signed in as the club.
router.post("/video/broadcast-ticket", async (req, res) => {
  const eventId = Number(req.body?.eventId);
  const cameraId = normalizeCameraId(req.body?.cameraId);
  if (!Number.isInteger(eventId) || eventId <= 0) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });
  if (!cameraId) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });

  const [event] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!event || !callerOwnsClub(res, event.clubId)) return res.status(404).json({ error: "Event not found" });

  return res.json({ ticket: createBroadcastTicket(eventId, cameraId) });
});

// GET /video/watch-access/:eventId — may this viewer watch? While RM Roost
// Premium is switched off (the default) everyone may, with no ticket. Once it's
// on, the relay needs a short-lived ticket: given to the event's own club staff
// and to riders with Premium (website session or rider-app Bearer token).
router.get("/video/watch-access/:eventId", async (req, res) => {
  const eventId = parseInt(req.params.eventId, 10);
  if (isNaN(eventId)) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });
  if (!(await premiumEnforced())) return res.json({ required: false, ticket: null });

  const [event] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!event) return res.status(404).json({ error: "Event not found" });
  if (res.locals.callerIsSuperAdmin || res.locals.callerClubId === event.clubId) {
    return res.json({ required: true, ticket: createWatchTicket(eventId, 0) });
  }

  let accountId = (req.session as any)?.riderAccountId as number | undefined;
  const auth = String(req.headers.authorization ?? "");
  if (auth.startsWith("Bearer ")) {
    const [tok] = await db.select({ id: riderMobileTokensTable.riderAccountId }).from(riderMobileTokensTable)
      .where(eq(riderMobileTokensTable.token, auth.slice(7).trim()));
    accountId = tok?.id;
  }
  if (!accountId) return res.status(402).json(premiumRequired("Watching live races", { required: true, signIn: true }));
  if (!(await riderAccess(accountId)).premium) return res.status(402).json(premiumRequired("Watching live races", { required: true }));
  return res.json({ required: true, ticket: createWatchTicket(eventId, accountId) });
});

export default router;
