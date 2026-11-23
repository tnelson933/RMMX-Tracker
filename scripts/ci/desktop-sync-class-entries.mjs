#!/usr/bin/env node
// Integration test (CI): a rider's two class entries made offline both reach the
// cloud through POST /api/clubs/:clubId/desktop-push.
//
// Regression guard for the bug fixed in db92471c: a pushed class entry the cloud
// didn't know by id was matched on (event, rider) only, so a rider's second
// offline entry (450 A) overwrote the first (250 B) and one entry was lost.
//
//   pnpm --filter @workspace/api-server exec node ./build.mjs     # builds dist/index.mjs
//   DATABASE_URL=postgres://postgres@127.0.0.1:5432/<throwaway> node scripts/ci/desktop-sync-class-entries.mjs
//
// Starts the built API against DATABASE_URL (schema already applied), seeds one
// club/organizer/event/rider with ids in a reserved range, pushes the entries the
// way the desktop's write queue does (separate pushes, desktop ids the cloud has
// never seen), asserts the rows, then deletes what it created.
// API_ENTRY overrides the server file (used to prove the test fails on the old code).
// Refuses any database host other than localhost/127.0.0.1/::1 or the CI service.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { Client } = createRequire(path.join(root, "lib", "db", "package.json"))("pg");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) { console.error("desktop-sync-class-entries: DATABASE_URL is not set"); process.exit(2); }
const host = new URL(databaseUrl).hostname;
if (!["localhost", "127.0.0.1", "[::1]", "postgres"].includes(host)) {
  console.error(`desktop-sync-class-entries: refusing non-local database host ${host}`);
  process.exit(2);
}
const apiEntry = path.resolve(root, process.env.API_ENTRY ?? "artifacts/api-server/dist/index.mjs");
if (!existsSync(apiEntry)) {
  console.error(`desktop-sync-class-entries: ${apiEntry} not found; build the API first (node ./build.mjs in artifacts/api-server)`);
  process.exit(2);
}

// Reserved ids, far above anything a dev or CI database hands out.
const CLUB_ID = 987_001;
const EVENT_ID = 987_001;
const RIDER_ID = 987_001;
const DESKTOP_REG_IDS = [987_101, 987_102]; // the desktop's own SQLite ids
const syncToken = randomBytes(24).toString("hex");

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const db = new Client({ connectionString: databaseUrl });
await db.connect();

async function cleanup() {
  await db.query("DELETE FROM registrations WHERE event_id = $1", [EVENT_ID]);
  await db.query("DELETE FROM events WHERE id = $1", [EVENT_ID]);
  await db.query("DELETE FROM riders WHERE id = $1", [RIDER_ID]);
  await db.query("DELETE FROM users WHERE club_id = $1", [CLUB_ID]);
  await db.query("DELETE FROM clubs WHERE id = $1", [CLUB_ID]);
}

let server;
let serverLog = "";
let failed = false;
try {
  await cleanup();
  await db.query("INSERT INTO clubs (id, name, state) VALUES ($1, 'CI Sync Club', 'CO')", [CLUB_ID]);
  await db.query(
    `INSERT INTO users (email, name, role, club_id, offline_sync_token)
     VALUES ('ci-sync-organizer@example.test', 'CI Organizer', 'club_organizer', $1, $2)`,
    [CLUB_ID, syncToken],
  );
  await db.query(
    "INSERT INTO events (id, club_id, name, date, state) VALUES ($1, $2, 'CI Sync National', '2026-08-27', 'CO')",
    [EVENT_ID, CLUB_ID],
  );
  await db.query("INSERT INTO riders (id, first_name, last_name) VALUES ($1, 'Avery', 'Rider')", [RIDER_ID]);

  const port = await freePort();
  server = spawn(process.execPath, ["--enable-source-maps", apiEntry], {
    cwd: path.dirname(path.dirname(apiEntry)),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      NODE_ENV: "development",
      SESSION_SECRET: randomBytes(32).toString("hex"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => { serverLog += d; });
  server.stderr.on("data", (d) => { serverLog += d; });
  const base = `http://127.0.0.1:${port}/api`;

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (server.exitCode != null) throw new Error(`API exited early with ${server.exitCode}`);
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error("API did not become healthy within 60 s");
    await new Promise((r) => setTimeout(r, 250));
  }

  const push = async (registrations) => {
    const res = await fetch(`${base}/clubs/${CLUB_ID}/desktop-push`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${syncToken}` },
      body: JSON.stringify({ registrations }),
    });
    const body = await res.json().catch(() => ({}));
    assert.equal(res.status, 200, `desktop-push answered ${res.status}: ${JSON.stringify(body)}`);
    return body;
  };
  const entry = (id, raceClass, bib) => ({
    id, event_id: EVENT_ID, rider_id: RIDER_ID, race_class: raceClass,
    status: "confirmed", payment_status: "paid", payment_method: "cash", amount_paid: "40.00", bib_number: bib,
  });
  const rows = async () => (await db.query(
    "SELECT race_class, bib_number FROM registrations WHERE event_id = $1 AND rider_id = $2 ORDER BY race_class",
    [EVENT_ID, RIDER_ID],
  )).rows;

  // The desktop queues each new entry as it is made, so they arrive in separate pushes.
  await push([entry(DESKTOP_REG_IDS[0], "250 B", "11")]);
  await push([entry(DESKTOP_REG_IDS[1], "450 A", "11")]);
  const afterTwoPushes = await rows();
  assert.deepEqual(
    afterTwoPushes.map((r) => r.race_class),
    ["250 B", "450 A"],
    `expected both class entries, got ${JSON.stringify(afterTwoPushes)}`,
  );
  console.log("ok - a rider's second offline class entry is added, not merged into the first");

  // Both entries in one push (a desktop that was offline for a while).
  await db.query("DELETE FROM registrations WHERE event_id = $1", [EVENT_ID]);
  await push([entry(DESKTOP_REG_IDS[0], "250 B", "11"), entry(DESKTOP_REG_IDS[1], "450 A", "11")]);
  assert.deepEqual((await rows()).map((r) => r.race_class), ["250 B", "450 A"]);
  console.log("ok - two class entries in one push make two rows");

  // Re-sending (the desktop retries after a dropped connection) changes nothing.
  await push([entry(DESKTOP_REG_IDS[0], "250 B", "11"), entry(DESKTOP_REG_IDS[1], "450 A", "11")]);
  assert.equal((await rows()).length, 2);
  console.log("ok - re-pushing the same entries keeps two rows");

  // An edit to one entry updates that entry only.
  await push([{ ...entry(DESKTOP_REG_IDS[1], "450 A", "711") }]);
  assert.deepEqual((await rows()).map((r) => `${r.race_class}#${r.bib_number}`), ["250 B#11", "450 A#711"]);
  console.log("ok - editing the second entry leaves the first alone");
} catch (err) {
  failed = true;
  console.error(`not ok - ${err.message}`);
  if (serverLog) console.error(`\n--- API output (last 4000 chars) ---\n${serverLog.slice(-4000)}`);
} finally {
  server?.kill();
  await cleanup().catch((err) => console.error(`cleanup failed: ${err.message}`));
  await db.end();
}
process.exit(failed ? 1 : 0);
