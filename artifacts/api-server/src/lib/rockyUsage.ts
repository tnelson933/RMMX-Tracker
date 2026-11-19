import { db, riderAiUsageTable } from "@workspace/db";

/**
 * One row per question a rider asks Rocky (coach chat, training plans,
 * maintenance plans), so AI cost can be watched. There is no limit: every
 * rider feature is free (RM Roost earns from the registration fee instead).
 */
export type RockyKind = "mechanic_chat" | "training_plan" | "maintenance_plan";

export async function recordRockyQuestion(riderAccountId: number, kind: RockyKind): Promise<void> {
  await db.insert(riderAiUsageTable).values({ riderAccountId, kind });
}
