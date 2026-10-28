import { Timer } from "lucide-react";

// Sector times for a moto whose course map has split readers. Rows come from
// the leaderboard snapshot (each entry carries `sectors`); renders nothing for
// motos without splits.

export interface SectorEntry {
  riderId: number | null;
  riderName: string;
  bibNumber?: string | null;
  position?: number | null;
  sectors?: {
    lastLapMs: Array<number | null> | null;
    bestMs: Array<number | null> | null;
    currentLapMs: Array<number | null> | null;
  };
}

function fmt(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const s = ms / 1000;
  return s >= 60 ? `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}` : s.toFixed(2);
}

export function SectorTimes({
  sectorNames,
  entries,
  view = "best",
  highlightRiderIds,
  title = "Sector times",
  tone = "card",
}: {
  sectorNames: string[] | null | undefined;
  entries: SectorEntry[];
  /** "best": each rider's best per sector. "last": their last completed lap. */
  view?: "best" | "last";
  highlightRiderIds?: number[];
  title?: string;
  /** "dark" for the black live-timing screens. */
  tone?: "card" | "dark";
}) {
  if (!sectorNames?.length) return null;
  const rows = entries.filter(e => e.sectors);
  if (!rows.length) return null;
  const pick = (e: SectorEntry) => (view === "best" ? e.sectors?.bestMs : e.sectors?.lastLapMs) ?? [];
  // Fastest time in each sector across the field, shown in bold.
  const fastest = sectorNames.map((_, i) => {
    const values = rows.map(e => pick(e)[i]).filter((v): v is number => v != null);
    return values.length ? Math.min(...values) : null;
  });

  const dark = tone === "dark";
  const muted = dark ? "text-white/40" : "text-muted-foreground";
  const fastestClass = dark ? "font-bold text-green-400" : "font-bold text-green-700 dark:text-green-400";
  return (
    <div className={dark ? "overflow-hidden" : "rounded-xl border bg-card overflow-hidden"}>
      <div className={`px-4 py-2.5 flex items-center gap-2 ${dark ? "border-b border-white/10" : "border-b bg-muted/30"}`}>
        <Timer size={15} className={dark ? "text-white/60" : "text-primary"} />
        <p className="font-heading font-bold uppercase tracking-wider text-sm">{title}</p>
        <span className={`text-xs ${muted}`}>{view === "best" ? "best per sector" : "last lap"}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className={`text-[11px] uppercase tracking-wider ${muted}`}>
              <th className="text-left font-semibold px-3 py-2">Rider</th>
              {sectorNames.map((name, i) => (
                <th key={i} className="text-right font-semibold px-3 py-2 whitespace-nowrap" title={name}>
                  S{i + 1}<span className="hidden md:inline font-normal normal-case tracking-normal"> · {name}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className={dark ? "divide-y divide-white/5" : "divide-y"}>
            {rows.map(e => {
              const values = pick(e);
              const mine = e.riderId != null && highlightRiderIds?.includes(e.riderId);
              return (
                <tr key={e.riderId ?? e.riderName} className={mine ? "bg-primary/10" : undefined}>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    {e.position != null && <span className={`font-mono text-xs mr-2 ${muted}`}>{e.position}</span>}
                    {e.bibNumber && <span className="font-mono text-xs mr-1.5">#{e.bibNumber}</span>}
                    {e.riderName}
                  </td>
                  {sectorNames.map((_, i) => (
                    <td key={i} className={`px-3 py-1.5 text-right font-mono tabular-nums ${values[i] != null && values[i] === fastest[i] ? fastestClass : ""}`}>
                      {fmt(values[i])}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
