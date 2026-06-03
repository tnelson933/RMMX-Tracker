import { useState, useEffect } from "react";
import { useRoute } from "wouter";
import { useListMotos, useListResults, useSubmitResults, usePublishResults, getListResultsQueryKey, getListMotosQueryKey, getGetEventQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch as UISwitch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Save, CheckCircle, Activity, Globe, Trophy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function EnterResults() {
  const [match, params] = useRoute("/events/:eventId/results");
  const eventId = parseInt(params?.eventId || "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [selectedMotoId, setSelectedMotoId] = useState<string>("");
  const [selectedClass, setSelectedClass] = useState<string>("");
  const [resultsData, setResultsData] = useState<Record<number, { pos: string, time: string, dnf: boolean, dns: boolean }>>({});

  const { data: motos, isLoading: motosLoading } = useListMotos(eventId, { query: { enabled: !!eventId } as any });
  const { data: existingResults } = useListResults(eventId, { query: { enabled: !!eventId } as any });
  
  const submitMutation = useSubmitResults();
  const publishMutation = usePublishResults();

  const completedMotos = motos?.filter(m => m.status === 'completed' || m.status === 'in_progress') || [];
  
  // Set default moto
  if (completedMotos.length > 0 && !selectedMotoId) {
    setSelectedMotoId(completedMotos[0].id.toString());
  }

  const activeMoto = completedMotos.find(m => m.id.toString() === selectedMotoId);
  const isCompleted = activeMoto?.status === 'completed';

  // Initialize form data when a moto is selected
  useEffect(() => {
    if (activeMoto && activeMoto.lineup) {
      const initialData: typeof resultsData = {};
      const motoResults = existingResults?.filter(r => r.motoId === activeMoto.id) || [];
      
      activeMoto.lineup.forEach((entry, idx) => {
        const existing = motoResults.find(r => r.riderId === entry.riderId);
        initialData[entry.riderId] = {
          pos: existing ? existing.position.toString() : (idx + 1).toString(),
          time: existing?.totalTime || "",
          dnf: existing?.dnf || false,
          dns: existing?.dns || false,
        };
      });
      setResultsData(initialData);
    }
  }, [selectedMotoId, existingResults, activeMoto]);

  // ── Overall standings computation ─────────────────────────────────────────
  const raceClasses = [...new Set((motos || []).map(m => m.raceClass))].sort();
  const displayClass = selectedClass || raceClasses[0] || "";

  const classMotos = (motos || [])
    .filter(m => m.raceClass === displayClass && (m.status === 'completed' || m.status === 'in_progress'))
    .sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0));

  const classResults = (existingResults || []).filter(r =>
    classMotos.some(m => m.id === r.motoId)
  );

  // Parse "M:SS.mmm" → total seconds for time comparison
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

  const riderMap = new Map<number, {
    riderName: string;
    motos: Map<number, { points: number; dnf: boolean; dns: boolean }>;
    times: Map<number, number>;
  }>();
  classResults.forEach(r => {
    if (!riderMap.has(r.riderId)) {
      riderMap.set(r.riderId, { riderName: r.riderName, motos: new Map(), times: new Map() });
    }
    const entry = riderMap.get(r.riderId)!;
    entry.motos.set(r.motoId, { points: r.points ?? 0, dnf: r.dnf ?? false, dns: r.dns ?? false });
    entry.times.set(r.motoId, parseTimeSeconds(r.totalTime));
  });

  const overallStandings = Array.from(riderMap.entries()).map(([riderId, data]) => {
    const motoPoints = classMotos.map(moto => {
      const result = data.motos.get(moto.id);
      if (!result) return { display: '-' as string | number, value: 0 };
      if (result.dnf) return { display: 'DNF', value: 0 };
      if (result.dns) return { display: 'DNS', value: 0 };
      return { display: result.points, value: result.points };
    });
    const total = motoPoints.reduce((sum, p) => sum + p.value, 0);
    // Sum only motos where the rider actually finished
    const totalTimeSeconds = classMotos.reduce((sum, moto) => {
      const t = data.times.get(moto.id);
      return isFinite(t ?? Infinity) ? sum + (t ?? 0) : sum;
    }, 0);
    return { riderId, riderName: data.riderName, motoPoints, total, totalTimeSeconds };
  // Sort descending by points; tiebreak by lower total time
  }).sort((a, b) => b.total - a.total || a.totalTimeSeconds - b.totalTimeSeconds);

  // Assign positions — ties broken by time; only identical points + time share a rank
  const standingsWithPos: Array<(typeof overallStandings)[number] & { overallPos: number; totalTimeDisplay: string }> = [];
  for (let idx = 0; idx < overallStandings.length; idx++) {
    const row = overallStandings[idx];
    let overallPos = idx + 1;
    if (idx > 0 && row.total === overallStandings[idx - 1].total && row.totalTimeSeconds === overallStandings[idx - 1].totalTimeSeconds) {
      overallPos = standingsWithPos[idx - 1].overallPos;
    }
    standingsWithPos.push({ ...row, overallPos, totalTimeDisplay: formatSeconds(row.totalTimeSeconds) });
  }

  const handleUpdateField = (riderId: number, field: string, value: any) => {
    setResultsData(prev => ({
      ...prev,
      [riderId]: { ...prev[riderId], [field]: value }
    }));
  };

  const handleSaveResults = () => {
    if (!activeMoto) return;
    
    const results = Object.entries(resultsData).map(([riderIdStr, data]) => ({
      riderId: parseInt(riderIdStr),
      position: parseInt(data.pos) || 999, // push to back if empty
      totalTime: data.time || undefined,
      dnf: data.dnf,
      dns: data.dns
    }));

    submitMutation.mutate({
      eventId,
      data: {
        motoId: activeMoto.id,
        results
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListResultsQueryKey(eventId) });
        toast({ title: "Results saved successfully" });
      },
      onError: (err) => {
        toast({ title: "Failed to save", description: err.message, variant: "destructive" });
      }
    });
  };

  const handlePublish = (published: boolean) => {
    publishMutation.mutate({
      eventId,
      data: { published }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetEventQueryKey(eventId) });
        toast({ title: published ? "Results published" : "Results unpublished" });
      }
    });
  };

  if (motosLoading) return <div className="p-8">Loading...</div>;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-heading font-bold uppercase tracking-tight flex items-center gap-2">
            <Activity className="text-primary" /> Enter Results
          </h2>
          <p className="text-muted-foreground mt-1">Record finishes for completed motos.</p>
        </div>
        
        <div className="flex items-center gap-4 bg-muted p-2 rounded-lg border">
          <Globe size={18} className="text-muted-foreground ml-2" />
          <Label htmlFor="publish-results" className="font-heading font-bold uppercase tracking-wider cursor-pointer">Publish to Web</Label>
          <UISwitch id="publish-results" onCheckedChange={handlePublish} />
        </div>
      </div>

      {completedMotos.length > 0 ? (
        <Card className="border-sidebar-border">
          <CardHeader className="bg-sidebar text-sidebar-foreground border-b flex flex-row items-center justify-between py-4">
            <div className="w-64">
              <Select value={selectedMotoId} onValueChange={setSelectedMotoId}>
                <SelectTrigger className="bg-sidebar-accent border-transparent text-white">
                  <SelectValue placeholder="Select Moto" />
                </SelectTrigger>
                <SelectContent>
                  {completedMotos.map(moto => (
                    <SelectItem key={moto.id} value={moto.id.toString()}>
                      Moto {moto.motoNumber}: {moto.name} ({moto.raceClass})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {isCompleted && (
              <div className="flex items-center text-secondary text-sm font-bold uppercase tracking-wider">
                <CheckCircle size={16} className="mr-1" /> Moto Completed
              </div>
            )}
          </CardHeader>
          <CardContent className="p-0">
            {activeMoto?.lineup && activeMoto.lineup.length > 0 ? (
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="w-16">Bib</TableHead>
                    <TableHead>Rider</TableHead>
                    <TableHead className="w-24 text-center">Position</TableHead>
                    <TableHead className="w-32">Total Time</TableHead>
                    <TableHead className="w-20 text-center">DNF</TableHead>
                    <TableHead className="w-20 text-center">DNS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...activeMoto.lineup].sort((a, b) => {
                    const aData = resultsData[a.riderId];
                    const bData = resultsData[b.riderId];
                    const aDnfDns = aData?.dnf || aData?.dns;
                    const bDnfDns = bData?.dnf || bData?.dns;
                    if (aDnfDns && !bDnfDns) return 1;
                    if (!aDnfDns && bDnfDns) return -1;
                    const aPos = parseInt(aData?.pos) || 999;
                    const bPos = parseInt(bData?.pos) || 999;
                    return aPos - bPos;
                  }).map(entry => {
                    const rowData = resultsData[entry.riderId] || { pos: "", time: "", dnf: false, dns: false };
                    const isDnfDns = rowData.dnf || rowData.dns;
                    
                    return (
                      <TableRow key={entry.riderId} className={isDnfDns ? "opacity-50 bg-muted/50" : ""}>
                        <TableCell className="font-mono font-medium">{entry.bibNumber || "-"}</TableCell>
                        <TableCell className="font-bold">{entry.riderName}</TableCell>
                        <TableCell>
                          <Input 
                            value={rowData.pos} 
                            onChange={e => handleUpdateField(entry.riderId, 'pos', e.target.value)}
                            className="w-16 text-center font-heading font-bold text-lg h-9"
                            disabled={isDnfDns}
                          />
                        </TableCell>
                        <TableCell>
                          <Input 
                            value={rowData.time} 
                            onChange={e => handleUpdateField(entry.riderId, 'time', e.target.value)}
                            placeholder="00:00.000"
                            className="font-mono text-sm h-9"
                            disabled={isDnfDns}
                          />
                        </TableCell>
                        <TableCell className="text-center">
                          <UISwitch 
                            checked={rowData.dnf} 
                            onCheckedChange={v => handleUpdateField(entry.riderId, 'dnf', v)}
                          />
                        </TableCell>
                        <TableCell className="text-center">
                          <UISwitch 
                            checked={rowData.dns} 
                            onCheckedChange={v => handleUpdateField(entry.riderId, 'dns', v)}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ) : (
              <div className="p-8 text-center text-muted-foreground">No lineup found for this moto.</div>
            )}
            
            <div className="p-4 bg-muted/30 border-t flex justify-end">
              <Button onClick={handleSaveResults} disabled={submitMutation.isPending || !activeMoto?.lineup?.length} className="font-heading uppercase tracking-wider">
                <Save size={16} className="mr-2" /> Save Results
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-16 text-center">
            <Activity className="mx-auto text-muted-foreground opacity-20 mb-4" size={48} />
            <h3 className="text-xl font-heading font-bold mb-2">No Active Motos</h3>
            <p className="text-muted-foreground">Start and complete motos on the Motos tab before entering results.</p>
          </CardContent>
        </Card>
      )}

      {/* ── Overall Standings ───────────────────────────────────────────────── */}
      {raceClasses.length > 0 && (
        <div className="space-y-4 pt-4">
          <h2 className="text-2xl font-heading font-bold uppercase tracking-tight flex items-center gap-2">
            <Trophy className="text-primary" /> Class Overall Standings
          </h2>

          {/* Class selector */}
          <div className="flex flex-wrap gap-2">
            {raceClasses.map(cls => (
              <button
                key={cls}
                onClick={() => setSelectedClass(cls ?? "")}
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
                      {classMotos.map(m => (
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
                            {p.display === 'DNF' ? (
                              <span className="text-destructive font-bold text-xs">DNF</span>
                            ) : p.display === 'DNS' || p.display === '-' ? (
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
    </div>
  );
}
