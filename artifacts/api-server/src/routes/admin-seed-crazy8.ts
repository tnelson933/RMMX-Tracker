import { Router } from "express";
import { db } from "@workspace/db";
import { ridersTable, registrationsTable, checkinsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

const router = Router();

const EVENT_ID = 42;
const CLUB_ID = 1009;
const PER_CLASS = 10;

const CLASSES = [
  "Pro Open","Pro 250","Vet Pro 35+",
  "A Open","A 250","A 30+","A 40+","A 50+","A Women",
  "B Open","B 150","B 30+","B 40+","B 50+","B Women",
  "C Open","C 250","C 150","C 30+","C 40+","C 50+","C Women",
];

const FEMALE_CLASSES = new Set(["A Women","B Women","C Women"]);

const MALE_FIRST = [
  "Colton","Brody","Mason","Wyatt","Hunter","Tanner","Caden","Logan","Garrett","Drake",
  "Rylan","Zane","Jaxon","Brock","Seth","Corbin","Tate","Reid","Lane","Grady",
  "Bridger","Crew","Bowen","Paxton","Cruz","Kyler","Holt","Nash","Reef","Slade",
  "Colt","Beau","Flint","Dane","Knox","Trey","Ace","Blaze","Jett","Mack",
  "Cade","Wade","Trace","Storm","Ryder","Axel","Cole","Gus","Clay","Beck",
  "Eli","Jake","Luke","Owen","Finn","Sean","Ross","Kyle","Mark","Dean",
  "Troy","Chad","Brad","Todd","Kirk","Wes","Rex","Ian","Roy","Jay",
  "Ty","Bo","Cam","Sam","Max","Cal","Ben","Ned","Hal","Stu",
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

const BIKES = [
  ["KTM","300 XC-W"],["KTM","250 XC-W"],["KTM","350 XCF"],
  ["Husqvarna","TE 300i"],["Husqvarna","TE 250i"],["Husqvarna","FE 350"],
  ["Beta","300 RR"],["Beta","250 RR"],["Beta","390 RR"],
  ["Gas Gas","EC 300"],["Gas Gas","EC 250"],["Gas Gas","EX 350F"],
  ["Honda","CRF 450RX"],["Honda","CRF 300L"],
  ["Yamaha","WR250F"],["Yamaha","WR450F"],
  ["Kawasaki","KX 450X"],["Suzuki","RMX 450Z"],
];

const YEARS = ["2022","2023","2024","2025"];
const STATES = ["CO","UT","WY","NM","AZ","MT","ID","NV"];

function prng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

router.post("/admin/seed-crazy8", async (req, res) => {
  const auth = req.headers["authorization"] ?? "";
  if (auth !== `Bearer ${process.env.SESSION_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const rand = prng(42);
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
      const bib = 200 + ci * PER_CLASS + i;
      const email = `rider.c8.${CLUB_ID}.${ci}.${i}@placeholder.rmmx`;
      const bike = pick(BIKES) as [string, string];
      const bikeYear = pick(YEARS);
      const homeState = pick(STATES);

      const [rider] = await db.insert(ridersTable).values({
        firstName,
        lastName,
        email,
        clubId: CLUB_ID,
        bibNumber: String(bib),
        bikeManufacturer: bike[0],
        bikeModel: bike[1],
        bikeYear,
        homeState,
      } as any).returning();

      await db.insert(registrationsTable).values({
        eventId: EVENT_ID,
        riderId: rider.id,
        raceClass: cls,
        status: "confirmed",
        paymentStatus: "unpaid",
        bibNumber: String(bib),
        bikeBrand: bike[0],
        bikeModel: bike[1],
        bikeYear,
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
    eventId: EVENT_ID,
    ridersInserted,
    checkinsInserted,
    classes: CLASSES.length,
    perClass: PER_CLASS,
    total: ridersInserted,
  });
});

export default router;
