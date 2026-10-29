import { Router } from "express";
import { db } from "@workspace/db";
import { readersTable, usersTable, eventReaderAssignmentsTable, ridersTable, registrationsTable, eventsTable, type ActiveTimingConfig } from "@workspace/db/schema";
import { eq, asc, and, inArray, ilike, or } from "drizzle-orm";
import { randomUUID } from "crypto";
import { disconnectReaderConnectors, getConnectorStatus, sendConnectorCommand, sendReaderConnectorCommand } from "../lib/connectorRelay";
import { forgetReaderToken } from "../lib/ingestAuth";
import { getRecentTags, clearRecentTags } from "../lib/recentTags";

const router = Router();
export const normalizeReaderType = (type: unknown) =>
  type === "mylaps" || type === "active_transponder" ? "active_transponder" : "rfid";
export const publicReader = <T extends { type: string }>(reader: T) => ({
  ...reader,
  type: normalizeReaderType(reader.type),
});

function parseActiveTimingConfig(input: unknown): ActiveTimingConfig | null {
  if (!input || typeof input !== "object") return null;
  const config = input as Record<string, unknown>;
  if (
    !Number.isInteger(config.channel) || Number(config.channel) < 0 || Number(config.channel) > 5 ||
    !Number.isInteger(config.power) || Number(config.power) < 0 || Number(config.power) > 100 ||
    typeof config.loop1Enabled !== "boolean" || typeof config.loop2Enabled !== "boolean"
  ) return null;
  return {
    channel: Number(config.channel),
    power: Number(config.power),
    loop1Enabled: config.loop1Enabled,
    loop2Enabled: config.loop2Enabled,
  };
}

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
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  return res.json(getConnectorStatus(clubId));
});

// GET /readers/recent-tags — live tag scanner: tags recently seen by this club's readers
router.get("/readers/recent-tags", async (req, res) => {
  const clubId = await getCallerClubId(req);
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const tags = getRecentTags(clubId);
  if (tags.length === 0) return res.json([]);

  // Match passive RFID and F2000 active-transponder identifiers. Scope riders
  // through registrations for this club because riders themselves are global.
  const tagMatches = tags.flatMap((tag) => [
    ilike(ridersTable.rfidNumber, tag.rfidNumber),
    ilike(ridersTable.mylapsTransponderId, tag.rfidNumber),
  ]);
  const riders = await db
    .select({
      id: ridersTable.id,
      firstName: ridersTable.firstName,
      lastName: ridersTable.lastName,
      rfidNumber: ridersTable.rfidNumber,
      mylapsTransponderId: ridersTable.mylapsTransponderId,
    })
    .from(ridersTable)
    .innerJoin(registrationsTable, eq(registrationsTable.riderId, ridersTable.id))
    .innerJoin(eventsTable, eq(eventsTable.id, registrationsTable.eventId))
    .where(and(eq(eventsTable.clubId, clubId), or(...tagMatches)));
  const byTag = new Map<string, (typeof riders)[number]>();
  for (const rider of riders) {
    if (rider.rfidNumber) byTag.set(rider.rfidNumber.toUpperCase(), rider);
    if (rider.mylapsTransponderId) byTag.set(rider.mylapsTransponderId.toUpperCase(), rider);
  }

  return res.json(tags.map((t) => {
    const rider = byTag.get(t.rfidNumber.toUpperCase());
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
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  clearRecentTags(clubId);
  return res.status(204).end();
});

// GET /readers — list club's readers
router.get("/readers", async (req, res) => {
  const clubId = await getCallerClubId(req);
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const rows = await db
    .select()
    .from(readersTable)
    .where(eq(readersTable.clubId, clubId))
    .orderBy(asc(readersTable.name));

  return res.json(rows.map(publicReader));
});

// POST /readers — register a new reader (generates a unique token)
router.post("/readers", async (req, res) => {
  const clubId = await getCallerClubId(req);
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const type = normalizeReaderType(req.body?.type);
  const hardwareAddress = typeof req.body?.hardwareAddress === "string" ? req.body.hardwareAddress.trim() || null : null;

  if (!name) return res.status(400).json({ error: "Enter a name." });

  const [reader] = await db
    .insert(readersTable)
    .values({ clubId, name, type, token: randomUUID(), hardwareAddress })
    .returning();

  return res.status(201).json(publicReader(reader));
});

// PATCH /readers/:readerId — rename a reader
router.patch("/readers/:readerId", async (req, res) => {
  const clubId = await getCallerClubId(req);
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const readerId = Number(req.params.readerId);
  if (!readerId) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });

  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "Enter a name." });

  const hardwareAddressRaw = req.body?.hardwareAddress;
  const hardwareAddress = hardwareAddressRaw === undefined
    ? undefined
    : typeof hardwareAddressRaw === "string" ? hardwareAddressRaw.trim() || null : null;

  // Verify ownership before update
  const [existing] = await db.select({ clubId: readersTable.clubId }).from(readersTable).where(eq(readersTable.id, readerId));
  if (!existing) return res.status(404).json({ error: "This reader couldn't be found. It may have been deleted. Refresh Reader Setup." });
  if (existing.clubId !== clubId) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });

  const updatePayload: Record<string, unknown> = { name };
  if (hardwareAddress !== undefined) updatePayload.hardwareAddress = hardwareAddress;

  const [reader] = await db
    .update(readersTable)
    .set(updatePayload)
    .where(eq(readersTable.id, readerId))
    .returning();

  return res.json(publicReader(reader));
});

// POST /readers/llrp-config — broadcast RF config to all connected RM Connect instances for this club
router.post("/readers/llrp-config", async (req, res) => {
  const clubId = await getCallerClubId(req);
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const { transmitPowerIndex, rfModeIndex, tagPopulation, tagTransitTime } = req.body ?? {};

  if (
    typeof transmitPowerIndex !== "number" || transmitPowerIndex < 1 || transmitPowerIndex > 81 ||
    typeof rfModeIndex !== "number" || rfModeIndex < 0 || rfModeIndex > 3 ||
    typeof tagPopulation !== "number" || tagPopulation < 1 || tagPopulation > 64 ||
    typeof tagTransitTime !== "number" || tagTransitTime < 50 || tagTransitTime > 5000
  ) {
    return res.status(400).json({ error: "Some reader settings are out of range. Check the values and try again." });
  }

  const sent = sendConnectorCommand(clubId, {
    type: "set_llrp_config",
    config: { transmitPowerIndex, rfModeIndex, tagPopulation, tagTransitTime },
  });

  return res.json({ sent });
});

// POST /readers/:readerId/active-timing-config — save F2000 settings in the
// organizer portal and send them to this reader's RM Connect instance.
router.post("/readers/:readerId/active-timing-config", async (req, res) => {
  const clubId = await getCallerClubId(req);
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const readerId = Number(req.params.readerId);
  if (!readerId) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });
  const config = parseActiveTimingConfig(req.body?.config);
  if (!config) return res.status(400).json({ error: "Channel must be 0–5, power must be 0–100, and both loop settings are required." });
  const syncClock = req.body?.syncClock === true;

  const [reader] = await db.select().from(readersTable).where(eq(readersTable.id, readerId));
  if (!reader) return res.status(404).json({ error: "This reader couldn't be found. It may have been deleted. Refresh Reader Setup." });
  if (reader.clubId !== clubId) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });
  if (normalizeReaderType(reader.type) !== "active_transponder") {
    return res.status(400).json({ error: "This configuration is only available for an Active Timing Reader." });
  }

  const [saved] = await db
    .update(readersTable)
    .set({ activeTimingConfig: config })
    .where(eq(readersTable.id, readerId))
    .returning();

  const sent = sendReaderConnectorCommand(clubId, readerId, {
    type: "set_active_timing_config",
    readerId,
    config,
    syncClock,
  });

  return res.json({ reader: publicReader(saved), sent, queued: sent === 0 });
});

// POST /readers/:readerId/rotate-token — issue a new token and revoke the old one.
// Hardware and RM Connect using the old URL or token stop working at once and
// must be given the new one.
router.post("/readers/:readerId/rotate-token", async (req, res) => {
  const clubId = await getCallerClubId(req);
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const readerId = Number(req.params.readerId);
  if (!readerId) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });

  const [existing] = await db
    .select({ clubId: readersTable.clubId, token: readersTable.token })
    .from(readersTable)
    .where(eq(readersTable.id, readerId));
  if (!existing) return res.status(404).json({ error: "This reader couldn't be found. It may have been deleted. Refresh Reader Setup." });
  if (existing.clubId !== clubId) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });

  const [reader] = await db
    .update(readersTable)
    .set({ token: randomUUID() })
    .where(eq(readersTable.id, readerId))
    .returning();

  forgetReaderToken(existing.token);
  disconnectReaderConnectors(readerId);
  return res.json(publicReader(reader));
});

// DELETE /readers/:readerId — remove a reader
router.delete("/readers/:readerId", async (req, res) => {
  const clubId = await getCallerClubId(req);
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const readerId = Number(req.params.readerId);
  if (!readerId) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });

  // Verify ownership before delete
  const [reader] = await db
    .select({ clubId: readersTable.clubId, token: readersTable.token })
    .from(readersTable)
    .where(eq(readersTable.id, readerId));
  if (!reader) return res.status(404).json({ error: "This reader couldn't be found. It may have been deleted. Refresh Reader Setup." });
  if (reader.clubId !== clubId) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });

  // Delete dependent assignments first (no DB-level CASCADE on this FK)
  await db.delete(eventReaderAssignmentsTable).where(eq(eventReaderAssignmentsTable.readerId, readerId));
  await db.delete(readersTable).where(eq(readersTable.id, readerId));
  forgetReaderToken(reader.token);
  disconnectReaderConnectors(readerId);
  return res.status(204).send();
});

export default router;
