import { Router } from "express";
import { getDb } from "../db";

const router = Router();

function getClubId(req: any): number | null {
  const userId = (req.session as any)?.userId;
  if (!userId) return null;
  const db = getDb();
  const user = db
    .prepare("SELECT club_id FROM users WHERE id = ?")
    .get(userId) as { club_id: number } | undefined;
  return user?.club_id ?? null;
}

router.get("/discount-codes", (req, res) => {
  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const filterRiderId = req.query.riderId ? Number(req.query.riderId) : null;

  const rows = db
    .prepare(
      `SELECT
         cc.id, cc.club_id, cc.event_id, cc.rider_id,
         cc.code, cc.discount_type, cc.amount, cc.max_uses,
         cc.uses_count, cc.is_active, cc.expires_at, cc.category_ids, cc.created_at,
         e.name AS event_name,
         (r.first_name || ' ' || r.last_name) AS rider_name
       FROM comp_codes cc
       LEFT JOIN events e ON cc.event_id = e.id
       LEFT JOIN riders r ON cc.rider_id = r.id
       WHERE cc.club_id = ?
         ${filterRiderId ? "AND cc.rider_id = ?" : ""}
       ORDER BY cc.created_at ASC`,
    )
    .all(...([clubId, ...(filterRiderId ? [filterRiderId] : [])] as any[])) as any[];

  return res.json(
    rows.map((r: any) => ({
      id: r.id,
      clubId: r.club_id,
      eventId: r.event_id ?? null,
      eventName: r.event_name ?? null,
      riderId: r.rider_id ?? null,
      riderName: r.rider_name ?? null,
      code: r.code,
      discountType: r.discount_type,
      amount: Number(r.amount),
      maxUses: r.max_uses,
      usesCount: r.uses_count,
      isActive: r.is_active === 1,
      expiresAt: r.expires_at ?? null,
      categoryIds: r.category_ids ? (JSON.parse(r.category_ids) as number[]) : [],
      createdAt: r.created_at,
    })),
  );
});

export default router;
