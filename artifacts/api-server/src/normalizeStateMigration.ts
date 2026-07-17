import { db } from "@workspace/db";
import { eventsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./lib/logger";

const NORMALIZATIONS: Array<{ from: string; to: string }> = [
  { from: "ut",      to: "UT" },
  { from: "az",      to: "AZ" },
  { from: "nv",      to: "NV" },
  { from: "co",      to: "CO" },
  { from: "tx",      to: "TX" },
  { from: "ca",      to: "CA" },
  { from: "id",      to: "ID" },
  { from: "mt",      to: "MT" },
  { from: "nm",      to: "NM" },
  { from: "wy",      to: "WY" },
  { from: "Utah",    to: "UT" },
  { from: "Arizona", to: "AZ" },
  { from: "Nevada",  to: "NV" },
  { from: "Colorado", to: "CO" },
  { from: "Texas",   to: "TX" },
  { from: "California", to: "CA" },
  { from: "Idaho",   to: "ID" },
  { from: "Montana", to: "MT" },
  { from: "New Mexico", to: "NM" },
  { from: "Wyoming", to: "WY" },
];

/** One-time data normalization: fix non-canonical state values in the events table.
 *  Safe to run repeatedly — rows that are already correct are skipped by the WHERE clause. */
export async function normalizeEventStates(): Promise<void> {
  let total = 0;
  for (const { from, to } of NORMALIZATIONS) {
    const result = await db.execute(
      sql`UPDATE ${eventsTable} SET state = ${to} WHERE state = ${from}`
    );
    const count = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    if (count > 0) {
      logger.info({ from, to, count }, "normalizeEventStates: fixed state value");
      total += count;
    }
  }
  if (total > 0) {
    logger.info({ total }, "normalizeEventStates: done");
  }
}
