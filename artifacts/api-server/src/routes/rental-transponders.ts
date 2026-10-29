import { Router, type Response } from "express";
import { db, eventsTable, registrationsTable, rentalTranspondersTable, ridersTable, usersTable } from "@workspace/db";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { normalizeActiveTransponderIdentifier } from "../lib/riderTimingIdentity";

/**
 * A club's rental transponder inventory (Admin → Rental Transponders).
 * A unit is "out" while an event rental with its number hasn't been returned;
 * otherwise it's available, unless the organizer marked it missing or retired.
 */
const router = Router();

async function clubIdFor(req: any, res: Response): Promise<number | null> {
  const staffClubId = res.locals?.staffClubId;
  if (typeof staffClubId === "number") return staffClubId;
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const [user] = await db.select({ clubId: usersTable.clubId, role: usersTable.role }).from(usersTable).where(eq(usersTable.id, userId));
  if (user?.clubId) return user.clubId;
  // Platform admins pick the club.
  const requested = Number(req.query.clubId ?? req.body?.clubId);
  if (user?.role === "super_admin" && Number.isInteger(requested) && requested > 0) return requested;
  res.status(400).json({ error: "clubId is required" });
  return null;
}

/** Units currently out: unreturned rentals at this club's events, newest event first. */
export async function rentalsOut(clubId: number) {
  const rows = await db.select({
    number: sql<string>`lower(trim(${registrationsTable.myLapsTransponderNumber}))`,
    registrationId: registrationsTable.id,
    eventId: eventsTable.id,
    eventName: eventsTable.name,
    eventDate: eventsTable.date,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
  }).from(registrationsTable)
    .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
    .leftJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
    .where(and(
      eq(eventsTable.clubId, clubId),
      eq(registrationsTable.transponderRental, true),
      eq(registrationsTable.transponderReturned, false),
      ne(registrationsTable.status, "void"),
      sql`coalesce(trim(${registrationsTable.myLapsTransponderNumber}), '') <> ''`,
    ))
    .orderBy(desc(eventsTable.date), desc(registrationsTable.id));
  const out = new Map<string, { registrationId: number; eventId: number; eventName: string; eventDate: string; riderName: string }>();
  for (const r of rows) {
    if (out.has(r.number)) continue;
    out.set(r.number, {
      registrationId: r.registrationId,
      eventId: r.eventId,
      eventName: r.eventName,
      eventDate: String(r.eventDate).slice(0, 10),
      riderName: [r.firstName, r.lastName].filter(Boolean).join(" ") || "Rider",
    });
  }
  return out;
}

// GET /rental-transponders — the club's units with their status
router.get("/rental-transponders", async (req, res) => {
  const clubId = await clubIdFor(req, res);
  if (clubId == null) return;
  const [units, out] = await Promise.all([
    db.select().from(rentalTranspondersTable).where(eq(rentalTranspondersTable.clubId, clubId))
      .orderBy(rentalTranspondersTable.label, rentalTranspondersTable.transponderNumber),
    rentalsOut(clubId),
  ]);
  return res.json(units.map(u => {
    const current = out.get(u.transponderNumber) ?? null;
    const status = u.retired ? "retired" : current ? "out" : u.missing ? "missing" : "available";
    return {
      id: u.id,
      transponderNumber: u.transponderNumber,
      label: u.label,
      notes: u.notes,
      missing: u.missing,
      retired: u.retired,
      status,
      current,
    };
  }));
});

// POST /rental-transponders — add units (one or many numbers)
router.post("/rental-transponders", async (req, res) => {
  const clubId = await clubIdFor(req, res);
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
  const inserted = numbers.length === 0 ? [] : await db.insert(rentalTranspondersTable)
    .values(numbers.map(n => ({ clubId, transponderNumber: n, label: numbers.length === 1 ? label : null })))
    .onConflictDoNothing()
    .returning({ id: rentalTranspondersTable.id });
  return res.status(201).json({ added: inserted.length, alreadyListed: numbers.length - inserted.length, invalid });
});

// PATCH /rental-transponders/:id — label, notes, missing, retired
router.patch("/rental-transponders/:id", async (req, res) => {
  const clubId = await clubIdFor(req, res);
  if (clubId == null) return;
  const id = Number(req.params.id);
  const updates: Record<string, unknown> = {};
  if (req.body.label !== undefined) updates.label = typeof req.body.label === "string" && req.body.label.trim() ? req.body.label.trim().slice(0, 60) : null;
  if (req.body.notes !== undefined) updates.notes = typeof req.body.notes === "string" && req.body.notes.trim() ? req.body.notes.trim().slice(0, 500) : null;
  for (const key of ["missing", "retired"] as const) {
    if (req.body[key] !== undefined) {
      if (typeof req.body[key] !== "boolean") return res.status(400).json({ error: `${key} must be true or false` });
      updates[key] = req.body[key];
    }
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "Nothing to change" });
  const [unit] = await db.update(rentalTranspondersTable).set(updates as any)
    .where(and(eq(rentalTranspondersTable.id, id), eq(rentalTranspondersTable.clubId, clubId)))
    .returning();
  if (!unit) return res.status(404).json({ error: "Not found" });
  return res.json(unit);
});

// DELETE /rental-transponders/:id — remove a unit that isn't out
router.delete("/rental-transponders/:id", async (req, res) => {
  const clubId = await clubIdFor(req, res);
  if (clubId == null) return;
  const id = Number(req.params.id);
  const [unit] = await db.select().from(rentalTranspondersTable)
    .where(and(eq(rentalTranspondersTable.id, id), eq(rentalTranspondersTable.clubId, clubId)));
  if (!unit) return res.status(404).json({ error: "Not found" });
  const current = (await rentalsOut(clubId)).get(unit.transponderNumber);
  if (current) {
    return res.status(409).json({ error: `This unit is out with ${current.riderName} (${current.eventName}). Mark it returned first, or retire it instead.` });
  }
  await db.delete(rentalTranspondersTable).where(eq(rentalTranspondersTable.id, id));
  return res.status(204).end();
});

export default router;
