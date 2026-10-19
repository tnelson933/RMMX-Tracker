import assert from "node:assert/strict";
import test from "node:test";
import { evaluateFormula, formulaPoints } from "./safeFormula";

const at = (formula: string, position: number, riders = 20) => formulaPoints(formula, position, riders);

test("typical points formulas evaluate like JavaScript", () => {
  assert.equal(at("riders - position + 1", 1), 20);
  assert.equal(at("riders - position + 1", 20), 1);
  assert.equal(at("position <= 3 ? (26 - position) * 2 : 26 - position", 2), 48);
  assert.equal(at("position <= 3 ? (26 - position) * 2 : 26 - position", 5), 21);
  assert.equal(at("Math.max(0, 25 - (position - 1) * 2)", 4), 19);
  assert.equal(at("Math.round(100 / Math.sqrt(position))", 4), 50);
  assert.equal(at("Math.floor(riders / position)", 3), 6);
  assert.equal(at("2 ** 3 * position", 2), 16);
  assert.equal(at("-2 ** 2", 1), 0); // JS forbids this; we parse as -(2**2) and clamp to 0
  assert.equal(at("position === 1 ? 50 : position == 2 ? 40 : 0", 1), 50);
  assert.equal(at("position > 10 && position < 15 ? 5 : 1", 12), 5);
  assert.equal(at("Math.PI * 0 + 7 % 4", 1), 3);
  assert.equal(at("Math.pow(2, Math.min(position, 4))", 9), 16);
});

test("results are clamped, rounded, and errors score zero", () => {
  assert.equal(at("1 - position", 5), 0);
  assert.equal(at("10.6", 1), 11);
  assert.equal(at("1 / 0", 1), 0);
  assert.equal(at("", 1), 0);
  assert.equal(at("position +", 1), 0);
});

test("anything beyond arithmetic is rejected", () => {
  const attacks = [
    'this.constructor.constructor("return process")()',
    "constructor",
    "process.exit()",
    "Math.constructor",
    "Math.__proto__",
    "Math.random()",
    "globalThis",
    "require('fs')",
    "position.toString",
    "(() => 1)()",
    "position = 5",
    "`${position}`",
    "'1'",
    "[1][0]",
    "{}",
    "new Date()",
    "Math['abs'](1)",
  ];
  for (const formula of attacks) {
    assert.throws(() => evaluateFormula(formula, { position: 1, riders: 1 }), `should reject: ${formula}`);
    assert.equal(at(formula, 1), 0);
  }
});

test("oversized or deeply nested formulas are rejected", () => {
  assert.throws(() => evaluateFormula("1+".repeat(300) + "1", { position: 1, riders: 1 }));
  assert.throws(() => evaluateFormula("(".repeat(80) + "1" + ")".repeat(80), { position: 1, riders: 1 }));
});
