import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's type-stripping runner requires the explicit extension.
import { formatEventDates, formatEventDatesFull, isEventOnLocalDate, localDateString } from "./eventDates.ts";

test("localDateString uses the local calendar date", () => {
  assert.equal(localDateString(new Date(2026, 9, 27, 23, 30)), "2026-10-27");
  assert.equal(localDateString(new Date(2026, 0, 5, 0, 5)), "2026-01-05");
});

test("single-day event is live only on its local date", () => {
  const lateEvening = new Date(2026, 9, 27, 22, 0);
  assert.equal(isEventOnLocalDate("2026-10-27", null, lateEvening), true);
  assert.equal(isEventOnLocalDate("2026-10-28", null, lateEvening), false);
  assert.equal(isEventOnLocalDate("2026-10-26", null, lateEvening), false);
  assert.equal(isEventOnLocalDate("2026-10-27T00:00:00.000Z", undefined, lateEvening), true);
});

test("multi-day event is live on every day of its range", () => {
  const start = "2026-10-26";
  const end = "2026-10-28";
  assert.equal(isEventOnLocalDate(start, end, new Date(2026, 9, 25, 12)), false);
  assert.equal(isEventOnLocalDate(start, end, new Date(2026, 9, 26, 0, 1)), true);
  assert.equal(isEventOnLocalDate(start, end, new Date(2026, 9, 27, 12)), true);
  assert.equal(isEventOnLocalDate(start, end, new Date(2026, 9, 28, 23, 59)), true);
  assert.equal(isEventOnLocalDate(start, end, new Date(2026, 9, 29, 0, 1)), false);
});

test("missing or inverted dates are handled", () => {
  const now = new Date(2026, 9, 27, 12);
  assert.equal(isEventOnLocalDate(null, null, now), false);
  assert.equal(isEventOnLocalDate("", null, now), false);
  assert.equal(isEventOnLocalDate("2026-10-27", "2026-10-20", now), true);
});

test("a same-day end date formats as a single day, not 'November 23 – 23'", () => {
  assert.equal(formatEventDatesFull("2026-11-23", "2026-11-23"), "Monday, November 23, 2026");
  assert.equal(formatEventDatesFull("2026-11-23", "2026-11-23T00:00:00.000Z"), "Monday, November 23, 2026");
  assert.equal(formatEventDates("2026-11-23", "2026-11-23"), "Nov 23, 2026");
  assert.equal(formatEventDates("2026-11-23", null), "Nov 23, 2026");
});

test("multi-day ranges keep both days", () => {
  assert.equal(formatEventDatesFull("2026-11-23", "2026-11-24"), "November 23 – 24, 2026");
  assert.equal(formatEventDates("2026-11-30", "2026-12-01"), "Nov 30 – Dec 1, 2026");
  assert.equal(formatEventDates("2026-12-31", "2027-01-01"), "Dec 31, 2026 – Jan 1, 2027");
});
