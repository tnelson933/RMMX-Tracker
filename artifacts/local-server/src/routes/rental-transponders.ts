import { Router } from "express";
import { normalizeActiveTransponderIdentifier } from "@workspace/api-zod";
import { getDb } from "../db";
import { newDesktopId } from "../lib/desktop-ids";

/**
 * A club's rental transponder inventory (Admin → Rentals), offline. Same
 * routes, checks and messages as the website (api-server
 * routes/rental-transponders.ts); the list is kept here and synced with the
 * cloud both ways. A unit is "out" while an event rental with its number hasn't
 * been returned. Return reminders are sent by the cloud (they need internet).
 */
const router = Router();

function clubIdFor(req: any, res: any): number | null {
  const userId = (req.session as any)?.userId;
  if (!userId) { res.status(401).json({ error: "You're signed out. Sign in again, then try once more." }); return null; }
  const user = getDb().prepare("SELECT club_id FROM users WHERE id = ?").get(userId) as { club_id: number | null } | undefined;
  if (user?.club_id) return user.club_id;
  res.status(400).json({ error: "Something was missing from that request. Refresh the page and try again." });
  return null;
}

function reminderStatusText(status: string | null): string | null {
  switch (status) {
    case "sent": return "Push notification sent";
    case "no_app": return "Not sent: the rider doesn't have the RM Roost app";
    case "no_notifications": return "Not sent: the rider hasn't turned on notifications in the app";
    case "failed": return "Not sent: the notification service didn't accept it. Try again in a few minutes.";
    default: return null;
  }
}

export interface RentalOut {
  registrationId: number; riderId: number; eventId: number; eventName: string; eventDate: string; riderName: string;
  riderEmail: string | null; reminderStatus: string | null; reminderMessage: string | null;
}

/** Units currently out: unreturned rentals at this club's events, newest event first. */
export function rentalsOut(clubId: number): Map<string, RentalOut> {
  const rows = getDb().prepare(
    `SELECT lower(trim(r.mylaps_transponder_number)) AS number, r.id AS registration_id, r.rider_id,
            r.rental_reminder_status, e.id AS event_id, e.name AS event_name, e.date AS event_date,
            ri.first_name, ri.last_name, ri.email
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       LEFT JOIN riders ri ON ri.id = r.rider_id
      WHERE e.club_id = ? AND r.transponder_rental = 1 AND COALESCE(r.transponder_returned, 0) = 0
        AND r.status != 'void' AND COALESCE(trim(r.mylaps_transponder_number), '') <> ''
      ORDER BY e.date DESC, r.id DESC`,
  ).all(clubId) as any[];
  const out = new Map<string, RentalOut>();
  for (const r of rows) {
    if (out.has(r.number)) continue;
    out.set(r.number, {
      registrationId: r.registration_id,
      riderId: r.rider_id,
      reminderStatus: r.rental_reminder_status ?? null,
      reminderMessage: reminderStatusText(r.rental_reminder_status ?? null),
      eventId: r.event_id,
      eventName: r.event_name,
      eventDate: String(r.event_date).slice(0, 10),
      riderName: [r.first_name, r.last_name].filter(Boolean).join(" ") || "Rider",
      riderEmail: r.email ? String(r.email).trim().toLowerCase() : null,
    });
  }
  return out;
}

/** Whether a push reminder could reach a rider (accounts and tokens as last pulled from the cloud). */
function reminderReach(): (email: string | null) => "sent" | "no_app" | "no_notifications" {
  const hasApp = new Set<string>();
  const hasToken = new Set<string>();
  try {
    for (const acct of getDb().prepare(
      `SELECT lower(trim(a.email)) AS email, (SELECT COUNT(*) FROM rider_push_tokens t WHERE t.rider_account_id = a.id) AS tokens
       FROM rider_accounts a`,
    ).all() as Array<{ email: string; tokens: number }>) {
      hasApp.add(acct.email);
      if (acct.tokens > 0) hasToken.add(acct.email);
    }
  } catch {
    // Older databases without the push tables: nobody shows as having the app.
  }
  return (email) => (!email || !hasApp.has(email) ? "no_app" : !hasToken.has(email) ? "no_notifications" : "sent");
}

type UnitRow = { id: number; club_id: number; transponder_number: string; label: string | null; missing: number; retired: number; notes: string | null; created_at: string };

// GET /rental-transponders — the club's units with their status
router.get("/rental-transponders", (req, res) => {
  const clubId = clubIdFor(req, res);
  if (clubId == null) return;
  const units = getDb()
    .prepare("SELECT * FROM rental_transponders WHERE club_id = ? ORDER BY label IS NULL, label, transponder_number")
    .all(clubId) as UnitRow[];
  const out = rentalsOut(clubId);
  const reach = reminderReach();
  return res.json(units.map(u => {
    const rental = out.get(u.transponder_number) ?? null;
    let current = null;
    if (rental) {
      const { riderEmail, ...shown } = rental;
      const reachable = reach(riderEmail);
      current = { ...shown, canNotify: reachable === "sent", notifyBlockedReason: reachable === "sent" ? null : reminderStatusText(reachable) };
    }
    const status = u.retired === 1 ? "retired" : current ? "out" : u.missing === 1 ? "missing" : "available";
    return {
      id: u.id,
      transponderNumber: u.transponder_number,
      label: u.label,
      notes: u.notes,
      missing: u.missing === 1,
      retired: u.retired === 1,
      status,
      current,
    };
  }));
});

// POST /rental-transponders — add units (one or many numbers)
// (Return reminders, /rental-transponders/remind-all, are sent by the cloud.)
router.post("/rental-transponders", (req, res) => {
  const clubId = clubIdFor(req, res);
  if (clubId == null) return;
  const raw = req.body?.numbers;
  const list: string[] = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(/[\s,;]+/) : [];
  const label = typeof req.body?.label === "string" && req.body.label.trim() ? req.body.label.trim().slice(0, 60) : null;
  const tokens = list.map(s => s.trim()).filter(Boolean);
  if (tokens.length === 0) return res.status(400).json({ error: "Enter at least one transponder number" });
  if (tokens.length > 500) return res.status(400).json({ error: "Add at most 500 units at a time" });

  const invalid: string[] = [];
  const numbers: string[] = [];
  for (const t of tokens) {
    const n = normalizeActiveTransponderIdentifier(t);
    if (!n) invalid.push(t);
    else if (!numbers.includes(n)) numbers.push(n);
  }
  const db = getDb();
  let added = 0;
  db.transaction(() => {
    const listed = db.prepare("SELECT 1 FROM rental_transponders WHERE club_id = ? AND transponder_number = ?");
    const insert = db.prepare("INSERT INTO rental_transponders (id, club_id, transponder_number, label, created_at) VALUES (?, ?, ?, ?, ?)");
    for (const n of numbers) {
      if (listed.get(clubId, n)) continue;
      insert.run(newDesktopId(db, "rental_transponders"), clubId, n, numbers.length === 1 ? label : null, new Date().toISOString());
      added++;
    }
  })();
  return res.status(201).json({ added, alreadyListed: numbers.length - added, invalid });
});

const unitJson = (u: UnitRow) => ({
  id: u.id, clubId: u.club_id, transponderNumber: u.transponder_number, label: u.label,
  missing: u.missing === 1, retired: u.retired === 1, notes: u.notes, createdAt: u.created_at,
});

// PATCH /rental-transponders/:id — label, notes, missing, retired
router.patch("/rental-transponders/:id", (req, res) => {
  const clubId = clubIdFor(req, res);
  if (clubId == null) return;
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const updates: Record<string, string | number | null> = {};
  if (body.label !== undefined) updates.label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 60) : null;
  if (body.notes !== undefined) updates.notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 500) : null;
  for (const key of ["missing", "retired"] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "boolean") return res.status(400).json({ error: `${key} must be true or false` });
      updates[key] = body[key] ? 1 : 0;
    }
  }
  const names = Object.keys(updates);
  if (names.length === 0) return res.status(400).json({ error: "Nothing was changed. Edit a field, then save." });
  const db = getDb();
  const changed = db.prepare(`UPDATE rental_transponders SET ${names.map(n => `${n} = ?`).join(", ")} WHERE id = ? AND club_id = ?`)
    .run(...Object.values(updates), id, clubId);
  if (changed.changes === 0) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  return res.json(unitJson(db.prepare("SELECT * FROM rental_transponders WHERE id = ?").get(id) as UnitRow));
});

// DELETE /rental-transponders/:id — remove a unit that isn't out
router.delete("/rental-transponders/:id", (req, res) => {
  const clubId = clubIdFor(req, res);
  if (clubId == null) return;
  const id = Number(req.params.id);
  const db = getDb();
  const unit = db.prepare("SELECT * FROM rental_transponders WHERE id = ? AND club_id = ?").get(id, clubId) as UnitRow | undefined;
  if (!unit) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  const current = rentalsOut(clubId).get(unit.transponder_number);
  if (current) {
    return res.status(409).json({ error: `This unit is out with ${current.riderName} (${current.eventName}). Mark it returned first, or retire it instead.` });
  }
  db.prepare("DELETE FROM rental_transponders WHERE id = ?").run(id);
  return res.status(204).end();
});

/**
 * Handing a unit out at check-in keeps the inventory complete and clears
 * "missing", as the website does when it assigns a rental.
 */
export function noteRentalHandedOut(clubId: number, transponderNumber: string): void {
  const db = getDb();
  const unit = db.prepare("SELECT id, missing FROM rental_transponders WHERE club_id = ? AND transponder_number = ?")
    .get(clubId, transponderNumber) as { id: number; missing: number } | undefined;
  if (!unit) {
    db.prepare("INSERT INTO rental_transponders (id, club_id, transponder_number, created_at) VALUES (?, ?, ?, ?)")
      .run(newDesktopId(db, "rental_transponders"), clubId, transponderNumber, new Date().toISOString());
  } else if (unit.missing === 1) {
    db.prepare("UPDATE rental_transponders SET missing = 0 WHERE id = ?").run(unit.id);
  }
}

export default router;
