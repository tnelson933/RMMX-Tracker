import { db, eventsTable, ridersTable, registrationsTable, checkinsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const FIRST_NAMES = [
  "Cade", "Tanner", "Wyatt", "Hunter", "Colby",
  "Garrett", "Brody", "Chase", "Dillon", "Rylan",
  "Austin", "Mason", "Zane", "Koby", "Trey",
  "Blake", "Jace", "Kyle", "Nolan", "Travis",
  "Colt", "Seth", "Reid", "Wade", "Luke",
  "Beau", "Lane", "Cruz", "Gage", "Cord",
];

const LAST_NAMES = [
  "Morrison", "Holt", "Briggs", "Whitfield", "Dunbar",
  "Castillo", "Finley", "Odom", "Stanton", "Graves",
  "Ashford", "Burnett", "Langford", "Morrow", "Strickland",
  "Holloway", "Tanner", "Vance", "Prescott", "Hayden",
  "Colburn", "Steele", "Calhoun", "Paxton", "Sherwood",
  "Blackwell", "Lester", "Davenport", "Kimball", "Slade",
];

async function main() {
  console.log("Seeding 30 riders into event #8 (rmmx)...\n");

  await db.transaction(async (tx) => {
    // 1. Update event #8 classes and status
    await tx
      .update(eventsTable)
      .set({
        raceClasses: ["125 cc Amature", "250 cc Amature", "450 cc Pro"],
        status: "race_day",
      })
      .where(eq(eventsTable.id, 8));
    console.log("  ✓ Updated event #8 race_classes and status → race_day");

    const now = new Date();

    // 2. Insert 30 riders and collect their IDs
    // Riders 0-14: 250 cc Amature (bibs 1100-1114)
    // Riders 15-29: 450 cc Pro    (bibs 1115-1129)
    const riderRows = Array.from({ length: 30 }, (_, i) => ({
      firstName: FIRST_NAMES[i],
      lastName: LAST_NAMES[i],
      bibNumber: String(1100 + i),
      homeState: "CO",
    }));

    const inserted = await tx
      .insert(ridersTable)
      .values(riderRows)
      .returning({ id: ridersTable.id, bibNumber: ridersTable.bibNumber });

    console.log(`  ✓ Inserted ${inserted.length} riders (bibs 1100–1129)`);

    // 3. Build registration + checkin rows
    const registrations = inserted.map((r, i) => ({
      eventId: 8,
      riderId: r.id,
      raceClass: i < 15 ? "250 cc Amature" : "450 cc Pro",
      status: "confirmed" as const,
      paymentStatus: "unpaid" as const,
      bibNumber: r.bibNumber,
    }));

    await tx.insert(registrationsTable).values(registrations);
    console.log(`  ✓ Inserted ${registrations.length} registrations`);

    const checkins = inserted.map((r, i) => ({
      eventId: 8,
      riderId: r.id,
      raceClass: i < 15 ? "250 cc Amature" : "450 cc Pro",
      bibNumber: r.bibNumber,
      checkedIn: true,
      checkedInAt: now,
    }));

    await tx.insert(checkinsTable).values(checkins);
    console.log(`  ✓ Inserted ${checkins.length} check-ins`);
  });

  console.log("\nDone! Event #8 is ready for moto generation.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
