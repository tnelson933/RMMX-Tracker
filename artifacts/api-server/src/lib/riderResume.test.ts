import assert from "node:assert/strict";
import test from "node:test";
import { computeCareerStats } from "./careerStats";
import { ageOn, computeResume, effectiveVisibility, type ResumeMoto } from "./riderResume";

const moto = (over: Partial<ResumeMoto>): ResumeMoto => ({
  motoId: 1, motoType: "heat", position: 5, dnf: false, dns: false, lapTimes: [],
  eventId: 10, eventName: "Spring MX", eventDate: "2026-04-12", raceClass: "250 B", track: "Example Raceway", ...over,
});

const resumeOf = (motos: ResumeMoto[], field = new Map<number, number[][]>()) => {
  const stats = computeCareerStats(motos.map(m => ({ ...m, motoName: "Moto" })), field);
  return { stats, resume: computeResume(motos, field, stats) };
};

test("highlights: best finish (latest on a tie) and biggest comeback from lap 1", () => {
  // Moto 1: four riders; this rider is 4th after lap 1 (slowest) and finishes 2nd.
  const mine = [70_000, 60_000, 60_000];
  const field = new Map([[1, [
    [70_000, 130_000, 190_000], // this rider
    [60_000, 125_000, 189_000],
    [61_000, 126_000, 195_000],
    [62_000, 127_000, 196_000],
  ]]]);
  const motos = [
    moto({ motoId: 1, position: 2, lapTimes: mine, eventId: 10, eventName: "Spring MX" }),
    moto({ motoId: 2, position: 2, eventId: 11, eventName: "Fall MX", eventDate: "2026-09-01" }),
    moto({ motoId: 3, position: 6, eventId: 12, eventName: "Summer MX", eventDate: "2026-06-01" }),
  ];
  const { resume } = resumeOf(motos, field);
  assert.deepEqual(resume.highlights.bestFinish, { position: 2, eventId: 11, eventName: "Fall MX", eventDate: "2026-09-01" });
  assert.deepEqual(resume.highlights.bestComeback, { gained: 2, eventId: 10, eventName: "Spring MX" });
});

test("seasons, classes, tracks and the improving headline", () => {
  const motos = [
    moto({ motoId: 1, position: 9, eventDate: "2024-05-01", raceClass: "250 C", track: "A" }),
    moto({ motoId: 2, position: 7, eventDate: "2024-06-01", raceClass: "250 C", track: "B" }),
    moto({ motoId: 3, position: 4, eventDate: "2026-05-01", raceClass: "250 B", track: "B" }),
    moto({ motoId: 4, position: 6, eventDate: "2026-06-01", raceClass: "250 B", track: "B" }),
    moto({ motoId: 5, position: 0, dns: true, eventDate: "2026-07-01", raceClass: "250 B" }),
  ];
  const { resume } = resumeOf(motos);
  assert.deepEqual(resume.seasons, [{ year: "2024", avgFinish: 8, motos: 2 }, { year: "2026", avgFinish: 5, motos: 2 }]);
  assert.deepEqual(resume.classes, ["250 B", "250 C"]);
  assert.deepEqual(resume.tracks, ["B", "A"]);
  assert.equal(resume.firstYear, "2024");
  assert.equal(resume.headline, "Average finish up from P8 to P5 since 2024.");
});

test("headline prefers wins, then podiums", () => {
  assert.equal(resumeOf([moto({ position: 1 }), moto({ motoId: 2, position: 3 }), moto({ motoId: 3, position: 8 })]).resume.headline,
    "1 moto win and 2 podiums in 3 motos.");
  assert.equal(resumeOf([moto({ position: 3 }), moto({ motoId: 2, position: 8 })]).resume.headline, "1 podium in 2 motos.");
  assert.equal(resumeOf([moto({ position: 9 })]).resume.headline, "Racing since 2026: 1 moto so far.");
  assert.equal(resumeOf([]).resume.headline, null);
});

test("badges: wins, finishing streak, podiums at a track", () => {
  const motos = [1, 2, 3, 4, 5].map(i => moto({ motoId: i, position: i === 1 ? 1 : 3, eventDate: `2026-0${i}-01` }));
  const labels = resumeOf(motos).resume.badges.map(b => b.label);
  assert.ok(labels.includes("1 moto win"));
  assert.ok(labels.includes("5 motos finished in a row"));
  assert.ok(labels.includes("5 podiums at Example Raceway"));
  const broken = [...motos, moto({ motoId: 9, dnf: true, eventDate: "2026-09-01" })];
  assert.ok(!resumeOf(broken).resume.badges.some(b => b.key === "streak"));
});

test("age and default visibility: under 18 private, unknown treated as adult, explicit choice wins", () => {
  assert.equal(ageOn("2008-11-05", "2026-11-04"), 17);
  assert.equal(ageOn("2008-11-04", "2026-11-04"), 18);
  assert.equal(ageOn(null, "2026-11-04"), null);
  const today = "2026-11-04";
  assert.equal(effectiveVisibility({ dateOfBirth: "2012-03-01", profileVisibility: null }, today), "private");
  assert.equal(effectiveVisibility({ dateOfBirth: "2012-03-01", profileVisibility: "public" }, today), "public");
  assert.equal(effectiveVisibility({ dateOfBirth: "1990-03-01", profileVisibility: null }, today), "public");
  assert.equal(effectiveVisibility({ dateOfBirth: "1990-03-01", profileVisibility: "private" }, today), "private");
  assert.equal(effectiveVisibility({ dateOfBirth: null, profileVisibility: null }, today), "public");
});
