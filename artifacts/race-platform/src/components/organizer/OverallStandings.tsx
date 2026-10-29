import { useState } from "react";
import { rankClassOverall } from "@/lib/classOverall";
import { olympicPenalty } from "@/lib/overallOrder";
import { useListMotos, useListResults } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Trophy } from "lucide-react";

/** Overall points standings per class (moved here from the old Enter Results tab). */
export function OverallStandings({ eventId }: { eventId: number }) {
  const [selectedClass, setSelectedClass] = useState<string>("");
  const { data: motos } = useListMotos(eventId, { query: { enabled: !!eventId } as any });
  const { data: existingResults } = useListResults(eventId, { query: { enabled: !!eventId } as any });
  const allMotos = motos ?? [];
  const raceClasses = [...new Set(allMotos.filter(m => m.raceClass).map(m => m.raceClass))].sort() as string[];
  const displayClass = selectedClass || raceClasses[0] || "";
  const classMotos = allMotos
    .filter((m) => m.raceClass === displayClass)
    .sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0));

  // ── Overall standings for the selected class ──────────────────────────────

  const parseTimeSeconds = (t: string | null | undefined): number => {
    if (!t) return Infinity;
    const m = t.match(/^(\d+):(\d+\.\d+)$/);
    return m ? parseInt(m[1]) * 60 + parseFloat(m[2]) : Infinity;
  };
  const formatSeconds = (s: number): string => {
    if (!isFinite(s)) return "–";
    const mins = Math.floor(s / 60);
    const secs = (s % 60).toFixed(3).padStart(6, "0");
    return `${mins}:${secs}`;
  };

  // Use saved results to build standings (reflects what's actually in the DB)
  const completedClassMotos = classMotos.filter(m => m.status === "completed");
  const classResults = (existingResults || []).filter((r) =>
    completedClassMotos.some((m) => m.id === r.motoId),
  );

  const riderMap = new Map<number, {
    riderName: string;
    motos: Map<number, { points: number; dnf: boolean; dns: boolean }>;
    times: Map<number, number>;
  }>();
  classResults.forEach((r) => {
    if (!riderMap.has(r.riderId)) {
      riderMap.set(r.riderId, { riderName: r.riderName, motos: new Map(), times: new Map() });
    }
    const entry = riderMap.get(r.riderId)!;
    entry.motos.set(r.motoId, { points: r.points ?? 0, dnf: r.dnf ?? false, dns: r.dns ?? false });
    entry.times.set(r.motoId, parseTimeSeconds(r.totalTime));
  });

  // Olympic tables: lowest total wins; DNF/DNS/missed motos score penalties.
  const lowerIsBetter = classResults.some((r) => (r as any).lowerIsBetter);
  const classSize = (motoId: number) => classResults.filter((r) => r.motoId === motoId).length;
  const ranking = rankClassOverall(classResults as any[], lowerIsBetter, completedClassMotos.map((m) => m.id));
  const rankByRider = new Map(ranking.map((e) => [e.result.riderId as number, e]));

  const overallStandings = Array.from(riderMap.entries())
    .map(([riderId, data]) => {
      const motoPoints = completedClassMotos.map((moto) => {
        const result = data.motos.get(moto.id);
        if (!result) return { display: "-" as string | number, value: lowerIsBetter ? olympicPenalty("dns", classSize(moto.id)) : 0 };
        if (result.dnf) return { display: "DNF", value: lowerIsBetter ? olympicPenalty("dnf", classSize(moto.id)) : 0 };
        if (result.dns) return { display: "DNS", value: lowerIsBetter ? olympicPenalty("dns", classSize(moto.id)) : 0 };
        return { display: result.points, value: result.points };
      });
      const total = lowerIsBetter ? rankByRider.get(riderId)?.total ?? 0 : motoPoints.reduce((sum, p) => sum + p.value, 0);
      const totalTimeSeconds = completedClassMotos.reduce((sum, moto) => {
        const t = data.times.get(moto.id);
        return isFinite(t ?? Infinity) ? sum + (t ?? 0) : sum;
      }, 0);
      return { riderId, riderName: data.riderName, motoPoints, total, totalTimeSeconds };
    })
    .sort((a, b) => lowerIsBetter
      ? (rankByRider.get(a.riderId)?.position ?? 999) - (rankByRider.get(b.riderId)?.position ?? 999)
      : b.total - a.total || a.totalTimeSeconds - b.totalTimeSeconds);

  const standingsWithPos: Array<(typeof overallStandings)[0] & { overallPos: number; totalTimeDisplay: string }> = [];
  for (let idx = 0; idx < overallStandings.length; idx++) {
    const row = overallStandings[idx];
    let overallPos = lowerIsBetter ? rankByRider.get(row.riderId)?.position ?? idx + 1 : idx + 1;
    if (!lowerIsBetter &&
      idx > 0 &&
      row.total === overallStandings[idx - 1].total &&
      row.totalTimeSeconds === overallStandings[idx - 1].totalTimeSeconds
    ) {
      overallPos = standingsWithPos[idx - 1]?.overallPos ?? idx + 1;
    }
    standingsWithPos.push({ ...row, overallPos, totalTimeDisplay: formatSeconds(row.totalTimeSeconds) });
  }

  const unofficial = completedClassMotos.some((m) => m.type !== "practice" && !(m as any).resultsFinalizedAt);
  if (raceClasses.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-xl font-heading font-bold uppercase tracking-tight flex items-center gap-2 mr-2">
          <Trophy className="text-primary" size={20} /> Overall Standings
        </h2>
        <Label className="font-heading font-bold uppercase tracking-wider text-xs text-muted-foreground">Class</Label>
        <Select value={displayClass} onValueChange={setSelectedClass}>
          <SelectTrigger className="w-48 font-heading font-bold uppercase tracking-wider"><SelectValue placeholder="Select a class" /></SelectTrigger>
          <SelectContent>
            {raceClasses.map((cls) => (
              <SelectItem key={cls} value={cls} className="font-heading font-bold uppercase tracking-wider">{cls}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {completedClassMotos.length > 0 && (
          <span className={`text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded ${unofficial ? "bg-amber-100 text-amber-800" : "bg-green-100 text-green-800"}`}>
            {unofficial ? "Unofficial results" : "Official results"}
          </span>
        )}
      </div>
      {completedClassMotos.length === 0 ? (
        <p className="text-sm text-muted-foreground">No finished motos in {displayClass} yet.</p>
      ) : (

            <div className="space-y-4 pt-6 border-t">
              <h2 className="text-2xl font-heading font-bold uppercase tracking-tight flex items-center gap-2">
                <Trophy className="text-primary" /> {lowerIsBetter ? "Olympic Score (lowest wins)" : "Total Points"} — {displayClass}
              </h2>

              <Card className="border-sidebar-border">
                <CardHeader className="bg-sidebar text-sidebar-foreground border-b py-3 px-6">
                  <CardTitle className="font-heading uppercase tracking-wider text-base">
                    {displayClass} — Overall Standings
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {standingsWithPos.length > 0 ? (
                    <Table>
                      <TableHeader className="bg-muted/50">
                        <TableRow>
                          <TableHead className="w-16 text-center">OA</TableHead>
                          <TableHead>Rider</TableHead>
                          {completedClassMotos.map((m) => (
                            <TableHead key={m.id} className="w-24 text-center text-xs">
                              Moto {m.motoNumber}
                            </TableHead>
                          ))}
                          <TableHead className="w-20 text-center">{lowerIsBetter ? "Score" : "Total Pts"}</TableHead>
                          <TableHead className="w-32 text-center">Total Time</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {standingsWithPos.map((row, idx) => (
                          <TableRow key={row.riderId} className={idx === 0 ? "bg-primary/5" : ""}>
                            <TableCell className="text-center">
                              <span className={`font-heading font-bold text-lg ${idx === 0 ? "text-primary" : ""}`}>
                                {row.overallPos}
                              </span>
                            </TableCell>
                            <TableCell className="font-bold">{row.riderName}</TableCell>
                            {row.motoPoints.map((p, i) => (
                              <TableCell key={i} className="text-center font-mono text-sm">
                                {p.display === "DNF" ? (
                                  <span className="text-destructive font-bold text-xs">DNF</span>
                                ) : p.display === "DNS" || p.display === "-" ? (
                                  <span className="text-muted-foreground text-xs">{p.display}</span>
                                ) : (
                                  <span className="font-bold">{p.display}</span>
                                )}
                              </TableCell>
                            ))}
                            <TableCell className="text-center">
                              <span className="font-heading font-bold text-primary text-lg">{row.total}</span>
                            </TableCell>
                            <TableCell className="text-center font-mono text-sm text-muted-foreground">
                              {row.totalTimeDisplay}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <div className="p-10 text-center text-muted-foreground">
                      Save moto results to see standings for <strong>{displayClass}</strong>.
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
      )}
    </div>
  );
}
