import { Router } from "express";
import { db } from "@workspace/db";
import { eventsTable } from "@workspace/db/schema";
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
  if (isNaN(eventId)) return res.status(400).json({ error: "Invalid event ID" });
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
  if (!Number.isInteger(eventId) || eventId <= 0) return res.status(400).json({ error: "Invalid event ID" });
  if (!cameraId) return res.status(400).json({ error: "Invalid camera" });

  const [event] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!event || !callerOwnsClub(res, event.clubId)) return res.status(404).json({ error: "Event not found" });

  return res.json({ ticket: createBroadcastTicket(eventId, cameraId) });
});

export default router;
