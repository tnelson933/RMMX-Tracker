/**
 * Season tab on the rider website (matches the app's My Races › Season):
 * average moto finish, points by race with the series position, % off the
 * winner's pace and lap spread, each with a takeaway.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { niceTicks } from "@workspace/rider-insights/raceReport";
import {
  finishTakeaway, ordinal, paceTakeaway, pointsTakeaway, seasonClasses, seasonRounds, seasonYears, spreadTakeaway,
} from "@workspace/rider-insights/season";

import { riderApi, type EventHistory } from "@/lib/rider-api";
import { CHART, ChartCard, Columns, Legend, PhotoHero, PosBadge, TrendChart } from "./insights";

function Chips({ items, selected, onSelect }: { items: string[]; selected: string; onSelect: (v: string) => void }) {
  if (items.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(it => (
        <button key={it} type="button" onClick={() => onSelect(it)} aria-pressed={it === selected}
          className={`rounded-full border px-4 py-1.5 font-heading font-bold uppercase tracking-[0.8px] text-[14px] ${it === selected ? "bg-[#242424] text-white border-[#242424]" : "border-[#D0D0D0] text-[#242424] hover:bg-[#F2F2F2]"}`}>
          {it}
        </button>
      ))}
    </div>
  );
}

export function SeasonPanel({ riderId, history, onOpenEvent }: {
  riderId: number;
  history: EventHistory[];
  onOpenEvent: (ev: EventHistory) => void;
}) {
  const years = useMemo(() => seasonYears(history), [history]);
  const [year, setYear] = useState(years[0] ?? "");
  const activeYear = years.includes(year) ? year : years[0] ?? "";
  const classes = useMemo(() => seasonClasses(history, activeYear), [history, activeYear]);
  const [raceClass, setRaceClass] = useState(classes[0] ?? "");
  const activeClass = classes.includes(raceClass) ? raceClass : classes[0] ?? "";
  const rounds = useMemo(() => seasonRounds(history, activeYear, activeClass), [history, activeYear, activeClass]);
  const roundEvents = history.filter(e => e.eventDate.startsWith(activeYear) && e.raceClass === activeClass);

  const { data: series = [] } = useQuery({ queryKey: ["rider-series", riderId], queryFn: () => riderApi.series(riderId), enabled: !!riderId });
  const ids = new Set(rounds.map(r => r.eventId));
  const seasonSeries = series
    .filter(s => s.raceClass === activeClass && ((s.eventIds ?? []).some(id => ids.has(id)) || String(s.season ?? "") === activeYear))
    .sort((a, b) => a.position - b.position)[0] ?? null;

  if (rounds.length === 0) {
    return <div className="rounded-xl border border-[#E2E2E2] bg-white p-10 text-center text-sm text-[#707070]">Race once and your finishes, points and pace trends show up here.</div>;
  }

  const xs = rounds.map((_, i) => `R${i + 1}`);
  const podiums = roundEvents.filter(e => e.bestPosition != null && e.bestPosition <= 3).length;
  const totalPoints = rounds.reduce((a, r) => a + r.points, 0);
  const finVals = rounds.map(r => r.avgFinish).filter((v): v is number => v != null);
  const worst = finVals.length ? Math.max(...finVals) : 3;
  const bestFin = finVals.length ? Math.min(...finVals) : null;
  const paceVals = rounds.map(r => r.pacePct).filter((v): v is number => v != null);
  const paceMax = Math.max(1, ...paceVals) * 1.15;
  const spreadVals = rounds.map(r => r.spreadMs).filter((v): v is number => v != null);

  return (
    <div className="space-y-4">
      <PhotoHero className="min-h-[150px]">
        <div className="flex min-h-[150px] flex-col justify-end p-5 text-white">
          <div className="font-heading font-bold text-[13px] uppercase tracking-[1.2px] text-white/85">{activeClass}</div>
          <div className="font-heading font-extrabold italic uppercase text-[32px] leading-none">{activeYear} season</div>
        </div>
      </PhotoHero>
      <Chips items={years} selected={activeYear} onSelect={setYear} />
      <Chips items={classes} selected={activeClass} onSelect={setRaceClass} />

      <div className="grid grid-cols-3 gap-3">
        {[
          { v: rounds.length, l: rounds.length === 1 ? "Race" : "Races" },
          { v: podiums, l: podiums === 1 ? "Podium" : "Podiums" },
          { v: totalPoints, l: "Points" },
        ].map(t => (
          <div key={t.l} className="rounded-xl border border-[#E2E2E2] bg-white py-3 text-center">
            <div className="font-heading font-extrabold italic text-3xl text-[#242424]">{t.v}</div>
            <div className="font-heading font-bold uppercase tracking-[1px] text-[12px] text-[#707070]">{t.l}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {finVals.length > 0 && (
          <ChartCard title="Average moto finish" takeaway={finishTakeaway(rounds)} right={<Legend items={[{ label: "Podium", color: CHART.best }]} />}>
            <TrendChart
              data={rounds.map((r, i) => ({ x: xs[i], you: r.avgFinish, name: r.eventName }))}
              series={[{ key: "you", name: "Avg finish", color: CHART.you, dots: true }]}
              yMin={0.5} yMax={Math.max(worst + 0.5, 3.5)} invert band={[0.5, 3.5]}
              yTicks={worst >= 5 ? [1, Math.round((1 + worst) / 2), Math.ceil(worst)] : worst > 1 ? [1, Math.ceil(worst)] : [1]}
              yFormat={v => `P${Math.round(v * 10) / 10}`}
              mark={bestFin != null ? { x: xs[rounds.findIndex(r => r.avgFinish === bestFin)], y: bestFin } : undefined}
              ariaLabel={`Average moto finish by race: ${rounds.map(r => (r.avgFinish == null ? "no finish" : `P${Math.round(r.avgFinish)}`)).join(", ")}.`} />
          </ChartCard>
        )}
        <ChartCard title="Points by race" takeaway={pointsTakeaway(rounds, seasonSeries)}
          right={seasonSeries ? <span className="inline-flex items-center gap-2 text-[12px] text-[#707070]">{ordinal(seasonSeries.position)} in series <PosBadge position={seasonSeries.position} size="sm" /></span> : null}>
          <Columns columns={rounds.map((r, i) => ({ key: String(r.eventId), label: xs[i], value: r.points, valueLabel: String(r.points), highlight: i === rounds.length - 1 }))}
            ariaLabel={`Points by race: ${rounds.map(r => `${r.eventName} ${r.points}`).join(", ")}.`} />
        </ChartCard>
        {paceVals.length > 0 && (
          <ChartCard title="% off the winner's pace" takeaway={paceTakeaway(rounds)}>
            <TrendChart data={rounds.map((r, i) => ({ x: xs[i], you: r.pacePct == null ? null : Math.max(0, r.pacePct) }))}
              series={[{ key: "you", name: "% off winner", color: CHART.you, dots: true, area: true }]}
              yMin={0} yMax={paceMax} yTicks={niceTicks(0, paceMax, 3)} yFormat={v => `${Math.round(v * 10) / 10}%`}
              ariaLabel={`Percent slower than the winner's average lap: ${rounds.map(r => (r.pacePct == null ? "no data" : `${r.pacePct}%`)).join(", ")}.`} />
          </ChartCard>
        )}
        {spreadVals.length > 0 && (
          <ChartCard title="Lap spread (lower is steadier)" takeaway={spreadTakeaway(rounds)}>
            <Columns columns={rounds.map((r, i) => ({ key: String(r.eventId), label: xs[i], value: r.spreadMs ?? 0, valueLabel: r.spreadMs == null ? "—" : `${(r.spreadMs / 1000).toFixed(1)}s`, highlight: i === rounds.length - 1 }))}
              ariaLabel={`Gap between fastest and slowest lap by race: ${rounds.map(r => (r.spreadMs == null ? "no data" : `${(r.spreadMs / 1000).toFixed(1)} seconds`)).join(", ")}.`} />
          </ChartCard>
        )}
      </div>

      <div className="divide-y divide-[#E2E2E2] rounded-xl border border-[#E2E2E2] bg-white">
        {rounds.map((r, i) => {
          const ev = roundEvents.find(e => e.eventId === r.eventId);
          return (
            <button key={r.eventId} type="button" onClick={() => ev && onOpenEvent(ev)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[#F7F7F7]">
              <span className="w-8 font-heading font-bold text-[#707070]">{xs[i]}</span>
              <span className="flex-1 truncate text-[15px] text-[#242424]">{r.eventName}</span>
              <PosBadge position={ev?.bestPosition} size="sm" />
              <span className="w-16 text-right text-[13px] text-[#707070]">{r.points} pts</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
