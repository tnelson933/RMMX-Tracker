import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanText, escapeHtml, eventMeta, eventPhase, formatEventDates, genericMeta, injectShareMeta, placeLine,
  racerMeta, racerStatLine, resultLabel, riderResultMeta, riderResultPath, siteOrigin,
} from "./shareMeta";
import { eventCardSvg, escapeXml, fitText, racerCardSvg, resultCardSvg, wrapLines } from "./shareCard";

const INDEX = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>RM Roost</title>
    <meta name="description" content="generic" />
    <meta name="robots" content="index, follow" />
    <meta property="og:title" content="RM Roost" />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta property="og:image" content="https://www.rmroost.com/brand/og-image.png" />
    <link rel="icon" href="/favicon-32.png" />
  </head>
  <body><div id="root"></div></body>
</html>`;

const ORIGIN = "https://www.rmroost.com";
const event = {
  id: 42, name: "Spring Classic MX", date: "2026-06-13", endDate: "2026-06-14",
  trackName: "Pine Ridge Raceway", location: "Boise", state: "ID", clubName: "Gem State MX",
};

test("event phase: results, live, register, closed, upcoming; drafts have none", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  assert.equal(eventPhase({ status: "completed", date: "2026-05-01" }, "2026-06-01", now), "results");
  assert.equal(eventPhase({ status: "race_day", date: "2026-06-01" }, "2026-06-01", now), "live");
  assert.equal(eventPhase({ status: "registration_closed", date: "2026-05-31", endDate: "2026-06-01" }, "2026-06-01", now), "live");
  assert.equal(eventPhase({ status: "registration_open", date: "2026-06-13" }, "2026-06-01", now), "register");
  assert.equal(eventPhase({ status: "registration_open", date: "2026-06-13", registrationClose: "2026-05-30T00:00:00Z" }, "2026-06-01", now), "closed");
  assert.equal(eventPhase({ status: "registration_closed", date: "2026-06-13" }, "2026-06-01", now), "closed");
  assert.equal(eventPhase({ status: "draft", date: "2026-06-13" }, "2026-06-01", now), null);
});

test("event dates read like the website's", () => {
  assert.equal(formatEventDates("2026-06-13"), "Sat, Jun 13, 2026");
  assert.equal(formatEventDates("2026-06-13", "2026-06-14"), "Jun 13–14, 2026");
  assert.equal(formatEventDates("2026-06-30", "2026-07-01"), "Jun 30 – Jul 1, 2026");
  assert.equal(formatEventDates("2026-12-31", "2027-01-01"), "Dec 31, 2026 – Jan 1, 2027");
  assert.equal(formatEventDates("2026-06-13T18:00:00.000Z"), "Sat, Jun 13, 2026");
  assert.equal(formatEventDates("garbage"), "");
});

test("place line skips blanks and repeats", () => {
  assert.equal(placeLine(event), "Pine Ridge Raceway, Boise, ID");
  assert.equal(placeLine({ trackName: "", location: "Boise, ID", state: "ID" }), "Boise, ID");
});

test("event meta per page and phase", () => {
  const results = eventMeta(event, "results", "results", ORIGIN, "/results/42");
  assert.equal(results.title, "Spring Classic MX Results");
  assert.match(results.description, /^Results from Spring Classic MX\. Jun 13–14, 2026 · Pine Ridge Raceway, Boise, ID\. Hosted by Gem State MX\.$/);
  assert.equal(results.image, `${ORIGIN}/api/public/og/event/42.png?v=results`);
  assert.equal(results.url, `${ORIGIN}/results/42`);

  assert.equal(eventMeta(event, "register", "register", ORIGIN, "/register/42").title, "Register: Spring Classic MX");
  assert.equal(eventMeta(event, "live", "watch", ORIGIN, "/watch/42").title, "Watch live: Spring Classic MX");
  const live = eventMeta(event, "live", "live", ORIGIN, "/live/7", { name: "250 B Moto 1", status: "in_progress" });
  assert.equal(live.title, "Live timing: 250 B Moto 1 · Spring Classic MX");
  assert.match(live.description, /^Live positions and lap times/);
  assert.equal(eventMeta(event, "results", "live", ORIGIN, "/live/7", { name: "Moto 1", status: "completed" }).title, "Results: Moto 1 · Spring Classic MX");
});

test("racer meta: number, class and stats; no personal details", () => {
  const m = racerMeta({ riderId: 9, name: "Sam Rider", number: "214", mainClass: "250 B", starts: 14, wins: 1, podiums: 0 }, ORIGIN);
  assert.equal(m.title, "Sam Rider #214");
  assert.equal(m.description, "250 B · 14 starts · 1 win. Race results, lap times and series standings on RM Roost.");
  assert.equal(m.image, `${ORIGIN}/api/public/og/racer/9.png?v=14`);
  assert.equal(m.type, "profile");
  assert.equal(racerStatLine({ starts: 1, wins: 0, podiums: 2 }), "1 start · 2 podiums");
});

test("text is cleaned and escaped; markup can't break out of the head", () => {
  assert.equal(cleanText("  a\n\tb\u0000c  "), "a b c");
  assert.equal(cleanText("x".repeat(50), 10), `${"x".repeat(9)}…`);
  assert.equal(escapeHtml(`"><script>alert('x')</script>&`), "&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;");
  const evil = { ...event, name: `</title><script>alert(1)</script>"` };
  const html = injectShareMeta(INDEX, eventMeta(evil, "results", "results", ORIGIN, "/results/42"));
  assert.ok(!html.includes("<script>alert"));
  assert.ok(!/content="[^"]*<\/title>/.test(html));
  assert.equal((html.match(/<title>/g) ?? []).length, 1);
  assert.equal(escapeXml(`<a & "b">`), "&lt;a &amp; &quot;b&quot;&gt;");
});

test("injectShareMeta replaces the preview tags once and keeps the rest", () => {
  const meta = eventMeta(event, "results", "results", ORIGIN, "/results/42");
  const html = injectShareMeta(INDEX, meta);
  assert.equal((html.match(/property="og:title"/g) ?? []).length, 1);
  assert.equal((html.match(/name="description"/g) ?? []).length, 1);
  assert.equal((html.match(/property="og:image"/g) ?? []).length, 1);
  assert.equal((html.match(/name="twitter:card"/g) ?? []).length, 1);
  assert.ok(html.includes("<title>Spring Classic MX Results · RM Roost</title>"));
  assert.ok(html.includes('<meta name="robots" content="index, follow" />'));
  assert.ok(html.includes('<link rel="icon" href="/favicon-32.png" />'));
  assert.ok(html.includes('content="https://www.rmroost.com/api/public/og/event/42.png?v=results"'));
  assert.ok(html.indexOf("og:title") < html.indexOf("</head>"));
});

test("generic meta is the site's own, with no page details", () => {
  const html = injectShareMeta(INDEX, genericMeta(ORIGIN, "/racer/5"));
  assert.ok(html.includes("<title>RM Roost</title>"));
  assert.ok(html.includes(`content="${ORIGIN}/brand/og-image.png"`));
  assert.ok(!html.includes("/api/public/og/racer/"));
});

test("site origin comes from APP_URL only", () => {
  assert.equal(siteOrigin("https://www.rmroost.com/"), "https://www.rmroost.com");
  assert.equal(siteOrigin("www.rmroost.com"), "https://www.rmroost.com");
  assert.equal(siteOrigin("javascript:alert(1)"), "https://www.rmroost.com");
  assert.equal(siteOrigin(undefined), "https://www.rmroost.com");
});

test("card text wraps to two lines and shrinks before it cuts", () => {
  const long = "THE GREAT NORTHWEST REGIONAL CHAMPIONSHIP SERIES FINALE AND AWARDS";
  const fit = fitText(long, [88, 78, 68, 60, 52], 860, 2, true);
  assert.ok(fit.lines.length <= 2);
  const cut = wrapLines("ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE TEN", 88, 400, 2, true);
  assert.equal(cut.length, 2);
  assert.ok(cut[1].endsWith("…"));
});

test("cards are 1200×630 SVG with escaped text", () => {
  const svg = eventCardSvg({ name: "A & B <MX>", phase: "live", dates: "Sat, Jun 13, 2026", place: "Track", club: "Club" }, null);
  assert.match(svg, /width="1200" height="630"/);
  assert.ok(svg.includes("A &amp; B &lt;MX&gt;"));
  assert.ok(svg.includes("LIVE NOW"));
  const racer = racerCardSvg({ name: "Sam Rider", number: "214", plateColor: "yellow", mainClass: "250 B", starts: 3, wins: 1, podiums: 2 }, null);
  assert.ok(racer.includes(">214<"));
  assert.ok(racer.includes("SAM RIDER"));
  assert.ok(racer.includes("PODIUMS"));
});

test("the event page in its live phase is titled Live now", () => {
  assert.equal(eventMeta(event, "live", "results", ORIGIN, "/results/42").title, "Live now: Spring Classic MX");
});

test("event phase follows a running moto, like the page", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  // A race running a day early still reads as live; a finished one doesn't.
  assert.equal(eventPhase({ status: "registration_closed", date: "2026-06-13", motos: [{ status: "in_progress" }] }, "2026-06-01", now), "live");
  assert.equal(eventPhase({ status: "registration_closed", date: "2026-06-13", motos: [{ status: "completed" }] }, "2026-06-01", now), "closed");
});

test("rider result meta: name, finish, class and event; unofficial until finalized", () => {
  const r = { riderId: 9, name: "Ryder Nash", number: "214", raceClass: "250 B", position: 1, official: false };
  const m = riderResultMeta({ ...event, name: "Fall Finale" }, r, ORIGIN);
  assert.equal(m.title, "Ryder Nash P1 · 250 B · Fall Finale");
  assert.match(m.description, /^Ryder Nash finished P1 in 250 B at Fall Finale\. Unofficial results\. Jun 13–14, 2026 · Pine Ridge Raceway, Boise, ID\.$/);
  assert.equal(m.image, `${ORIGIN}/api/public/og/result/42/9.png?v=P1-u`);
  assert.equal(m.url, `${ORIGIN}/results/42?rider=9`);
  assert.equal(riderResultPath(42, 9), "/results/42?rider=9");
  const official = riderResultMeta(event, { ...r, official: true }, ORIGIN);
  assert.ok(!official.description.includes("Unofficial"));
  assert.ok(official.image.endsWith("?v=P1-o"));
  assert.equal(resultLabel({ position: null, status: "dns" }), "DNS");
  assert.equal(resultLabel({ position: null }), "DNF");
  const dnf = riderResultMeta(event, { ...r, position: null, status: "dnf" }, ORIGIN);
  assert.equal(dnf.title, "Ryder Nash DNF · 250 B · Spring Classic MX");
  assert.match(dnf.description, /^Ryder Nash raced 250 B at Spring Classic MX\./);
});

test("result card: plate, position, class, name and the unofficial badge", () => {
  const input = {
    name: "Ryder Nash", number: "214", plateColor: "yellow", label: "P1", raceClass: "250 B",
    eventName: "Fall Finale & <Awards>", dates: "Sat, Jun 13, 2026", place: "Pine Ridge Raceway", official: false,
  };
  const svg = resultCardSvg(input, null);
  assert.match(svg, /width="1200" height="630"/);
  assert.ok(svg.includes(">214<"));
  assert.ok(svg.includes(">P1<"));
  assert.ok(svg.includes(">250 B<"));
  assert.ok(svg.includes("RYDER NASH"));
  assert.ok(svg.includes("Fall Finale &amp; &lt;Awards&gt;"));
  assert.ok(svg.includes("UNOFFICIAL"));
  assert.ok(!resultCardSvg({ ...input, official: true }, null).includes("UNOFFICIAL"));
  // No number: no plate, text moves left.
  assert.ok(!resultCardSvg({ ...input, number: null }, null).includes('rx="28"'));
});
