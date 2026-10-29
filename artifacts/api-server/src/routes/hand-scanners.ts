/**
 * Hand scanners: handheld RFID scanners on cellular or Wi-Fi (enduro
 * checkpoints, sections) that send reads straight to RM Roost, with no RM
 * Connect laptop. Each scanner is a reader (connection = "hand_scanner"), so it
 * appears on the Course Map and its reads are routed like any reader's.
 *
 * A scanner either
 *  - opens the RM Roost scanner page (/scan) and pairs with a 6-digit code
 *    (camera: scan the QR; no camera: type the code). The page timestamps each
 *    scan on the device, corrected to RM Roost's clock, and queues scans while
 *    offline; or
 *  - posts reads itself from its own app to the scanner's upload URL.
 *
 * Organizer (session):  GET  /readers/hand-scanners
 *                       POST /readers/hand-scanners           { name }
 *                       POST /readers/hand-scanners/:id/code
 *                       (remove with DELETE /readers/:id)
 * Public:               POST /scanner/pair                    { code }
 *                       GET  /timing/readers/:token/scanner   (token = credential)
 */
import { Router, type Request } from "express";
import { randomInt, randomUUID } from "crypto";
import { db } from "@workspace/db";
import {
  connectorPairingCodesTable,
  eventReaderAssignmentsTable,
  eventsTable,
  readersTable,
  usersTable,
} from "@workspace/db/schema";
import { and, eq, gt, gte, inArray, isNull, or } from "drizzle-orm";
import { findReaderByToken } from "../lib/ingestAuth";
import { logger } from "../lib/logger";

const router = Router();

export const HAND_SCANNER = "hand_scanner";
const CODE_TTL_MS = 15 * 60_000;
const PAIR_WINDOW_MS = 10 * 60_000;
const PAIR_MAX_FAILURES = 20;
const PAIR_MAX_FAILURES_ALL = 100;
const pairFailures = new Map<string, number[]>();
let allPairFailures: number[] = [];

const clientAddress = (req: Request) => {
  const cf = req.headers["cf-connecting-ip"];
  return `${req.ip ?? "unknown"}|${typeof cf === "string" ? cf.trim() : ""}`;
};

async function callerClub(req: Request): Promise<{ userId: number; clubId: number } | null> {
  const userId = (req.session as any)?.userId as number | undefined;
  if (!userId) return null;
  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, userId));
  return user?.clubId != null ? { userId, clubId: user.clubId } : null;
}

/** A fresh 6-digit code for one scanner; earlier unused codes for it stop working. */
async function newScannerCode(clubId: number, readerId: number, userId: number) {
  await db.update(connectorPairingCodesTable).set({ usedAt: new Date() })
    .where(and(eq(connectorPairingCodesTable.readerId, readerId), isNull(connectorPairingCodesTable.usedAt)));
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const [clash] = await db.select({ id: connectorPairingCodesTable.id }).from(connectorPairingCodesTable)
      .where(and(eq(connectorPairingCodesTable.code, code), isNull(connectorPairingCodesTable.usedAt), gt(connectorPairingCodesTable.expiresAt, new Date())))
      .limit(1);
    if (clash) continue;
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await db.insert(connectorPairingCodesTable).values({ clubId, code, createdBy: userId, expiresAt, readerId });
    return { code, expiresAt: expiresAt.toISOString() };
  }
  return null;
}

type Placement = { eventId: number; eventName: string; role: string; label: string | null; sequence: number | null };

const ROLE_NAMES: Record<string, string> = {
  start: "Start",
  finish: "Finish",
  split: "Split",
  time_check: "Time check",
};

export function describePlacement(p: Pick<Placement, "role" | "label" | "sequence">): string {
  const role = ROLE_NAMES[p.role] ?? p.role;
  if (p.label) return `${p.label} (${role.toLowerCase()})`;
  return p.role === "split" && p.sequence ? `Split ${p.sequence}` : role;
}

/** Where each reader sits on the Course Map of current and upcoming events. */
async function placementsFor(readerIds: number[]): Promise<Map<number, Placement[]>> {
  const map = new Map<number, Placement[]>();
  if (readerIds.length === 0) return map;
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({
      readerId: eventReaderAssignmentsTable.readerId,
      eventId: eventReaderAssignmentsTable.eventId,
      eventName: eventsTable.name,
      role: eventReaderAssignmentsTable.role,
      label: eventReaderAssignmentsTable.label,
      sequence: eventReaderAssignmentsTable.sequence,
    })
    .from(eventReaderAssignmentsTable)
    .innerJoin(eventsTable, eq(eventReaderAssignmentsTable.eventId, eventsTable.id))
    .where(and(
      inArray(eventReaderAssignmentsTable.readerId, readerIds),
      or(gte(eventsTable.date, today), eq(eventsTable.status, "race_day")),
    ))
    .orderBy(eventsTable.date);
  for (const r of rows) {
    if (r.readerId == null) continue;
    const list = map.get(r.readerId) ?? [];
    if (!list.some(p => p.eventId === r.eventId && p.role === r.role && p.label === r.label)) {
      list.push({ eventId: r.eventId, eventName: r.eventName, role: r.role, label: r.label, sequence: r.sequence });
    }
    map.set(r.readerId, list);
  }
  return map;
}

// ── Organizer ────────────────────────────────────────────────────────────────

router.get("/readers/hand-scanners", async (req, res) => {
  const caller = await callerClub(req);
  if (!caller) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const scanners = await db.select().from(readersTable)
    .where(and(eq(readersTable.clubId, caller.clubId), eq(readersTable.connection, HAND_SCANNER)))
    .orderBy(readersTable.name);
  const placements = await placementsFor(scanners.map(s => s.id));
  return res.json(scanners.map(s => ({
    id: s.id,
    name: s.name,
    token: s.token,
    lastSeenAt: s.lastSeenAt,
    createdAt: s.createdAt,
    placements: (placements.get(s.id) ?? []).map(p => ({ eventId: p.eventId, eventName: p.eventName, where: describePlacement(p) })),
  })));
});

router.post("/readers/hand-scanners", async (req, res) => {
  const caller = await callerClub(req);
  if (!caller) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 60) : "";
  if (!name) return res.status(400).json({ error: "Give the scanner a name, like \"Section 4 check\"." });
  const [reader] = await db.insert(readersTable)
    .values({ clubId: caller.clubId, name, type: "rfid", token: randomUUID(), connection: HAND_SCANNER })
    .returning();
  const code = await newScannerCode(caller.clubId, reader.id, caller.userId);
  logger.info({ clubId: caller.clubId, readerId: reader.id }, "Hand scanner added");
  return res.status(201).json({ id: reader.id, name: reader.name, token: reader.token, code });
});

router.post("/readers/hand-scanners/:id/code", async (req, res) => {
  const caller = await callerClub(req);
  if (!caller) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const [reader] = await db.select().from(readersTable).where(eq(readersTable.id, Number(req.params.id)));
  if (!reader || reader.connection !== HAND_SCANNER) return res.status(404).json({ error: "This scanner couldn't be found. It may have been deleted. Refresh Reader Setup." });
  if (reader.clubId !== caller.clubId) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });
  const code = await newScannerCode(caller.clubId, reader.id, caller.userId);
  if (!code) return res.status(503).json({ error: "Couldn't create a code right now. Try again." });
  return res.status(201).json(code);
});

// ── Scanner (public) ─────────────────────────────────────────────────────────

router.post("/scanner/pair", async (req, res) => {
  const address = clientAddress(req);
  const now = Date.now();
  const recent = (pairFailures.get(address) ?? []).filter(t => now - t < PAIR_WINDOW_MS);
  allPairFailures = allPairFailures.filter(t => now - t < PAIR_WINDOW_MS);
  if (recent.length >= PAIR_MAX_FAILURES || allPairFailures.length >= PAIR_MAX_FAILURES_ALL) {
    return res.status(429).json({ error: "Too many wrong codes. Get a fresh code from Reader Setup and try again in a few minutes." });
  }
  const code = String(req.body?.code ?? "").replace(/\D/g, "");
  const [match] = code.length === 6
    ? await db.select().from(connectorPairingCodesTable).where(and(
      eq(connectorPairingCodesTable.code, code),
      isNull(connectorPairingCodesTable.usedAt),
      gt(connectorPairingCodesTable.expiresAt, new Date()),
    )).limit(1)
    : [];
  if (!match?.readerId) {
    pairFailures.set(address, [...recent, now]);
    allPairFailures.push(now);
    return res.status(400).json({ error: "That code didn't work. Codes last 15 minutes; get a new one from Reader Setup → hand scanners." });
  }
  const claimed = await db.update(connectorPairingCodesTable).set({ usedAt: new Date() })
    .where(and(eq(connectorPairingCodesTable.id, match.id), isNull(connectorPairingCodesTable.usedAt)))
    .returning({ id: connectorPairingCodesTable.id });
  if (claimed.length === 0) return res.status(400).json({ error: "That code was just used. Get a new one from Reader Setup." });
  const [reader] = await db.select().from(readersTable).where(eq(readersTable.id, match.readerId));
  if (!reader) return res.status(404).json({ error: "This scanner was removed. Add it again on Reader Setup." });
  pairFailures.delete(address);
  logger.info({ clubId: reader.clubId, readerId: reader.id }, "Hand scanner paired");
  return res.status(201).json({ token: reader.token, name: reader.name });
});

// What the scanner page shows: its name, where it sits on the course, and
// RM Roost's clock so scans are timed on RM Roost's time, not the phone's.
router.get("/timing/readers/:token/scanner", async (req, res) => {
  const reader = await findReaderByToken(req.params.token);
  if (!reader) return res.status(404).json({ error: "This scanner isn't connected any more. Pair it again from Reader Setup." });
  const placements = (await placementsFor([reader.id])).get(reader.id) ?? [];
  return res.json({
    name: reader.name,
    placements: placements.map(p => ({ eventId: p.eventId, eventName: p.eventName, where: describePlacement(p) })),
    serverTime: new Date().toISOString(),
  });
});

export default router;
