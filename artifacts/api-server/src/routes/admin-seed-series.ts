import { Router } from "express";
import { db } from "@workspace/db";
import { seriesTable, eventPublicationTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const router = Router();

// One-time: link series 2-5 to published events with real results so standings show up
router.post("/admin/seed-series-events", async (_req, res) => {
  // Events with published results: 1 (Desert Classic, 32 results) and 4 (Spring Opener, 15 results)
  // Event 33 (Flower patch run) has 38 results too — publish it and add it
  await db.insert(eventPublicationTable)
    .values({ eventId: 33, published: true })
    .onConflictDoNothing();

  await db.update(seriesTable).set({ eventIds: [4, 1] }).where(eq(seriesTable.id, 2));
  await db.update(seriesTable).set({ eventIds: [1, 33] }).where(eq(seriesTable.id, 3));
  await db.update(seriesTable).set({ eventIds: [4, 33] }).where(eq(seriesTable.id, 4));
  await db.update(seriesTable).set({ eventIds: [1, 4, 33] }).where(eq(seriesTable.id, 5));

  const updated = await db.select({ id: seriesTable.id, name: seriesTable.name, eventIds: seriesTable.eventIds })
    .from(seriesTable)
    .where(inArray(seriesTable.id, [1, 2, 3, 4, 5]));

  return res.json({ ok: true, series: updated });
});

export default router;
