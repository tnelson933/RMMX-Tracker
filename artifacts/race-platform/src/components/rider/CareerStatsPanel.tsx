/**
 * Stats tab on the rider website (matches the app's Career stats): how motos
 * finish, after lap 1 vs the finish, and laps led, each with a takeaway.
 */
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ChevronRight } from "lucide-react";
import { finishSpread, lapsLedTakeaway, spreadTakeaway, startTakeaway } from "@workspace/rider-insights/career";
import { fmtLapShort } from "@workspace/rider-insights/raceReport";

import { riderApi } from "@/lib/rider-api";
import { CHART, ChartCard, HBars } from "./insights";

const SEG_COLOR: Record<string, string> = { wins: CHART.best, podiums: CHART.you, top5: CHART.teammate, rest: CHART.field, dnf: "#C62828" };

export function CareerStatsPanel({ riderId }: { riderId: number }) {
  const { data, isLoading, error } = useQuery({ queryKey: ["rider-career", riderId], queryFn: () => riderApi.careerStats(riderId) });
  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-muted" />;
  if (error) return <p className="text-sm text-destructive">{(error as Error).message}</p>;
  const stats = data?.stats;
  if (!stats || stats.starts === 0) {
    return <div className="rounded-xl border border-[#E2E2E2] bg-white p-10 text-center text-sm text-[#707070]">No races yet. Stats appear after your first timed moto.</div>;
  }
  const spread = finishSpread(stats);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-heading font-extrabold italic uppercase text-[22px] text-[#242424]">Career stats</h3>
        <Link href={`/rider/racer/${riderId}`} className="inline-flex items-center gap-1 text-[15px] font-semibold text-[#B30000] hover:underline">
          Racer profile <ChevronRight size={16} />
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { v: String(stats.starts), l: "Motos" },
          { v: String(stats.totalLaps), l: "Laps" },
          { v: stats.avgFinish != null ? `P${Math.round(stats.avgFinish)}` : "—", l: "Avg finish" },
          { v: stats.bestLap ? fmtLapShort(stats.bestLap.ms) : "—", l: "Best lap" },
        ].map(t => (
          <div key={t.l} className="rounded-xl border border-[#E2E2E2] bg-white py-3 text-center">
            <div className="font-heading font-extrabold italic text-3xl text-[#242424]">{t.v}</div>
            <div className="font-heading font-bold uppercase tracking-[1px] text-[12px] text-[#707070]">{t.l}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <ChartCard title="How your motos finish" takeaway={spreadTakeaway(stats)}>
          <div role="img" aria-label={spread.map(x => `${x.label} ${x.count}`).join(", ")} className="flex h-5 overflow-hidden rounded bg-[#EFEFEF]">
            {spread.filter(x => x.count > 0).map(x => <div key={x.key} style={{ flex: x.count, background: SEG_COLOR[x.key] }} />)}
          </div>
          <div className="flex flex-wrap gap-3 text-[13px] text-[#242424]">
            {spread.map(x => (
              <span key={x.key} className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: SEG_COLOR[x.key] }} />
                {x.label} <b>{x.count}</b>
              </span>
            ))}
          </div>
        </ChartCard>
        {stats.avgLap1Position != null && stats.avgFinish != null && (
          <ChartCard title="After lap 1 vs the finish" takeaway={startTakeaway(stats)}>
            <div className="flex items-center justify-around py-2"
              aria-label={`Average position after lap 1 P${stats.avgLap1Position}, average finish P${stats.avgFinish}.`}>
              <div className="text-center">
                <div className="font-heading font-extrabold italic text-4xl text-[#242424]">P{stats.avgLap1Position.toFixed(1)}</div>
                <div className="font-heading font-bold uppercase tracking-[1px] text-[12px] text-[#707070]">After lap 1</div>
              </div>
              <ArrowRight className="text-[#707070]" />
              <div className="text-center">
                <div className="font-heading font-extrabold italic text-4xl text-[#242424]">P{stats.avgFinish.toFixed(1)}</div>
                <div className="font-heading font-bold uppercase tracking-[1px] text-[12px] text-[#707070]">Finish</div>
              </div>
            </div>
          </ChartCard>
        )}
        <ChartCard title="Laps led" takeaway={lapsLedTakeaway(stats)}>
          <HBars max={100}
            rows={[
              { key: "led", label: "Laps led", value: (stats.lapsLed / Math.max(1, stats.totalLaps)) * 100, valueLabel: `${stats.lapsLed}/${stats.totalLaps}`, color: CHART.best },
              { key: "lap1", label: "Led lap 1", value: (stats.lap1Leads / Math.max(1, stats.starts)) * 100, valueLabel: `${stats.lap1Leads}/${stats.starts}`, color: CHART.you },
            ]}
            ariaLabel={`Led ${stats.lapsLed} of ${stats.totalLaps} laps. Led lap 1 in ${stats.lap1Leads} of ${stats.starts} motos.`} />
        </ChartCard>
      </div>
      <p className="text-[12px] text-[#707070]">From lap-by-lap timing, so laps led and lap-1 positions only count races with recorded laps.</p>
    </div>
  );
}
