import { useState, useEffect, useCallback, Fragment } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Save, CheckCircle, Activity, Globe, Trophy, ChevronDown, ChevronRight,
  Plus, Trash2, Zap, Clock,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ── Lap-time utilities ────────────────────────────────────────────────────────

function parseLapMs(s: string | number): number | null {
  if (typeof s === "number") return s > 0 ? s : null;
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

function fmtMs(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const rem = ms % 60_000;
  const s = Math.floor(rem / 1_000);
  const f = rem % 1_000;
  return `${m}:${String(s).padStart(2, "0")}.${String(f).padStart(3, "0")}`;
}

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
  laps: string[];
  totalOverridden: boolean;
  bibNumber: string;
  riderName: string;
}

const DEFAULT_RIDER_STATE: RiderState = {
  pos: "", time: "", dnf: false, dns: false, laps: [],
  totalOverridden: false, bibNumber: "", riderName: "",
};

type MotoResults = Record<number, RiderState>;

// ── Lap editor ────────────────────────────────────────────────────────────────

function LapEditor({
  riderId,
  riderState,
  onChange,
  lapCount,
}: {
  riderId: number;
  riderState: RiderState;
  onChange: (riderId: number, updated: Partial<RiderState>) => void;
  lapCount?: number | null;
}) {
  const laps = riderState.laps;
  const lapErrors = laps.map((l) => l.trim() !== "" && parseLapMs(l) == null);
  const cap = lapCount != null && lapCount > 0 ? lapCount : null;

  const countingLaps = (next: string[]) => cap != null ? next.slice(0, cap) : next;

  const handleLapChange = (idx: number, val: string) => {
    const next = [...laps];
    next[idx] = val;
    let newTime = riderState.time;
    if (!riderState.totalOverridden) {
      const total = sumLaps(countingLaps(next));
      if (total != null) newTime = fmtMs(total);
    }
    onChange(riderId, { laps: next, time: newTime, totalOverridden: riderState.totalOverridden });
  };

  const handleDelete = (idx: number) => {
    const next = laps.filter((_, i) => i !== idx);
    let newTime = riderState.time;
    if (!riderState.totalOverridden) {
      const total = sumLaps(countingLaps(next));
      if (total != null) newTime = fmtMs(total);
    }
    onChange(riderId, { laps: next, time: newTime });
  };

  return (
    <div className="px-4 pb-3 pt-1 bg-muted/30 border-t space-y-1">
      {laps.length === 0 ? (
        <p className="text-xs text-muted-foreground italic py-1">No laps recorded.</p>
      ) : (
        laps.map((l, i) => (
          <Fragment key={i}>
            {cap != null && i === cap && (
              <div className="flex items-center gap-2 py-0.5">
                <div className="flex-1 border-t border-dashed border-destructive/50" />
                <span className="text-[10px] text-destructive font-semibold shrink-0 uppercase tracking-wide">
                  Race cap — laps beyond {cap} not counted
                </span>
                <div className="flex-1 border-t border-dashed border-destructive/50" />
              </div>
            )}
            <div className={`flex items-center gap-2 ${cap != null && i >= cap ? "opacity-40" : ""}`}>
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
          </Fragment>
        ))
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 text-xs text-muted-foreground hover:text-foreground gap-1 px-1 mt-1"
        onClick={() => onChange(riderId, { laps: [...laps, ""], totalOverridden: riderState.totalOverridden })}
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
  lapCount,
}: {
  moto: any;
  motoResults: MotoResults;
  onUpdate: (riderId: number, field: keyof RiderState, value: any) => void;
  onSave: (motoId: number) => void;
  saving: boolean;
  lapCount?: number | null;
}) {
  const [expandedRiders, setExpandedRiders] = useState<Set<number>>(new Set());

  const toggleRider = (riderId: number) => {
    setExpandedRiders((prev) => {
      const next = new Set(prev);
      next.has(riderId) ? next.delete(riderId) : next.add(riderId);
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

  const hasLapErrors = sortedLineup.some((e: any) => {
    const s = motoResults[e.riderId];
    return s?.laps?.some((l) => l.trim() !== "" && parseLapMs(l) == null);
  });

  return (
    <Card className="border-sidebar-border">
      <CardHeader className="bg-sidebar text-sidebar-foreground border-b flex flex-row items-center justify-between py-3 px-4">
        <div className="flex items-center gap-3">
          <span className="font-heading font-bold uppercase tracking-wider text-sm">
            Moto {moto.motoNumber}
          </span>
          {moto.name && (
            <span className="text-sidebar-foreground/70 text-sm">{moto.name}</span>
          )}
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
          {moto.status === "scheduled" && (
            <div className="flex items-center text-muted-foreground text-xs font-bold uppercase tracking-wider">
              <Clock size={13} className="mr-1" /> Scheduled
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
                  <TableHead className="w-20">Bib #</TableHead>
                  <TableHead>Rider</TableHead>
                  <TableHead className="w-16 text-center">Laps</TableHead>
                  <TableHead className="w-24 text-center">Position</TableHead>
                  <TableHead className="w-32">Total Time</TableHead>
                  <TableHead className="w-16 text-center">DNF</TableHead>
                  <TableHead className="w-16 text-center">DNS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedLineup.map((entry: any) => {
                  const row = motoResults[entry.riderId] ?? {
                    ...DEFAULT_RIDER_STATE,
                    bibNumber: entry.bibNumber ?? "", riderName: entry.riderName ?? "",
                  };
                  const isDnfDns = row.dnf || row.dns;
                  const isExpanded = expandedRiders.has(entry.riderId);

                  return (
                    <Fragment key={entry.riderId}>
                      <TableRow
                        className={isDnfDns ? "opacity-50 bg-muted/50" : ""}
                      >
                        {/* Expand toggle — clicking chevron or lap badge expands */}
                        <TableCell className="pl-3 pr-0">
                          <button
                            onClick={() => toggleRider(entry.riderId)}
                            className="text-muted-foreground hover:text-foreground transition-colors"
                          >
                            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        </TableCell>

                        {/* Editable bib # */}
                        <TableCell>
                          <Input
                            value={row.bibNumber}
                            onChange={(e) => onUpdate(entry.riderId, "bibNumber", e.target.value)}
                            placeholder="—"
                            className="w-16 text-center font-mono font-medium h-8 text-sm"
                          />
                        </TableCell>

                        {/* Editable rider name */}
                        <TableCell>
                          <Input
                            value={row.riderName}
                            onChange={(e) => onUpdate(entry.riderId, "riderName", e.target.value)}
                            className="font-bold h-8 text-sm min-w-[140px]"
                          />
                        </TableCell>

                        {/* Lap count — click to expand/collapse lap times */}
                        <TableCell className="text-center">
                          <button
                            onClick={() => toggleRider(entry.riderId)}
                            title={isExpanded ? "Collapse lap times" : "View lap times"}
                            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-mono font-semibold transition-colors ${
                              isExpanded
                                ? "bg-primary text-primary-foreground"
                                : row.laps.length > 0
                                  ? "bg-muted hover:bg-muted-foreground/20 text-foreground"
                                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
                            }`}
                          >
                            {row.laps.length > 0 ? row.laps.length : "—"}
                            {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                          </button>
                        </TableCell>

                        {/* Position */}
                        <TableCell>
                          <Input
                            value={row.pos}
                            onChange={(e) => onUpdate(entry.riderId, "pos", e.target.value)}
                            className="w-16 text-center font-heading font-bold text-lg h-9 mx-auto"
                            disabled={isDnfDns}
                          />
                        </TableCell>

                        {/* Total time */}
                        <TableCell>
                          <Input
                            value={row.time}
                            onChange={(e) => {
                              onUpdate(entry.riderId, "time", e.target.value);
                              onUpdate(entry.riderId, "totalOverridden", true);
                            }}
                            placeholder="0:00.000"
                            className="font-mono text-sm h-9"
                            disabled={isDnfDns}
                          />
                        </TableCell>

                        {/* DNF */}
                        <TableCell className="text-center">
                          <UISwitch
                            checked={row.dnf}
                            onCheckedChange={(v) => onUpdate(entry.riderId, "dnf", v)}
                          />
                        </TableCell>

                        {/* DNS */}
                        <TableCell className="text-center">
                          <UISwitch
                            checked={row.dns}
                            onCheckedChange={(v) => onUpdate(entry.riderId, "dns", v)}
                          />
                        </TableCell>
                      </TableRow>

                      {/* Expandable lap editor */}
                      {isExpanded && (
                        <TableRow>
                          <TableCell colSpan={8} className="p-0">
                            <LapEditor
                              riderId={entry.riderId}
                              riderState={row}
                              lapCount={lapCount}
                              onChange={(rid, updated) => {
                                for (const [k, v] of Object.entries(updated)) {
                                  onUpdate(rid, k as keyof RiderState, v);
                                }
                              }}
                            />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
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
          <div className="p-8 text-center text-muted-foreground">No lineup assigned to this moto yet.</div>
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
  const [allMotoResults, setAllMotoResults] = useState<Record<number, MotoResults>>({});
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

  // All motos (any status) — organizer may need to enter results for any moto
  const allMotos = (motos || []);

  // Derive class list from all motos that have a class assigned
  const raceClasses = [...new Set(
    allMotos.filter(m => m.raceClass).map(m => m.raceClass)
  )].sort() as string[];
  const displayClass = selectedClass || raceClasses[0] || "";

  const classMotos = allMotos
    .filter((m) => m.raceClass === displayClass)
    .sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0));

  // Initialize moto state from server data (once per moto)
  useEffect(() => {
    if (!existingResults || !motos) return;
    for (const moto of allMotos) {
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
          laps: Array.isArray(existing?.lapTimes)
            ? (existing!.lapTimes as Array<string | number>)
                .slice(0, moto.lapCount != null ? moto.lapCount : undefined)
                .map((l) => typeof l === "number" ? fmtMs(l) : l)
            : [],
          totalOverridden: false,
          bibNumber: existing?.bibNumber ?? entry.bibNumber ?? "",
          riderName: existing?.riderName ?? entry.riderName ?? "",
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
          [riderId]: { ...DEFAULT_RIDER_STATE, ...prev[motoId]?.[riderId], [field]: value },
        },
      }));
    },
    [],
  );

  const handleSave = useCallback(
    (motoId: number) => {
      const moto = allMotos.find((m) => m.id === motoId);
      if (!moto?.lineup) return;
      const motoResults = allMotoResults[motoId] ?? {};

      const results = moto.lineup.map((entry: any) => {
        const data = motoResults[entry.riderId] ?? {
          pos: "", time: "", dnf: false, dns: false, laps: [],
          totalOverridden: false, bibNumber: "", riderName: "",
        };
        const lapCap = moto.lapCount != null && moto.lapCount > 0 ? moto.lapCount : data.laps.length;
        const lapTimesMs = data.laps
          .slice(0, lapCap)
          .map((l) => parseLapMs(l))
          .filter((ms): ms is number => ms != null)
          .map((ms) => fmtMs(ms));
        return {
          riderId:    entry.riderId,
          position:   parseInt(data.pos) || 999,
          totalTime:  data.time || undefined,
          dnf:        data.dnf,
          dns:        data.dns,
          lapTimes:   lapTimesMs,
          bibNumber:  data.bibNumber || undefined,
          riderName:  data.riderName || undefined,
        };
      });

      setSavingMotoId(motoId);
      submitMutation.mutate(
        { eventId, data: { motoId, results } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListResultsQueryKey(eventId) });
            queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
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
    [allMotoResults, allMotos, eventId, submitMutation, queryClient, toast],
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

  // Use saved results to build standings (reflects what's actually in the DB)
  const completedClassMotos = classMotos.filter(m => m.status === "completed" || m.status === "in_progress");
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

  const overallStandings = Array.from(riderMap.entries())
    .map(([riderId, data]) => {
      const motoPoints = completedClassMotos.map((moto) => {
        const result = data.motos.get(moto.id);
        if (!result) return { display: "-" as string | number, value: 0 };
        if (result.dnf) return { display: "DNF", value: 0 };
        if (result.dns) return { display: "DNS", value: 0 };
        return { display: result.points, value: result.points };
      });
      const total = motoPoints.reduce((sum, p) => sum + p.value, 0);
      const totalTimeSeconds = completedClassMotos.reduce((sum, moto) => {
        const t = data.times.get(moto.id);
        return isFinite(t ?? Infinity) ? sum + (t ?? 0) : sum;
      }, 0);
      return { riderId, riderName: data.riderName, motoPoints, total, totalTimeSeconds };
    })
    .sort((a, b) => b.total - a.total || a.totalTimeSeconds - b.totalTimeSeconds);

  const standingsWithPos: Array<(typeof overallStandings)[0] & { overallPos: number; totalTimeDisplay: string }> = [];
  for (let idx = 0; idx < overallStandings.length; idx++) {
    const row = overallStandings[idx];
    let overallPos = idx + 1;
    if (
      idx > 0 &&
      row.total === overallStandings[idx - 1].total &&
      row.totalTimeSeconds === overallStandings[idx - 1].totalTimeSeconds
    ) {
      overallPos = standingsWithPos[idx - 1]?.overallPos ?? idx + 1;
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
          <p className="text-muted-foreground mt-1">Review and edit results for each moto. All fields are editable.</p>
        </div>
        <div className="flex items-center gap-4 bg-muted p-2 rounded-lg border">
          <Globe size={18} className="text-muted-foreground ml-2" />
          <Label htmlFor="publish-results" className="font-heading font-bold uppercase tracking-wider cursor-pointer">
            Publish to Web
          </Label>
          <UISwitch id="publish-results" onCheckedChange={handlePublish} />
        </div>
      </div>

      {raceClasses.length === 0 ? (
        <Card>
          <CardContent className="p-16 text-center">
            <Activity className="mx-auto text-muted-foreground opacity-20 mb-4" size={48} />
            <h3 className="text-xl font-heading font-bold mb-2">No Motos Found</h3>
            <p className="text-muted-foreground">
              Create motos with lineups on the Motos tab first.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Class selector dropdown */}
          <div className="flex items-center gap-3">
            <Label className="font-heading font-bold uppercase tracking-wider text-sm text-muted-foreground shrink-0">
              Class
            </Label>
            <Select value={displayClass} onValueChange={setSelectedClass}>
              <SelectTrigger className="w-56 font-heading font-bold uppercase tracking-wider">
                <SelectValue placeholder="Select a class" />
              </SelectTrigger>
              <SelectContent>
                {raceClasses.map((cls) => (
                  <SelectItem key={cls} value={cls} className="font-heading font-bold uppercase tracking-wider">
                    {cls}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {classMotos.length > 0 && (
              <span className="text-sm text-muted-foreground">
                {classMotos.length} moto{classMotos.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>

          {/* All motos for the selected class */}
          {classMotos.length === 0 ? (
            <Card>
              <CardContent className="p-10 text-center text-muted-foreground">
                No motos found for <strong>{displayClass}</strong>.
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
                  lapCount={(moto as any).lapCount ?? null}
                />
              ))}
            </div>
          )}

          {/* Total points standings — always at the bottom */}
          {completedClassMotos.length > 0 && (
            <div className="space-y-4 pt-6 border-t">
              <h2 className="text-2xl font-heading font-bold uppercase tracking-tight flex items-center gap-2">
                <Trophy className="text-primary" /> Total Points — {displayClass}
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
                          <TableHead className="w-20 text-center">Total Pts</TableHead>
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
        </>
      )}
    </div>
  );
}
