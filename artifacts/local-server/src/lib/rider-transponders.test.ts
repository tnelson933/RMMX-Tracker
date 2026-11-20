/**
 * Offline lookups with several transponders per rider, on a real SQLite file
 * built by initDb(). better-sqlite3 is built for Electron here, so run with
 * Electron as Node (see scripts/test-local-server.mjs).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rm-transponders-"));
process.env.SQLITE_FILE = path.join(dir, "test.db");

const { getDb } = await import("../db");
const { initDb } = await import("../db-init");
initDb();
const db = getDb();
const { resolveRider } = await import("../routes/timing");
const { resolvePracticeRider } = await import("../routes/practice");
const { teamTagRider } = await import("./group-teams");
const lib = await import("./rider-transponders");

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const CLUB = 1000;
const list = (riderId: number) =>
  (db.prepare("SELECT transponder_number FROM rider_transponders WHERE rider_id = ? ORDER BY id").all(riderId) as Array<{ transponder_number: string }>)
    .map((r) => r.transponder_number);
const field = (riderId: number) =>
  db.prepare("SELECT mylaps_transponder_id AS trackr, rfid_number AS rfid FROM riders WHERE id = ?").get(riderId) as { trackr: string | null; rfid: string | null };

db.prepare("INSERT INTO riders (id, first_name, last_name, mylaps_transponder_id) VALUES (1, 'Ana', 'Two-Bikes', 'AAA111')").run();
db.prepare("INSERT INTO riders (id, first_name, last_name) VALUES (2, 'Ben', 'Other')").run();
db.prepare("INSERT INTO riders (id, first_name, last_name) VALUES (3, 'Cal', 'Captain')").run();
db.prepare("INSERT INTO events (id, club_id, name, date) VALUES (50, ?, 'Race', '2026-11-21')").run(CLUB);
db.prepare("INSERT INTO events (id, club_id, name, date) VALUES (51, ?, 'Team race', '2026-11-22')").run(CLUB);
db.prepare("INSERT INTO registrations (id, event_id, rider_id, race_class) VALUES (500, 50, 1, '250 B')").run();

test("a profile number is copied into the rider's list", () => {
  assert.deepEqual(list(1), ["aaa111"]);
});

test("a second RM TrackR is added, and both time the rider in races and practice", () => {
  const added = lib.addRiderTransponder(db, 1, { number: "bbb222", kind: "trackr", label: "KX450" });
  assert.equal(added.ok, true);
  assert.deepEqual(list(1), ["aaa111", "bbb222"]);
  assert.equal(field(1).trackr, "AAA111", "the primary stays the first one");
  for (const tag of ["AAA111", "bbb222", " BBB222 "]) {
    assert.equal(resolveRider(tag.trim(), 50), 1, `race: ${tag}`);
    assert.equal(resolvePracticeRider(db, CLUB, tag.trim())?.riderId, 1, `practice: ${tag}`);
    assert.equal(lib.riderIdForTransponder(db, tag), 1);
  }
  assert.equal(resolvePracticeRider(db, CLUB, "bbb222")?.riderName, "Ana Two-Bikes");
});

test("a number on another rider is refused and names them", () => {
  const taken = lib.addRiderTransponder(db, 2, { number: "BBB222", kind: "trackr", label: null });
  assert.equal(taken.ok, false);
  assert.match((taken as { error: string }).error, /RM TrackR BBB222 is already assigned to Ana Two-Bikes \(rider #1\)/);
  assert.deepEqual(list(2), []);
  assert.equal(lib.addRiderTransponderIfFree(db, 2, "bbb222", "trackr"), false, "registrations never take it either");
});

test("an event entry's transponder still wins at that event", () => {
  db.prepare("INSERT INTO registrations (id, event_id, rider_id, race_class, mylaps_transponder_number) VALUES (501, 50, 2, '250 B', 'bbb222')").run();
  assert.equal(resolveRider("bbb222", 50), 2);
  assert.equal(resolveRider("bbb222", 51), 1, "but not at another event");
  db.prepare("DELETE FROM registrations WHERE id = 501").run();
});

test("any of a team member's transponders is a lap for their team", () => {
  db.prepare("INSERT INTO registrations (id, event_id, rider_id, race_class, team_name) VALUES (510, 51, 3, 'Team', 'Fast Four')").run();
  db.prepare("INSERT INTO team_members (event_id, registration_id, position, rider_id, first_name, last_name) VALUES (51, 510, 1, 3, 'Cal', 'Captain')").run();
  db.prepare("INSERT INTO team_members (event_id, registration_id, position, rider_id, first_name, last_name, trackr_number) VALUES (51, 510, 2, 1, 'Ana', 'Two-Bikes', 'aaa111')").run();
  assert.equal(teamTagRider("aaa111", 51), 3);
  assert.equal(teamTagRider("BBB222", 51), 3, "her other bike's RM TrackR too");
  assert.equal(resolveRider("bbb222", 51), 3);
  assert.equal(resolveRider("bbb222", 50), 1, "other events: her own");
});

test("removing the primary moves the profile field to the next one", () => {
  const id = (db.prepare("SELECT id FROM rider_transponders WHERE transponder_number = 'aaa111'").get() as { id: number }).id;
  assert.deepEqual(lib.removeRiderTransponder(db, 1, id)?.map((t) => t.number), ["BBB222"]);
  assert.equal(field(1).trackr, "bbb222");
  assert.equal(resolveRider("aaa111", 50), null, "the removed one no longer times her");
  assert.equal(lib.removeRiderTransponder(db, 2, id), null, "only the owner's list");
});

test("older code writing the single field still works (rename, clear, taken)", () => {
  db.prepare("UPDATE riders SET mylaps_transponder_id = 'CCC333' WHERE id = 1").run();
  assert.deepEqual(list(1), ["ccc333"], "replacing the primary renames it in the list");
  lib.addRiderTransponder(db, 1, { number: "ddd444", kind: "trackr", label: null });
  db.prepare("UPDATE riders SET mylaps_transponder_id = NULL WHERE id = 1").run();
  assert.deepEqual(list(1), ["ddd444"]);
  assert.equal(field(1).trackr, "ddd444", "the field falls back to the next one");
  db.prepare("UPDATE riders SET mylaps_transponder_id = 'ddd444' WHERE id = 2").run();
  assert.deepEqual(list(2), [], "a number another rider owns stays theirs");
  assert.equal(resolveRider("ddd444", 50), 1);
  db.prepare("UPDATE riders SET rfid_number = 'E200ABC' WHERE id = 2").run();
  assert.deepEqual(list(2), ["e200abc"]);
  assert.equal(resolveRider("e200abc", 50), 2);
});

test("the sync engine's rider upsert never fails on a number another rider owns", () => {
  // INSERT … ON CONFLICT DO UPDATE: its conflict policy applies inside triggers too.
  const upsert = db.prepare(`INSERT INTO riders (id, first_name, last_name, mylaps_transponder_id) VALUES (?, 'Ben', 'Other', ?)
    ON CONFLICT(id) DO UPDATE SET mylaps_transponder_id = excluded.mylaps_transponder_id`);
  assert.doesNotThrow(() => upsert.run(2, "ddd444"));
  assert.doesNotThrow(() => upsert.run(77, "ddd444"), "new row too");
  assert.equal(lib.riderIdForTransponder(db, "ddd444"), 1);
  assert.deepEqual(list(77), []);
  db.prepare("DELETE FROM riders WHERE id = 77").run();
});

test("a new rider row with numbers fills the list", () => {
  db.prepare("INSERT INTO riders (id, first_name, last_name, mylaps_transponder_id, rfid_number) VALUES (4, 'Dee', 'New', 'EEE555', 'F00')").run();
  assert.deepEqual(list(4), ["eee555", "f00"]);
});

test("a pulled cloud list replaces the local one unless the rider has unpushed edits", () => {
  const changed = lib.applyPulledRiderTransponders(db, new Map([[1, 1], [4, 4]]), [
    { riderId: 1, transponderNumber: "ddd444", kind: "trackr", label: "Old bike" },
    { riderId: 1, transponderNumber: "fff666", kind: "trackr", label: null },
    // Moved to rider 4 on the cloud.
    { riderId: 4, transponderNumber: "e200abc", kind: "rfid", label: null },
  ]);
  assert.ok(changed > 0);
  assert.deepEqual(list(1), ["ddd444", "fff666"]);
  assert.deepEqual(list(4), ["e200abc"], "rider 4's list is the cloud's");
  assert.deepEqual(list(2), [], "taken from rider 2, who had no unpushed edits");
  assert.equal(field(4).trackr, null);
  assert.equal(field(4).rfid, "e200abc");

  db.prepare("INSERT INTO _rider_profile_dirty (rider_id, field_name) VALUES (1, 'transponders')").run();
  lib.applyPulledRiderTransponders(db, new Map([[1, 1]]), []);
  assert.deepEqual(list(1), ["ddd444", "fff666"], "unpushed local edits win until pushed");
  assert.deepEqual(lib.transpondersForSync(db, 1).map((t) => t.number), ["ddd444", "fff666"]);
});
