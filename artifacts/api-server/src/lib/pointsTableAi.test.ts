// The AI Points Assistant's checks: every reply the AI might give either
// becomes a table the form and the scoring engine accept, or a clear error.
import assert from "node:assert/strict";
import test from "node:test";
import { scoreMotoRows } from "./motoPoints";
import { AMA_POINTS } from "./overallOrder";
import {
  SUGGEST_SYSTEM_PROMPT, TWEAK_SYSTEM_PROMPT, aiReplyText, parseAiPointsTable, tweakUserMessage,
} from "./pointsTableAi";

const reply = (o: Record<string, unknown>) => JSON.stringify(o);
const ok = (text: string) => {
  const r = parseAiPointsTable(text);
  assert.ok("table" in r, "error" in r ? r.error : "");
  return r.table;
};
const err = (text: string) => {
  const r = parseAiPointsTable(text);
  assert.ok("error" in r, "expected the reply to be rejected");
  return r.error;
};
const base = { name: "Club MX", description: "d", mainEventOnly: false, scoringFormula: null, motoNotes: null };

test("an AMA reply in a code fence becomes the AMA scale", () => {
  const t = ok("```json\n" + reply({ ...base, scoringMethod: "highest_points", pointsScale: AMA_POINTS }) + "\n```");
  assert.deepEqual(t.pointsScale, AMA_POINTS);
  assert.equal(t.scoringMethod, "highest_points");
  assert.equal("motoNotes" in t, false); // null note left out (the API contract's motoNotes is a string)
});

test("a reply with a sentence around the JSON is still read", () => {
  const t = ok(`Here is your table:\n${reply({ ...base, scoringMethod: "lowest_positions", pointsScale: [1, 2, 3] })}\nEnjoy!`);
  assert.deepEqual(t.pointsScale, [1, 2, 3]);
});

test("Supercross keeps main event only", () => {
  assert.equal(ok(reply({ ...base, scoringMethod: "highest_points", mainEventOnly: true, pointsScale: AMA_POINTS })).mainEventOnly, true);
});

test("per rider and formula tables never carry a scale; per rider drops a formula", () => {
  const pr = ok(reply({ ...base, scoringMethod: "per_rider", pointsScale: [5, 4], scoringFormula: "riders" }));
  assert.deepEqual([pr.pointsScale, pr.scoringFormula], [[], null]);
  const f = ok(reply({ ...base, scoringMethod: "formula", pointsScale: [9], scoringFormula: " position <= 3 ? (4 - position) * 10 : Math.max(1, 30 - position) " }));
  assert.deepEqual([f.pointsScale, f.scoringFormula], [[], "position <= 3 ? (4 - position) * 10 : Math.max(1, 30 - position)"]);
});

test("scale tables drop a stray formula", () => {
  assert.equal(ok(reply({ ...base, scoringMethod: "highest_points", pointsScale: [3, 2, 1], scoringFormula: "riders" })).scoringFormula, null);
});

test("formulas the engine can't run are refused (unsafe, empty, or not a number)", () => {
  assert.match(err(reply({ ...base, scoringMethod: "formula", pointsScale: [], scoringFormula: "process.exit(1)" })), /can't use/);
  assert.match(err(reply({ ...base, scoringMethod: "formula", pointsScale: [], scoringFormula: "" })), /didn't write one/);
  assert.match(err(reply({ ...base, scoringMethod: "formula", pointsScale: [], scoringFormula: "100 / (riders - position)" })), /can't use/); // last place divides by 0
});

test("points must be whole and 0 or more; numeric strings are accepted", () => {
  assert.deepEqual(ok(reply({ ...base, scoringMethod: "highest_points", pointsScale: ["25", 22, "20"] })).pointsScale, [25, 22, 20]);
  err(reply({ ...base, scoringMethod: "highest_points", pointsScale: [25, 22.5, 20] }));
  err(reply({ ...base, scoringMethod: "highest_points", pointsScale: [25, -1] }));
  err(reply({ ...base, scoringMethod: "highest_points", pointsScale: [] }));
  err(reply({ ...base, scoringMethod: "highest_points", pointsScale: Array(201).fill(1) }));
});

test("a scale in the wrong direction is refused", () => {
  assert.match(err(reply({ ...base, scoringMethod: "highest_points", pointsScale: [1, 2, 3] })), /lower place more points/);
  assert.match(err(reply({ ...base, scoringMethod: "lowest_positions", pointsScale: [3, 2, 1] })), /same or more/);
  ok(reply({ ...base, scoringMethod: "highest_points", pointsScale: [50, 50, 40, 0] })); // ties and trailing 0 are fine
});

test("unknown method, missing name and unreadable replies are refused", () => {
  err(reply({ ...base, scoringMethod: "most_points", pointsScale: [3, 2, 1] }));
  err(reply({ ...base, name: "  ", scoringMethod: "per_rider", pointsScale: [] }));
  err("Sorry, I can't help with that.");
  err("[1, 2, 3]");
});

test("long names are shortened; notes are kept", () => {
  const t = ok(reply({ ...base, name: "x".repeat(90), scoringMethod: "per_rider", pointsScale: [], motoNotes: " Auto DNF is a club-wide setting. " }));
  assert.equal(t.name.length, 60);
  assert.equal(t.motoNotes, "Auto DNF is a club-wide setting.");
});

test("refusals, cut-off and empty replies get a clear message", () => {
  assert.match((aiReplyText({ stop_reason: "refusal", content: [] }) as any).error, /declined/);
  assert.match((aiReplyText({ stop_reason: "max_tokens", content: [{ type: "text", text: "{" }] }) as any).error, /cut off/);
  assert.match((aiReplyText({ stop_reason: "end_turn", content: [{ type: "thinking" }] }) as any).error, /empty/);
  assert.deepEqual(aiReplyText({ stop_reason: "end_turn", content: [{ type: "thinking" }, { type: "text", text: "{}" }] }), { text: "{}" });
});

test("an edit sends the whole table, formula included", () => {
  const m = tweakUserMessage({ name: "F", description: "", scoringMethod: "formula", mainEventOnly: false, pointsScale: [], scoringFormula: "riders - position + 1" }, "double it");
  assert.match(m, /Scoring method: formula/);
  assert.match(m, /Scoring formula: riders - position \+ 1/);
  assert.match(m, /Points scale: \(none\)/);
  assert.match(m, /Change requested: double it/);
});

test("both prompts know all four methods and the engine's fixed rules", () => {
  for (const p of [SUGGEST_SYSTEM_PROMPT, TWEAK_SYSTEM_PROMPT]) {
    for (const m of ["highest_points", "lowest_positions", "per_rider", "formula"]) assert.ok(p.includes(`"${m}"`), m);
    assert.match(p, /starters \+ 30/);
    assert.match(p, /never less than 20/);
    assert.match(p, /Auto DNF/);
    assert.match(p, /DNF beats a DNS/);
  }
  assert.ok(SUGGEST_SYSTEM_PROMPT.includes(AMA_POINTS.join(", ")));
});

test("an AI table scores races the way the engine should", () => {
  const rows = [1, 2, 3, 4].map(position => ({ id: position, position, dnf: position === 4, dns: false, lapTimes: [] }));
  const settings = (t: ReturnType<typeof ok>) => ({ ...t, scoringFormula: t.scoringFormula });
  const ama = ok(reply({ ...base, scoringMethod: "highest_points", pointsScale: AMA_POINTS }));
  assert.deepEqual([...scoreMotoRows(rows, settings(ama), "heat").values()], [25, 22, 20, 0]);
  const formula = ok(reply({ ...base, scoringMethod: "formula", pointsScale: [], scoringFormula: "(riders - position + 1) * 2" }));
  assert.deepEqual([...scoreMotoRows(rows, settings(formula), "heat").values()], [8, 6, 4, 0]);
});
