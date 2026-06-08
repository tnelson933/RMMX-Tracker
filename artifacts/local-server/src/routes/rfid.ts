import { Router } from "express";
import { getDb } from "../db";

const router = Router();

router.post("/rfid/assign", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const { riderId, rfidNumber, eventId } = req.body;
  if (!riderId || !rfidNumber) {
    return res.status(400).json({ error: "riderId and rfidNumber required" });
  }

  const db = getDb();
  const numRiderId = Number(riderId);
  const numEventId = eventId ? Number(eventId) : null;

  if (numEventId) {
    const conflict = db
      .prepare(
        "SELECT * FROM rfid_assignments WHERE rfid_number = ? AND event_id = ? AND rider_id != ?",
      )
      .get(rfidNumber, numEventId, numRiderId) as Record<string, unknown> | undefined;

    if (conflict) {
      return res
        .status(409)
        .json({ error: `Tag ${rfidNumber} is already assigned to another rider for this event` });
    }

    const existing = db
      .prepare(
        "SELECT id FROM rfid_assignments WHERE rider_id = ? AND event_id = ?",
      )
      .get(numRiderId, numEventId) as { id: number } | undefined;

    if (existing) {
      db.prepare(
        "UPDATE rfid_assignments SET rfid_number = ? WHERE id = ?",
      ).run(rfidNumber, existing.id);
    } else {
      db.prepare(
        "INSERT INTO rfid_assignments (rider_id, event_id, rfid_number) VALUES (?, ?, ?)",
      ).run(numRiderId, numEventId, rfidNumber);
    }
  }

  db.prepare("UPDATE riders SET rfid_number = ? WHERE id = ?").run(
    rfidNumber,
    numRiderId,
  );

  return res.json({ ok: true, riderId: numRiderId, rfidNumber, eventId: numEventId });
});

export default router;
