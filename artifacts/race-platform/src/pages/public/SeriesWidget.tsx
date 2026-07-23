import { useState, useEffect } from "react";
import { useParams } from "wouter";
import rmLogo from "@assets/rm-logo.png";

const BRAND_COLORS: Record<string, { bg: string; text: string }> = {
  "KTM":      { bg: "#FF6600", text: "#ffffff" },
  "Honda":    { bg: "#CC0000", text: "#ffffff" },
  "Gas Gas":  { bg: "#E30613", text: "#ffffff" },
  "Husqvarna":{ bg: "#F5C222", text: "#1a1a1a" },
  "Yamaha":   { bg: "#003087", text: "#ffffff" },
  "Kawasaki": { bg: "#3D9B35", text: "#ffffff" },
  "Suzuki":   { bg: "#FFDE00", text: "#1a1a1a" },
  "Beta":     { bg: "#E8220D", text: "#ffffff" },
};

/**
 * Parse a totalTime value that may be:
 *  - a plain millisecond number or number-string (e.g. 91217 or "91217")
 *  - a "MM:SS.d" formatted string (e.g. "31:58.1", "3:07.07")
 * Returns milliseconds, or null if unparseable.
 */
function parseTotalTimeMs(totalTime: string | number | null | undefined): number | null {
  if (totalTime == null) return null;
  if (typeof totalTime === "number") return totalTime > 0 ? totalTime : null;
  const colonIdx = totalTime.indexOf(":");
  if (colonIdx >= 0) {
    const mins = parseFloat(totalTime.slice(0, colonIdx));
    const secs = parseFloat(totalTime.slice(colonIdx + 1));
    if (!isNaN(mins) && !isNaN(secs)) return Math.round((mins * 60 + secs) * 1000);
    return null;
  }
  const n = parseFloat(totalTime);
  if (!isNaN(n) && n > 0) return n > 10000 ? n : Math.round(n * 1000);
  return null;
}

function toLapNums(lapTimes: unknown[] | undefined): number[] {
  if (!lapTimes) return [];
  return lapTimes.map(item => {
    if (typeof item === "number") return item;
    if (typeof item === "string") return Number(item);
    // {lap, time} objects from traditional results
    if (item && typeof item === "object" && "time" in item) {
      return parseTotalTimeMs((item as Record<string, unknown>).time as string) ?? 0;
    }
    return 0;
  }).filter(n => n > 0);
}

function fmtMs(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "—";
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = (totalSec % 60).toFixed(3);
  return m > 0 ? `${m}:${s.padStart(6, "0")}` : `${Number(s).toFixed(3)}s`;
}

function bestLapMs(laps: number[]): number | null {
  const valid = laps.filter(t => t > 0);
  return valid.length ? Math.min(...valid) : null;
}

function posBadge(pos: number | null | undefined): React.CSSProperties {
  if (!pos) return { background: "#e2e8f0", color: "#94a3b8" };
  if (pos === 1) return { background: "#eab308", color: "#713f12" };
  if (pos === 2) return { background: "#9ca3af", color: "#1f2937" };
  if (pos === 3) return { background: "#b45309", color: "#fef3c7" };
  return { background: "#e2e8f0", color: "#374151" };
}

interface SeriesEvent {
  id: number; name: string; date: string | null; status: string; location: string | null; state: string;
}

interface SeriesInfo {
  id: number; name: string; season: number; classes: string[]; eventIds: number[]; events: SeriesEvent[];
}

interface StandingRow {
  position: number; riderId: number; riderName: string; raceClass: string;
  totalScore: number; eventsEntered: number; amaNumber: string | null; bikeBrand: string | null;
  events: Array<{ eventId: number; eventName: string; eventScore: number; attended: boolean; motos: number[] }>;
}

interface RaceResult {
  id: number; riderId: number; riderName: string; raceClass: string | null;
  position: number | null; bibNumber: string | null; lapTimes: unknown[] | null;
  totalTime: string | null; motoId: number; dnf: boolean | null; dns: boolean | null;
}

interface Moto {
  id: number; name: string | null; motoNumber: number | null; raceClass: string | null;
  eventId: number; status: string;
}

type View = "standings" | "event";

export default function SeriesWidget() {
  const params = useParams<{ seriesId: string }>();
  const seriesId = parseInt(params.seriesId || "0");

  const [series, setSeries] = useState<SeriesInfo | null>(null);
  const [standings, setStandings] = useState<StandingRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [view, setView] = useState<View>("standings");
  const [activeClass, setActiveClass] = useState("");
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const [selectedEventName, setSelectedEventName] = useState("");

  const [eventResults, setEventResults] = useState<RaceResult[]>([]);
  const [eventMotos, setEventMotos] = useState<Moto[]>([]);
  const [eventLoading, setEventLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [activeEventClass, setActiveEventClass] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    if (!seriesId) return;
    Promise.all([
      fetch(`/api/public/series/${seriesId}`).then(r => r.json()),
      fetch(`/api/public/series/${seriesId}/standings`).then(r => r.json()),
    ]).then(([info, stands]) => {
      setSeries(info);
      setStandings(Array.isArray(stands) ? stands : []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [seriesId]);

  useEffect(() => {
    if (!selectedEventId) return;
    setEventLoading(true);
    setEventResults([]);
    setEventMotos([]);

    const doFetch = (showLoader = false) => {
      if (showLoader) setEventLoading(true);
      return Promise.all([
        fetch(`/api/events/${selectedEventId}/results`).then(r => r.json()),
        fetch(`/api/events/${selectedEventId}/motos`).then(r => r.json()),
      ]).then(([results, motos]) => {
        setEventResults(Array.isArray(results) ? results : []);
        setEventMotos(Array.isArray(motos) ? motos : []);
        setEventLoading(false);
      }).catch(() => setEventLoading(false));
    };

    doFetch(true);

    // Auto-refresh every 30s when the selected event is live (race_day status)
    const selectedEvent = series?.events.find(e => e.id === selectedEventId);
    const isLive = selectedEvent?.status === "race_day";
    if (!isLive) return;
    const interval = setInterval(() => doFetch(false), 30_000);
    return () => clearInterval(interval);
  }, [selectedEventId, series]);

  const riderInfoMap = new Map<number, { amaNumber: string | null; bikeBrand: string | null }>(
    standings.map(s => [s.riderId, { amaNumber: s.amaNumber, bikeBrand: s.bikeBrand }])
  );

  const classes = [...new Set(standings.map(s => s.raceClass))].sort();
  const displayClass = activeClass || classes[0] || "";
  const classStandings = standings.filter(s => s.raceClass === displayClass).sort((a, b) => a.position - b.position);
  const eventColumns = classStandings[0]?.events || [];

  const eventClasses = [...new Set(eventResults.map(r => r.raceClass).filter(Boolean))] as string[];
  const displayEventClass = activeEventClass || eventClasses[0] || "";

  const filteredEventResults: RaceResult[] = search.trim()
    ? eventResults.filter(r => r.riderName.toLowerCase().includes(search.toLowerCase()))
    : eventResults.filter(r => r.raceClass === displayEventClass);

  // Find a completed "main" moto for the active event class (supercross format)
  const mainMotoForEventClass = !search.trim()
    ? eventMotos.find(
        m => (m as any).raceClass === displayEventClass && (m as any).type === "main" && m.status === "completed"
      )
    : null;

  const uniqueRiders = (() => {
    if (search.trim()) {
      return Array.from(
        filteredEventResults.reduce<Map<number, RaceResult>>((map, r) => {
          const ex = map.get(r.riderId);
          if (!ex || (r.position ?? 999) < (ex.position ?? 999)) map.set(r.riderId, r);
          return map;
        }, new Map()).values()
      ).sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
    }

    if (mainMotoForEventClass) {
      // Supercross: use main moto results only for definitive ranking
      return eventResults
        .filter(r => r.raceClass === displayEventClass && r.motoId === mainMotoForEventClass.id)
        .sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
    }

    // Traditional multi-heat: rank by total accumulated points
    const byRider = new Map<number, { result: RaceResult; totalPoints: number }>();
    eventResults.filter(r => r.raceClass === displayEventClass).forEach(r => {
      const pts = (r as any).points ?? 0;
      const ex = byRider.get(r.riderId);
      if (!ex) {
        byRider.set(r.riderId, { result: r, totalPoints: pts });
      } else {
        byRider.set(r.riderId, { result: ex.result, totalPoints: ex.totalPoints + pts });
      }
    });
    return Array.from(byRider.values())
      .sort((a, b) => b.totalPoints - a.totalPoints || (a.result.position ?? 999) - (b.result.position ?? 999))
      .map((entry, i) => ({ ...entry.result, position: i + 1 }));
  })();

  const riderMotoResults = (riderId: number, raceClass: string) =>
    eventResults.filter(r => r.riderId === riderId && r.raceClass === raceClass)
      .sort((a, b) => {
        const ma = eventMotos.find(m => m.id === a.motoId);
        const mb = eventMotos.find(m => m.id === b.motoId);
        return (ma?.motoNumber ?? 0) - (mb?.motoNumber ?? 0);
      });

  const goToEvent = (eventId: number, eventName: string, cls?: string) => {
    setSelectedEventId(eventId);
    setSelectedEventName(eventName);
    setActiveEventClass(cls ?? "");
    setSearch("");
    setExpanded(null);
    setView("event");
  };

  const goBack = () => {
    setView("standings");
    setExpanded(null);
    setSearch("");
  };

  if (loading) {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", background: "#ffffff", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#dc2626", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", opacity: 0.7 }}>Loading Series…</div>
      </div>
    );
  }

  if (!series) {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", background: "#ffffff", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#dc2626", fontSize: 13 }}>Series not found.</div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, sans-serif", background: "#ffffff", minHeight: "100vh", color: "#0f172a", paddingBottom: 64 }}>

      {/* ── Header ───────────────────────────────────────────── */}
      <div style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", padding: "14px 18px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {view === "event" && (
              <button
                onClick={goBack}
                style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "#dc2626", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", background: "none", border: "none", cursor: "pointer", marginBottom: 8, padding: 0 }}
              >
                ← Series Standings
              </button>
            )}
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.14em", color: "#dc2626", marginBottom: 3 }}>
              Championship Series · {series.season}
            </div>
            <div style={{ fontSize: 19, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.03em", lineHeight: 1.2, color: "#0f172a" }}>
              {view === "event" ? selectedEventName : series.name}
            </div>
            {view === "event" && (
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{series.name}</div>
            )}
          </div>
          <div style={{ flexShrink: 0 }}>
            <div style={{ background: view === "standings" ? "rgba(220,38,38,0.08)" : "rgba(22,163,74,0.08)", border: `1px solid ${view === "standings" ? "rgba(220,38,38,0.35)" : "rgba(22,163,74,0.35)"}`, color: view === "standings" ? "#dc2626" : "#16a34a", borderRadius: 4, padding: "3px 10px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em" }}>
              {view === "standings" ? "Championship" : "Race Results"}
            </div>
          </div>
        </div>
      </div>

      {/* ══════════ STANDINGS VIEW ══════════ */}
      {view === "standings" && (
        <>
          {classes.length === 0 ? (
            <div style={{ padding: "48px 20px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
              No completed results yet for this series.
            </div>
          ) : (
            <>
              {/* Class tabs */}
              <div style={{ padding: "0 18px", borderBottom: "1px solid #e2e8f0", display: "flex", gap: 2, overflowX: "auto" }}>
                {classes.map(cls => (
                  <button key={cls} onClick={() => setActiveClass(cls)}
                    style={{ padding: "10px 14px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", border: "none", borderBottom: cls === displayClass ? "2px solid #dc2626" : "2px solid transparent", background: "none", color: cls === displayClass ? "#dc2626" : "#94a3b8", cursor: "pointer", whiteSpace: "nowrap" }}>
                    {cls}
                  </button>
                ))}
              </div>

              {/* Races quick-nav */}
              {series.events.length > 0 && (
                <div style={{ padding: "10px 18px", borderBottom: "1px solid #e2e8f0", display: "flex", gap: 6, overflowX: "auto", alignItems: "center" }}>
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#94a3b8", whiteSpace: "nowrap" }}>Races:</span>
                  {series.events.map((ev, i) => (
                    <button key={ev.id} onClick={() => goToEvent(ev.id, ev.name, displayClass)}
                      style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 5, color: "#374151", fontSize: 11, fontWeight: 600, padding: "4px 10px", cursor: "pointer", whiteSpace: "nowrap" }}>
                      <span style={{ color: "#dc2626", fontSize: 10, fontWeight: 800 }}>{i + 1}</span>
                      {ev.name}
                      {ev.status === "race_day" && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#dc2626", display: "inline-block" }} />}
                    </button>
                  ))}
                </div>
              )}

              {/* Standings table */}
              {classStandings.length === 0 ? (
                <div style={{ padding: "40px 20px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
                  No results for {displayClass} yet.
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  {/* Column headers */}
                  <div style={{ display: "grid", gridTemplateColumns: `38px 1fr${eventColumns.map(() => " 70px").join("")} 52px 64px`, padding: "8px 18px", borderBottom: "1px solid #e2e8f0", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#94a3b8", minWidth: 320 }}>
                    <span>Pos</span>
                    <span>Rider</span>
                    {eventColumns.map((ev, i) => (
                      <button key={ev.eventId} onClick={() => goToEvent(ev.eventId, ev.eventName, displayClass)}
                        style={{ textAlign: "center", background: "none", border: "none", color: "#94a3b8", cursor: "pointer", padding: "0 2px", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
                        <span style={{ color: "#dc2626", fontSize: 8, fontWeight: 800 }}>R{i + 1}</span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 62 }}>{ev.eventName}</span>
                      </button>
                    ))}
                    <span style={{ textAlign: "center" }}>Evts</span>
                    <span style={{ textAlign: "right" }}>Pts</span>
                  </div>

                  {classStandings.map(row => (
                    <div key={row.riderId} style={{ display: "grid", gridTemplateColumns: `38px 1fr${eventColumns.map(() => " 70px").join("")} 52px 64px`, padding: "9px 18px", borderBottom: "1px solid #f1f5f9", alignItems: "center", minWidth: 320, background: row.position === 1 ? "rgba(220,38,38,0.03)" : "transparent" }}>
                      {/* Pos */}
                      <div>
                        <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: "50%", fontSize: 11, fontWeight: 800, ...posBadge(row.position) }}>
                          {row.position}
                        </span>
                      </div>
                      {/* Rider info */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, paddingRight: 6 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {row.riderName}
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                          {row.amaNumber && (
                            <span style={{ fontSize: 10, color: "#94a3b8" }}>AMA# {row.amaNumber}</span>
                          )}
                          {row.bikeBrand && BRAND_COLORS[row.bikeBrand] && (
                            <span style={{ display: "inline-block", background: BRAND_COLORS[row.bikeBrand].bg, color: BRAND_COLORS[row.bikeBrand].text, fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", borderRadius: 3, padding: "1px 6px" }}>
                              {row.bikeBrand}
                            </span>
                          )}
                        </div>
                      </div>
                      {/* Per-event scores */}
                      {eventColumns.map(ev => {
                        const evData = row.events.find(e => e.eventId === ev.eventId);
                        return (
                          <div key={ev.eventId} style={{ textAlign: "center" }}>
                            {evData?.attended ? (
                              <div>
                                <div style={{ fontSize: 12, fontWeight: 800, color: "#0f172a" }}>{evData.eventScore}</div>
                                <div style={{ fontSize: 9, color: "#94a3b8" }}>{evData.motos?.join("·")}</div>
                              </div>
                            ) : (
                              <div style={{ fontSize: 11, color: "#cbd5e1" }}>—</div>
                            )}
                          </div>
                        );
                      })}
                      {/* Events entered */}
                      <div style={{ textAlign: "center", fontSize: 12, color: "#94a3b8" }}>{row.eventsEntered}</div>
                      {/* Total */}
                      <div style={{ textAlign: "right", fontSize: 15, fontWeight: 900, color: "#dc2626" }}>{row.totalScore}</div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ══════════ EVENT DRILL-DOWN VIEW ══════════ */}
      {view === "event" && (
        <>
          {/* Search */}
          <div style={{ padding: "10px 18px", borderBottom: "1px solid #e2e8f0" }}>
            <input type="text" placeholder="🔍  Search rider name…" value={search}
              onChange={e => { setSearch(e.target.value); setExpanded(null); }}
              style={{ width: "100%", background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: 6, color: "#0f172a", padding: "8px 12px", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
          </div>

          {/* Class tabs */}
          {!search.trim() && eventClasses.length > 1 && (
            <div style={{ padding: "0 18px", borderBottom: "1px solid #e2e8f0", display: "flex", gap: 2, overflowX: "auto" }}>
              {eventClasses.map(cls => (
                <button key={cls} onClick={() => { setActiveEventClass(cls); setExpanded(null); }}
                  style={{ padding: "10px 14px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", border: "none", borderBottom: cls === displayEventClass ? "2px solid #dc2626" : "2px solid transparent", background: "none", color: cls === displayEventClass ? "#dc2626" : "#94a3b8", cursor: "pointer", whiteSpace: "nowrap" }}>
                  {cls}
                </button>
              ))}
            </div>
          )}

          {eventLoading ? (
            <div style={{ padding: "40px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>Loading results…</div>
          ) : uniqueRiders.length === 0 ? (
            <div style={{ padding: "48px 20px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
              {search.trim() ? "No riders found." : "No results recorded for this race."}
            </div>
          ) : (
            <>
              {/* Column header */}
              <div style={{ display: "grid", gridTemplateColumns: "40px 1fr 50px 78px 78px", padding: "8px 18px", borderBottom: "1px solid #e2e8f0", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#94a3b8" }}>
                <span>Pos</span><span>Rider</span>
                <span style={{ textAlign: "center" }}>Laps</span>
                <span style={{ textAlign: "right" }}>Best</span>
                <span style={{ textAlign: "right" }}>{mainMotoForEventClass ? "Total" : "Pts"}</span>
              </div>

              {uniqueRiders.map(rider => {
                const motoResults = riderMotoResults(rider.riderId, rider.raceClass ?? "");
                const allLaps = motoResults.flatMap(m => toLapNums(m.lapTimes ?? undefined));
                const directLaps = toLapNums(rider.lapTimes ?? undefined);
                const lapsToShow = allLaps.length > 0 ? allLaps : directLaps;
                const bl = bestLapMs(lapsToShow.slice(1)); // exclude lap 1 (gate-to-line partial lap)
                const totalMs = parseTotalTimeMs(rider.totalTime);
                const totalPts = !mainMotoForEventClass
                  ? motoResults.reduce((sum, r) => sum + ((r as any).points ?? 0), 0)
                  : null;
                const isExpanded = expanded === rider.riderId;
                const rInfo = riderInfoMap.get(rider.riderId);

                return (
                  <div key={rider.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <div role="button" tabIndex={0}
                      onClick={() => setExpanded(isExpanded ? null : rider.riderId)}
                      onKeyDown={e => e.key === "Enter" && setExpanded(isExpanded ? null : rider.riderId)}
                      style={{ display: "grid", gridTemplateColumns: "40px 1fr 50px 78px 78px", padding: "10px 18px", cursor: "pointer", background: isExpanded ? "#f8fafc" : "transparent" }}>
                      {/* Pos */}
                      <div style={{ display: "flex", alignItems: "center" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: "50%", fontSize: 11, fontWeight: 800, ...posBadge(rider.position) }}>
                          {rider.dnf ? "F" : rider.dns ? "S" : (rider.position ?? "—")}
                        </span>
                      </div>
                      {/* Rider info */}
                      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 3, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {rider.riderName}
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                          {rider.bibNumber && <span style={{ fontSize: 10, color: "#94a3b8" }}>#{rider.bibNumber}</span>}
                          {rInfo?.amaNumber && <span style={{ fontSize: 10, color: "#94a3b8" }}>AMA# {rInfo.amaNumber}</span>}
                          {rInfo?.bikeBrand && BRAND_COLORS[rInfo.bikeBrand] && (
                            <span style={{ display: "inline-block", background: BRAND_COLORS[rInfo.bikeBrand].bg, color: BRAND_COLORS[rInfo.bikeBrand].text, fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", borderRadius: 3, padding: "1px 6px" }}>
                              {rInfo.bikeBrand}
                            </span>
                          )}
                          {rider.dnf && <span style={{ color: "#dc2626", fontSize: 10 }}>DNF</span>}
                          {rider.dns && <span style={{ color: "#94a3b8", fontSize: 10 }}>DNS</span>}
                        </div>
                      </div>
                      {/* Laps */}
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "#64748b" }}>{lapsToShow.length || "—"}</div>
                      {/* Best */}
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", fontSize: 12, color: "#16a34a", fontVariantNumeric: "tabular-nums" }}>{fmtMs(bl)}</div>
                      {/* Total time (main format) OR total points (multi-heat) */}
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", fontSize: 12, fontVariantNumeric: "tabular-nums", color: mainMotoForEventClass ? "#64748b" : "#dc2626", fontWeight: mainMotoForEventClass ? 400 : 700 }}>
                        {mainMotoForEventClass
                          ? fmtMs(totalMs)
                          : (totalPts != null && totalPts > 0 ? `${totalPts}` : "—")}
                      </div>
                    </div>

                    {/* Expanded lap history */}
                    {isExpanded && (
                      <div style={{ background: "#f8fafc", padding: "12px 18px 16px", borderTop: "1px solid #e2e8f0" }}>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#94a3b8", marginBottom: 10 }}>
                          Lap History · {rider.riderName}
                        </div>
                        {motoResults.length > 0 ? motoResults.map(moto => {
                          const laps = toLapNums(moto.lapTimes ?? undefined);
                          const motoInfo = eventMotos.find(m => m.id === moto.motoId);
                          const mbl = bestLapMs(laps.slice(1)); // exclude lap 1 (gate-to-line partial lap)
                          return (
                            <div key={moto.id} style={{ marginBottom: 14 }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: "#dc2626", marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
                                <span style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}>{motoInfo?.name ?? `Moto`}</span>
                                {moto.dnf && <span style={{ color: "#dc2626", fontSize: 10 }}>DNF</span>}
                                {laps.length > 0 && <span style={{ marginLeft: "auto", color: "#94a3b8", fontSize: 10 }}>Best: <span style={{ color: "#16a34a" }}>{fmtMs(mbl)}</span></span>}
                              </div>
                              {laps.length > 0 ? (
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                                  {laps.map((lap, i) => {
                                    const isBest = i > 0 && mbl !== null && lap === mbl;
                                    return (
                                      <div key={i} style={{ background: isBest ? "rgba(22,163,74,0.08)" : "#f1f5f9", border: `1px solid ${isBest ? "rgba(22,163,74,0.35)" : "#e2e8f0"}`, borderRadius: 5, padding: "4px 10px", fontSize: 12, color: isBest ? "#16a34a" : "#374151", fontVariantNumeric: "tabular-nums" }}>
                                        <span style={{ fontSize: 9, color: isBest ? "#16a34a" : "#94a3b8", marginRight: 4 }}>L{i + 1}</span>
                                        {fmtMs(lap)}
                                        {isBest && <span style={{ fontSize: 9, marginLeft: 4 }}>★</span>}
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div style={{ fontSize: 12, color: "#94a3b8" }}>No laps recorded.</div>
                              )}
                            </div>
                          );
                        }) : directLaps.length > 0 ? (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                            {directLaps.map((lap, i) => {
                              const isBest = i > 0 && bestLapMs(directLaps.slice(1)) === lap;
                              return (
                                <div key={i} style={{ background: isBest ? "rgba(22,163,74,0.08)" : "#f1f5f9", border: `1px solid ${isBest ? "rgba(22,163,74,0.35)" : "#e2e8f0"}`, borderRadius: 5, padding: "4px 10px", fontSize: 12, color: isBest ? "#16a34a" : "#374151", fontVariantNumeric: "tabular-nums" }}>
                                  <span style={{ fontSize: 9, color: "#94a3b8", marginRight: 4 }}>L{i + 1}</span>
                                  {fmtMs(lap)}
                                  {isBest && <span style={{ fontSize: 9, marginLeft: 4 }}>★</span>}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div style={{ fontSize: 12, color: "#94a3b8" }}>No lap data available.</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </>
      )}

      {/* ── Footer ───────────────────────────────────────────── */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#f8fafc", borderTop: "1px solid #e2e8f0", padding: "7px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <img src={rmLogo} alt="RM Tracker" style={{ width: 22, height: 22, objectFit: "contain" }} />
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
            <span style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.08em", color: "#dc2626" }}>RM</span>
            <span style={{ fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.12em", color: "#dc2626" }}>Tracker</span>
          </div>
        </div>
        <div style={{ fontSize: 11, color: "#94a3b8", textAlign: "right" }}>
          {view === "standings"
            ? `${standings.length} rider${standings.length !== 1 ? "s" : ""} · ${classes.length} class${classes.length !== 1 ? "es" : ""}`
            : `${selectedEventName}`}
        </div>
      </div>

      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #ffffff; }
        input::placeholder { color: #94a3b8; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: #f1f5f9; }
        ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 2px; }
        div[role=button]:focus-visible { outline: 2px solid #dc2626; outline-offset: -2px; }
      `}</style>
    </div>
  );
}
