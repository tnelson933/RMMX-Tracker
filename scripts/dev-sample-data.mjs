#!/usr/bin/env node
// Fill an EMPTY LOCAL dev database with demo race data so public pages have content:
// 2 completed events (with motos, results and lap times), 12 riders, and a series.
// Results are published and series points recalculated through the running API
// (POST /events/:id/results/publish, POST /series/:id/recalculate), so the app
// computes standings itself instead of this script hand-writing them.
//
//   node scripts/dev-sample-data.mjs <organizer-email> <organizer-password> [clubId]
//
// Requires: local API running (pnpm run dev:api). Refuses non-localhost DATABASE_URL.
// Idempotent: does nothing if the demo events already exist.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const url = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
  console.error(`Refusing: DATABASE_URL host is ${url.hostname}, not localhost.`);
  process.exit(1);
}
const [email, password, clubArg = "1000"] = process.argv.slice(2);
if (!email || !password) {
  console.error("Usage: node scripts/dev-sample-data.mjs <organizer-email> <organizer-password> [clubId]");
  process.exit(1);
}
const clubId = Number(clubArg);
const api = `http://127.0.0.1:${process.env.API_PORT ?? "8080"}/api`;

const RIDERS = [
  ["Cody", "Hansen", "12"], ["Mason", "Reyes", "27"], ["Tyler", "Brooks", "4"], ["Jace", "Whitaker", "88"],
  ["Logan", "Pierce", "51"], ["Ryder", "Nash", "7"], ["Colt", "Draper", "33"], ["Kaden", "Ruiz", "19"],
  ["Brody", "Lund", "62"], ["Hayden", "Cole", "45"], ["Wyatt", "Sorensen", "9"], ["Dane", "Carver", "71"],
];
const CLASSES = ["250 B", "450 A"];
const EVENTS = [
  { name: "Demo: Spring Thaw MX", date: "2026-04-18", state: "UT", location: "Erda, UT", track: "Rocky Mountain Raceway" },
  { name: "Demo: Snake River Shootout", date: "2026-06-06", state: "ID", location: "Blackfoot, ID", track: "Snake River Raceway" },
];

const { Client } = createRequire(path.join(root, "lib", "db", "package.json"))("pg");
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

// Deterministic pseudo-random so reruns on a fresh DB look the same.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const fmt = ms => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}.${String(Math.floor((ms % 1000) / 10)).padStart(2, "0")}`;

try {
  const exists = await db.query("SELECT 1 FROM events WHERE club_id = $1 AND name LIKE 'Demo:%' LIMIT 1", [clubId]);
  if (exists.rowCount) {
    console.log("Demo data already present; nothing to do.");
    process.exit(0);
  }

  await db.query("BEGIN");
  const riderIds = [];
  for (const [first, last, bib] of RIDERS) {
    const r = await db.query(
      "INSERT INTO riders (club_id, first_name, last_name, bib_number, home_state) VALUES ($1,$2,$3,$4,'UT') RETURNING id",
      [clubId, first, last, bib],
    );
    riderIds.push({ id: r.rows[0].id, bib });
  }

  const eventIds = [];
  for (const ev of EVENTS) {
    const e = await db.query(
      `INSERT INTO events (club_id, name, date, state, location, track_name, race_classes, status, entry_fee)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'completed',45) RETURNING id`,
      [clubId, ev.name, ev.date, ev.state, ev.location, ev.track, CLASSES],
    );
    const eventId = e.rows[0].id;
    eventIds.push(eventId);

    for (const [ci, raceClass] of CLASSES.entries()) {
      const entrants = riderIds.slice(ci * 6, ci * 6 + 6);
      for (const motoNumber of [1, 2]) {
        const m = await db.query(
          `INSERT INTO motos (event_id, name, type, race_class, race_classes, status, moto_number, lap_count, completed_at)
           VALUES ($1,$2,'moto',$3,$4,'completed',$5,6, now()) RETURNING id`,
          [eventId, `${raceClass} Moto ${motoNumber}`, raceClass, [raceClass], motoNumber],
        );
        const runs = entrants
          .map(r => {
            const laps = Array.from({ length: 6 }, () => Math.round(118000 + rand() * 14000));
            return { ...r, laps, total: laps.reduce((a, b) => a + b, 0) };
          })
          .sort((a, b) => a.total - b.total);
        for (const [i, run] of runs.entries()) {
          await db.query(
            `INSERT INTO race_results (event_id, moto_id, rider_id, race_class, position, total_time, lap_times, bib_number, dnf, dns)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,false)`,
            [eventId, m.rows[0].id, run.id, raceClass, i + 1, fmt(run.total), JSON.stringify(run.laps.map(String)), run.bib],
          );
        }
      }
    }
  }

  const series = await db.query(
    "INSERT INTO series (name, club_id, season, classes, event_ids) VALUES ($1,$2,2026,$3,$4) RETURNING id",
    ["Demo: Dev Club 2026 Championship", clubId, CLASSES, eventIds],
  );
  await db.query("COMMIT");
  console.log(`Inserted ${riderIds.length} riders, events ${eventIds.join(", ")}, and a series.`);

  // Publish through the API so the app computes series points itself.
  const login = await fetch(`${api}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  const json = { "Content-Type": "application/json", cookie };
  for (const id of eventIds) {
    const r = await fetch(`${api}/events/${id}/results/publish`, {
      method: "POST", headers: json, body: JSON.stringify({ published: true }),
    });
    console.log(`publish event ${id}: ${r.status}`);
  }
  const rc = await fetch(`${api}/series/${series.rows[0].id}/recalculate`, { method: "POST", headers: json, body: "{}" });
  console.log(`recalculate series ${series.rows[0].id}: ${rc.status}`);
} catch (err) {
  await db.query("ROLLBACK").catch(() => {});
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
