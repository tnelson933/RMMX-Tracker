import assert from "node:assert/strict";
import test from "node:test";
import { checkAcknowledgement, checkBrands, checkDefaultClasses, checkPdfUrl, checkWaiverFields } from "./clubSettingsInput";

test("waiver links must be files uploaded to RM Roost", () => {
  assert.deepEqual(checkPdfUrl("/api/storage/uploads/53580b70-6d41.pdf", "waiver"), { ok: true, value: "/api/storage/uploads/53580b70-6d41.pdf" });
  assert.deepEqual(checkPdfUrl(null, "waiver"), { ok: true, value: null });
  assert.deepEqual(checkPdfUrl("", "waiver"), { ok: true, value: null });
  for (const bad of ["javascript:alert(1)", "https://evil.example/w.pdf", "/api/storage/../auth/me", "//evil.example/x.pdf", 42]) {
    assert.equal(checkPdfUrl(bad, "waiver").ok, false, String(bad));
  }
});

test("race classes: trimmed, blanks and case-insensitive repeats dropped, rules kept", () => {
  const r = checkDefaultClasses([
    { id: "a", name: "  125cc   Class A " },
    { id: "b", name: "125CC class a" },
    { id: "c", name: "", details: "x" },
    { foo: 1 },
    { id: "d", name: "Vet 30+", details: " Riders 30 and older. " },
  ]);
  assert.ok(r.ok);
  assert.deepEqual(r.value, [{ id: "a", name: "125cc Class A" }, { id: "d", name: "Vet 30+", details: "Riders 30 and older." }]);
  assert.equal(checkDefaultClasses("not-a-list").ok, false);
  assert.equal(checkDefaultClasses([{ id: "x", name: "x".repeat(81) }]).ok, false);
  const noId = checkDefaultClasses([{ name: "Open" }]);
  assert.ok(noId.ok && noId.value[0].id.length > 0);
});

test("brands: trimmed, blanks and repeats dropped", () => {
  assert.deepEqual(checkBrands([" Yamaha ", "yamaha", "", 5, "Fox Racing"]), { ok: true, value: ["Yamaha", "Fox Racing"] });
  assert.equal(checkBrands({}).ok, false);
});

test("signing fields and acknowledgement text", () => {
  assert.ok(checkWaiverFields([{ id: "1", type: "signature", page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.05 }]).ok);
  assert.equal(checkWaiverFields([{ type: "script", x: 0, y: 0, width: 1, height: 1 }]).ok, false);
  assert.equal(checkWaiverFields([{ type: "name", x: "0", y: 0, width: 1, height: 1 }]).ok, false);
  assert.deepEqual(checkWaiverFields(null), { ok: true, value: null });
  assert.deepEqual(checkAcknowledgement("Wear a helmet."), { ok: true, value: "Wear a helmet." });
  assert.equal(checkAcknowledgement("x".repeat(50_001)).ok, false);
});
