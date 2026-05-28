import { Router } from "express";
import { isEventLive, getLiveEvents } from "../lib/videoRelay";

const router = Router();

// GET /video/status/:eventId — is this event streaming live?
router.get("/video/status/:eventId", (req, res) => {
  const eventId = parseInt(req.params.eventId, 10);
  if (isNaN(eventId)) return res.status(400).json({ error: "Invalid event ID" });
  return res.json({ live: isEventLive(eventId) });
});

// GET /video/live-events — list of currently live event IDs
router.get("/video/live-events", (_req, res) => {
  return res.json({ liveEventIds: getLiveEvents() });
});

export default router;
