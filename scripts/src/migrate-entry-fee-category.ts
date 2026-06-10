import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("Running entry_fee_category migration...");

  // 1. Ensure entry_fee_category_id column exists
  await db.execute(sql`
    ALTER TABLE events ADD COLUMN IF NOT EXISTS entry_fee_category_id integer
  `);
  console.log("Column ensured");

  // 2. Ensure the unique index on discount_categories(club_id, name) exists.
  //    drizzle push-force should create this, but we guard here so that the
  //    INSERT below (which uses WHERE NOT EXISTS, not ON CONFLICT) is safe
  //    regardless of whether push-force ran successfully.
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS discount_categories_club_id_name_unique
    ON discount_categories (club_id, name)
  `);
  console.log("Unique index ensured");

  // 3. Seed "Entry Fees" category for all clubs.
  //    Use WHERE NOT EXISTS instead of ON CONFLICT so this works even before
  //    the unique index exists (avoids 42P10 infer_arbiter_indexes error).
  const clubs = await db.execute(sql`SELECT id FROM clubs`);
  for (const club of clubs.rows as { id: number }[]) {
    await db.execute(sql`
      INSERT INTO discount_categories (club_id, name)
      SELECT ${club.id}, 'Entry Fees'
      WHERE NOT EXISTS (
        SELECT 1 FROM discount_categories
        WHERE club_id = ${club.id} AND name = 'Entry Fees'
      )
    `);
  }
  console.log(`Entry Fees seeded for ${clubs.rows.length} clubs`);

  // 4. Backfill existing events entry_fee_category_id where missing
  const updated = await db.execute(sql`
    UPDATE events e
    SET entry_fee_category_id = dc.id
    FROM discount_categories dc
    WHERE dc.club_id = e.club_id
      AND dc.name = 'Entry Fees'
      AND e.entry_fee_category_id IS NULL
  `);
  console.log(`Events backfilled: ${(updated as any).rowCount ?? 0}`);

  // 5. Add FK constraint on events.entry_fee_category_id if not present
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
