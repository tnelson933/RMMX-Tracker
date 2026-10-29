import assert from "node:assert/strict";
import test from "node:test";
import { buildContingencyReport, normalizeBrand, riderBrandMatch } from "./contingencyReport";

test("brand names match however they're typed", () => {
  assert.equal(normalizeBrand("Gas Gas"), "gasgas");
  assert.equal(normalizeBrand("GASGAS"), "gasgas");
  assert.equal(normalizeBrand("Kawi"), "kawasaki");
  assert.equal(normalizeBrand("Husky"), "husqvarna");
  assert.equal(normalizeBrand(null), "");
});

test("a rider runs a brand on their bike or as a listed sponsor", () => {
  assert.equal(riderBrandMatch("Yamaha", { bikeBrand: "yamaha", sponsors: "" }), "bike");
  assert.equal(riderBrandMatch("Fox Racing", { bikeBrand: "KTM", sponsors: "FMF, fox racing; Alpinestars" }), "sponsor");
  assert.equal(riderBrandMatch("Fox", { bikeBrand: "KTM", sponsors: "Fox Racing" }), null);
  assert.equal(riderBrandMatch("Honda", { bikeBrand: "Husqvarna", sponsors: null }), null);
  assert.equal(riderBrandMatch("  ", { bikeBrand: "", sponsors: "" }), null);
});

test("each brand lists its finishers by class and position, with class size", () => {
  const details: Record<number, { bikeBrand: string; sponsors: string }> = {
    1: { bikeBrand: "Yamaha", sponsors: "Maxxis" },
    2: { bikeBrand: "Honda", sponsors: "" },
    3: { bikeBrand: "yamaha", sponsors: "" },
  };
  const report = buildContingencyReport(
    ["Yamaha", "Maxxis", "yamaha", "KTM"],
    [
      { raceClass: "250 B", riders: [{ position: 1, riderId: 1, bibNumber: "11" }, { position: 2, riderId: 2, bibNumber: "22" }] },
      { raceClass: "450 A", riders: [{ position: 1, riderId: 3, bibNumber: "33" }, { position: 2, riderId: 4, bibNumber: "44" }] },
    ],
    id => details[id] ? { ...details[id], firstName: "F" + id, lastName: "L" + id, amaNumber: null, bikeModel: null, bikeYear: null } : null,
  );
  // Duplicate brand names collapse into one.
  assert.deepEqual(report.map(r => r.brand), ["Yamaha", "Maxxis", "KTM"]);
  assert.deepEqual(report[0].finishers.map(f => [f.raceClass, f.position, f.classSize, f.riderId, f.matchedBy]), [
    ["250 B", 1, 2, 1, "bike"],
    ["450 A", 1, 2, 3, "bike"],
  ]);
  assert.deepEqual(report[1].finishers.map(f => [f.riderId, f.matchedBy]), [[1, "sponsor"]]);
  assert.equal(report[2].finishers.length, 0);
});
