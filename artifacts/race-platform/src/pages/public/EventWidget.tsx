import { useState, useEffect } from "react";
import { useParams } from "wouter";
import { useGetEvent, useListResults, useListMotos, RaceResult } from "@workspace/api-client-react";
import rmLogo from "@assets/rm-logo.png";

function toLapNums(lapTimes: string[] | undefined): number[] {
  if (!lapTimes) return [];
  return lapTimes.map(Number).filter(n => n > 0);
}

function toTotalMs(totalTime: string | null | undefined): number | null {
  if (!totalTime) return null;
  const n = Number(totalTime);
  return isNaN(n) || n <= 0 ? null : n;
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
  if (!pos) return { background: "#1e2740", color: "#6b7280" };
  if (pos === 1) return { background: "#eab308", color: "#713f12" };
  if (pos === 2) return { background: "#9ca3af", color: "#1f2937" };
  if (pos === 3) return { background: "#b45309", color: "#fef3c7" };
  return { background: "#1e2740", color: "#94a3b8" };
}

export default function EventWidget() {
  const params = useParams<{ eventId: string }>();
  const eventId = parseInt(params.eventId || "0");

  const [search, setSearch] = useState("");
  const [activeClass, setActiveClass] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);

  const { data: event, isLoading: eventLoading } = useGetEvent(eventId, { query: { enabled: !!eventId } as any });
  const isLive = event?.status === "race_day";

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

  const uniqueRiders = Array.from(
    filteredResults.reduce<Map<number, RaceResult>>((map, r) => {
      const key = r.riderId;
      const existing = map.get(key);
      if (!existing || (r.position ?? 999) < (existing.position ?? 999)) map.set(key, r);
      return map;
    }, new Map()).values()
  ).sort((a, b) => (a.position ?? 999) - (b.position ?? 999));

  const riderMotoResults = (riderId: number, raceClass: string) =>
    (results ?? [])
      .filter(r => r.riderId === riderId && r.raceClass === raceClass)
      .sort((a, b) => {
        const ma = motos?.find(m => m.id === a.motoId);
        const mb = motos?.find(m => m.id === b.motoId);
        return (ma?.motoNumber ?? 0) - (mb?.motoNumber ?? 0);
      });

  if (eventLoading) {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", background: "#0f1117", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#dc2626", fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.7 }}>Loading…</div>
      </div>
    );
  }
  if (!event) {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", background: "#0f1117", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#ef4444", fontSize: 14 }}>Event not found.</div>
      </div>
    );
  }

  const statusLabel = event.status === "race_day" ? "LIVE" : event.status === "completed" ? "Final Results" : event.status.replace(/_/g, " ");
  const statusColor = event.status === "race_day" ? "#ef4444" : event.status === "completed" ? "#22c55e" : "#6b7280";

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, sans-serif", background: "#0f1117", minHeight: "100vh", color: "#f4f4f5" }}>

      {/* Header */}
      <div style={{ background: "#161b2e", borderBottom: "1px solid #1e2740", padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {isLive && (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.4)", color: "#f87171", borderRadius: 4, padding: "2px 8px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#ef4444", display: "inline-block" }} />
                Race Day Live
              </div>
            )}
            <div style={{ fontSize: 20, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.03em", lineHeight: 1.2, color: "#ffffff", marginBottom: 4 }}>
              {event.name}
            </div>
            <div style={{ fontSize: 12, color: "#94a3b8", display: "flex", gap: 12, flexWrap: "wrap" }}>
              {event.date && (
                <span>📅 {new Date(event.date.substring(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
              )}
              {event.location && <span>📍 {event.location}{event.state ? `, ${event.state}` : ""}</span>}
              {event.clubName && <span>🏆 {event.clubName}</span>}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
            <div style={{ background: statusColor + "22", border: `1px solid ${statusColor}55`, color: statusColor, borderRadius: 4, padding: "3px 10px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
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
      <div style={{ padding: "12px 20px", borderBottom: "1px solid #1e2740" }}>
        <input
          type="text"
          placeholder="🔍  Search rider name…"
          value={search}
          onChange={e => { setSearch(e.target.value); setExpanded(null); }}
          style={{ width: "100%", background: "#1a2035", border: "1px solid #2a3a5c", borderRadius: 6, color: "#f4f4f5", padding: "8px 12px", fontSize: 13, outline: "none", boxSizing: "border-box" }}
        />
      </div>

      {/* Class tabs — hidden when searching */}
      {!search.trim() && classes.length > 0 && (
        <div style={{ padding: "0 20px", borderBottom: "1px solid #1e2740", display: "flex", gap: 2, overflowX: "auto" }}>
          {classes.map(cls => (
            <button
              key={cls}
              onClick={() => { setActiveClass(cls); setExpanded(null); }}
              style={{ padding: "10px 14px", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", border: "none", borderBottom: cls === activeClass ? "2px solid #e05a1a" : "2px solid transparent", background: "none", color: cls === activeClass ? "#e05a1a" : "#94a3b8", cursor: "pointer", whiteSpace: "nowrap" }}
            >
              {cls}
            </button>
          ))}
        </div>
      )}

      {/* Results */}
      <div style={{ paddingBottom: 80 }}>
        {uniqueRiders.length === 0 ? (
          <div style={{ padding: "48px 20px", textAlign: "center", color: "#4b5563", fontSize: 13 }}>
            {search.trim() ? "No riders found matching that name." : "No results recorded yet."}
          </div>
        ) : (
          <>
            {/* Header row */}
            <div style={{ display: "grid", gridTemplateColumns: "42px 1fr 54px 80px 80px", padding: "8px 20px", borderBottom: "1px solid #1e2740", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#374151" }}>
              <span>Pos</span>
              <span>Rider</span>
              <span style={{ textAlign: "center" }}>Laps</span>
              <span style={{ textAlign: "right" }}>Best</span>
              <span style={{ textAlign: "right" }}>Total</span>
            </div>

            {uniqueRiders.map(rider => {
              const motoResults = riderMotoResults(rider.riderId, rider.raceClass ?? "");
              const allLaps = motoResults.flatMap(m => toLapNums(m.lapTimes));
              const directLaps = toLapNums(rider.lapTimes);
              const lapsToShow = allLaps.length > 0 ? allLaps : directLaps;
              const bl = bestLapMs(lapsToShow);
              const totalMs = toTotalMs(rider.totalTime);
              const isExpanded = expanded === rider.riderId;

              return (
                <div key={rider.id} style={{ borderBottom: "1px solid #111827" }}>
                  {/* Rider row */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setExpanded(isExpanded ? null : rider.riderId)}
                    onKeyDown={e => e.key === "Enter" && setExpanded(isExpanded ? null : rider.riderId)}
                    style={{ display: "grid", gridTemplateColumns: "42px 1fr 54px 80px 80px", padding: "10px 20px", cursor: "pointer", background: isExpanded ? "#161b2e" : "transparent" }}
                  >
                    {/* Position */}
                    <div style={{ display: "flex", alignItems: "center" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: "50%", fontSize: 11, fontWeight: 800, ...posBadgeStyle(rider.position) }}>
                        {rider.dnf ? "F" : rider.dns ? "S" : (rider.position ?? "—")}
                      </span>
                    </div>
                    {/* Rider name */}
                    <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 2, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#f4f4f5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {rider.riderName}
                      </div>
                      <div style={{ fontSize: 11, color: "#6b7280" }}>
                        {search.trim() && <span style={{ background: "#1e2740", borderRadius: 3, padding: "1px 5px", marginRight: 5 }}>{rider.raceClass}</span>}
                        {rider.bibNumber && <span>#{rider.bibNumber}</span>}
                        {rider.dnf && <span style={{ color: "#ef4444", marginLeft: 4 }}>DNF</span>}
                        {rider.dns && <span style={{ color: "#6b7280", marginLeft: 4 }}>DNS</span>}
                      </div>
                    </div>
                    {/* Laps */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "#94a3b8" }}>
                      {lapsToShow.length || "—"}
                    </div>
                    {/* Best lap */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", fontSize: 12, color: "#34d399", fontVariantNumeric: "tabular-nums" }}>
                      {fmtMs(bl)}
                    </div>
                    {/* Total time */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", fontSize: 12, color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}>
                      {fmtMs(totalMs)}
                    </div>
                  </div>

                  {/* Expanded lap history */}
                  {isExpanded && (
                    <div style={{ background: "#0d1120", padding: "12px 20px 16px", borderTop: "1px solid #1a2035" }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#374151", marginBottom: 10 }}>
                        Lap History · {rider.riderName}
                      </div>

                      {motoResults.length > 0 ? (
                        motoResults.map(moto => {
                          const laps = toLapNums(moto.lapTimes);
                          const motoInfo = motos?.find(m => m.id === moto.motoId);
                          const mbl = bestLapMs(laps);
                          return (
                            <div key={moto.id} style={{ marginBottom: 14 }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: "#dc2626", marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
                                <span style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                  {motoInfo?.name ?? moto.motoName ?? `Moto`}
                                </span>
                                {moto.dnf && <span style={{ color: "#ef4444", fontSize: 10 }}>DNF</span>}
                                {moto.dns && <span style={{ color: "#6b7280", fontSize: 10 }}>DNS</span>}
                                {laps.length > 0 && (
                                  <span style={{ marginLeft: "auto", color: "#4b5563", fontSize: 10 }}>
                                    Best: <span style={{ color: "#34d399" }}>{fmtMs(mbl)}</span>
                                  </span>
                                )}
                              </div>
                              {laps.length > 0 ? (
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                                  {laps.map((lap, i) => {
                                    const isBest = mbl !== null && lap === mbl;
                                    return (
                                      <div key={i} style={{ background: isBest ? "rgba(52,211,153,0.1)" : "#161b2e", border: `1px solid ${isBest ? "rgba(52,211,153,0.35)" : "#1e2740"}`, borderRadius: 5, padding: "4px 10px", fontSize: 12, color: isBest ? "#34d399" : "#94a3b8", fontVariantNumeric: "tabular-nums" }}>
                                        <span style={{ fontSize: 9, color: isBest ? "#34d399" : "#374151", marginRight: 4 }}>L{i + 1}</span>
                                        {fmtMs(lap)}
                                        {isBest && <span style={{ fontSize: 9, marginLeft: 4 }}>★</span>}
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div style={{ fontSize: 12, color: "#374151" }}>No laps recorded.</div>
                              )}
                            </div>
                          );
                        })
                      ) : directLaps.length > 0 ? (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                          {directLaps.map((lap, i) => {
                            const isBest = bestLapMs(directLaps) === lap;
                            return (
                              <div key={i} style={{ background: isBest ? "rgba(52,211,153,0.1)" : "#161b2e", border: `1px solid ${isBest ? "rgba(52,211,153,0.35)" : "#1e2740"}`, borderRadius: 5, padding: "4px 10px", fontSize: 12, color: isBest ? "#34d399" : "#94a3b8", fontVariantNumeric: "tabular-nums" }}>
                                <span style={{ fontSize: 9, color: "#374151", marginRight: 4 }}>L{i + 1}</span>
                                {fmtMs(lap)}
                                {isBest && <span style={{ fontSize: 9, marginLeft: 4 }}>★</span>}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, color: "#374151" }}>No lap data available.</div>
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
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#0a0d16", borderTop: "1px solid #1a2035", padding: "7px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <img src={rmLogo} alt="RMMX Tracker" style={{ width: 22, height: 22, objectFit: "contain" }} />
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
            <span style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.08em", color: "#dc2626" }}>RMMX</span>
            <span style={{ fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.12em", color: "#dc2626" }}>Tracker</span>
          </div>
          {isLive && <span style={{ fontSize: 10, color: "#4b5563", marginLeft: 4 }}>· auto-updates every 30s</span>}
        </div>
        {(results?.length ?? 0) > 0 && (
          <div style={{ fontSize: 11, color: "#374151" }}>
            {new Set(results?.map(r => r.riderId)).size} riders
          </div>
        )}
      </div>

      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0f1117; }
        input::placeholder { color: #4b5563; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: #0f1117; }
        ::-webkit-scrollbar-thumb { background: #1e2740; border-radius: 2px; }
        div[role=button]:focus-visible { outline: 2px solid #e05a1a; outline-offset: -2px; }
      `}</style>
    </div>
  );
}
