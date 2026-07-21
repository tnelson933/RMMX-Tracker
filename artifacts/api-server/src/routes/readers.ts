import { Router } from "express";
import { db } from "@workspace/db";
import { readersTable, usersTable, eventReaderAssignmentsTable, ridersTable } from "@workspace/db/schema";
import { eq, asc, and, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";
import { getConnectorStatus, sendConnectorCommand } from "../lib/connectorRelay";
import { getRecentTags, clearRecentTags } from "../lib/recentTags";

const router = Router();

/** Get the caller's clubId from session, or null if not authenticated. */
async function getCallerClubId(req: any): Promise<number | null> {
  const userId = (req.session as any)?.userId;
  if (!userId) return null;
  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, userId));
  return user?.clubId ?? null;
}

// GET /readers/connector-status — live RM Connect app connections for this club
router.get("/readers/connector-status", async (req, res) => {
  const clubId = await getCallerClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });
  return res.json(getConnectorStatus(clubId));
});

// GET /readers/recent-tags — live tag scanner: tags recently seen by this club's readers
router.get("/readers/recent-tags", async (req, res) => {
  const clubId = await getCallerClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  const tags = getRecentTags(clubId);
  if (tags.length === 0) return res.json([]);

  // Match tags to riders via the permanent rfid_number on rider profiles
  const riders = await db
    .select({ id: ridersTable.id, firstName: ridersTable.firstName, lastName: ridersTable.lastName, rfidNumber: ridersTable.rfidNumber })
    .from(ridersTable)
    .where(and(eq(ridersTable.clubId, clubId), inArray(ridersTable.rfidNumber, tags.map((t) => t.rfidNumber))));
  const byTag = new Map(riders.map((r) => [r.rfidNumber, r]));

  return res.json(tags.map((t) => {
    const rider = byTag.get(t.rfidNumber);
    return {
      rfidNumber: t.rfidNumber,
      count: t.count,
      firstSeenAt: new Date(t.firstSeenAt).toISOString(),
      lastSeenAt: new Date(t.lastSeenAt).toISOString(),
      riderId: rider?.id ?? null,
      riderName: rider ? `${rider.firstName} ${rider.lastName}`.trim() : null,
    };
  }));
});

// DELETE /readers/recent-tags — clear the live tag scanner list
router.delete("/readers/recent-tags", async (req, res) => {
  const clubId = await getCallerClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });
  clearRecentTags(clubId);
  return res.status(204).end();
});

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
  const hardwareAddress = typeof req.body?.hardwareAddress === "string" ? req.body.hardwareAddress.trim() || null : null;

  if (!name) return res.status(400).json({ error: "name is required" });

  const [reader] = await db
    .insert(readersTable)
    .values({ clubId, name, type, token: randomUUID(), hardwareAddress })
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

  const hardwareAddressRaw = req.body?.hardwareAddress;
  const hardwareAddress = hardwareAddressRaw === undefined
    ? undefined
    : typeof hardwareAddressRaw === "string" ? hardwareAddressRaw.trim() || null : null;

  // Verify ownership before update
  const [existing] = await db.select({ clubId: readersTable.clubId }).from(readersTable).where(eq(readersTable.id, readerId));
  if (!existing) return res.status(404).json({ error: "Reader not found" });
  if (existing.clubId !== clubId) return res.status(403).json({ error: "Forbidden" });

  const updatePayload: Record<string, unknown> = { name };
  if (hardwareAddress !== undefined) updatePayload.hardwareAddress = hardwareAddress;

  const [reader] = await db
    .update(readersTable)
    .set(updatePayload)
    .where(eq(readersTable.id, readerId))
    .returning();

  return res.json(reader);
});

// POST /readers/llrp-config — broadcast RF config to all connected RM Connect instances for this club
router.post("/readers/llrp-config", async (req, res) => {
  const clubId = await getCallerClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  const { transmitPowerIndex, rfModeIndex, tagPopulation, tagTransitTime } = req.body ?? {};

  if (
    typeof transmitPowerIndex !== "number" || transmitPowerIndex < 1 || transmitPowerIndex > 81 ||
    typeof rfModeIndex !== "number" || rfModeIndex < 0 || rfModeIndex > 3 ||
    typeof tagPopulation !== "number" || tagPopulation < 1 || tagPopulation > 64 ||
    typeof tagTransitTime !== "number" || tagTransitTime < 50 || tagTransitTime > 5000
  ) {
    return res.status(400).json({ error: "Invalid RF config values" });
  }

  const sent = sendConnectorCommand(clubId, {
    type: "set_llrp_config",
    config: { transmitPowerIndex, rfModeIndex, tagPopulation, tagTransitTime },
  });

  return res.json({ sent });
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
