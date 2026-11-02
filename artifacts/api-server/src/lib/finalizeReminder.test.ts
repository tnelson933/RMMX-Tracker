import assert from "node:assert/strict";
import test from "node:test";
import { endOfDayAt, eventEndedAt, reminderDue, reminderEmailHtml, REMINDER_DELAY_MS } from "./finalizeReminder";

test("the event day ends at local midnight at the track", () => {
  // Utah (MDT, UTC-6 in summer): June 13 ends at 06:00 UTC on June 14.
  assert.equal(endOfDayAt("2026-06-13", "America/Denver").toISOString(), "2026-06-14T06:00:00.000Z");
  // Winter (MST, UTC-7).
  assert.equal(endOfDayAt("2026-12-05", "America/Denver").toISOString(), "2026-12-06T07:00:00.000Z");
});

test("ended: when the last race finished, else the end of the last day", () => {
  const finished = new Date("2026-06-13T22:30:00Z");
  const ev = { date: "2026-06-13", endDate: null, state: "UT", trackLat: null, trackLng: null };
  assert.equal(eventEndedAt(ev, finished), finished);
  assert.equal(eventEndedAt({ ...ev, endDate: "2026-06-14" }, null).toISOString(), "2026-06-15T06:00:00.000Z");
});

test("due 12 hours after the end, not for events long past", () => {
  const ended = new Date("2026-06-13T22:00:00Z");
  assert.equal(reminderDue(ended, new Date(ended.getTime() + REMINDER_DELAY_MS - 60_000)), false);
  assert.equal(reminderDue(ended, new Date(ended.getTime() + REMINDER_DELAY_MS)), true);
  assert.equal(reminderDue(ended, new Date(ended.getTime() + 30 * 24 * 3600_000)), false);
});

test("email: count of races, escaped names, link to Race Day Management", () => {
  const html = reminderEmailHtml({ organizerName: "Dan <b>", eventName: "Spring & Fall", unofficial: 3, url: "https://www.rmroost.com/events/7/motos" });
  assert.match(html, /3 races at <strong>Spring &amp; Fall<\/strong>/);
  assert.match(html, /Hi Dan &lt;b&gt;,/);
  assert.match(html, /href="https:\/\/www\.rmroost\.com\/events\/7\/motos"/);
});
