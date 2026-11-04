/**
 * Race Report for the rider website (matches the rider app): a photo header
 * with the finish and field size, moto chips, and per-moto charts (lap times,
 * position by lap, gap to the leader, sectors, teammates), each with one
 * takeaway from @workspace/rider-insights. The lap table stays one click away.
 */
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  fmtLapShort, fmtSecs, gapTakeaway, lapTakeaway, niceTicks, parseLap, positionTakeaway,
  sectorLosses, sectorTakeaway, summarizeLaps, teamTakeaway,
} from "@workspace/rider-insights/raceReport";

import type { EventHistory, MotoResult } from "@/lib/rider-api";
import { CHART, ChartCard, HBars, Legend, PhotoHero, PosBadge, TrendChart, eventImage } from "./insights";

function MotoCharts({ moto, raceStyle }: { moto: MotoResult; raceStyle?: string | null }) {
  const cards: ReactNode[] = [];

  const sum = summarizeLaps(moto.lapTimes ?? [], raceStyle === "motocross");
  const counted = sum.laps.slice(sum.firstCounted);
  const countedVals = counted.filter((v): v is number => v != null);
  if (countedVals.length >= 2 && sum.bestIndex != null && sum.bestMs != null) {
    const lo = Math.min(...countedVals), hi = Math.max(...countedVals);
    const pad = Math.max(500, (hi - lo) * 0.15);
    const data = counted.map((v, i) => ({ x: `L${i + sum.firstCounted + 1}`, you: v }));
    cards.push(
      <ChartCard key="laps" title="Lap times" takeaway={lapTakeaway(sum)}
        right={<Legend items={[{ label: "You", color: CHART.you }, { label: `Best ${fmtLapShort(sum.bestMs)}`, color: CHART.best }]} />}>
        <TrendChart data={data} series={[{ key: "you", name: "Lap", color: CHART.you, dots: true }]}
          yMin={lo - pad} yMax={hi + pad} yTicks={niceTicks(lo - pad, hi + pad, 4)} yFormat={fmtLapShort}
          mark={{ x: `L${sum.bestIndex + 1}`, y: sum.bestMs }}
          ariaLabel={`Lap times. Best ${fmtLapShort(sum.bestMs)} on lap ${sum.bestIndex + 1}.`} />
      </ChartCard>,
    );
  }

  const positions = moto.positionByLap ?? [];
  const posVals = positions.filter((p): p is number => p != null);
  if (posVals.length >= 2 && (moto.fieldSize ?? 0) > 1) {
    const worst = Math.max(...posVals);
    const ticks = worst >= 5 ? [1, Math.round((1 + worst) / 2), worst] : worst > 1 ? [1, worst] : [1];
    cards.push(
      <ChartCard key="pos" title="Position by lap" takeaway={positionTakeaway(positions)}
        right={<span className="text-[12px] text-[#707070]">{moto.fieldSize} riders</span>}>
        <TrendChart data={positions.map((p, i) => ({ x: `L${i + 1}`, you: p }))}
          series={[{ key: "you", name: "Position", color: CHART.you, dots: true }]}
          yMin={0.5} yMax={Math.max(worst + 0.5, 3.5)} yTicks={ticks} yFormat={v => `P${v}`} invert band={[0.5, 3.5]}
          ariaLabel={`Position at the end of each lap: ${posVals.map(p => `P${p}`).join(", ")}.`} />
      </ChartCard>,
    );
  }

  const gaps = (moto.lapGaps ?? []).map(g => g.leader);
  const gapVals = gaps.filter((g): g is number => g != null);
  if (gapVals.length >= 2) {
    const hi = Math.max(...gapVals, 1000) * 1.1;
    const final = gapVals[gapVals.length - 1];
    cards.push(
      <ChartCard key="gap" title="Gap to leader" takeaway={gapTakeaway(gaps)}
        right={<span className="text-[13px] font-bold tabular-nums">{final === 0 ? "Leader" : `+${fmtSecs(final)}`}</span>}>
        <TrendChart data={gaps.map((g, i) => ({ x: `L${i + 1}`, you: g }))}
          series={[{ key: "you", name: "Gap", color: CHART.you, area: true }]}
          yMin={0} yMax={hi} yTicks={niceTicks(0, hi, 3)} yFormat={v => (v === 0 ? "0" : `+${Math.round(v / 1000)}s`)}
          ariaLabel={`Gap to the leader after each lap, ending ${final === 0 ? "in the lead" : `${fmtSecs(final)} back`}.`} />
      </ChartCard>,
    );
  }

  const sectorRows = moto.sectors ? sectorLosses(moto.sectors.names, moto.sectors.bestMs, moto.sectors.fieldBestMs) : [];
  if (sectorRows.length > 0) {
    const worstLoss = Math.max(...sectorRows.map(r => r.lossMs));
    cards.push(
      <ChartCard key="sectors" title="Your best sectors vs the fastest" takeaway={sectorTakeaway(sectorRows)}>
        <HBars max={Math.max(worstLoss, 500)}
          rows={sectorRows.map(r => ({
            key: String(r.index), label: `S${r.index + 1} ${r.name}`, value: r.lossMs,
            valueLabel: r.lossMs < 50 ? "Fastest" : `+${(r.lossMs / 1000).toFixed(1)}s`,
            color: r.lossMs === worstLoss && worstLoss >= 100 ? CHART.you : CHART.field,
          }))}
          ariaLabel={`Seconds lost to the fastest split: ${sectorRows.map(r => `${r.name} ${(r.lossMs / 1000).toFixed(1)}`).join(", ")}.`} />
      </ChartCard>,
    );
  }

  const team = moto.team && moto.team.members.length > 1 ? moto.team : null;
  if (team) {
    const laps = team.members.map(m => m.lapTimes.map(parseLap));
    const all = laps.flat().filter((v): v is number => v != null);
    if (all.length >= 2) {
      const lo = Math.min(...all), hi = Math.max(...all);
      const pad = Math.max(500, (hi - lo) * 0.15);
      const longest = Math.max(...laps.map(l => l.length));
      const pal = [CHART.teammate, CHART.field];
      let other = 0;
      const series = team.members.map((m, i) => ({
        key: `m${i}`, name: m.isYou ? "You" : m.name.split(" ")[0], color: m.isYou ? CHART.you : pal[Math.min(other++, 1)], dots: true,
      }));
      const data = Array.from({ length: longest }, (_, k) => {
        const row: Record<string, string | number | null> = { x: `L${k + 1}` };
        laps.forEach((l, i) => { row[`m${i}`] = l[k] ?? null; });
        return row;
      });
      cards.push(
        <ChartCard key="team" title={team.name ? `Team ${team.name}` : "Your team"} takeaway={teamTakeaway(team.members)}
          right={<Legend items={series.map(s => ({ label: s.name, color: s.color }))} />}>
          <TrendChart data={data} series={series} yMin={lo - pad} yMax={hi + pad} yTicks={niceTicks(lo - pad, hi + pad, 4)} yFormat={fmtLapShort}
            ariaLabel={`Each team rider's lap times: ${team.members.map(m => `${m.isYou ? "you" : m.name} ${m.lapCount} laps`).join(", ")}.`} />
        </ChartCard>,
      );
    }
  }

  if (cards.length === 0) return null;
  return <div className="grid gap-3 md:grid-cols-2">{cards}</div>;
}

/** One event in Race History: photo header, moto chips, charts, and the lap table behind a toggle. */
export function RaceReportCard({ event, defaultOpen, renderMotoTable }: {
  event: EventHistory;
  defaultOpen?: boolean;
  renderMotoTable: (moto: MotoResult) => ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [motoIdx, setMotoIdx] = useState(0);
  const [showTable, setShowTable] = useState(false);
  const moto = event.motos[Math.min(motoIdx, event.motos.length - 1)];
  const bestMoto = event.motos.find(m => !m.dnf && !m.dns && m.position === event.bestPosition);
  const date = event.eventDate ? new Date(event.eventDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : null;
  const place = event.eventLocation ?? event.eventState;

  return (
    <div className="space-y-3">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="block w-full text-left">
        <PhotoHero src={eventImage(event.eventImageUrl)} className="min-h-[190px]">
          <div className="flex min-h-[190px] flex-col justify-end gap-1 p-5 text-white">
            <div className="font-heading font-bold text-[13px] uppercase tracking-[1.2px] text-white/85">
              {[date, event.raceClass, event.teamName ? `Team ${event.teamName}` : null].filter(Boolean).join("  ·  ")}
            </div>
            <div className="flex items-end gap-4">
              <h3 className="flex-1 font-heading font-extrabold italic uppercase text-[28px] leading-[1.05]">{event.eventName}</h3>
              <PosBadge position={event.bestPosition} size="lg" />
            </div>
            <div className="flex items-center justify-between gap-3 text-[14px] text-white/85">
              <span>
                {[event.bestPosition != null && bestMoto?.fieldSize ? `of ${bestMoto.fieldSize} riders` : null,
                  `${event.motos.length} ${event.motos.length === 1 ? "moto" : "motos"}`,
                  event.totalPoints ? `${event.totalPoints} pts` : null, place].filter(Boolean).join("  ·  ")}
              </span>
              <span className="inline-flex items-center gap-1 font-heading font-bold uppercase tracking-[1px] text-[13px]">
                {open ? "Hide report" : "Race report"} {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </span>
            </div>
          </div>
        </PhotoHero>
      </button>

      {open && moto && (
        <div className="space-y-3">
          {event.motos.length > 1 && (
            <div className="flex flex-wrap gap-2" role="tablist">
              {event.motos.map((m, i) => {
                const on = m === moto;
                const result = m.dnf ? "DNF" : m.dns ? "DNS" : m.position != null ? `P${m.position}` : "";
                return (
                  <button key={m.motoId} type="button" role="tab" aria-selected={on} onClick={() => setMotoIdx(i)}
                    className={`rounded-full border px-4 py-1.5 font-heading font-bold uppercase tracking-[0.8px] text-[14px] transition-colors ${on ? "bg-[#242424] text-white border-[#242424]" : "border-[#D0D0D0] text-[#242424] hover:bg-[#F2F2F2]"}`}>
                    {m.motoName}{result ? `  ·  ${result}` : ""}
                  </button>
                );
              })}
            </div>
          )}
          <MotoCharts moto={moto} raceStyle={event.raceStyle} />
          <div className="rounded-xl border border-[#E2E2E2] bg-white">
            <button type="button" onClick={() => setShowTable(s => !s)} aria-expanded={showTable}
              className="flex w-full items-center justify-between px-4 py-3 font-heading font-bold uppercase tracking-[1px] text-[14px] text-[#242424]">
              All laps and splits {showTable ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {showTable && <div className="border-t border-[#E2E2E2] p-3">{renderMotoTable(moto)}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
