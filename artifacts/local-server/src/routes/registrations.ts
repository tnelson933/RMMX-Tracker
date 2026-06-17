import { Router } from "express";
import { getDb, parseBool, parseJsonArr } from "../db";

const router = Router();

function deserializeReg(r: Record<string, unknown>) {
  return {
    id: r.id,
    eventId: r.event_id,
    riderId: r.rider_id,
    raceClass: r.race_class,
    status: r.status,
    paymentStatus: r.payment_status,
    bibNumber: r.bib_number,
    bikeBrand: r.bike_brand,
    myLapsTransponderNumber: r.mylaps_transponder_number,
    clubIdNumber: r.club_id_number,
    amountPaid: r.amount_paid,
    paymentMethod: r.payment_method,
    statsEmailOptIn: parseBool(r.stats_email_opt_in as number),
    transponderRental: parseBool(r.transponder_rental as number),
    selectedPurchaseOptions: parseJsonArr(r.selected_purchase_options as string),
    displayFirstName: r.display_first_name,
    displayLastName: r.display_last_name,
    createdAt: r.created_at,
  };
}

router.get("/events/:eventId/registrations", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const eventId = Number(req.params.eventId);
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT
        r.*,
        ri.first_name, ri.last_name, ri.email AS rider_email, ri.phone
       FROM registrations r
       LEFT JOIN riders ri ON r.rider_id = ri.id
       WHERE r.event_id = ?
       ORDER BY ri.last_name`,
    )
    .all(eventId) as Record<string, unknown>[];

  return res.json(
    rows.map((r) => ({
      ...deserializeReg(r),
      riderName: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
      firstName: r.first_name,
      lastName: r.last_name,
      email: r.rider_email,
      phone: r.phone,
    })),
  );
});

router.patch("/registrations/:registrationId", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const id = Number(req.params.registrationId);
  const { status, paymentStatus, raceClass, bibNumber } = req.body;

  const updates: string[] = [];
  const params: unknown[] = [];

  if (status !== undefined) { updates.push("status = ?"); params.push(status); }
  if (paymentStatus !== undefined) { updates.push("payment_status = ?"); params.push(paymentStatus); }
  if (raceClass !== undefined) { updates.push("race_class = ?"); params.push(raceClass); }
  if (bibNumber !== undefined) { updates.push("bib_number = ?"); params.push(bibNumber || null); }

  if (updates.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  params.push(id);
  const db = getDb();
  db.prepare(`UPDATE registrations SET ${updates.join(", ")} WHERE id = ?`).run(...(params as any[]));

  const updated = db
    .prepare("SELECT * FROM registrations WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;

  if (!updated) return res.status(404).json({ error: "Not found" });
  return res.json(deserializeReg(updated));
});

export default router;
