import assert from "node:assert/strict";
import test from "node:test";
import { contingencyCsv, contingencyFileName, csvCell, type ContingencyReportData } from "./contingencyCsv";

const finisher = {
  raceClass: "250 B", position: 1, classSize: 12, riderId: 1, firstName: "Sam", lastName: "Rider",
  bibNumber: "11", amaNumber: "123456", bikeBrand: "Yamaha", bikeModel: "YZ250F", bikeYear: "2025", matchedBy: "bike" as const,
};
const report: ContingencyReportData = {
  eventId: 7, eventName: "Spring Classic", eventDate: "2026-05-02", official: true,
  brands: [
    { brand: "Yamaha", finishers: [finisher] },
    { brand: "Fox Racing", finishers: [{ ...finisher, riderId: 2, firstName: "Alex", position: 3, matchedBy: "sponsor" }] },
  ],
};

test("one row per finisher, with the brand and whether results are official", () => {
  const lines = contingencyCsv(report).trim().split("\r\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^"Brand","Event","Event Date","Results","Class","Position"/);
  assert.equal(lines[1], '"Yamaha","Spring Classic","2026-05-02","Official","250 B","1","12","Sam","Rider","123456","11","Yamaha","YZ250F","2025","Bike"');
  assert.match(lines[2], /"Fox Racing".*"Sponsor"$/);
});

test("a single brand's file has only its finishers", () => {
  const lines = contingencyCsv(report, "Fox Racing").trim().split("\r\n");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^"Fox Racing"/);
});

test("cells can't run as spreadsheet formulas and quotes are escaped", () => {
  assert.equal(csvCell("=HYPERLINK(1)"), `"'=HYPERLINK(1)"`);
  assert.equal(csvCell("-5"), `"'-5"`);
  assert.equal(csvCell('Team "Fast"'), '"Team ""Fast"""');
  assert.equal(csvCell(null), '""');
});

test("file names", () => {
  assert.equal(contingencyFileName("Spring Classic", "Fox Racing"), "contingency-spring-classic-fox-racing.csv");
  assert.equal(contingencyFileName("Spring Classic"), "contingency-spring-classic-all-brands.csv");
});
