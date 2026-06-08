export function StatsEmail() {
  const riderName = "Tyler Johnson";
  const eventName = "Desert Classic 2026";
  const eventDate = "Saturday, June 7, 2026 — Chandler, AZ";

  const results = [
    {
      motoName: "Moto 1",
      raceClass: "250cc Open",
      position: 1,
      totalTime: "18:42.331",
      lapTimes: ["3:42.1", "3:38.4", "3:41.8", "3:52.7", "3:47.3"],
      points: 25,
      dnf: false,
      dns: false,
    },
    {
      motoName: "Moto 2",
      raceClass: "250cc Open",
      position: 3,
      totalTime: "19:05.812",
      lapTimes: ["3:51.2", "3:49.6", "3:55.1", "3:44.9", "3:45.0"],
      points: 16,
      dnf: false,
      dns: false,
    },
    {
      motoName: "Moto 3",
      raceClass: "250cc Open",
      position: 2,
      totalTime: "18:58.204",
      lapTimes: ["3:47.0", "3:45.3", "3:52.6", "3:48.1", "3:45.2"],
      points: 20,
      dnf: false,
      dns: false,
    },
  ];

  const ordinal = (n: number) => {
    if (n === 1) return "1st";
    if (n === 2) return "2nd";
    if (n === 3) return "3rd";
    return `${n}th`;
  };

  const totalPoints = results.reduce((sum, r) => sum + (r.points ?? 0), 0);

  return (
    <div style={{ background: "#f0f0f0", minHeight: "100vh", padding: "32px 16px", fontFamily: "Arial, sans-serif" }}>
      {/* Email client chrome hint */}
      <div style={{ maxWidth: 680, margin: "0 auto 12px", fontSize: 12, color: "#999", textAlign: "right" }}>
        Preview: Race Day Stats Email
      </div>

      <div style={{ maxWidth: 680, margin: "0 auto", background: "#fff", border: "1px solid #e5e5e5", borderRadius: 8, overflow: "hidden" }}>

        {/* Header */}
        <div style={{ background: "#111", padding: "28px 32px" }}>
          <p style={{ margin: "0 0 4px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 2, color: "#dc2626" }}>
            Race Day Stats
          </p>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1, color: "#fff" }}>
            {eventName}
          </h1>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "#888" }}>{eventDate}</p>
        </div>

        {/* Greeting */}
        <div style={{ padding: "28px 32px 0" }}>
          <p style={{ margin: "0 0 20px", fontSize: 15, color: "#444", lineHeight: 1.6 }}>
            Hey {riderName}, here are your results from {eventName}. Great riding out there!
          </p>
        </div>

        {/* Results table */}
        <div style={{ padding: "0 32px 28px", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #111" }}>
                {["Moto", "Finish", "Total Time", "Lap Times", "Points"].map((h, i) => (
                  <th key={h} style={{
                    padding: "8px 12px 10px",
                    textAlign: i === 0 || i === 3 ? "left" : "center",
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: 1,
                    color: "#888"
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const finishLabel = r.dns ? "DNS" : r.dnf ? "DNF" : ordinal(r.position);
                const finishColor = r.dns || r.dnf ? "#999" : r.position === 1 ? "#dc2626" : "#111";
                return (
                  <tr key={r.motoName}>
                    {/* Moto + class */}
                    <td style={{ padding: "14px 12px", borderBottom: "1px solid #f0f0f0", verticalAlign: "top" }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: "#111" }}>{r.motoName}</div>
                      <div style={{ fontSize: 12, color: "#888", marginTop: 2, textTransform: "uppercase", letterSpacing: 0.5 }}>{r.raceClass}</div>
                    </td>
                    {/* Finish */}
                    <td style={{ padding: "14px 12px", borderBottom: "1px solid #f0f0f0", textAlign: "center", verticalAlign: "top" }}>
                      <span style={{ fontSize: 22, fontWeight: 800, color: finishColor }}>{finishLabel}</span>
                    </td>
                    {/* Total time */}
                    <td style={{ padding: "14px 12px", borderBottom: "1px solid #f0f0f0", textAlign: "center", verticalAlign: "top" }}>
                      <span style={{ fontFamily: "monospace", fontSize: 14, color: "#333" }}>{r.totalTime}</span>
                    </td>
                    {/* Lap times */}
                    <td style={{ padding: "14px 12px", borderBottom: "1px solid #f0f0f0", verticalAlign: "top" }}>
                      {r.lapTimes.map((t, i) => (
                        <span key={i} style={{
                          display: "inline-block", margin: "2px 4px 2px 0",
                          padding: "2px 8px", background: "#f3f3f3",
                          borderRadius: 3, fontSize: 12, fontFamily: "monospace", color: "#555"
                        }}>
                          L{i + 1}: {t}
                        </span>
                      ))}
                    </td>
                    {/* Points */}
                    <td style={{ padding: "14px 12px", borderBottom: "1px solid #f0f0f0", textAlign: "center", verticalAlign: "top" }}>
                      <span style={{ fontWeight: 700, color: "#dc2626" }}>{r.points ?? 0} pts</span>
                    </td>
                  </tr>
                );
              })}
              {/* Totals row */}
              <tr>
                <td colSpan={4} style={{ padding: "12px 12px", textAlign: "right", fontSize: 13, fontWeight: 700, color: "#555", textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Total Points Earned
                </td>
                <td style={{ padding: "12px 12px", textAlign: "center" }}>
                  <span style={{ fontSize: 18, fontWeight: 800, color: "#dc2626" }}>{totalPoints} pts</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* CTA */}
        <div style={{ padding: "20px 32px 32px", borderTop: "1px solid #f0f0f0" }}>
          <a
            href="#"
            style={{
              display: "inline-block", padding: "12px 24px",
              background: "#dc2626", color: "#fff",
              textDecoration: "none", fontWeight: 700,
              fontSize: 13, textTransform: "uppercase",
              letterSpacing: 1, borderRadius: 4
            }}
          >
            View Full Event Results
          </a>
          <p style={{ margin: "16px 0 0", fontSize: 12, color: "#aaa" }}>
            You opted in to receive race day stats when you registered. To stop receiving these emails, reply and let us know.
          </p>
        </div>

      </div>
    </div>
  );
}
