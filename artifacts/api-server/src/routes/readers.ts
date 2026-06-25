import { Router } from "express";
import { db } from "@workspace/db";
import { readersTable, usersTable, eventReaderAssignmentsTable } from "@workspace/db/schema";
import { eq, asc } from "drizzle-orm";
import { randomUUID } from "crypto";

const router = Router();

/** Get the caller's clubId from session, or null if not authenticated. */
async function getCallerClubId(req: any): Promise<number | null> {
  const userId = (req.session as any)?.userId;
  if (!userId) return null;
  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, userId));
  return user?.clubId ?? null;
}

// GET /readers — list club's readers
router.get("/readers", async (req, res) => {
  const clubId = await getCallerClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  const rows = await db
    .select()
    .from(readersTable)
    .where(eq(readersTable.clubId, clubId))
    .orderBy(asc(readersTable.name));

  return res.json(rows);
});

// POST /readers — register a new reader (generates a unique token)
router.post("/readers", async (req, res) => {
  const clubId = await getCallerClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const type = req.body?.type === "mylaps" ? "mylaps" : "rfid";

  if (!name) return res.status(400).json({ error: "name is required" });

  const [reader] = await db
    .insert(readersTable)
    .values({ clubId, name, type, token: randomUUID() })
    .returning();

  return res.status(201).json(reader);
});

// PATCH /readers/:readerId — rename a reader
router.patch("/readers/:readerId", async (req, res) => {
  const clubId = await getCallerClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  const readerId = Number(req.params.readerId);
  if (!readerId) return res.status(400).json({ error: "Invalid readerId" });

  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "name is required" });

  // Verify ownership before update
  const [existing] = await db.select({ clubId: readersTable.clubId }).from(readersTable).where(eq(readersTable.id, readerId));
  if (!existing) return res.status(404).json({ error: "Reader not found" });
  if (existing.clubId !== clubId) return res.status(403).json({ error: "Forbidden" });

  const [reader] = await db
    .update(readersTable)
    .set({ name })
    .where(eq(readersTable.id, readerId))
    .returning();

  return res.json(reader);
});

// DELETE /readers/:readerId — remove a reader
router.delete("/readers/:readerId", async (req, res) => {
  const clubId = await getCallerClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  const readerId = Number(req.params.readerId);
  if (!readerId) return res.status(400).json({ error: "Invalid readerId" });

  // Verify ownership before delete
  const [reader] = await db.select({ clubId: readersTable.clubId }).from(readersTable).where(eq(readersTable.id, readerId));
  if (!reader) return res.status(404).json({ error: "Reader not found" });
  if (reader.clubId !== clubId) return res.status(403).json({ error: "Forbidden" });

  // Delete dependent assignments first (no DB-level CASCADE on this FK)
  await db.delete(eventReaderAssignmentsTable).where(eq(eventReaderAssignmentsTable.readerId, readerId));
  await db.delete(readersTable).where(eq(readersTable.id, readerId));
  return res.status(204).send();
});

export default router;
