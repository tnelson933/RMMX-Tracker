import { useState, useEffect, useCallback } from "react";
import { useRoute } from "wouter";
import {
  useListMotos,
  useListResults,
  useSubmitResults,
  usePublishResults,
  getListResultsQueryKey,
  getListMotosQueryKey,
  getGetEventQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch as UISwitch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Save, CheckCircle, Activity, Globe, Trophy, ChevronDown, ChevronRight,
  Plus, Trash2, Zap,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ── Lap-time utilities ────────────────────────────────────────────────────────

/** Parse "M:SS.mmm" or "M:SS.mm" or "SS.mmm" into milliseconds, null if invalid. */
function parseLapMs(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const full = t.match(/^(\d+):(\d{2})\.(\d{1,3})$/);
  if (full) {
    const ms = parseInt(full[1]) * 60_000 + parseInt(full[2]) * 1_000 + parseInt(full[3].padEnd(3, "0"));
    return ms > 0 ? ms : null;
  }
  const sec = t.match(/^(\d+)\.(\d{1,3})$/);
  if (sec) {
    const ms = parseInt(sec[1]) * 1_000 + parseInt(sec[2].padEnd(3, "0"));
    return ms > 0 ? ms : null;
  }
  return null;
}

/** Format milliseconds as "M:SS.mmm". */
function fmtMs(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const rem = ms % 60_000;
  const s = Math.floor(rem / 1_000);
  const f = rem % 1_000;
  return `${m}:${String(s).padStart(2, "0")}.${String(f).padStart(3, "0")}`;
}

/** Sum lap strings to milliseconds total, null if any lap is invalid. */
function sumLaps(laps: string[]): number | null {
  let total = 0;
  for (const l of laps) {
    const ms = parseLapMs(l);
    if (ms == null) return null;
    total += ms;
  }
  return total;
}

// ── Per-rider state ───────────────────────────────────────────────────────────

interface RiderState {
  pos: string;
  time: string;
  dnf: boolean;
  dns: boolean;
  laps: string[];           // editable lap time strings
  totalOverridden: boolean; // true when organizer manually edited totalTime
}

type MotoResults = Record<number, RiderState>;

// ── Lap row component ─────────────────────────────────────────────────────────

function LapEditor({
  riderId,
  riderState,
  onChange,
}: {
  riderId: number;
  riderState: RiderState;
  onChange: (riderId: number, updated: Partial<RiderState>) => void;
}) {
  const laps = riderState.laps;

  const handleLapChange = (idx: number, val: string) => {
    const next = [...laps];
    next[idx] = val;
    const newLaps = next;
    let newTime = riderState.time;
    let overridden = riderState.totalOverridden;
    if (!overridden) {
      const total = sumLaps(newLaps);
      if (total != null) { newTime = fmtMs(total); }
    }
    onChange(riderId, { laps: newLaps, time: newTime, totalOverridden: overridden });
  };

  const handleDelete = (idx: number) => {
    const next = laps.filter((_, i) => i !== idx);
    let newTime = riderState.time;
    if (!riderState.totalOverridden) {
      const total = sumLaps(next);
      if (total != null) newTime = fmtMs(total);
    }
    onChange(riderId, { laps: next, time: newTime });
  };

  const handleAdd = () => {
    onChange(riderId, { laps: [...laps, ""], totalOverridden: riderState.totalOverridden });
  };

  const lapErrors = laps.map((l) => l.trim() !== "" && parseLapMs(l) == null);

  return (
    <div className="px-4 pb-3 pt-1 bg-muted/30 border-t space-y-1">
      {laps.length === 0 ? (
        <p className="text-xs text-muted-foreground italic py-1">No laps recorded.</p>
      ) : (
        laps.map((l, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-muted-foreground w-8 text-right shrink-0">
              {i + 1}
            </span>
            <Input
              value={l}
              onChange={(e) => handleLapChange(i, e.target.value)}
              placeholder="M:SS.mmm"
              className={`h-7 text-xs font-mono flex-1 ${lapErrors[i] ? "border-destructive focus-visible:ring-destructive" : ""}`}
            />
            {lapErrors[i] && (
              <span className="text-[10px] text-destructive shrink-0">invalid</span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => handleDelete(i)}
            >
              <Trash2 size={12} />
            </Button>
          </div>
        ))
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 text-xs text-muted-foreground hover:text-foreground gap-1 px-1 mt-1"
        onClick={handleAdd}
      >
        <Plus size={11} /> Add lap
      </Button>
    </div>
  );
}

// ── Moto section ──────────────────────────────────────────────────────────────

function MotoSection({
  moto,
  motoResults,
  onUpdate,
  onSave,
  saving,
}: {
  moto: any;
  motoResults: MotoResults;
  onUpdate: (riderId: number, field: keyof RiderState, value: any) => void;
  onSave: (motoId: number) => void;
  saving: boolean;
}) {
  const [expandedRiders, setExpandedRiders] = useState<Set<number>>(new Set());

  const toggleRider = (riderId: number) => {
    setExpandedRiders((prev) => {
      const next = new Set(prev);
      if (next.has(riderId)) next.delete(riderId);
      else next.add(riderId);
      return next;
    });
  };

  const isCompleted = moto.status === "completed";
  const hasLineup = moto.lineup && moto.lineup.length > 0;

  const sortedLineup = hasLineup
    ? [...moto.lineup].sort((a: any, b: any) => {
        const aD = motoResults[a.riderId];
        const bD = motoResults[b.riderId];
        if ((aD?.dnf || aD?.dns) && !(bD?.dnf || bD?.dns)) return 1;
        if (!(aD?.dnf || aD?.dns) && (bD?.dnf || bD?.dns)) return -1;
        return (parseInt(aD?.pos) || 999) - (parseInt(bD?.pos) || 999);
      })
    : [];

  // Validation: any lap with a non-empty invalid string blocks save
  const hasLapErrors = sortedLineup.some((e: any) => {
    const s = motoResults[e.riderId];
    return s?.laps.some((l) => l.trim() !== "" && parseLapMs(l) == null);
  });

  return (
    <Card className="border-sidebar-border">
      <CardHeader className="bg-sidebar text-sidebar-foreground border-b flex flex-row items-center justify-between py-3 px-4">
        <div className="flex items-center gap-3">
          <span className="font-heading font-bold uppercase tracking-wider text-sm">
            Moto {moto.motoNumber}
          </span>
          <span className="text-sidebar-foreground/70 text-sm">{moto.name}</span>
        </div>
        <div className="flex items-center gap-3">
          {isCompleted && (
            <div className="flex items-center text-secondary text-xs font-bold uppercase tracking-wider">
              <CheckCircle size={13} className="mr-1" /> Completed
            </div>
          )}
          {moto.status === "in_progress" && (
            <div className="flex items-center text-amber-400 text-xs font-bold uppercase tracking-wider">
              <Zap size={13} className="mr-1" /> In Progress
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {hasLineup ? (
          <>
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="w-6 pl-3" />
                  <TableHead className="w-14">#</TableHead>
                  <TableHead>Rider</TableHead>
                  <TableHead className="w-20 text-center">Laps</TableHead>
                  <TableHead className="w-24 text-center">Position</TableHead>
                  <TableHead className="w-32">Total Time</TableHead>
                  <TableHead className="w-16 text-center">DNF</TableHead>
                  <TableHead className="w-16 text-center">DNS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedLineup.map((entry: any) => {
                  const row = motoResults[entry.riderId] ?? {
                    pos: "", time: "", dnf: false, dns: false, laps: [], totalOverridden: false,
                  };
                  const isDnfDns = row.dnf || row.dns;
                  const isExpanded = expandedRiders.has(entry.riderId);

                  const handleTimeChange = (val: string) => {
                    onUpdate(entry.riderId, "time" as any, val);
                    // Mark overridden only when the user manually edits the field
                    onUpdate(entry.riderId, "totalOverridden" as any, true);
                  };

                  return (
                    <>
                      <TableRow
                        key={entry.riderId}
                        className={`${isDnfDns ? "opacity-50 bg-muted/50" : ""} cursor-pointer hover:bg-muted/30`}
                        onClick={() => toggleRider(entry.riderId)}
                      >
                        <TableCell className="pl-3 pr-0">
                          {isExpanded ? (
                            <ChevronDown size={14} className="text-muted-foreground" />
                          ) : (
                            <ChevronRight size={14} className="text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell className="font-mono font-medium">{entry.bibNumber || "—"}</TableCell>
                        <TableCell className="font-bold">{entry.riderName}</TableCell>
                        <TableCell className="text-center text-sm font-mono">
                          {row.laps.length > 0 ? row.laps.length : "—"}
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Input
                            value={row.pos}
                            onChange={(e) => onUpdate(entry.riderId, "pos", e.target.value)}
                            className="w-16 text-center font-heading font-bold text-lg h-9 mx-auto"
                            disabled={isDnfDns}
                          />
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Input
                            value={row.time}
                            onChange={(e) => handleTimeChange(e.target.value)}
                            placeholder="0:00.000"
                            className="font-mono text-sm h-9"
                            disabled={isDnfDns}
                          />
                        </TableCell>
                        <TableCell className="text-center" onClick={(e) => e.stopPropagation()}>
                          <UISwitch
                            checked={row.dnf}
                            onCheckedChange={(v) => onUpdate(entry.riderId, "dnf", v)}
                          />
                        </TableCell>
                        <TableCell className="text-center" onClick={(e) => e.stopPropagation()}>
                          <UISwitch
                            checked={row.dns}
                            onCheckedChange={(v) => onUpdate(entry.riderId, "dns", v)}
                          />
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow key={`${entry.riderId}-laps`}>
                          <TableCell colSpan={8} className="p-0">
                            <LapEditor
                              riderId={entry.riderId}
                              riderState={row}
                              onChange={(rid, updated) => {
                                for (const [k, v] of Object.entries(updated)) {
                                  onUpdate(rid, k as keyof RiderState, v);
                                }
                              }}
                            />
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  );
                })}
              </TableBody>
            </Table>
            <div className="p-4 bg-muted/30 border-t flex items-center justify-between">
              {hasLapErrors && (
                <span className="text-xs text-destructive font-medium">
                  Fix invalid lap times before saving.
                </span>
              )}
              <div className="ml-auto">
                <Button
                  onClick={() => onSave(moto.id)}
                  disabled={saving || hasLapErrors}
                  className="font-heading uppercase tracking-wider"
                >
                  <Save size={16} className="mr-2" /> Save Moto {moto.motoNumber}
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="p-8 text-center text-muted-foreground">No lineup found for this moto.</div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function EnterResults() {
  const [, params] = useRoute("/events/:eventId/results");
  const eventId = parseInt(params?.eventId || "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [selectedClass, setSelectedClass] = useState<string>("");
  // motoId → riderId → RiderState
  const [allMotoResults, setAllMotoResults] = useState<Record<number, MotoResults>>({});
  // which moto IDs we've already loaded from server (to avoid overwriting edits on refetch)
  const [initializedMotos, setInitializedMotos] = useState<Set<number>>(new Set());
  const [savingMotoId, setSavingMotoId] = useState<number | null>(null);

  const { data: motos, isLoading: motosLoading } = useListMotos(eventId, {
    query: { enabled: !!eventId } as any,
  });
  const { data: existingResults } = useListResults(eventId, {
    query: { enabled: !!eventId } as any,
  });

  const submitMutation = useSubmitResults();
  const publishMutation = usePublishResults();

  // Derive class list and active motos
  const allActiveMotes = (motos || []).filter(
    (m) => m.status === "completed" || m.status === "in_progress",
  );
  const raceClasses = [...new Set(allActiveMotes.map((m) => m.raceClass))].sort() as string[];
  const displayClass = selectedClass || raceClasses[0] || "";

  const classMotos = allActiveMotes
    .filter((m) => m.raceClass === displayClass)
    .sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0));

  // Initialize moto state from server data (once per moto, not on every refetch)
  useEffect(() => {
    if (!existingResults || !motos) return;
    for (const moto of allActiveMotes) {
      if (initializedMotos.has(moto.id)) continue;
      if (!moto.lineup) continue;
      const motoResults: MotoResults = {};
      const motoRes = existingResults.filter((r) => r.motoId === moto.id);
      moto.lineup.forEach((entry: any, idx: number) => {
        const existing = motoRes.find((r) => r.riderId === entry.riderId);
        motoResults[entry.riderId] = {
          pos: existing ? existing.position.toString() : (idx + 1).toString(),
          time: existing?.totalTime ?? "",
          dnf: existing?.dnf ?? false,
          dns: existing?.dns ?? false,
          laps: Array.isArray(existing?.lapTimes) ? (existing!.lapTimes as string[]) : [],
          totalOverridden: false,
        };
      });
      setAllMotoResults((prev) => ({ ...prev, [moto.id]: motoResults }));
      setInitializedMotos((prev) => new Set([...prev, moto.id]));
    }
  }, [existingResults, motos]);

  const handleUpdate = useCallback(
    (motoId: number, riderId: number, field: keyof RiderState, value: any) => {
      setAllMotoResults((prev) => ({
        ...prev,
        [motoId]: {
          ...prev[motoId],
          [riderId]: { ...prev[motoId]?.[riderId], [field]: value },
        },
      }));
    },
    [],
  );

  const handleSave = useCallback(
    (motoId: number) => {
      const moto = allActiveMotes.find((m) => m.id === motoId);
      if (!moto?.lineup) return;
      const motoResults = allMotoResults[motoId] ?? {};

      const results = moto.lineup.map((entry: any) => {
        const data = motoResults[entry.riderId] ?? {
          pos: "", time: "", dnf: false, dns: false, laps: [], totalOverridden: false,
        };
        // Convert lap strings to ms integers for the API
        const lapTimesMs = data.laps
          .map((l) => parseLapMs(l))
          .filter((ms): ms is number => ms != null)
          .map((ms) => fmtMs(ms));
        return {
          riderId: entry.riderId,
          position: parseInt(data.pos) || 999,
          totalTime: data.time || undefined,
          dnf: data.dnf,
          dns: data.dns,
          lapTimes: lapTimesMs,
        };
      });

      setSavingMotoId(motoId);
      submitMutation.mutate(
        { eventId, data: { motoId, results } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListResultsQueryKey(eventId) });
            toast({ title: `Moto ${moto.motoNumber} results saved` });
            setSavingMotoId(null);
          },
          onError: (err) => {
            toast({ title: "Failed to save", description: err.message, variant: "destructive" });
            setSavingMotoId(null);
          },
        },
      );
    },
    [allMotoResults, allActiveMotes, eventId, submitMutation, queryClient, toast],
  );

  const handlePublish = (published: boolean) => {
    publishMutation.mutate(
      { eventId, data: { published } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetEventQueryKey(eventId) });
          toast({ title: published ? "Results published" : "Results unpublished" });
        },
      },
    );
  };

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

  const classResults = (existingResults || []).filter((r) =>
    classMotos.some((m) => m.id === r.motoId),
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

  const overallStandings = Array.from(riderMap.entries())
    .map(([riderId, data]) => {
      const motoPoints = classMotos.map((moto) => {
        const result = data.motos.get(moto.id);
        if (!result) return { display: "-" as string | number, value: 0 };
        if (result.dnf) return { display: "DNF", value: 0 };
        if (result.dns) return { display: "DNS", value: 0 };
        return { display: result.points, value: result.points };
      });
      const total = motoPoints.reduce((sum, p) => sum + p.value, 0);
      const totalTimeSeconds = classMotos.reduce((sum, moto) => {
        const t = data.times.get(moto.id);
        return isFinite(t ?? Infinity) ? sum + (t ?? 0) : sum;
      }, 0);
      return { riderId, riderName: data.riderName, motoPoints, total, totalTimeSeconds };
    })
    .sort((a, b) => b.total - a.total || a.totalTimeSeconds - b.totalTimeSeconds);

  const standingsWithPos: Array<(typeof overallStandings)[number] & { overallPos: number; totalTimeDisplay: string }> = [];
  for (let idx = 0; idx < overallStandings.length; idx++) {
    const row = overallStandings[idx];
    let overallPos = idx + 1;
    if (
      idx > 0 &&
      row.total === overallStandings[idx - 1].total &&
      row.totalTimeSeconds === overallStandings[idx - 1].totalTimeSeconds
    ) {
      overallPos = standingsWithPos[idx - 1].overallPos;
    }
    standingsWithPos.push({ ...row, overallPos, totalTimeDisplay: formatSeconds(row.totalTimeSeconds) });
  }

  // ─────────────────────────────────────────────────────────────────────────

  if (motosLoading) return <div className="p-8">Loading...</div>;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-heading font-bold uppercase tracking-tight flex items-center gap-2">
            <Activity className="text-primary" /> Enter Results
          </h2>
          <p className="text-muted-foreground mt-1">Record finishes for completed motos.</p>
        </div>
        <div className="flex items-center gap-4 bg-muted p-2 rounded-lg border">
          <Globe size={18} className="text-muted-foreground ml-2" />
          <Label htmlFor="publish-results" className="font-heading font-bold uppercase tracking-wider cursor-pointer">
            Publish to Web
          </Label>
          <UISwitch id="publish-results" onCheckedChange={handlePublish} />
        </div>
      </div>

      {allActiveMotes.length === 0 ? (
        <Card>
          <CardContent className="p-16 text-center">
            <Activity className="mx-auto text-muted-foreground opacity-20 mb-4" size={48} />
            <h3 className="text-xl font-heading font-bold mb-2">No Active Motos</h3>
            <p className="text-muted-foreground">
              Start and complete motos on the Motos tab before entering results.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Class selector */}
          <div className="flex flex-wrap gap-2">
            {raceClasses.map((cls) => (
              <button
                key={cls}
                onClick={() => setSelectedClass(cls)}
                className={`px-4 py-1.5 rounded-full text-sm font-heading font-bold uppercase tracking-wider border transition-colors ${
                  displayClass === cls
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-muted text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
                }`}
              >
                {cls}
              </button>
            ))}
          </div>

          {/* Moto sections */}
          {classMotos.length === 0 ? (
            <Card>
              <CardContent className="p-10 text-center text-muted-foreground">
                No completed or in-progress motos for <strong>{displayClass}</strong>.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {classMotos.map((moto) => (
                <MotoSection
                  key={moto.id}
                  moto={moto}
                  motoResults={allMotoResults[moto.id] ?? {}}
                  onUpdate={(riderId, field, value) => handleUpdate(moto.id, riderId, field, value)}
                  onSave={handleSave}
                  saving={savingMotoId === moto.id}
                />
              ))}
            </div>
          )}

          {/* Overall standings */}
          {raceClasses.length > 0 && (
            <div className="space-y-4 pt-4">
              <h2 className="text-2xl font-heading font-bold uppercase tracking-tight flex items-center gap-2">
                <Trophy className="text-primary" /> Class Overall Standings
              </h2>

              <Card className="border-sidebar-border">
                <CardHeader className="bg-sidebar text-sidebar-foreground border-b py-3 px-6">
                  <CardTitle className="font-heading uppercase tracking-wider text-base">
                    {displayClass} — Overall
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {standingsWithPos.length > 0 ? (
                    <Table>
                      <TableHeader className="bg-muted/50">
                        <TableRow>
                          <TableHead className="w-16 text-center">OA Pos</TableHead>
                          <TableHead>Rider</TableHead>
                          {classMotos.map((m) => (
                            <TableHead key={m.id} className="w-24 text-center text-xs">
                              Moto {m.motoNumber}
                            </TableHead>
                          ))}
                          <TableHead className="w-20 text-center">Points</TableHead>
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
                              <span className="font-heading font-bold text-primary">{row.total}</span>
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
                      No completed moto results for <strong>{displayClass}</strong> yet.
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  );
}
