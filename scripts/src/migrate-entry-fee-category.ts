import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("Running entry_fee_category migration...");

  // 1. Ensure entry_fee_category_id column exists (drizzle push-force handles this,
  //    but this is a safe fallback for environments where push hasn't run yet)
  await db.execute(sql`
    ALTER TABLE events ADD COLUMN IF NOT EXISTS entry_fee_category_id integer
  `);
  console.log("Column ensured");

  // 2. Seed Entry Fees category for all clubs.
  //    ON CONFLICT (club_id, name) is safe because drizzle push-force already
  //    creates the unique index on (club_id, name) before this script runs.
  const clubs = await db.execute(sql`SELECT id FROM clubs`);
  for (const club of clubs.rows as { id: number }[]) {
    await db.execute(sql`
      INSERT INTO discount_categories (club_id, name)
      VALUES (${club.id}, 'Entry Fees')
      ON CONFLICT (club_id, name) DO NOTHING
    `);
  }
  console.log(`Entry Fees seeded for ${clubs.rows.length} clubs`);

  // 3. Backfill existing events entry_fee_category_id where missing
  const updated = await db.execute(sql`
    UPDATE events e
    SET entry_fee_category_id = dc.id
    FROM discount_categories dc
    WHERE dc.club_id = e.club_id
      AND dc.name = 'Entry Fees'
      AND e.entry_fee_category_id IS NULL
  `);
  console.log(`Events backfilled: ${(updated as any).rowCount ?? 0}`);

  // 4. Add FK constraint on events.entry_fee_category_id if not present
  //    (drizzle push-force manages this via schema, but guard for safety)
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name='events' AND constraint_type='FOREIGN KEY'
        AND constraint_name='events_entry_fee_category_id_fkey'
      ) THEN
        ALTER TABLE events
          ADD CONSTRAINT events_entry_fee_category_id_fkey
          FOREIGN KEY (entry_fee_category_id) REFERENCES discount_categories(id);
      END IF;
    END
    $$
  `);
  console.log("FK constraint ensured");

  console.log("Migration complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
