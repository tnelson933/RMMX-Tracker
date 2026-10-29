/**
 * RM Connect laptop pairing. No organizer password is stored on a timing
 * laptop: an organizer shows a 6-digit code on Reader Setup, RM Connect trades
 * it for its own laptop key, and uses that key to list and add the club's
 * readers. Organizers can see and remove paired laptops.
 *
 * Organizer (session):  POST   /readers/pairing-codes
 *                       GET    /readers/laptops
 *                       DELETE /readers/laptops/:id
 * Public:               POST   /connector/pair            { code, laptopName }
 * Laptop (Bearer key):  GET    /connector/laptop/me
 *                       GET    /connector/laptop/readers
 *                       POST   /connector/laptop/readers  { name, type, hardwareAddress }
 *                       PATCH  /connector/laptop/readers/:id { name?, hardwareAddress? }
 */
import { Router, type Request, type Response } from "express";
import { createHash, randomBytes, randomInt, randomUUID } from "crypto";
import { db } from "@workspace/db";
import { connectorPairingCodesTable, connectorLaptopsTable, readersTable, usersTable, clubsTable } from "@workspace/db";
import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import { normalizeReaderType, publicReader } from "./readers";
import { logger } from "../lib/logger";

const router = Router();

const CODE_TTL_MS = 10 * 60_000;
// Codes are short, so guessing is limited per address (generous for real typos)
// and across everyone: wrong codes from many addresses (or forged address
// headers) still can't add up to a meaningful share of the million codes.
const PAIR_WINDOW_MS = 10 * 60_000;
const PAIR_MAX_FAILURES = 20;
const PAIR_MAX_FAILURES_ALL = 100;
const pairFailures = new Map<string, number[]>();
let allPairFailures: number[] = [];

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
// The proxy's view of the caller plus the address Cloudflare forwards: a forged
// header can't move a caller out of its real address's bucket.
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

/** The paired laptop calling with `Authorization: Bearer <laptop key>`, or null. */
async function callerLaptop(req: Request) {
  const auth = req.headers.authorization ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!key) return null;
  const [laptop] = await db
    .select()
    .from(connectorLaptopsTable)
    .where(and(eq(connectorLaptopsTable.tokenHash, hashKey(key)), isNull(connectorLaptopsTable.revokedAt)));
  if (!laptop) return null;
  db.update(connectorLaptopsTable).set({ lastSeenAt: new Date() }).where(eq(connectorLaptopsTable.id, laptop.id)).catch(() => {});
  return laptop;
}

async function requireLaptop(req: Request, res: Response) {
  const laptop = await callerLaptop(req);
  if (!laptop) {
    res.status(401).json({ error: "This laptop isn't connected to RM Roost. Enter a new pairing code from Reader Setup." });
    return null;
  }
  return laptop;
}

// ── Organizer ────────────────────────────────────────────────────────────────

router.post("/readers/pairing-codes", async (req, res) => {
  const caller = await callerClub(req);
  if (!caller) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  // Any unused laptop code for this club is replaced, so only the newest one
  // works. Hand scanner codes (readerId set) are separate and stay valid.
  await db.update(connectorPairingCodesTable).set({ usedAt: new Date() })
    .where(and(eq(connectorPairingCodesTable.clubId, caller.clubId), isNull(connectorPairingCodesTable.usedAt), isNull(connectorPairingCodesTable.readerId)));
  // Unique among live codes, so a code can only ever pair with one club.
  let code = "";
  for (let attempt = 0; attempt < 10 && !code; attempt++) {
    const candidate = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const [clash] = await db.select({ id: connectorPairingCodesTable.id }).from(connectorPairingCodesTable)
      .where(and(eq(connectorPairingCodesTable.code, candidate), isNull(connectorPairingCodesTable.usedAt), gt(connectorPairingCodesTable.expiresAt, new Date())))
      .limit(1);
    if (!clash) code = candidate;
  }
  if (!code) return res.status(503).json({ error: "Couldn't create a code right now. Try again." });
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await db.insert(connectorPairingCodesTable).values({ clubId: caller.clubId, code, createdBy: caller.userId, expiresAt });
  return res.status(201).json({ code, expiresAt: expiresAt.toISOString() });
});

router.get("/readers/laptops", async (req, res) => {
  const caller = await callerClub(req);
  if (!caller) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const rows = await db
    .select({ id: connectorLaptopsTable.id, name: connectorLaptopsTable.name, createdAt: connectorLaptopsTable.createdAt, lastSeenAt: connectorLaptopsTable.lastSeenAt })
    .from(connectorLaptopsTable)
    .where(and(eq(connectorLaptopsTable.clubId, caller.clubId), isNull(connectorLaptopsTable.revokedAt)))
    .orderBy(desc(connectorLaptopsTable.lastSeenAt), asc(connectorLaptopsTable.id));
  return res.json(rows);
});

router.delete("/readers/laptops/:id", async (req, res) => {
  const caller = await callerClub(req);
  if (!caller) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const id = Number(req.params.id);
  const [laptop] = await db.select({ clubId: connectorLaptopsTable.clubId }).from(connectorLaptopsTable).where(eq(connectorLaptopsTable.id, id));
  if (!laptop) return res.status(404).json({ error: "This laptop couldn't be found. It may have been deleted. Refresh Reader Setup." });
  if (laptop.clubId !== caller.clubId) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });
  await db.update(connectorLaptopsTable).set({ revokedAt: new Date() }).where(eq(connectorLaptopsTable.id, id));
  logger.info({ clubId: caller.clubId, laptopId: id, by: caller.userId }, "RM Connect laptop removed");
  return res.json({ ok: true });
});

// ── Pairing (public, code-authenticated) ─────────────────────────────────────

router.post("/connector/pair", async (req, res) => {
  const address = clientAddress(req);
  const now = Date.now();
  const recent = (pairFailures.get(address) ?? []).filter(t => now - t < PAIR_WINDOW_MS);
  allPairFailures = allPairFailures.filter(t => now - t < PAIR_WINDOW_MS);
  if (recent.length >= PAIR_MAX_FAILURES || allPairFailures.length >= PAIR_MAX_FAILURES_ALL) {
    return res.status(429).json({ error: "Too many wrong codes. Get a fresh code from Reader Setup and try again in a few minutes." });
  }
  const code = String(req.body?.code ?? "").replace(/\D/g, "");
  const laptopName = typeof req.body?.laptopName === "string" && req.body.laptopName.trim()
    ? req.body.laptopName.trim().slice(0, 60)
    : "Timing laptop";
  const [match] = code.length === 6
    ? await db.select().from(connectorPairingCodesTable).where(and(
      eq(connectorPairingCodesTable.code, code),
      isNull(connectorPairingCodesTable.usedAt),
      gt(connectorPairingCodesTable.expiresAt, new Date()),
      // A hand scanner's code can't pair a laptop.
      isNull(connectorPairingCodesTable.readerId),
    )).limit(1)
    : [];
  if (!match) {
    pairFailures.set(address, [...recent, now]);
    allPairFailures.push(now);
    return res.status(400).json({ error: "That code didn't work. Codes last 10 minutes; get a new one from Reader Setup → Connect a laptop." });
  }
  const key = `rmc_${randomBytes(32).toString("base64url")}`;
  const laptop = await db.transaction(async (tx) => {
    // Claim the code atomically: of two simultaneous requests only one wins.
    const claimed = await tx.update(connectorPairingCodesTable).set({ usedAt: new Date() })
      .where(and(eq(connectorPairingCodesTable.id, match.id), isNull(connectorPairingCodesTable.usedAt)))
      .returning({ id: connectorPairingCodesTable.id });
    if (claimed.length === 0) return null;
    const [row] = await tx.insert(connectorLaptopsTable)
      .values({ clubId: match.clubId, name: laptopName, tokenHash: hashKey(key), createdBy: match.createdBy, lastSeenAt: new Date() })
      .returning();
    return row;
  });
  if (!laptop) return res.status(400).json({ error: "That code was just used. Get a new one from Reader Setup → Connect a laptop." });
  const [club] = await db.select({ name: clubsTable.name }).from(clubsTable).where(eq(clubsTable.id, match.clubId));
  pairFailures.delete(address);
  logger.info({ clubId: match.clubId, laptopId: laptop.id, laptopName }, "RM Connect laptop paired");
  return res.status(201).json({ laptopKey: key, laptopId: laptop.id, clubId: match.clubId, clubName: club?.name ?? null });
});

// ── Paired laptop ────────────────────────────────────────────────────────────

router.get("/connector/laptop/me", async (req, res) => {
  const laptop = await requireLaptop(req, res);
  if (!laptop) return;
  const [club] = await db.select({ name: clubsTable.name }).from(clubsTable).where(eq(clubsTable.id, laptop.clubId));
  return res.json({ laptopId: laptop.id, name: laptop.name, clubId: laptop.clubId, clubName: club?.name ?? null });
});

router.get("/connector/laptop/readers", async (req, res) => {
  const laptop = await requireLaptop(req, res);
  if (!laptop) return;
  const rows = await db.select().from(readersTable).where(eq(readersTable.clubId, laptop.clubId)).orderBy(asc(readersTable.name));
  // Hand scanners send their own reads; a laptop never runs them.
  return res.json(rows.filter(r => r.connection !== "hand_scanner").map(publicReader));
});

router.post("/connector/laptop/readers", async (req, res) => {
  const laptop = await requireLaptop(req, res);
  if (!laptop) return;
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 60) : "";
  if (!name) return res.status(400).json({ error: "Give the reader a name, like Finish Line." });
  const hardwareAddress = typeof req.body?.hardwareAddress === "string" ? req.body.hardwareAddress.trim() || null : null;
  const [reader] = await db.insert(readersTable)
    .values({ clubId: laptop.clubId, name, type: normalizeReaderType(req.body?.type), token: randomUUID(), hardwareAddress })
    .returning();
  return res.status(201).json(publicReader(reader));
});

router.patch("/connector/laptop/readers/:id", async (req, res) => {
  const laptop = await requireLaptop(req, res);
  if (!laptop) return;
  const id = Number(req.params.id);
  const [existing] = await db.select({ clubId: readersTable.clubId }).from(readersTable).where(eq(readersTable.id, id));
  if (!existing) return res.status(404).json({ error: "This reader couldn't be found. It may have been deleted. Refresh Reader Setup." });
  if (existing.clubId !== laptop.clubId) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });
  const update: Record<string, unknown> = {};
  if (typeof req.body?.name === "string" && req.body.name.trim()) update.name = req.body.name.trim().slice(0, 60);
  if (typeof req.body?.hardwareAddress === "string") update.hardwareAddress = req.body.hardwareAddress.trim() || null;
  if (Object.keys(update).length === 0) return res.status(400).json({ error: "Nothing was changed. Edit a field, then save." });
  const [reader] = await db.update(readersTable).set(update).where(eq(readersTable.id, id)).returning();
  return res.json(publicReader(reader));
});

// Drop old pairing failures so the map doesn't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of pairFailures) {
    const recent = times.filter(t => now - t < PAIR_WINDOW_MS);
    if (recent.length) pairFailures.set(key, recent); else pairFailures.delete(key);
  }
}, PAIR_WINDOW_MS).unref();

export default router;
