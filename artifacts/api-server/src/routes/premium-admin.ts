import { Router } from "express";
import { db, usersTable, riderAccountsTable, riderAiUsageTable, platformSettingsTable } from "@workspace/db";
import { and, count, desc, eq, gt, gte, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { PREMIUM_ENFORCED_KEY, premiumEnforced } from "../lib/premium";
import { validDeadline } from "../lib/stripePayments";

/**
 * Admin → Clubs → RM Roost Premium (super admins only): the on/off switch for
 * Premium (off by default: every rider gets everything), granting Premium to a
 * rider account by email (promotions, testing, before billing exists), and how
 * many Rocky questions riders asked in the last 24 hours.
 */
const router = Router();

async function superAdminId(req: any, res: any): Promise<number | null> {
  const userId = (req.session as any)?.userId;
  if (!userId) { res.status(401).json({ error: "You're signed out. Sign in again, then try once more." }); return null; }
  const [user] = await db.select({ role: usersTable.role }).from(usersTable).where(eq(usersTable.id, userId));
  if (user?.role !== "super_admin") { res.status(403).json({ error: "Only RM Roost admins can change Premium." }); return null; }
  return userId;
}

router.get("/admin/premium", async (req, res) => {
  if (!(await superAdminId(req, res))) return;
  const now = new Date();
  const [accounts, [usage]] = await Promise.all([
    db.select({ email: riderAccountsTable.email, until: riderAccountsTable.premiumUntil, source: riderAccountsTable.premiumSource })
      .from(riderAccountsTable).where(gt(riderAccountsTable.premiumUntil, now))
      .orderBy(desc(riderAccountsTable.premiumUntil)).limit(100),
    db.select({ n: count() }).from(riderAiUsageTable).where(gte(riderAiUsageTable.createdAt, new Date(now.getTime() - 24 * 3600 * 1000))),
  ]);
  res.json({
    enforced: await premiumEnforced(),
    rockyQuestionsLast24h: Number(usage?.n ?? 0),
    accounts: accounts.map(a => ({ email: a.email, until: a.until?.toISOString() ?? null, source: a.source })),
  });
});

// PUT /admin/premium { enforced }: switch Premium on (gates apply) or off (everything free).
router.put("/admin/premium", async (req, res) => {
  const adminId = await superAdminId(req, res);
  if (!adminId) return;
  if (typeof req.body?.enforced !== "boolean") return res.status(400).json({ error: "Choose on or off." });
  const enforced = req.body.enforced as boolean;
  await db.insert(platformSettingsTable)
    .values({ key: PREMIUM_ENFORCED_KEY, value: enforced, updatedBy: adminId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: platformSettingsTable.key, set: { value: sql`excluded.value`, updatedBy: adminId, updatedAt: new Date() } });
  logger.info({ adminId, enforced }, "Rider Premium switched");
  return res.json({ enforced });
});

// PUT /admin/premium/grant { email, until: "YYYY-MM-DD" | null }: give or remove Premium for one rider account.
router.put("/admin/premium/grant", async (req, res) => {
  const adminId = await superAdminId(req, res);
  if (!adminId) return;
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Enter the rider account's email." });
  const raw = req.body?.until;
  const day = raw === null || raw === "" ? null : validDeadline(raw);
  if (raw !== null && raw !== "" && !day) return res.status(400).json({ error: "Pick the date Premium ends." });
  // Premium runs to the end of the chosen day (UTC).
  const until = day ? new Date(`${day}T23:59:59Z`) : null;
  const updated = await db.update(riderAccountsTable)
    .set({ premiumUntil: until, premiumSource: until ? "admin" : null })
    .where(and(eq(sql`lower(${riderAccountsTable.email})`, email)))
    .returning({ id: riderAccountsTable.id });
  if (updated.length === 0) return res.status(404).json({ error: `There's no rider account for ${email}.` });
  logger.info({ adminId, riderAccountId: updated[0].id, until }, "Rider Premium granted by admin");
  return res.json({ email, until: until?.toISOString() ?? null });
});

export default router;
