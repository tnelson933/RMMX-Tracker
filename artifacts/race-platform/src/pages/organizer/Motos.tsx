import { useState, useEffect, useRef } from "react";
import { useRoute, Link } from "wouter";
import {
  useListMotos, useGenerateLineups, useUpdateMoto, useDeleteMoto,
  useGetEvent, useListCheckins, useCreateMoto,
  getListMotosQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Settings, Play, CheckCircle, Flag, RefreshCw, Radio, ExternalLink, Copy, Check, Trash2, Video, PlusCircle, Users, Zap } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { LiveBroadcast } from "./LiveBroadcast";
import { format } from "date-fns";

type RawCrossing = {
  id: number;
  rfidNumber: string;
  riderName: string | null;
  lapNumber: number;
  lapTime: string | null;
  lapTimeMs: number | null;
  crossingTime: string;
  readerId: string | null;
};

const POLL_INTERVAL_MS = 3000;

function LiveCrossingsFeed({ motoId }: { motoId: number }) {
  const [crossings, setCrossings] = useState<RawCrossing[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { toast } = useToast();

  const fetchCrossings = async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(`/api/timing/crossings/${motoId}`, { signal: ctrl.signal });
      if (!res.ok) return;
      const data: RawCrossing[] = await res.json();
      setCrossings(Array.isArray(data) ? [...data].reverse().slice(0, 15) : []);
      setLastUpdated(new Date());
    } catch {
      // ignore abort or network errors
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteCrossing = async (crossingId: number) => {
    setDeletingId(crossingId);
    try {
      const res = await fetch(`/api/timing/crossings/${crossingId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast({ title: "Failed to delete crossing", description: body.error ?? "Unknown error", variant: "destructive" });
        return;
      }
      toast({ title: "Crossing deleted", description: "Lap times recalculated." });
      await fetchCrossings();
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setDeletingId(null);
    }
  };

  useEffect(() => {
    setLoading(true);
    setCrossings([]);
    fetchCrossings();
    const timer = setInterval(fetchCrossings, POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [motoId]);

  return (
    <div className="border-t">
      <div className="flex items-center justify-between px-3 py-2 bg-primary/5 border-b">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          <span className="text-xs font-bold uppercase tracking-widest text-primary">Live Crossing Feed</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {lastUpdated ? `Updated ${format(lastUpdated, "h:mm:ss a")}` : "Loading…"}
        </span>
      </div>

      {loading ? (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground animate-pulse">
          Fetching crossings…
        </div>
      ) : crossings.length === 0 ? (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground flex flex-col items-center gap-1.5">
          <Zap size={16} className="text-muted-foreground/40" />
          No crossings yet — waiting for riders
        </div>
      ) : (
        <div className="max-h-44 overflow-y-auto">
          <Table>
            <TableHeader className="bg-muted/40 sticky top-0">
              <TableRow>
                <TableHead className="text-xs py-1.5 px-3">Rider</TableHead>
                <TableHead className="text-xs py-1.5 text-center w-14">Lap</TableHead>
                <TableHead className="text-xs py-1.5 text-center w-20">Lap Time</TableHead>
                <TableHead className="text-xs py-1.5 text-right pr-3 w-20">Time</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {crossings.map((c, idx) => (
                <TableRow key={c.id} className={`h-7 ${idx === 0 ? "bg-primary/5" : ""}`}>
                  <TableCell className="py-1 px-3 text-xs font-medium">
                    {c.riderName ?? (
                      <span className="text-muted-foreground font-mono">{c.rfidNumber}</span>
                    )}
                  </TableCell>
                  <TableCell className="py-1 text-center text-xs font-heading font-bold">{c.lapNumber}</TableCell>
                  <TableCell className="py-1 text-center text-xs font-mono">
                    {c.lapTime ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="py-1 pr-3 text-right text-xs text-muted-foreground tabular-nums">
                    {format(new Date(c.crossingTime), "h:mm:ss")}
                  </TableCell>
                  <TableCell className="py-1 pr-1 text-right">
                    <button
                      onClick={() => handleDeleteCrossing(c.id)}
                      disabled={deletingId === c.id}
                      className="text-muted-foreground/40 hover:text-destructive transition-colors disabled:opacity-40 p-0.5 rounded"
                      title="Delete crossing"
                    >
                      <Trash2 size={12} />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export default function Motos() {
  const [match, params] = useRoute("/events/:eventId/motos");
  const eventId = parseInt(params?.eventId || "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [isGenerateOpen, setIsGenerateOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [format, setFormat] = useState<"one_moto" | "two_moto" | "three_moto">("two_moto");
  const [ridersPerHeat, setRidersPerHeat] = useState<string>("");
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  // Manual create moto state
  const [newMotoName, setNewMotoName] = useState("");
  const [newMotoType, setNewMotoType] = useState<"heat" | "lcq" | "main" | "practice">("heat");
  const [newMotoClass, setNewMotoClass] = useState("");
  const [selectedRiderIds, setSelectedRiderIds] = useState<Set<number>>(new Set());

  const { data: event } = useGetEvent(eventId, { query: { enabled: !!eventId } as any });
  const { data: motos, isLoading } = useListMotos(eventId, { query: { enabled: !!eventId } as any });
  const { data: checkins } = useListCheckins(eventId, { query: { enabled: !!eventId } as any });

  const generateMutation = useGenerateLineups();
  const createMotoMutation = useCreateMoto();
  const updateMutation = useUpdateMoto();
  const deleteMutation = useDeleteMoto();

  // Checked-in riders for the currently selected class in the create dialog
  const classCheckins = (checkins ?? []).filter(c => c.checkedIn && c.raceClass === newMotoClass);
  const allSelected = classCheckins.length > 0 && classCheckins.every(c => selectedRiderIds.has(c.riderId));

  const toggleRider = (riderId: number) => {
    setSelectedRiderIds(prev => {
      const next = new Set(prev);
      if (next.has(riderId)) next.delete(riderId); else next.add(riderId);
      return next;
    });
  };

  const resetCreateDialog = () => {
    setNewMotoName("");
    setNewMotoType("heat");
    setNewMotoClass("");
    setSelectedRiderIds(new Set());
  };

  const handleCreateMoto = () => {
    if (!newMotoName.trim() || !newMotoClass) return;
    const nextMotoNumber = motos?.length ? Math.max(...motos.map(m => m.motoNumber ?? 0)) + 1 : 1;
    const lineup = classCheckins
      .filter(c => selectedRiderIds.has(c.riderId))
      .map((c, i) => ({
        position: i + 1,
        riderId: c.riderId,
        riderName: c.riderName,
        bibNumber: c.bibNumber || c.registrationBib || null,
        rfidNumber: c.rfidNumber || null,
      }));

    createMotoMutation.mutate(
      { eventId, data: { name: newMotoName.trim(), type: newMotoType, raceClass: newMotoClass, motoNumber: nextMotoNumber, lineup: lineup as any } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          setIsCreateOpen(false);
          resetCreateDialog();
          toast({ title: "Moto created" });
        },
        onError: (err) => {
          toast({ title: "Failed to create moto", description: err.message, variant: "destructive" });
        },
      }
    );
  };

  const handleGenerate = () => {
    if (!event?.raceClasses) return;
    const perHeat = ridersPerHeat.trim() ? parseInt(ridersPerHeat, 10) : undefined;
    generateMutation.mutate(
      { eventId, data: { raceFormat: format, classes: event.raceClasses, ridersPerHeat: perHeat } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          setIsGenerateOpen(false);
          toast({ title: "Lineups generated" });
        },
        onError: (err) => {
          toast({ title: "Failed to generate", description: err.message, variant: "destructive" });
        },
      }
    );
  };

  const handleDelete = (motoId: number) => {
    deleteMutation.mutate({ motoId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
        setConfirmDeleteId(null);
        toast({ title: "Heat deleted" });
      },
      onError: (err) => {
        toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
      },
    });
  };

  const handleStatusUpdate = (motoId: number, status: string) => {
    updateMutation.mutate(
      { motoId, data: { status } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          if (status === "in_progress") toast({ title: "🏁 Moto started — RFID timing active" });
          if (status === "completed") toast({ title: "Moto finished" });
        },
      }
    );
  };

  const copyLiveLink = (motoId: number) => {
    const url = `${window.location.origin}/live/${motoId}`;
    navigator.clipboard.writeText(url);
    setCopiedId(motoId);
    setTimeout(() => setCopiedId(null), 2000);
    toast({ title: "Live timing link copied" });
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-heading font-bold uppercase tracking-tight">Moto Management</h2>
          <p className="text-muted-foreground">Manage heats, mains, and RFID timing.</p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant={showBroadcast ? "default" : "outline"}
            className={`font-heading uppercase tracking-wider gap-2 ${showBroadcast ? "bg-red-600 hover:bg-red-700 text-white border-red-600" : ""}`}
            onClick={() => setShowBroadcast(v => !v)}
          >
            <Video size={16} /> {showBroadcast ? "Hide Video Feed" : "Live Video Feed"}
          </Button>

          {/* Manual create moto */}
          <Dialog open={isCreateOpen} onOpenChange={open => { setIsCreateOpen(open); if (!open) resetCreateDialog(); }}>
            <DialogTrigger asChild>
              <Button variant="outline" className="font-heading uppercase tracking-wider">
                <PlusCircle size={16} className="mr-2" /> Create Moto
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle className="font-heading uppercase text-xl">Create Moto Manually</DialogTitle>
              </DialogHeader>
              <div className="space-y-5 py-2">

                {/* Name */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Moto Name</label>
                  <Input
                    value={newMotoName}
                    onChange={e => setNewMotoName(e.target.value)}
                    placeholder="e.g. 250 Pro LCQ, Open Moto 1..."
                    className="h-9"
                  />
                </div>

                {/* Type + Class row */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Type</label>
                    <Select value={newMotoType} onValueChange={(v: any) => setNewMotoType(v)}>
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="heat">Heat</SelectItem>
                        <SelectItem value="lcq">LCQ</SelectItem>
                        <SelectItem value="main">Main</SelectItem>
                        <SelectItem value="practice">Practice</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Race Class</label>
                    <Select
                      value={newMotoClass}
                      onValueChange={v => { setNewMotoClass(v); setSelectedRiderIds(new Set()); }}
                    >
                      <SelectTrigger className="h-9"><SelectValue placeholder="Select class" /></SelectTrigger>
                      <SelectContent>
                        {(event?.raceClasses ?? []).map(cls => (
                          <SelectItem key={cls} value={cls}>{cls}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Rider picker */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium flex items-center gap-1.5">
                      <Users size={14} /> Riders
                      {selectedRiderIds.size > 0 && (
                        <Badge variant="secondary" className="ml-1 font-mono">{selectedRiderIds.size} selected</Badge>
                      )}
                    </label>
                    {newMotoClass && classCheckins.length > 0 && (
                      <div className="flex gap-2">
                        <button
                          className="text-xs text-primary hover:underline font-medium"
                          onClick={() => setSelectedRiderIds(new Set(classCheckins.map(c => c.riderId)))}
                        >
                          Select all
                        </button>
                        <span className="text-muted-foreground text-xs">·</span>
                        <button
                          className="text-xs text-muted-foreground hover:underline"
                          onClick={() => setSelectedRiderIds(new Set())}
                        >
                          Clear
                        </button>
                      </div>
                    )}
                  </div>

                  {!newMotoClass ? (
                    <div className="border rounded-md bg-muted/30 py-8 text-center text-sm text-muted-foreground">
                      Select a race class to see riders
                    </div>
                  ) : classCheckins.length === 0 ? (
                    <div className="border rounded-md bg-muted/30 py-8 text-center text-sm text-muted-foreground">
                      No checked-in riders for {newMotoClass}
                    </div>
                  ) : (
                    <ScrollArea className="border rounded-md h-52">
                      <div className="p-1">
                        {classCheckins.map(c => (
                          <label
                            key={c.riderId}
                            className="flex items-center gap-3 px-3 py-2 rounded hover:bg-muted/60 cursor-pointer select-none"
                          >
                            <Checkbox
                              checked={selectedRiderIds.has(c.riderId)}
                              onCheckedChange={() => toggleRider(c.riderId)}
                              id={`rider-${c.riderId}`}
                            />
                            <div className="flex-1 min-w-0">
                              <span className="font-medium text-sm">{c.riderName}</span>
                            </div>
                            {(c.bibNumber || c.registrationBib) && (
                              <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded border text-muted-foreground shrink-0">
                                #{c.bibNumber || c.registrationBib}
                              </span>
                            )}
                            {c.rfidNumber && (
                              <span className="text-green-600 text-xs flex items-center gap-0.5 shrink-0">
                                <Radio size={10} /> RFID
                              </span>
                            )}
                          </label>
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </div>
              </div>

              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => { setIsCreateOpen(false); resetCreateDialog(); }}>
                  Cancel
                </Button>
                <Button
                  onClick={handleCreateMoto}
                  disabled={createMotoMutation.isPending || !newMotoName.trim() || !newMotoClass}
                  className="font-heading uppercase tracking-wider"
                >
                  {createMotoMutation.isPending ? "Creating..." : "Create Moto"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Auto generate */}
          <Dialog open={isGenerateOpen} onOpenChange={setIsGenerateOpen}>
            <DialogTrigger asChild>
              <Button className="font-heading uppercase tracking-wider">
                <Settings size={16} className="mr-2" /> Generate Lineups
              </Button>
            </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="font-heading uppercase text-xl">Generate Moto Lineups</DialogTitle>
            </DialogHeader>
            <div className="space-y-6 py-4">
              <p className="text-sm text-muted-foreground">
                Generates motos based on checked-in riders for all classes.
              </p>
              <div className="space-y-2">
                <label className="text-sm font-medium">Race Format</label>
                <Select value={format} onValueChange={(v: any) => setFormat(v)}>
                  <SelectTrigger><SelectValue placeholder="Select Format" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="one_moto">1 Moto Format</SelectItem>
                    <SelectItem value="two_moto">2 Moto Format</SelectItem>
                    <SelectItem value="three_moto">3 Moto Format</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Max Riders Per Heat</label>
                <Input
                  type="number"
                  min={1}
                  value={ridersPerHeat}
                  onChange={e => setRidersPerHeat(e.target.value)}
                  placeholder="No limit (all in one heat)"
                  className="h-9"
                />
                <p className="text-xs text-muted-foreground">
                  If a class exceeds this number, riders are automatically split into separate heats.
                </p>
              </div>
              <Button onClick={handleGenerate} disabled={generateMutation.isPending} className="w-full font-heading uppercase">
                {generateMutation.isPending ? "Generating..." : "Generate Lineups"}
              </Button>
            </div>
          </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Live Video Feed panel */}
      {showBroadcast && (
        <div className="border rounded-xl p-5 bg-card space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <Video size={16} className="text-red-500" />
            <h3 className="font-heading font-bold uppercase tracking-wider text-sm">Live Video Broadcast</h3>
          </div>
          <LiveBroadcast eventId={eventId} />
        </div>
      )}

      {/* RFID timing info banner */}
      <div className="bg-primary/5 border border-primary/20 rounded-md px-4 py-3 flex items-start gap-3">
        <Radio size={18} className="text-primary mt-0.5 shrink-0" />
        <div className="text-sm">
          <span className="font-bold text-primary">RFID Timing:</span>{" "}
          <span className="text-muted-foreground">
            Start a moto to activate live timing. Readers send tag crossings to{" "}
            <code className="bg-muted px-1 rounded text-xs font-mono">POST /api/timing/crossing</code> with{" "}
            <code className="bg-muted px-1 rounded text-xs font-mono">{`{ rfidNumber, motoId }`}</code>.
            The leaderboard updates in real time via SSE.
          </span>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {[...Array(4)].map((_, i) => <Card key={i} className="h-64 animate-pulse" />)}
        </div>
      ) : motos?.length ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
          {motos.sort((a, b) => (a.motoNumber || 0) - (b.motoNumber || 0)).map((moto) => (
            <Card key={moto.id} className="flex flex-col h-full border-sidebar-border overflow-hidden">
              <CardHeader className="bg-sidebar text-sidebar-foreground py-3 border-b flex flex-row items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="bg-sidebar-accent text-white w-8 h-8 rounded-full flex items-center justify-center font-heading font-bold text-lg">
                    {moto.motoNumber}
                  </div>
                  <div>
                    <CardTitle className="font-heading uppercase text-lg text-white leading-tight">{moto.name}</CardTitle>
                    <div className="text-xs text-sidebar-foreground/70 uppercase tracking-widest">{moto.raceClass}</div>
                  </div>
                </div>
                <div className="text-right">
                  <span className={`px-2 py-1 rounded text-xs font-bold uppercase tracking-wider border ${
                    moto.status === "in_progress" ? "bg-primary/20 text-primary border-primary/30 animate-pulse" :
                    moto.status === "completed" ? "bg-secondary/20 text-secondary border-secondary/30" :
                    "bg-sidebar-accent text-sidebar-foreground/80 border-transparent"
                  }`}>
                    {moto.status === "in_progress" && (
                      <span className="inline-block w-1.5 h-1.5 bg-primary rounded-full mr-1 animate-ping" />
                    )}
                    {moto.status.replace("_", " ")}
                  </span>
                </div>
              </CardHeader>

              <CardContent className="p-0 flex-1 flex flex-col">
                {/* Lineup table */}
                <div className="flex-1 overflow-y-auto max-h-52 border-b">
                  <Table>
                    <TableHeader className="bg-muted/50 sticky top-0">
                      <TableRow>
                        <TableHead className="w-12 text-center text-xs">Gate</TableHead>
                        <TableHead className="text-xs">Rider</TableHead>
                        <TableHead className="w-16 text-center text-xs">Bib</TableHead>
                        <TableHead className="w-20 text-center text-xs">RFID</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {moto.lineup && moto.lineup.length > 0 ? (
                        moto.lineup.map((entry) => (
                          <TableRow key={entry.riderId} className="h-8">
                            <TableCell className="text-center font-heading font-bold">{entry.position}</TableCell>
                            <TableCell className="font-medium">{entry.riderName}</TableCell>
                            <TableCell className="text-center font-mono text-xs">{entry.bibNumber || "—"}</TableCell>
                            <TableCell className="text-center">
                              {entry.rfidNumber ? (
                                <span className="inline-flex items-center gap-1 text-green-600">
                                  <Radio size={10} /> <span className="font-mono text-xs">{entry.rfidNumber}</span>
                                </span>
                              ) : (
                                <span className="text-muted-foreground text-xs">—</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))
                      ) : (
                        <TableRow>
                          <TableCell colSpan={4} className="text-center py-4 text-muted-foreground text-sm">
                            No lineup generated
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>

                {/* Live crossing feed — shown only while moto is in progress */}
                {moto.status === "in_progress" && (
                  <LiveCrossingsFeed motoId={moto.id} />
                )}

                {/* Action bar */}
                <div className="p-3 bg-muted/30 flex gap-2 items-center flex-wrap">
                  {moto.status === "scheduled" && (
                    <Button size="sm" onClick={() => handleStatusUpdate(moto.id, "in_progress")} className="font-heading uppercase text-xs">
                      <Play size={14} className="mr-1" /> Start Moto
                    </Button>
                  )}
                  {moto.status === "in_progress" && (
                    <Button size="sm" variant="outline" className="text-secondary border-secondary/50 font-heading uppercase text-xs" onClick={() => handleStatusUpdate(moto.id, "completed")}>
                      <CheckCircle size={14} className="mr-1" /> Finish Moto
                    </Button>
                  )}
                  {moto.status === "completed" && (
                    <Button size="sm" variant="ghost" className="text-muted-foreground font-heading uppercase text-xs" onClick={() => handleStatusUpdate(moto.id, "in_progress")}>
                      <RefreshCw size={14} className="mr-1" /> Reopen
                    </Button>
                  )}

                  <div className="ml-auto flex gap-1.5">
                    {/* Live timing link — always available */}
                    <a href={`/live/${moto.id}`} target="_blank" rel="noopener noreferrer">
                      <Button size="sm" variant="ghost" className={`font-heading uppercase text-xs gap-1 ${moto.status === "in_progress" ? "text-primary" : "text-muted-foreground"}`}>
                        <Radio size={13} /> Live
                        <ExternalLink size={11} />
                      </Button>
                    </a>
                    <Button size="sm" variant="ghost" className="text-muted-foreground px-2" onClick={() => copyLiveLink(moto.id)}>
                      {copiedId === moto.id ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive/60 hover:text-destructive hover:bg-destructive/10 px-2"
                      onClick={() => setConfirmDeleteId(moto.id)}
                      title="Delete heat"
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="p-16 text-center">
            <Flag className="mx-auto text-muted-foreground opacity-20 mb-4" size={48} />
            <h3 className="text-xl font-heading font-bold mb-2">No Motos Generated</h3>
            <p className="text-muted-foreground mb-6">Generate lineups to create heats and main events for this race.</p>
            <Button onClick={() => setIsGenerateOpen(true)} className="font-heading uppercase tracking-wider">
              Generate Lineups
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={confirmDeleteId !== null} onOpenChange={open => { if (!open) setConfirmDeleteId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading uppercase text-xl">Delete Heat?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            This will permanently remove the heat and its lineup. This cannot be undone.
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => confirmDeleteId !== null && handleDelete(confirmDeleteId)}
              className="font-heading uppercase tracking-wider"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Heat"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
