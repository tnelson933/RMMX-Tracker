import { Router } from "express";
import { db } from "@workspace/db";
import { ridersTable, registrationsTable, checkinsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

const router = Router();

const EVENT_ID = 34;
const CLUB_ID = 1011;
const PER_CLASS = 15;

const CLASSES = [
  "+25 B, +25C",
  "+40 open",
  "65 (10-11)",
  "Supermini 1",
  "450d",
  "250 C 17+",
  "250 C 12-17",
  "85 10-12",
  "250A",
  "50 shaft drive",
  "Girls 65",
  "Schoolboy 2",
  "+20 Open",
  "50 7-8 4-6",
  "250B",
  "25A",
  "65 beginner",
  "30A",
  "E-2",
  "65 7-9",
  "+50 open",
];

const FEMALE_CLASSES = new Set(["Girls 65"]);

const MALE_FIRST = [
  "Colton","Brody","Mason","Wyatt","Hunter","Tanner","Caden","Logan","Garrett","Drake",
  "Rylan","Zane","Jaxon","Brock","Seth","Corbin","Tate","Reid","Lane","Grady",
  "Bridger","Crew","Bowen","Paxton","Cruz","Kyler","Holt","Nash","Reef","Slade",
  "Colt","Beau","Flint","Dane","Knox","Trey","Ace","Blaze","Jett","Mack",
  "Cade","Wade","Trace","Storm","Ryder","Axel","Cole","Gus","Clay","Beck",
  "Eli","Jake","Luke","Owen","Finn","Sean","Ross","Kyle","Mark","Dean",
  "Troy","Chad","Brad","Todd","Kirk","Lane","Wes","Rex","Ian","Roy",
  "Jay","Ray","Ty","Bo","Cam","Sam","Max","Cal","Ben","Ned",
];

const FEMALE_FIRST = [
  "Avery","Kylie","Paige","Brooke","Shelby","Haley","Cassidy","Peyton","Morgan","Taylor",
  "Remi","Lacey","Hailey","Kaitlyn","Jordan","Sierra","Bailey","Reagan","Savannah","Allison",
  "Emma","Olivia","Sophia","Isabella","Mia","Charlotte","Harper","Evelyn","Lily","Zoey",
];

const LAST = [
  "Anderson","Brooks","Carter","Davis","Evans","Foster","Garcia","Hayes","Ingram","Jensen",
  "Kelley","Lewis","Martin","Nelson","Owen","Parker","Quinn","Roberts","Smith","Taylor",
  "Underwood","Vance","Walker","Xavier","Young","Zimmerman","Allen","Baker","Clark","Diaz",
  "Edwards","Fisher","Green","Hill","Irwin","Jones","King","Lee","Moore","Nichols",
  "Olson","Price","Reed","Scott","Turner","Upton","Wade","Xiong","Yates","Zane",
  "Adams","Bell","Cruz","Dean","Ellis","Ford","Grant","Hunt","Ives","Jacks",
  "Knox","Long","Mann","Nash","Obrien","Page","Rowe","Shaw","Todd","Uhl",
  "Voss","Webb","Xiao","York","Zink","Abbott","Bates","Cole","Duke","Eaton",
];

function prng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

router.post("/admin/seed-thanksgiving", async (req, res) => {
  const auth = req.headers["authorization"] ?? "";
  if (auth !== `Bearer ${process.env.SESSION_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const rand = prng(99);
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];

  let ridersInserted = 0;
  let checkinsInserted = 0;

  for (let ci = 0; ci < CLASSES.length; ci++) {
    const cls = CLASSES[ci];
    const isFemale = FEMALE_CLASSES.has(cls);
    const firstNames = isFemale ? FEMALE_FIRST : MALE_FIRST;

    for (let i = 0; i < PER_CLASS; i++) {
      const firstName = pick(firstNames);
      const lastName = pick(LAST);
      const bib = 100 + ci * PER_CLASS + i;
      const email = `rider.tg.${CLUB_ID}.${ci}.${i}@placeholder.rmmx`;

      const [rider] = await db.insert(ridersTable).values({
        firstName,
        lastName,
        email,
        clubId: CLUB_ID,
        bibNumber: String(bib),
      } as any).returning();

      await db.insert(registrationsTable).values({
        eventId: EVENT_ID,
        riderId: rider.id,
        raceClass: cls,
        status: "confirmed",
        paymentStatus: "unpaid",
        bibNumber: String(bib),
      } as any);

      const [existingCheckin] = await db.select({ id: checkinsTable.id })
        .from(checkinsTable)
        .where(and(eq(checkinsTable.eventId, EVENT_ID), eq(checkinsTable.riderId, rider.id)))
        .limit(1);

      if (!existingCheckin) {
        await db.insert(checkinsTable).values({
          eventId: EVENT_ID,
          riderId: rider.id,
          raceClass: cls,
          bibNumber: String(bib),
          checkedIn: true,
          rfidLinked: false,
        } as any);
        checkinsInserted++;
      }

      ridersInserted++;
    }
  }

  return res.json({
    ok: true,
    ridersInserted,
    checkinsInserted,
    classes: CLASSES.length,
    perClass: PER_CLASS,
  });
});

export default router;
