import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's type-stripping runner requires the explicit extension.
import { fullTitle, routeTitle } from "./documentTitle.ts";

test("every page title ends with the site name", () => {
  assert.equal(fullTitle("Results"), "Results · RM Roost");
  assert.equal(fullTitle("  "), "RM Roost");
  assert.equal(fullTitle(null), "RM Roost");
});

test("route defaults", () => {
  assert.equal(routeTitle("/"), "RM Roost");
  assert.equal(routeTitle("/results"), "Results · RM Roost");
  assert.equal(routeTitle("/results/"), "Results · RM Roost");
  assert.equal(routeTitle("/leaderboard?series=3"), "Series Standings · RM Roost");
  assert.equal(routeTitle("/results/43"), "Event · RM Roost");
  assert.equal(routeTitle("/live/812"), "Live Timing · RM Roost");
  assert.equal(routeTitle("/rider/racer/12"), "Racer Profile · RM Roost");
  assert.equal(routeTitle("/events/7/registrations"), "Event · RM Roost");
  assert.equal(routeTitle("/widget/series/2"), "RM Roost");
  assert.equal(routeTitle("/nope"), "Page Not Found · RM Roost");
});
