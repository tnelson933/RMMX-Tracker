import { Router } from "express";
import { db, clubsTable } from "@workspace/db";
import { eventsTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
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

// GET /video/live-now — events streaming right now, with what the rider app's
// "Live now" list shows (name, track, club, cameras, viewers). Public.
router.get("/video/live-now", async (_req, res) => {
  const ids = getLiveEvents();
  if (ids.length === 0) return res.json({ events: [] });
  const rows = await db.select({
    id: eventsTable.id, name: eventsTable.name, date: eventsTable.date, state: eventsTable.state,
    location: eventsTable.location, trackName: eventsTable.trackName, imageUrl: eventsTable.imageUrl,
    clubName: clubsTable.name,
  }).from(eventsTable).innerJoin(clubsTable, eq(eventsTable.clubId, clubsTable.id)).where(inArray(eventsTable.id, ids));
  const events = rows.map(e => {
    const cams = getLiveCameras(e.id);
    return {
      eventId: e.id, name: e.name, date: e.date, state: e.state, location: e.location, trackName: e.trackName,
      imageUrl: e.imageUrl, clubName: e.clubName,
      cameras: cams.map(c => ({ id: c.id, name: c.name })),
      viewers: cams.reduce((sum, c) => sum + c.viewers, 0),
      liveSince: cams.map(c => c.startedAt).sort().at(0) ?? null,
    };
  }).sort((a, b) => b.viewers - a.viewers);
  return res.json({ events });
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

export default router;
