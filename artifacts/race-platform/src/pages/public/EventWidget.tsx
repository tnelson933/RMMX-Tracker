import { useState, useEffect } from "react";
import { useParams } from "wouter";
import { useGetEvent, useListResults, useListMotos, RaceResult } from "@workspace/api-client-react";
import { formatEventDates } from "@/lib/eventDates";
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
 *  - a "MM:SS.d" / "M:SS.dd" formatted string (e.g. "31:58.1", "3:07.07")
 *  - a plain seconds decimal string (e.g. "58.4")
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
  if (!isNaN(n) && n > 0) {
    // If large enough to be ms (>10000 = more than 10s as ms), treat as ms; otherwise as seconds
    return n > 10000 ? n : Math.round(n * 1000);
  }
  return null;
}

/**
 * Convert lapTimes array to millisecond numbers.
 * Handles:
 *  - plain numbers (ms from RFID)
 *  - {lap, time} objects where time is "MM:SS.d"
 *  - string numbers
 */
function toLapNums(lapTimes: unknown[] | undefined): number[] {
  if (!lapTimes) return [];
  return lapTimes.map(item => {
    if (typeof item === "number") return item;
    if (typeof item === "string") {
      const n = Number(item);
      return isNaN(n) ? 0 : n;
    }
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

function posBadgeStyle(pos: number | null | undefined): React.CSSProperties {
  if (!pos) return { background: "#e2e8f0", color: "#94a3b8" };
  if (pos === 1) return { background: "#eab308", color: "#713f12" };
  if (pos === 2) return { background: "#9ca3af", color: "#1f2937" };
  if (pos === 3) return { background: "#b45309", color: "#fef3c7" };
  return { background: "#e2e8f0", color: "#374151" };
}

export default function EventWidget() {
  const params = useParams<{ eventId: string }>();
  const eventId = parseInt(params.eventId || "0");

  const [search, setSearch] = useState("");
  const [activeClass, setActiveClass] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);

  const { data: event, isLoading: eventLoading } = useGetEvent(eventId, { query: { enabled: !!eventId } as any });
  const isLive = event?.status === "race_day" || (
    event?.status !== "completed" && event?.status !== "draft" &&
    !!event?.date && event.date.substring(0, 10) === new Date().toLocaleDateString("en-CA")
  );

  const { data: results } = useListResults(eventId, {
    query: { enabled: !!eventId, refetchInterval: isLive ? 30_000 : false } as any,
  });
  const { data: motos } = useListMotos(eventId, {
    query: { enabled: !!eventId, refetchInterval: isLive ? 30_000 : false } as any,
  });

  useEffect(() => {
    if (!activeClass && event?.raceClasses?.length) {
      setActiveClass(event.raceClasses[0]);
    }
  }, [event, activeClass]);

  const classes: string[] = event?.raceClasses?.length
    ? (event.raceClasses as string[])
    : Array.from(new Set((results ?? []).map(r => r.raceClass))).filter(Boolean) as string[];

  const filteredResults: RaceResult[] = search.trim()
    ? (results ?? []).filter(r => r.riderName.toLowerCase().includes(search.toLowerCase()))
    : (results ?? []).filter(r => r.raceClass === activeClass);

  /**
   * For a class with a completed "main" moto (supercross format),
   * use only that moto's results for the summary ranking.
   * For traditional multi-heat events, rank by total accumulated points.
   */
  const mainMotoForClass = !search.trim()
    ? (motos ?? []).find(
        m => (m as any).raceClass === activeClass && (m as any).type === "main" && m.status === "completed"
      )
    : null;

  const uniqueRiders: RaceResult[] = (() => {
    if (search.trim()) {
      // Search mode: show best-position result per rider across all classes
      return Array.from(
        filteredResults.reduce<Map<number, RaceResult>>((map, r) => {
          const ex = map.get(r.riderId);
          if (!ex || (r.position ?? 999) < (ex.position ?? 999)) map.set(r.riderId, r);
          return map;
        }, new Map()).values()
      ).sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
    }

    if (mainMotoForClass) {
      // Supercross / main-event format: definitive ranking comes from the main moto only
      return (results ?? [])
        .filter(r => r.raceClass === activeClass && r.motoId === mainMotoForClass.id)
        .sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
    }

    // Traditional multi-heat: rank by total accumulated points across all motos
    const byRider = new Map<number, { result: RaceResult; totalPoints: number }>();
    (results ?? []).filter(r => r.raceClass === activeClass).forEach(r => {
      const pts = r.points ?? 0;
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
    (results ?? [])
      .filter(r => r.riderId === riderId && r.raceClass === raceClass)
      .sort((a, b) => {
        const ma = motos?.find(m => m.id === a.motoId);
        const mb = motos?.find(m => m.id === b.motoId);
        return ((ma as any)?.motoNumber ?? 0) - ((mb as any)?.motoNumber ?? 0);
      });

  if (eventLoading) {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", background: "#ffffff", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#dc2626", fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.7 }}>Loading…</div>
      </div>
    );
  }
  if (!event) {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", background: "#ffffff", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#dc2626", fontSize: 14 }}>Event not found.</div>
      </div>
    );
  }

  const isEventToday = !!event.date && event.date.substring(0, 10) === new Date().toLocaleDateString("en-CA");
  const isRaceDayStatus = event.status === "race_day" || (isEventToday && event.status !== "completed" && event.status !== "draft");
  const statusLabel = isRaceDayStatus ? "LIVE" : event.status === "completed" ? "Final Results" : event.status.replace(/_/g, " ");
  const statusColor = isRaceDayStatus ? "#dc2626" : event.status === "completed" ? "#16a34a" : "#6b7280";

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, sans-serif", background: "#ffffff", minHeight: "100vh", color: "#0f172a" }}>

      {/* Header */}
      <div style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {isLive && (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(220,38,38,0.08)", border: "1px solid rgba(220,38,38,0.35)", color: "#dc2626", borderRadius: 4, padding: "2px 8px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#dc2626", display: "inline-block" }} />
                Race Day Live
              </div>
            )}
            <div style={{ fontSize: 20, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.03em", lineHeight: 1.2, color: "#0f172a", marginBottom: 4 }}>
              {event.name}
            </div>
            <div style={{ fontSize: 12, color: "#64748b", display: "flex", gap: 12, flexWrap: "wrap" }}>
              {event.date && (
                <span>📅 {formatEventDates(event.date, (event as any).endDate)}</span>
              )}
              {event.location && <span>📍 {event.location}{event.state ? `, ${event.state}` : ""}</span>}
              {event.clubName && <span>🏆 {event.clubName}</span>}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
            <div style={{ background: statusColor + "18", border: `1px solid ${statusColor}55`, color: statusColor, borderRadius: 4, padding: "3px 10px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              {statusLabel}
            </div>
            {(event as any).imageUrl && (
              <img src={(event as any).imageUrl} alt={event.name} style={{ height: 48, width: "auto", maxWidth: 100, objectFit: "contain", opacity: 0.9, borderRadius: 4 }} />
            )}
          </div>
        </div>
        {(event as any).clubLogoUrl && (
          <div style={{ marginTop: 10 }}>
            <img src={(event as any).clubLogoUrl} alt={event.clubName || ""} style={{ height: 36, width: "auto", objectFit: "contain", opacity: 0.8 }} />
          </div>
        )}
      </div>

      {/* Search */}
      <div style={{ padding: "12px 20px", borderBottom: "1px solid #e2e8f0" }}>
        <input
          type="text"
          placeholder="🔍  Search rider name…"
          value={search}
          onChange={e => { setSearch(e.target.value); setExpanded(null); }}
          style={{ width: "100%", background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: 6, color: "#0f172a", padding: "8px 12px", fontSize: 13, outline: "none", boxSizing: "border-box" }}
        />
      </div>

      {/* Class tabs */}
      {!search.trim() && classes.length > 0 && (
        <div style={{ padding: "0 20px", borderBottom: "1px solid #e2e8f0", display: "flex", gap: 2, overflowX: "auto" }}>
          {classes.map(cls => (
            <button
              key={cls}
              onClick={() => { setActiveClass(cls); setExpanded(null); }}
              style={{ padding: "10px 14px", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", border: "none", borderBottom: cls === activeClass ? "2px solid #dc2626" : "2px solid transparent", background: "none", color: cls === activeClass ? "#dc2626" : "#94a3b8", cursor: "pointer", whiteSpace: "nowrap" }}
            >
              {cls}
            </button>
          ))}
        </div>
      )}

      {/* Results */}
      <div style={{ paddingBottom: 80 }}>
        {uniqueRiders.length === 0 ? (
          <div style={{ padding: "48px 20px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
            {search.trim() ? "No riders found matching that name." : "No results recorded yet."}
          </div>
        ) : (
          <>
            {/* Header row */}
            <div style={{ display: "grid", gridTemplateColumns: "42px 1fr 54px 80px 80px", padding: "8px 20px", borderBottom: "1px solid #e2e8f0", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#94a3b8" }}>
              <span>Pos</span>
              <span>Rider</span>
              <span style={{ textAlign: "center" }}>Laps</span>
              <span style={{ textAlign: "right" }}>Best</span>
              <span style={{ textAlign: "right" }}>{mainMotoForClass ? "Total" : "Pts"}</span>
            </div>

            {uniqueRiders.map(rider => {
              const motoResults = riderMotoResults(rider.riderId, rider.raceClass ?? "");
              const allLaps = motoResults.flatMap(m => toLapNums(m.lapTimes as unknown[] | undefined));
              const directLaps = toLapNums(rider.lapTimes as unknown[] | undefined);
              const lapsToShow = allLaps.length > 0 ? allLaps : directLaps;
              const bl = bestLapMs(lapsToShow.slice(1)); // exclude lap 1 (gate-to-line partial lap)
              const totalMs = parseTotalTimeMs(rider.totalTime);
              const isExpanded = expanded === rider.riderId;

              // For multi-heat: compute total points for this rider
              const totalPts = !mainMotoForClass
                ? motoResults.reduce((sum, r) => sum + (r.points ?? 0), 0)
                : null;

              return (
                <div key={rider.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  {/* Rider row */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setExpanded(isExpanded ? null : rider.riderId)}
                    onKeyDown={e => e.key === "Enter" && setExpanded(isExpanded ? null : rider.riderId)}
                    style={{ display: "grid", gridTemplateColumns: "42px 1fr 54px 80px 80px", padding: "10px 20px", cursor: "pointer", background: isExpanded ? "#f8fafc" : "transparent" }}
                  >
                    {/* Position */}
                    <div style={{ display: "flex", alignItems: "center" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: "50%", fontSize: 11, fontWeight: 800, ...posBadgeStyle(rider.position) }}>
                        {rider.dnf ? "F" : rider.dns ? "S" : (rider.position ?? "—")}
                      </span>
                    </div>
                    {/* Rider name */}
                    <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 2, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {rider.riderName}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", fontSize: 11, color: "#94a3b8" }}>
                        {search.trim() && <span style={{ background: "#f1f5f9", borderRadius: 3, padding: "1px 5px" }}>{rider.raceClass}</span>}
                        {rider.bibNumber && <span>#{rider.bibNumber}</span>}
                        {(rider as any).amaNumber && <span style={{ color: "#64748b" }}>AMA# {(rider as any).amaNumber}</span>}
                        {(rider as any).bikeBrand && BRAND_COLORS[(rider as any).bikeBrand] && (
                          <span style={{ display: "inline-block", background: BRAND_COLORS[(rider as any).bikeBrand].bg, color: BRAND_COLORS[(rider as any).bikeBrand].text, fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", borderRadius: 3, padding: "1px 6px" }}>
                            {(rider as any).bikeBrand}
                          </span>
                        )}
                        {rider.dnf && <span style={{ color: "#dc2626" }}>DNF</span>}
                        {rider.dns && <span style={{ color: "#94a3b8" }}>DNS</span>}
                      </div>
                    </div>
                    {/* Laps */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "#64748b" }}>
                      {lapsToShow.length || "—"}
                    </div>
                    {/* Best lap */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", fontSize: 12, color: "#16a34a", fontVariantNumeric: "tabular-nums" }}>
                      {fmtMs(bl)}
                    </div>
                    {/* Total time (main format) OR total points (multi-heat) */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", fontSize: 12, fontVariantNumeric: "tabular-nums", color: mainMotoForClass ? "#64748b" : "#dc2626", fontWeight: mainMotoForClass ? 400 : 700 }}>
                      {mainMotoForClass
                        ? fmtMs(totalMs)
                        : (totalPts != null && totalPts > 0 ? `${totalPts}` : "—")}
                    </div>
                  </div>

                  {/* Expanded lap history */}
                  {isExpanded && (
                    <div style={{ background: "#f8fafc", padding: "12px 20px 16px", borderTop: "1px solid #e2e8f0" }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#94a3b8", marginBottom: 10 }}>
                        Lap History · {rider.riderName}
                      </div>

                      {motoResults.length > 0 ? (
                        motoResults.map(moto => {
                          const laps = toLapNums(moto.lapTimes as unknown[] | undefined);
                          const motoInfo = motos?.find(m => m.id === moto.motoId);
                          const mbl = bestLapMs(laps.slice(1)); // exclude lap 1 (gate-to-line partial lap)
                          const motoTotalMs = parseTotalTimeMs(moto.totalTime);
                          return (
                            <div key={moto.id} style={{ marginBottom: 14 }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: "#dc2626", marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
                                <span style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                  {motoInfo?.name ?? moto.motoName ?? `Moto`}
                                </span>
                                {moto.position != null && (
                                  <span style={{ fontSize: 10, color: "#64748b" }}>P{moto.position}</span>
                                )}
                                {moto.dnf && <span style={{ color: "#dc2626", fontSize: 10 }}>DNF</span>}
                                {moto.dns && <span style={{ color: "#94a3b8", fontSize: 10 }}>DNS</span>}
                                <span style={{ marginLeft: "auto", display: "flex", gap: 10, color: "#94a3b8", fontSize: 10 }}>
                                  {laps.length > 0 && (
                                    <span>Best: <span style={{ color: "#16a34a" }}>{fmtMs(mbl)}</span></span>
                                  )}
                                  {motoTotalMs && (
                                    <span>Total: <span style={{ color: "#64748b" }}>{fmtMs(motoTotalMs)}</span></span>
                                  )}
                                </span>
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
                        })
                      ) : directLaps.length > 0 ? (
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
      </div>

      {/* Fixed footer */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#f8fafc", borderTop: "1px solid #e2e8f0", padding: "7px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <img src={rmLogo} alt="RM Tracker" style={{ width: 22, height: 22, objectFit: "contain" }} />
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
            <span style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.08em", color: "#dc2626" }}>RM</span>
            <span style={{ fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.12em", color: "#dc2626" }}>Tracker</span>
          </div>
          {isLive && <span style={{ fontSize: 10, color: "#94a3b8", marginLeft: 4 }}>· auto-updates every 30s</span>}
        </div>
        {(results?.length ?? 0) > 0 && (
          <div style={{ fontSize: 11, color: "#94a3b8" }}>
            {new Set(results?.map(r => r.riderId)).size} riders
          </div>
        )}
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
