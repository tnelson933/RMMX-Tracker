import { Router } from "express";
import { createHmac } from "node:crypto";
import { db, clubsTable, eventsTable, raceGasCreditsTable, raceGasSettingsTable, usersTable } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { gatherRaceGasCredits, raceGasCreditId, raceGasFileName, raceGasSettings, resolveUnconfirmedRaceGas, sendRaceGasCredits } from "../lib/raceGasCredits";

// RM Roost admin only: Race Gas credits (Rocky Mountain ATV website credit for
// every rider who races) and where they're sent.
const router = Router();

async function requireSuperAdmin(req: any, res: any): Promise<boolean> {
  const userId = (req.session as any)?.userId;
  if (!userId) { res.status(401).json({ error: "You're signed out. Sign in again, then try once more." }); return false; }
  const [user] = await db.select({ role: usersTable.role }).from(usersTable).where(eq(usersTable.id, userId));
  if (user?.role !== "super_admin") { res.status(403).json({ error: "Only RM Roost admins can open Race Gas." }); return false; }
  return true;
}

/** https only (http is allowed for this machine, for testing). */
function validEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname));
  } catch { return false; }
}

router.get("/admin/race-gas/settings", async (req, res) => {
  if (!await requireSuperAdmin(req, res)) return;
  const s = await raceGasSettings();
  // The key is never sent back, only whether one is saved.
  return res.json({ enabled: s.enabled, endpointUrl: s.endpointUrl, hasApiKey: !!s.apiKey, amount: Number(s.amount), updatedAt: s.updatedAt });
});

router.put("/admin/race-gas/settings", async (req, res) => {
  if (!await requireSuperAdmin(req, res)) return;
  const { enabled, endpointUrl, apiKey, amount } = req.body ?? {};
  const url = typeof endpointUrl === "string" ? endpointUrl.trim() : "";
  if (url && !validEndpoint(url)) return res.status(400).json({ error: "Enter the full https:// address the CRM gave you." });
  if (enabled === true && !url) return res.status(400).json({ error: "Add the CRM's address before turning sending on." });
  const value = amount != null ? Number(amount) : 15;
  if (!Number.isFinite(value) || value <= 0 || value > 1000) return res.status(400).json({ error: "Enter a credit amount between $1 and $1,000." });
  const set: Record<string, unknown> = { enabled: enabled === true, endpointUrl: url || null, amount: String(value), updatedAt: new Date() };
  // Blank keeps the saved key; null removes it.
  if (typeof apiKey === "string" && apiKey.trim()) set.apiKey = apiKey.trim();
  if (apiKey === null) set.apiKey = null;
  await db.insert(raceGasSettingsTable).values({ id: 1, ...(set as any) })
    .onConflictDoUpdate({ target: raceGasSettingsTable.id, set: set as any });
  const s = await raceGasSettings();
  return res.json({ enabled: s.enabled, endpointUrl: s.endpointUrl, hasApiKey: !!s.apiKey, amount: Number(s.amount), updatedAt: s.updatedAt });
});

// A sample request (marked test, no real credits) so the CRM side can be checked.
router.post("/admin/race-gas/test", async (req, res) => {
  if (!await requireSuperAdmin(req, res)) return;
  const s = await raceGasSettings();
  if (!s.endpointUrl) return res.status(400).json({ error: "Save the CRM's address first." });
  const body = JSON.stringify({
    source: "rm-roost",
    test: true,
    event: { id: 0, name: "Test Event", date: new Date().toISOString().slice(0, 10), club: "RM Roost", fileName: raceGasFileName("RM Roost", "Test Event", new Date().toISOString()) },
    credits: [{ creditId: "rmroost-race-gas-test", amount: Number(s.amount), firstName: "Test", lastName: "Rider", mailingAddress: "123 Example St", city: "Payson", state: "UT", zipcode: "84651", email: "test-rider@example.com", riderId: 0 }],
  });
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "RM-Roost-RaceGas/1" };
  if (s.apiKey) {
    headers.Authorization = `Bearer ${s.apiKey}`;
    headers["X-RM-Roost-Signature"] = `sha256=${createHmac("sha256", s.apiKey).update(body).digest("hex")}`;
  }
  try {
    const r = await fetch(s.endpointUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(20_000) });
    const text = (await r.text().catch(() => "")).slice(0, 300);
    return res.json({ ok: r.ok, status: r.status, response: text });
  } catch (err: any) {
    return res.json({ ok: false, status: 0, response: String(err?.message ?? err).slice(0, 300) });
  }
});

// Events with Race Gas credits, newest first, with counts by status.
router.get("/admin/race-gas/events", async (req, res) => {
  if (!await requireSuperAdmin(req, res)) return;
  const rows = await db.select({
    eventId: raceGasCreditsTable.eventId,
    eventName: eventsTable.name,
    eventDate: eventsTable.date,
    clubName: clubsTable.name,
    total: sql<number>`count(*)::int`,
    ready: sql<number>`count(*) filter (where ${raceGasCreditsTable.status} = 'ready')::int`,
    missing: sql<number>`count(*) filter (where ${raceGasCreditsTable.status} = 'missing_info')::int`,
    sent: sql<number>`count(*) filter (where ${raceGasCreditsTable.status} = 'sent')::int`,
    failed: sql<number>`count(*) filter (where ${raceGasCreditsTable.status} = 'failed')::int`,
    unconfirmed: sql<number>`count(*) filter (where ${raceGasCreditsTable.status} in ('unconfirmed', 'sending'))::int`,
  }).from(raceGasCreditsTable)
    .innerJoin(eventsTable, eq(raceGasCreditsTable.eventId, eventsTable.id))
    .leftJoin(clubsTable, eq(eventsTable.clubId, clubsTable.id))
    .groupBy(raceGasCreditsTable.eventId, eventsTable.name, eventsTable.date, clubsTable.name)
    .orderBy(desc(eventsTable.date))
    .limit(200);
  return res.json(rows.map(r => ({ ...r, eventDate: String(r.eventDate).slice(0, 10), fileName: raceGasFileName(r.clubName ?? "", r.eventName, String(r.eventDate)) })));
});

// One event's credits (the rows of the Race Gas file).
router.get("/admin/race-gas/events/:eventId", async (req, res) => {
  if (!await requireSuperAdmin(req, res)) return;
  const eventId = Number(req.params.eventId);
  const [event] = await db.select({ name: eventsTable.name, date: eventsTable.date, club: clubsTable.name })
    .from(eventsTable).leftJoin(clubsTable, eq(eventsTable.clubId, clubsTable.id)).where(eq(eventsTable.id, eventId));
  if (!event) return res.status(404).json({ error: "That event couldn't be found." });
  const credits = await db.select().from(raceGasCreditsTable).where(eq(raceGasCreditsTable.eventId, eventId)).orderBy(raceGasCreditsTable.lastName, raceGasCreditsTable.firstName);
  return res.json({
    event: { id: eventId, name: event.name, date: String(event.date).slice(0, 10), club: event.club ?? "" },
    fileName: raceGasFileName(event.club ?? "", event.name, String(event.date)),
    credits: credits.map(c => ({ ...c, creditId: raceGasCreditId(eventId, c.riderId), amount: Number(c.amount) })),
  });
});

// Gather again (e.g. after riders fixed their profiles), then send if sending is on.
router.post("/admin/race-gas/events/:eventId/send", async (req, res) => {
  if (!await requireSuperAdmin(req, res)) return;
  const eventId = Number(req.params.eventId);
  const gathered = await gatherRaceGasCredits(eventId);
  const result = await sendRaceGasCredits(eventId);
  return res.json({ gathered, ...result });
});

// After checking the CRM: unconfirmed credits are "sent" (it has them) or "resend" (it doesn't).
router.post("/admin/race-gas/events/:eventId/unconfirmed", async (req, res) => {
  if (!await requireSuperAdmin(req, res)) return;
  const action = req.body?.action;
  if (action !== "sent" && action !== "resend") return res.status(400).json({ error: "Choose Mark as sent or Send again." });
  const count = await resolveUnconfirmedRaceGas(Number(req.params.eventId), action);
  return res.json({ count });
});

export default router;
