/**
 * Practice charts on the rider website (matches the app's Train tab): this
 * session's laps, and best and average lap per session at a track.
 */
import { sessionSummary, sessionTakeaway, sessionTrend, trendTakeaway, type PracticeLap, type PracticeSession } from "@workspace/rider-insights/practice";
import { fmtLapShort, niceTicks } from "@workspace/rider-insights/raceReport";

import { CHART, ChartCard, Legend, TrendChart } from "./insights";

export function SessionLapChart({ laps, raceStyle }: { laps: PracticeLap[]; raceStyle?: string | null }) {
  const sum = sessionSummary(laps, raceStyle);
  const counted = sum.laps.slice(sum.firstCounted).filter((v): v is number => v != null);
  if (counted.length < 2 || sum.bestIndex == null || sum.bestMs == null) return null;
  const lo = Math.min(...counted), hi = Math.max(...counted);
  const pad = Math.max(500, (hi - lo) * 0.15);
  const labels = sum.lapNumbers.slice(sum.firstCounted).map(n => `L${n}`);
  return (
    <ChartCard title="This session" takeaway={sessionTakeaway(sum)}
      right={<Legend items={[{ label: "You", color: CHART.you }, { label: `Best ${fmtLapShort(sum.bestMs)}`, color: CHART.best }]} />}>
      <TrendChart data={counted.map((v, i) => ({ x: labels[i], you: v }))}
        series={[{ key: "you", name: "Lap", color: CHART.you, dots: counted.length <= 20 }]}
        yMin={lo - pad} yMax={hi + pad} yTicks={niceTicks(lo - pad, hi + pad, 4)} yFormat={fmtLapShort}
        mark={{ x: `L${sum.lapNumbers[sum.bestIndex]}`, y: sum.bestMs }}
        ariaLabel={`Lap times this session. Best ${fmtLapShort(sum.bestMs)} on lap ${sum.lapNumbers[sum.bestIndex]}.`} />
    </ChartCard>
  );
}

export function TrackProgressChart({ sessions, trackLabel }: { sessions: PracticeSession[]; trackLabel: string }) {
  const points = sessionTrend(sessions).filter(p => p.bestMs != null);
  if (points.length < 2) return null;
  const vals = points.flatMap(p => [p.bestMs!, p.avgMs ?? p.bestMs!]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max(500, (hi - lo) * 0.15);
  const best = Math.min(...points.map(p => p.bestMs!));
  const bestIdx = points.findIndex(p => p.bestMs === best);
  return (
    <ChartCard title={`Progress at ${trackLabel}`} takeaway={trendTakeaway(points, trackLabel)}
      right={<Legend items={[{ label: "Best", color: CHART.you }, { label: "Average", color: CHART.field }]} />}>
      <TrendChart data={points.map((p, i) => ({ x: `S${i + 1}`, best: p.bestMs, avg: p.avgMs, session: p.label }))}
        series={[{ key: "avg", name: "Average", color: CHART.field, width: 2 }, { key: "best", name: "Best", color: CHART.you, dots: true }]}
        yMin={lo - pad} yMax={hi + pad} yTicks={niceTicks(lo - pad, hi + pad, 4)} yFormat={fmtLapShort}
        mark={{ x: `S${bestIdx + 1}`, y: best }}
        ariaLabel={`Best lap per session at ${trackLabel}: ${points.map(p => fmtLapShort(p.bestMs)).join(", ")}.`} />
    </ChartCard>
  );
}
