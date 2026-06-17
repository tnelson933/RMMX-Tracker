import { Router } from "express";
import { getDb } from "../db";

const router = Router();

router.get("/stripe/connect/status", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const db = getDb();
  const user = db
    .prepare("SELECT club_id FROM users WHERE id = ?")
    .get(userId) as Record<string, unknown> | undefined;

  if (!user?.club_id) {
    return res.json({ connected: false, onboardingComplete: false, accountId: null });
  }

  const club = db
    .prepare("SELECT * FROM clubs WHERE id = ?")
    .get(user.club_id) as Record<string, unknown> | undefined;

  if (!club) {
    return res.json({ connected: false, onboardingComplete: false, accountId: null });
  }

  return res.json({
    connected: !!club.stripe_account_id,
    onboardingComplete: !!(club.stripe_onboarding_complete as number),
    accountId: club.stripe_account_id ?? null,
  });
});

export default router;
