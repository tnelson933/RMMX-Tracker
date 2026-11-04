/**
 * Train › Track charts: this session's laps, and best and average lap per
 * session at this track over time. Each has one plain-language takeaway.
 */
import React from "react";

import { ChartCard, Legend, LineChart } from "@/components/charts";
import { useColors } from "@/hooks/useColors";
import { sessionSummary, sessionTakeaway, sessionTrend, trendTakeaway, type PracticeLap, type PracticeSession } from "@/lib/practice";
import { fmtLapShort, niceTicks } from "@/lib/raceReport";

export function SessionLapChart({ laps, raceStyle }: { laps: PracticeLap[]; raceStyle?: string | null }) {
  const colors = useColors();
  const sum = sessionSummary(laps, raceStyle);
  // Practice laps are all readable (empty ones were dropped), so indexes still line up.
  const counted = sum.laps.slice(sum.firstCounted).filter((v): v is number => v != null);
  if (counted.length < 2 || sum.bestIndex == null || sum.bestMs == null) return null;
  const lo = Math.min(...counted), hi = Math.max(...counted);
  const pad = Math.max(500, (hi - lo) * 0.15);
  return (
    <ChartCard
      title="This session"
      right={<Legend items={[{ label: "You", color: colors.chartYou }, { label: `Best ${fmtLapShort(sum.bestMs)}`, color: colors.chartBest }]} />}
      takeaway={sessionTakeaway(sum)}
    >
      <LineChart
        xLabels={sum.lapNumbers.slice(sum.firstCounted).map(n => `L${n}`)}
        series={[{ data: counted, color: colors.chartYou, dots: counted.length <= 20 }]}
        yMin={lo - pad} yMax={hi + pad} yTicks={niceTicks(lo - pad, hi + pad, 4)} yFormat={fmtLapShort}
        marks={[{ index: sum.bestIndex - sum.firstCounted, value: sum.bestMs, color: colors.chartBest }]}
        accessibilityLabel={`Lap times this session. Best ${fmtLapShort(sum.bestMs)} on lap ${sum.lapNumbers[sum.bestIndex]}.`}
      />
    </ChartCard>
  );
}

export function TrackProgressChart({ sessions, trackLabel }: { sessions: PracticeSession[]; trackLabel: string }) {
  const colors = useColors();
  const points = sessionTrend(sessions).filter(p => p.bestMs != null);
  if (points.length < 2) return null;
  const vals = points.flatMap(p => [p.bestMs!, p.avgMs ?? p.bestMs!]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max(500, (hi - lo) * 0.15);
  const best = Math.min(...points.map(p => p.bestMs!));
  const bestIdx = points.findIndex(p => p.bestMs === best);
  return (
    <ChartCard
      title={`Progress at ${trackLabel}`}
      right={<Legend items={[{ label: "Best", color: colors.chartYou }, { label: "Average", color: colors.chartField }]} />}
      takeaway={trendTakeaway(points, trackLabel)}
    >
      <LineChart
        xLabels={points.map((_, i) => `S${i + 1}`)}
        series={[
          { data: points.map(p => p.avgMs), color: colors.chartField, width: 2 },
          { data: points.map(p => p.bestMs), color: colors.chartYou, dots: true },
        ]}
        yMin={lo - pad} yMax={hi + pad} yTicks={niceTicks(lo - pad, hi + pad, 4)} yFormat={fmtLapShort}
        marks={[{ index: bestIdx, value: best, color: colors.chartBest }]}
        accessibilityLabel={`Best lap per session at ${trackLabel}: ${points.map(p => fmtLapShort(p.bestMs)).join(", ")}.`}
      />
    </ChartCard>
  );
}
