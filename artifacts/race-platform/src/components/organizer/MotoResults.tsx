import { useState, useEffect, useCallback, Fragment } from "react";
import {
  useListResults,
  useSubmitResults,
  getListResultsQueryKey,
  getListMotosQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch as UISwitch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Save, CheckCircle, Activity, ChevronDown, ChevronRight,
  Plus, Trash2, Zap, Clock, BadgeCheck, RotateCcw, Loader2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Reviewing a finished moto's results on Race Day Management: positions, total
// time, laps, DNF/DNS, then Finalize Race to make the results official. Results
// are public as "Unofficial results" until then.

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
        (cap != null ? laps.slice(0, cap) : laps).map((l, i) => (
          <Fragment key={i}>
            <div className="flex items-center gap-2">
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

/** Review & finalize one moto (used in a dialog on Race Day Management). */
export function MotoResultsReview({ eventId, moto, onFinalized }: { eventId: number; moto: any; onFinalized?: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: existingResults } = useListResults(eventId, { query: { enabled: !!eventId } as any });
  const submitMutation = useSubmitResults();
  const [motoResults, setMotoResults] = useState<MotoResults | null>(null);
  const [saving, setSaving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const official = !!moto.resultsFinalizedAt;

  // Start from the stored results, in their stored finishing order.
  useEffect(() => {
    if (!existingResults || motoResults || !moto.lineup) return;
    const init: MotoResults = {};
    const motoRes = existingResults.filter((r) => r.motoId === moto.id);
    (moto.lineup as any[]).forEach((entry: any, idx: number) => {
      const existing = motoRes.find((r) => r.riderId === entry.riderId);
      init[entry.riderId] = {
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
    // Riders with no result yet follow the stored order, in lineup order.
    if (motoRes.length > 0) {
      let next = Math.max(0, ...motoRes.map((r) => r.position).filter((p) => p < 999)) + 1;
      for (const entry of moto.lineup as any[]) {
        if (!motoRes.some((r) => r.riderId === entry.riderId) && init[entry.riderId]) init[entry.riderId].pos = (next++).toString();
      }
    }
    setMotoResults(init);
  }, [existingResults, moto, motoResults]);

  const onUpdate = useCallback((riderId: number, field: keyof RiderState, value: any) => {
    setMotoResults((prev) => ({
      ...(prev ?? {}),
      [riderId]: { ...DEFAULT_RIDER_STATE, ...prev?.[riderId], [field]: value },
    }));
  }, []);

  const buildPayload = () => (moto.lineup as any[]).map((entry: any) => {
    const data = motoResults?.[entry.riderId] ?? { ...DEFAULT_RIDER_STATE };
    const lapCap = moto.lapCount != null && moto.lapCount > 0 ? moto.lapCount : data.laps.length;
    // Sent as text per the API contract; the server stores milliseconds.
    const lapTimesMs = data.laps
      .slice(0, lapCap)
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
      bibNumber: data.bibNumber || undefined,
      riderName: data.riderName || undefined,
    };
  });

  const save = () => new Promise<boolean>((resolve) => {
    setSaving(true);
    submitMutation.mutate(
      { eventId, data: { motoId: moto.id, results: buildPayload() } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListResultsQueryKey(eventId) });
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          setSaving(false);
          resolve(true);
        },
        onError: (err) => {
          toast({ title: "Couldn't save the results", description: err.message, variant: "destructive" });
          setSaving(false);
          resolve(false);
        },
      },
    );
  });

  const setFinal = async (finalize: boolean) => {
    setFinalizing(true);
    try {
      // Save the edits first so what goes official is what's on screen.
      if (finalize && !(await save())) return;
      const res = await fetch(`/api/motos/${moto.id}/${finalize ? "finalize" : "unfinalize"}`, { method: "POST", credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Request failed");
      queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
      toast({ title: finalize ? "Results are official" : "Results reopened", description: finalize ? "Shown everywhere as Official results." : "Shown as Unofficial results until you finalize again." });
      if (finalize) onFinalized?.();
    } catch (err) {
      toast({ title: finalize ? "Couldn't finalize" : "Couldn't reopen", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setFinalizing(false);
    }
  };

  if (!motoResults) return <div className="p-6 text-sm text-muted-foreground flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading results…</div>;

  return (
    <div className="space-y-4">
      <MotoSection
        moto={moto}
        motoResults={motoResults}
        onUpdate={onUpdate}
        onSave={() => { void save().then(ok => ok && toast({ title: "Results saved", description: official ? "Official results updated." : "Still unofficial until you finalize." })); }}
        saving={saving}
        lapCount={moto.lapCount ?? null}
      />
      <div className={`rounded-lg border p-3 flex flex-wrap items-center gap-3 ${official ? "border-green-600/30 bg-green-50" : "bg-amber-50 border-amber-200"}`}>
        {official ? (
          <>
            <BadgeCheck size={18} className="text-green-700 shrink-0" />
            <p className="text-sm text-green-900 flex-1 min-w-48"><strong>Official results.</strong> Changes you save stay official.</p>
            <Button variant="outline" size="sm" onClick={() => setFinal(false)} disabled={finalizing} className="gap-1.5">
              <RotateCcw size={13} /> Reopen as unofficial
            </Button>
          </>
        ) : (
          <>
            <Activity size={18} className="text-amber-700 shrink-0" />
            <p className="text-sm text-amber-900 flex-1 min-w-48">
              <strong>Unofficial results.</strong> Riders and spectators see them marked unofficial. Finalize when they're right; you can come back to this any time.
            </p>
            <Button size="sm" onClick={() => setFinal(true)} disabled={finalizing || saving || moto.status !== "completed"} className="gap-1.5 bg-green-700 hover:bg-green-800 text-white">
              {finalizing ? <Loader2 size={13} className="animate-spin" /> : <BadgeCheck size={13} />} Finalize race
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
