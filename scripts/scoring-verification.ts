/**
 * Builds a document for checking RM Roost's scoring by hand: sample races run
 * through the same scoring code the API uses (moto points → event overall →
 * series standings), for each scoring type. No database, no network.
 *
 *   cd scripts && ./node_modules/.bin/tsx scoring-verification.ts [output.html]
 */
import { writeFileSync } from "node:fs";
import { scoreMotoRows, type MotoScoringSettings } from "../artifacts/api-server/src/lib/motoPoints";
import { AMA_POINTS, compareOverall, olympicPenalty, overallPositions } from "../artifacts/api-server/src/lib/overallOrder";
import { buildSeriesStandings, type SeriesMotoRow, type SeriesResultRow } from "../artifacts/api-server/src/lib/seriesStandingsCore";
import { buildEventOverall } from "../lib/api-zod/src/eventOverall";

const rules = { compareOverall, overallPositions, olympicPenalty };

const RIDERS: Record<number, string> = {
  1: "Alex Reed (#11)", 2: "Blake Stone (#22)", 3: "Casey Hill (#33)", 4: "Drew Lane (#44)",
  5: "Eli Marsh (#55)", 6: "Finn Cole (#66)", 7: "Gray Wolfe (#77)", 8: "Hank Price (#88)",
};

type Entry = number | [number, "dnf" | "dns"] | [number, number];
interface MotoDef { name: string; type: string; raceClass: string; order: Entry[] }
interface RoundDef { name: string; date: string; motos: MotoDef[] }
interface Scenario { title: string; rules: string[]; settings: MotoScoringSettings; rounds: RoundDef[]; leaderLaps?: number }

type Row = SeriesResultRow & { id: number; lapTimes: number[]; bibNumber: string | null; auto?: boolean };
let nextId = 1;
let nextMoto = 1;

const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ord = (n: number) => `${n}${["th", "st", "nd", "rd"][n % 100 > 10 && n % 100 < 14 ? 0 : Math.min(n % 10, 4) % 4] ?? "th"}`;

function runMoto(def: MotoDef, settings: MotoScoringSettings, leaderLaps: number): { motoId: number; rows: Row[] } {
  const motoId = nextMoto++;
  const rows: Row[] = def.order.map((entry, i) => {
    const [riderId, flag] = Array.isArray(entry) ? entry : [entry, undefined];
    const laps = typeof flag === "number" ? flag : flag === "dns" ? 0 : flag === "dnf" ? Math.max(1, leaderLaps - 3) : leaderLaps;
    return {
      id: nextId++, motoId, riderId, raceClass: def.raceClass, position: i + 1, points: null,
      dnf: flag === "dnf", dns: flag === "dns", lapTimes: Array.from({ length: laps }, () => 60_000),
      bibNumber: null, firstName: RIDERS[riderId], lastName: "",
    };
  });
  const scored = scoreMotoRows(rows, settings, def.type);
  for (const r of rows) r.points = scored.get(r.id)!;
  return { motoId, rows };
}

function motoTable(def: MotoDef, rows: Row[], settings: MotoScoringSettings): string {
  const starters = rows.filter(r => !r.dns).length;
  const body = rows.map(r => {
    const status = r.dns ? "DNS (did not start)" : r.dnf ? "DNF (did not finish)" : "Finished";
    return `<tr><td class="n">${r.dns || r.dnf ? "–" : r.position}</td><td>${esc(RIDERS[r.riderId])}</td><td>${status}</td><td class="n">${r.lapTimes.length}</td><td class="n b">${r.points}</td></tr>`;
  }).join("");
  const note = settings.scoringMethod === "per_rider" ? ` <span class="muted">(${starters} starters, so 1st = ${starters})</span>` : "";
  return `<div class="moto"><h5>${esc(def.name)} <span class="muted">· ${esc(def.raceClass)}${def.type === "main" ? " · main event" : def.type === "heat" && settings.mainEventOnly ? " · heat (doesn't score)" : ""}</span>${note}</h5>
<table><thead><tr><th class="n">Pos</th><th>Rider</th><th>Result</th><th class="n">Laps</th><th class="n">Points</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderScenario(sc: Scenario): string {
  const lower = sc.settings.scoringMethod === "lowest_positions";
  const seriesMotos: SeriesMotoRow[] = [];
  const seriesResults: SeriesResultRow[] = [];
  let html = `<section><h2>${esc(sc.title)}</h2><ul class="rules">${sc.rules.map(r => `<li>${r}</li>`).join("")}</ul>`;

  sc.rounds.forEach((round, ri) => {
    const eventId = ri + 1;
    const ran = round.motos.map((def, mi) => {
      const m = runMoto(def, sc.settings, sc.leaderLaps ?? 6);
      seriesMotos.push({ id: m.motoId, eventId, type: def.type, raceClass: def.raceClass, motoNumber: mi + 1, resultsFinalizedAt: new Date() });
      seriesResults.push(...m.rows);
      return { def, ...m };
    });
    html += `<h3>${esc(round.name)} <span class="muted">· ${esc(round.date)}</span></h3><div class="motos">${ran.map(m => motoTable(m.def, m.rows, sc.settings)).join("")}</div>`;

    const overall = buildEventOverall(ran.map(m => m.motoId), ran.flatMap(m => m.rows), lower, rules);
    for (const cls of overall.classes) {
      const classMotos = ran.filter(m => m.def.raceClass === cls.raceClass);
      const head = classMotos.map(m => `<th class="n">${esc(m.def.name)}</th>`).join("");
      const body = cls.riders.map(r => {
        const cells = classMotos.map(m => {
          const row = m.rows.find(x => x.riderId === r.riderId);
          if (!row) return `<td class="n muted">${lower ? `missed (${olympicPenalty("dns", m.rows.length)})` : "missed (0)"}</td>`;
          const tag = row.dns ? "DNS" : row.dnf ? "DNF" : ord(row.position);
          return `<td class="n">${tag} <span class="muted">(${row.points})</span></td>`;
        }).join("");
        return `<tr><td class="n b">${r.position}</td><td>${esc(r.riderName)}</td>${cells}<td class="n b">${r.totalPoints}</td></tr>`;
      }).join("");
      html += `<h4>${esc(round.name)} overall · ${esc(cls.raceClass)}</h4>
<table><thead><tr><th class="n">Overall</th><th>Rider</th>${head}<th class="n">${lower ? "Score (lowest wins)" : "Total points"}</th></tr></thead><tbody>${body}</tbody></table>`;
    }
  });

  if (sc.rounds.length > 1) {
    const eventIds = sc.rounds.map((_, i) => i + 1);
    const standings = buildSeriesStandings({
      eventIds,
      eventNames: new Map(sc.rounds.map((r, i) => [i + 1, r.name])),
      eligibleClasses: new Map(eventIds.map(id => [id, null])),
      motos: seriesMotos,
      results: seriesResults,
      scoring: sc.settings,
    });
    for (const raceClass of [...new Set(standings.map(s => s.raceClass))]) {
      const rows = standings.filter(s => s.raceClass === raceClass);
      const head = sc.rounds.map(r => `<th class="n">${esc(r.name)}</th>`).join("");
      const body = rows.map(s => {
        const cells = s.events.map(e => `<td class="n">${e.attended ? e.eventScore : `<span class="muted">${lower ? `away (${e.eventScore})` : "away (0)"}</span>`} <span class="muted">[${e.finishPositions.map(p => p ?? "–").join(", ")}]</span></td>`).join("");
        const finishes = s.events.flatMap(e => e.finishPositions).filter((p): p is number => p != null);
        const count = (n: number) => finishes.filter(p => p === n).length;
        return `<tr><td class="n b">${s.position}</td><td>${esc(s.riderName)}</td>${cells}<td class="n b">${s.totalScore}</td><td class="n">${count(1)} / ${count(2)} / ${count(3)}</td><td class="n">${s.eventsEntered}</td></tr>`;
      }).join("");
      html += `<h3 class="series">Series standings · ${esc(raceClass)}</h3>
<table class="seriesT"><thead><tr><th class="n">Place</th><th>Rider</th>${head}<th class="n">${lower ? "Series score (lowest wins)" : "Series points"}</th><th class="n">Wins / 2nds / 3rds</th><th class="n">Rounds raced</th></tr></thead><tbody>${body}</tbody></table>
<p class="muted">Each round shows the round total and, in brackets, the rider's finish in each moto (– = DNF, DNS or missed).</p>`;
    }
  }
  return html + "</section>";
}

// ── The sample season (same finishing orders for every scoring type) ─────────
const heat = (name: string, raceClass: string, order: Entry[]): MotoDef => ({ name, type: "heat", raceClass, order });
const season: RoundDef[] = [
  { name: "Round 1", date: "May 2", motos: [
    heat("Moto 1", "250 B", [1, 2, 3, 4, 5, 6]),
    heat("Moto 2", "250 B", [2, 1, 3, 5, 4, [6, "dnf"]]),
    heat("Vet Moto 1", "Vet 30+", [7, 8, 3]),
    heat("Vet Moto 2", "Vet 30+", [8, 7, 3]),
  ] },
  { name: "Round 2", date: "June 20", motos: [
    heat("Moto 1", "250 B", [2, 1, 4, 3, [5, "dnf"], [6, "dns"]]),
    heat("Moto 2", "250 B", [1, 2, 3, 4, 6]),            // Eli misses moto 2
    heat("Vet Moto 1", "Vet 30+", [7, 8, 3]),
    heat("Vet Moto 2", "Vet 30+", [8, 7, 3]),
  ] },
  { name: "Round 3", date: "July 18", motos: [
    heat("Moto 1", "250 B", [3, 1, 2, 4, 6]),            // Eli misses the round
    heat("Moto 2", "250 B", [2, 1, 3, 6, 4]),
    heat("Vet Moto 1", "Vet 30+", [8, 7, 3]),
    heat("Vet Moto 2", "Vet 30+", [7, 8, 3]),
  ] },
];
const whatToLookFor = `<li><b>Things built into this season to check:</b> Finn DNFs Round 1 Moto 2 and is a DNS in Round 2 Moto 1; Eli DNFs Round 2 Moto 1, misses Round 2 Moto 2 and misses Round 3 entirely; Casey Hill rides two classes (250 B and Vet 30+) and is scored separately in each; Gray and Hank tie on points in Vet 30+ at every round and for the series.</li>`;

const scenarios: Scenario[] = [
  {
    title: "1. Highest Points wins (AMA scale)",
    settings: { scoringMethod: "highest_points", pointsScale: AMA_POINTS, scoringFormula: null, mainEventOnly: false },
    rules: [
      "Each moto: 1st = 25, 2nd = 22, 3rd = 20, 4th = 18, 5th = 17, 6th = 16, then one less per place. DNF and DNS score 0. A missed moto scores 0.",
      "Round overall: add the motos; highest total wins. A tie goes to the better finish in the <b>last moto</b>.",
      "Series: add every moto of every round. A tie goes to the most moto wins, then most 2nds, 3rds…, then the final moto of the last round.",
      whatToLookFor,
    ],
    rounds: season,
  },
  {
    title: "2. Olympic (Lowest Positions wins)",
    settings: { scoringMethod: "lowest_positions", pointsScale: [], scoringFormula: null, mainEventOnly: false },
    rules: [
      "Each moto scores the finishing position: 1st = 1, 2nd = 2… <b>Lowest total wins.</b>",
      "DNF scores the number of riders in the moto, never less than 20. DNS, or a moto the rider missed, scores riders + 30.",
      "A tie goes to the better finish in the last moto. A rider who finished no moto is placed after everyone who did.",
      whatToLookFor,
    ],
    rounds: season,
  },
  {
    title: "3. Per Rider (points scale with turnout)",
    settings: { scoringMethod: "per_rider", pointsScale: [], scoringFormula: null, mainEventOnly: false },
    rules: [
      "1st earns as many points as there were starters in that moto, 2nd one less, and so on (a DNS doesn't count as a starter). DNF and DNS score 0.",
      "Round overall and series: highest total wins, with the same tie-breaks as Highest Points.",
      whatToLookFor,
    ],
    rounds: season,
  },
  {
    title: "4. Supercross format (Main Event Only)",
    settings: { scoringMethod: "highest_points", pointsScale: AMA_POINTS, scoringFormula: null, mainEventOnly: true },
    rules: [
      "Heats decide who goes to the main and score no points. Only the main event scores (AMA scale).",
      "Before the main is run the overall has no points and is listed by best heat finish.",
    ],
    rounds: [{ name: "Supercross night", date: "Aug 8", motos: [
      { name: "Heat 1", type: "heat", raceClass: "450", order: [1, 3, 5] },
      { name: "Heat 2", type: "heat", raceClass: "450", order: [2, 4, 6] },
      { name: "Main Event", type: "main", raceClass: "450", order: [2, 1, 4, 3, [5, "dnf"]] },
    ] }],
  },
  {
    title: "5. Auto DNF (club setting, 75% of the leader's laps)",
    settings: { scoringMethod: "highest_points", pointsScale: AMA_POINTS, scoringFormula: null, mainEventOnly: false, autoDnfEnabled: true, autoDnfThreshold: 75 },
    rules: [
      "The winner ran 8 laps, so a rider needs at least 6 laps (75% of 8) to score. A rider with fewer keeps their finishing position but scores 0.",
    ],
    leaderLaps: 8,
    rounds: [{ name: "Auto DNF race", date: "Aug 22", motos: [
      { name: "Moto 1", type: "heat", raceClass: "Open", order: [[1, 8], [2, 8], [3, 7], [4, 6], [5, 5], [6, 3]] },
    ] }],
  },
];

const body = scenarios.map(renderScenario).join("\n");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>RM Roost scoring verification</title>
<style>
  body { font: 14px/1.45 Roboto, Arial, sans-serif; color: #242424; background: #fff; margin: 0 auto; max-width: 1100px; padding: 24px 16px 60px; }
  h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 20px; margin: 44px 0 8px; padding: 8px 12px; background: #242424; color: #fff; border-left: 6px solid #B30000; }
  h3 { font-size: 16px; margin: 26px 0 8px; border-bottom: 2px solid #242424; padding-bottom: 3px; } h3.series { border-color: #B30000; }
  h4 { font-size: 14px; margin: 14px 0 6px; } h5 { font-size: 13px; margin: 0 0 4px; }
  .muted { color: #6b6b6b; font-weight: 400; } .b { font-weight: 700; } .n { text-align: center; white-space: nowrap; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 6px; } th, td { border: 1px solid #cfcfcf; padding: 4px 8px; text-align: left; }
  th { background: #f1f1f1; font-size: 12px; } table.seriesT th { background: #f6e1e1; }
  .motos { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 12px; }
  .rules { margin: 6px 0 0; padding-left: 20px; } .rules li { margin-bottom: 3px; }
  .intro { background: #f6f6f6; border: 1px solid #ddd; padding: 10px 14px; margin: 12px 0; }
  @media print { h2 { break-before: page; } .moto, table { break-inside: avoid; } }
</style></head><body>
<h1>RM Roost scoring verification</h1>
<p class="muted">Generated ${new Date().toISOString().slice(0, 10)} by running sample races through the same scoring code the website uses (moto points → round overall → series standings). Riders are made up.</p>
<div class="intro"><b>How to use this:</b> every race lists who finished where and the points the software gave. Check a few by hand against the rules at the top of each section, add up a round, then add up the series. Sections 1–3 use the <i>same</i> season of races scored three different ways, so you can compare the scoring types side by side. Sections 4 and 5 check the Supercross format and Auto DNF.</div>
${body}
</body></html>`;

const out = process.argv[2] ?? "scoring-verification.html";
writeFileSync(out, html, "utf8");
console.log(`wrote ${out} (${html.length} bytes)`);
