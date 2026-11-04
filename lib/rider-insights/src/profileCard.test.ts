// Run from scripts/: ./node_modules/.bin/tsx --test ../lib/rider-insights/src/profileCard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { cardSummary, nextMaintenance, recentFinishes } from "./profileCard";

test("card summary", () => {
  assert.equal(cardSummary({ eventsRaced: 6, totalPoints: 120, bestPosition: 1 }), "6 events · 120 pts · best P1");
  assert.equal(cardSummary({ eventsRaced: 1, totalPoints: 0, bestPosition: null }), "1 event");
});

test("recent finishes: oldest first, skips DNFs, capped", () => {
  const feed = [
    { motos: [{ position: 2 }, { position: null }] },   // newest event: moto 1 P2, moto 2 DNF
    { motos: [{ position: 5 }, { position: 4 }] },
  ];
  assert.deepEqual(recentFinishes(feed), [5, 4, 2]);
  assert.deepEqual(recentFinishes(feed, 2), [4, 2]);
  assert.deepEqual(recentFinishes([]), []);
});

test("next maintenance: most overdue first, unlogged last", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  const ago = (d: number) => new Date(now - d * 86_400_000).toISOString();
  assert.equal(nextMaintenance([], now), null);
  const items = [
    { itemName: "Chain", intervalDays: null, lastServicedAt: null },
    { itemName: "Oil", intervalDays: 30, lastServicedAt: ago(35) },
    { itemName: "Air filter", intervalDays: 10, lastServicedAt: ago(8) },
  ];
  assert.deepEqual(nextMaintenance(items, now), { itemName: "Oil", status: "overdue", dueInDays: -5, label: "Oil overdue 5 days" });
  assert.equal(nextMaintenance(items.slice(2), now)?.label, "Air filter due in 2 days");
  assert.equal(nextMaintenance(items.slice(2), now)?.status, "due_soon");
  assert.equal(nextMaintenance(items.slice(0, 1), now)?.label, "Chain: not logged yet");
});
