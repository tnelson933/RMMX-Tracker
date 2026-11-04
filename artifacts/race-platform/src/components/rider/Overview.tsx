/**
 * Top of the rider page on the website (matches the app's Home): the next
 * race as a photo card with a countdown, recent form as finish badges, and
 * one trend with a takeaway.
 */
import { countdownLabel, pickNextRace } from "@workspace/rider-insights/home";
import { finishTakeaway, paceTakeaway, recentRounds } from "@workspace/rider-insights/season";

import type { EventHistory, ScheduleEvent } from "@/lib/rider-api";
import { CHART, ChartCard, PhotoHero, PosBadge, TrendChart, eventImage } from "./insights";

const todayYmd = () => new Date().toLocaleDateString("en-CA");
const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function NextRaceHero({ events, onOpen, onFind }: {
  events: ScheduleEvent[];
  onOpen: (ev: ScheduleEvent) => void;
  onFind: () => void;
}) {
  const today = todayYmd();
  const upcoming = events.filter(e => e.status === "registration_open" || e.status === "race_day");
  const next = pickNextRace(upcoming, today);
  const label = next ? countdownLabel(next, today) : null;
  const live = label === "Racing today";
  const classes = next ? [...new Set(next.registrations.map(r => r.raceClass).filter((c): c is string => !!c))] : [];
  const date = next?.eventDate
    ? new Date(next.eventDate).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
    : null;
  const place = next ? [next.eventLocation, next.eventState].filter(Boolean).join(", ") : null;
  return (
    <button type="button" onClick={() => (next ? onOpen(next) : onFind())} className="block h-full w-full text-left">
      <PhotoHero src={eventImage(next?.eventImageUrl)} className="h-full min-h-[220px]">
        <div className="flex h-full min-h-[220px] flex-col justify-end gap-1 p-5 text-white">
          <div className="flex items-center gap-2 font-heading font-bold uppercase tracking-[1.2px] text-[13px] text-white/85">
            {live && <span className="inline-block h-2 w-2 rounded-full bg-[#22c55e]" />}
            {next ? `Next gate drop  ·  ${label}` : "No race booked"}
          </div>
          <div className="font-heading font-extrabold italic uppercase text-[30px] leading-[1.05]">{next ? next.eventName : "Find your next race"}</div>
          <div className="text-[14px] text-white/85">{next ? [date, place].filter(Boolean).join("  ·  ") : "Open races near you are one click away."}</div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {classes.slice(0, 3).map(c => (
                <span key={c} className="rounded-full border border-white/50 px-3 py-0.5 font-heading font-bold uppercase tracking-[0.8px] text-[12px]">{c}</span>
              ))}
            </div>
            <span className="rounded-full bg-[#B30000] px-5 py-2 font-heading font-bold uppercase tracking-[1px] text-[14px]">
              {next ? (live ? "Race day" : "Details") : "Find a race"}
            </span>
          </div>
        </div>
      </PhotoHero>
    </button>
  );
}

export function RecentForm({ history, onOpen }: { history: EventHistory[]; onOpen: (ev: EventHistory) => void }) {
  const recent = [...history].sort((a, b) => a.eventDate.localeCompare(b.eventDate)).slice(-5);
  if (recent.length === 0) return null;
  return (
    <div className="rounded-xl border border-[#E2E2E2] bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="font-heading font-bold text-[14px] uppercase tracking-[1px] text-[#707070]">Recent form</h4>
        <span className="text-[12px] text-[#707070]">Latest on the right</span>
      </div>
      <div className="flex gap-2">
        {recent.map(ev => (
          <button key={`${ev.eventId}-${ev.raceClass}`} type="button" onClick={() => onOpen(ev)}
            title={ev.eventName} aria-label={`${ev.eventName}: ${ev.bestPosition != null ? `best finish P${ev.bestPosition}` : "no finish"}`}
            className="flex flex-1 flex-col items-center gap-1 rounded-lg py-1 hover:bg-[#F7F7F7]">
            {ev.bestPosition != null ? <PosBadge position={ev.bestPosition} size="sm" /> : <span className="text-[13px] font-bold text-[#707070]">DNF</span>}
            <span className="text-[11px] text-[#707070]">{shortDate(ev.eventDate)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function FormTrend({ history }: { history: EventHistory[] }) {
  const rounds = recentRounds(history, 5);
  const xs = rounds.map(r => shortDate(r.eventDate));
  const pace = rounds.map(r => (r.pacePct == null ? null : Math.max(0, r.pacePct)));
  const paceVals = pace.filter((v): v is number => v != null);
  if (paceVals.length >= 2) {
    const last = paceVals[paceVals.length - 1];
    return (
      <ChartCard title="Pace vs the winner" takeaway={paceTakeaway(rounds, `in your last ${rounds.length} races`)}
        right={<span className="font-heading font-extrabold italic text-2xl text-[#242424]">{last.toFixed(1)}%</span>}>
        <TrendChart data={rounds.map((_, i) => ({ x: xs[i], you: pace[i] }))}
          series={[{ key: "you", name: "% off winner", color: CHART.you, dots: true, area: true }]}
          yMin={0} yMax={Math.max(1, ...paceVals) * 1.2} yFormat={v => `${Math.round(v * 10) / 10}%`} height={140}
          ariaLabel={`Percent off the winner's pace in your last races: ${paceVals.map(v => `${v.toFixed(1)}%`).join(", ")}.`} />
      </ChartCard>
    );
  }
  const fin = rounds.map(r => r.avgFinish);
  const finVals = fin.filter((v): v is number => v != null);
  if (finVals.length < 2) return null;
  const worst = Math.max(...finVals);
  return (
    <ChartCard title="Average moto finish" takeaway={finishTakeaway(rounds)}>
      <TrendChart data={rounds.map((_, i) => ({ x: xs[i], you: fin[i] }))}
        series={[{ key: "you", name: "Avg finish", color: CHART.you, dots: true }]}
        yMin={0.5} yMax={Math.max(worst + 0.5, 3.5)} invert band={[0.5, 3.5]} yFormat={v => `P${Math.round(v)}`} height={140}
        ariaLabel={`Average moto finish in your last races: ${finVals.map(v => `P${Math.round(v)}`).join(", ")}.`} />
    </ChartCard>
  );
}
