/**
 * TEMPORARY one-shot seed endpoint — remove after use.
 * POST /admin/seed-america-250gp
 * Requires: Authorization: Bearer <SESSION_SECRET>
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { ridersTable, registrationsTable } from "@workspace/db/schema";

const router = Router();

const EVENT_ID = 36;
const CLUB_ID = 1009;
const RIDERS_PER_CLASS = 15;

const CLASSES = [
  "Pro Open","Pro 250","Vet Pro 35+",
  "A Open","A 250","A 30+","A 40+","A 50+","A Women",
  "B Open","B 150","B 30+","B 40+","B 50+","B Women",
  "C Open","C 250","C 150","C 30+","C 40+","C 50+","C Women",
];

// Deterministic rider name pools (seeded)
const FIRST_M = [
  "Tyler","Marcus","Blake","Devon","Brett","Jaxon","Cole","Hunter","Wyatt","Cody",
  "Zach","Logan","Garrett","Tanner","Kyle","Chase","Dylan","Ryder","Austin","Ethan",
  "Colton","Jake","Mason","Nolan","Ryan","Luke","Brady","Brody","Carter","Devin",
  "Grant","Hayes","Jace","Kade","Lane","Mace","Nash","Owen","Pace","Quinn",
  "Reed","Seth","Tate","Vance","Wade","Xander","Yale","Zane","Ace","Bo",
  "Cal","Dax","Eli","Finn","Gage","Holt","Ivan","Jed","Knox","Levi",
  "Miles","Nate","Oscar","Penn","Rex","Silas","Theo","Uri","Vince","Walt",
];
const FIRST_F = [
  "Kayla","Brianna","Madison","Hailey","Sierra","Paige","Taylor","Morgan",
  "Alexis","Brooke","Caitlyn","Danielle","Emma","Faith","Grace","Hannah",
  "Isabel","Jessica","Kelsey","Lauren","Megan","Nicole","Olivia","Peyton",
  "Quinn","Rachel","Savannah","Tori","Ava","Bailey",
];
const LAST = [
  "Anderson","Baker","Clark","Davis","Evans","Foster","Garcia","Harris",
  "Jackson","Johnson","King","Lewis","Martin","Nelson","Parker","Roberts",
  "Scott","Taylor","Turner","Walker","White","Wilson","Wright","Young",
  "Adams","Allen","Brown","Campbell","Collins","Cook","Cooper","Cox",
  "Cruz","Diaz","Edwards","Flores","Green","Hall","Hernandez","Hill",
  "Howard","Hughes","James","Jenkins","Jones","Kelly","Lee","Long",
  "Lopez","Martinez","Miller","Mitchell","Moore","Morgan","Murphy",
  "Myers","Ortiz","Perez","Peterson","Phillips","Price","Ramirez",
  "Reed","Richardson","Rivera","Robinson","Rodriguez","Rogers","Russell",
  "Sanchez","Sanders","Shaw","Simmons","Smith","Stewart","Sullivan",
  "Thomas","Thompson","Torres","Ward","Watson","Webb","Williams","Wood",
  "Carter","Brooks","Bryant","Coleman","Crawford","Dixon","Fleming",
  "Graham","Grant","Graves","Hamilton","Hancock","Hardy","Haynes","Hicks",
];

/** Simple seeded PRNG (mulberry32) */
function makePrng(seed: number) {
  let s = seed;
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function buildRiderList() {
  const rand = makePrng(42);
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const used = new Set<string>();
  const riders: Array<{ firstName: string; lastName: string; bibNumber: string; raceClass: string }> = [];
  for (const cls of CLASSES) {
    const female = cls.includes("Women");
    for (let i = 0; i < RIDERS_PER_CLASS; i++) {
      let fn: string, ln: string, key: string;
      let attempts = 0;
      do {
        fn = pick(female ? FIRST_F : FIRST_M);
        ln = pick(LAST);
        key = `${fn}|${ln}`;
        attempts++;
      } while (used.has(key) && attempts < 200);
      used.add(key);
      riders.push({
        firstName: fn,
        lastName: ln,
        bibNumber: String(100 + Math.floor(rand() * 900)),
        raceClass: cls,
      });
    }
  }
  return riders;
}

router.post("/admin/seed-america-250gp", async (req, res) => {
  const secret = process.env.SESSION_SECRET;
  const auth = req.headers.authorization;
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const riderList = buildRiderList();
    let inserted = 0;

    for (const r of riderList) {
      const [newRider] = await db
        .insert(ridersTable)
        .values({ firstName: r.firstName, lastName: r.lastName, bibNumber: r.bibNumber, clubId: CLUB_ID })
        .returning({ id: ridersTable.id });

      await db.insert(registrationsTable).values({
        eventId: EVENT_ID,
        riderId: newRider.id,
        raceClass: r.raceClass,
        status: "confirmed",
        paymentStatus: "unpaid",
      });

      inserted++;
    }

    return res.json({ ok: true, ridersInserted: inserted, classes: CLASSES.length, perClass: RIDERS_PER_CLASS });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
