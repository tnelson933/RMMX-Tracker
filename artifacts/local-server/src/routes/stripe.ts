import { Router } from "express";
import { getDb } from "../db";

const router = Router();

router.get("/stripe/connect/status", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const db = getDb();
  const user = db
    .prepare("SELECT club_id FROM users WHERE id = ?")
    .get(userId) as Record<string, unknown> | undefined;

  if (!user?.club_id) {
    return res.json({ connected: false, onboardingComplete: false, accountId: null, source: "local" });
  }

  const clubId = user.club_id as number;

  // Try the cloud for real-time status first (5-second timeout).
  const cloudUrl = (process.env.CLOUD_URL ?? "").replace(/\/$/, "");
  if (cloudUrl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const cloudRes = await fetch(
        `${cloudUrl}/api/stripe/clubs/${clubId}/status`,
        { signal: controller.signal },
      );
      clearTimeout(timer);
      if (cloudRes.ok) {
        const data = (await cloudRes.json()) as {
          connected: boolean;
          onboardingComplete: boolean;
        };
        // Write the latest values back into local SQLite so the sync state and
        // the event-form payment toggle both stay current.
        db.prepare(
          "UPDATE clubs SET stripe_onboarding_complete = ? WHERE id = ?",
        ).run(data.onboardingComplete ? 1 : 0, clubId);
        if (!data.connected) {
          db.prepare(
            "UPDATE clubs SET stripe_account_id = NULL WHERE id = ?",
          ).run(clubId);
        }
        return res.json({ ...data, accountId: null, source: "cloud" });
      }
    } catch {
      // Cloud unreachable — fall through to local SQLite.
    }
  }

  // Fall back to local SQLite (populated by the sync engine).
  const club = db
    .prepare("SELECT stripe_account_id, stripe_onboarding_complete FROM clubs WHERE id = ?")
    .get(clubId) as Record<string, unknown> | undefined;

  if (!club) {
    return res.json({ connected: false, onboardingComplete: false, accountId: null, source: "local" });
  }

  return res.json({
    connected: !!club.stripe_account_id,
    onboardingComplete: !!(club.stripe_onboarding_complete as number),
    accountId: club.stripe_account_id ?? null,
    source: "local",
  });
});

export default router;
