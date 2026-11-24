import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's type-stripping runner requires the explicit extension.
import { dedupeFeedItems } from "./feed.ts";

test("one feed card per rider, event and class", () => {
  const items = [
    { riderId: 1, riderName: "Kade Moss", eventId: 40, raceClass: "250 B", n: 1 },
    { riderId: 9, riderName: "Kade  Moss", eventId: 40, raceClass: "250 b ", n: 2 },
    { riderId: 1, riderName: "Kade Moss", eventId: 40, raceClass: "450 B", n: 3 },
    { riderId: 1, riderName: "Kade Moss", eventId: 41, raceClass: "250 B", n: 4 },
    { riderId: 2, riderName: "Ava Moss", eventId: 40, raceClass: "250 B", n: 5 },
  ];
  assert.deepEqual(dedupeFeedItems(items).map(i => i.n), [1, 3, 4, 5]);
  assert.deepEqual(dedupeFeedItems([]), []);
});
