import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useListSeries, useCreateSeries, useUpdateSeries, useGetSeriesLeaderboard, useListPointsTables, getListSeriesQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import { Trophy, Plus, ChevronRight, Medal, X, Calendar, Pencil } from "lucide-react";
import { EmbedSeriesWidgetCard } from "@/components/organizer/EmbedSeriesWidgetCard";

const createSeriesSchema = z.object({
  name: z.string().min(1, "Name is required"),
  season: z.coerce.number().min(2000),
  scoringTableId: z.number().optional(),
});

export default function SeriesManagement() {
  const { user } = useAuth();
  const clubId = user?.clubId || 0;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editingSeriesId, setEditingSeriesId] = useState<number | null>(null);
  const [selectedSeriesId, setSelectedSeriesId] = useState<number | null>(null);
  const [selectedClass, setSelectedClass] = useState<string>("");
  const [classList, setClassList] = useState<string[]>([]);
  const [classInput, setClassInput] = useState("");
  const [editClassList, setEditClassList] = useState<string[]>([]);
  const [editClassInput, setEditClassInput] = useState("");

  const { data: seriesList, isLoading } = useListSeries();
  const { data: leaderboard, isLoading: leaderboardLoading } = useGetSeriesLeaderboard(selectedSeriesId || 0, {
    query: { enabled: !!selectedSeriesId } as any
  });
  const { data: pointsTables } = useListPointsTables({ query: {} as any });

  // Set default series selection
  if (seriesList?.length && !selectedSeriesId) {
    setSelectedSeriesId(seriesList[0].id);
  }

  const createMutation = useCreateSeries();
  const updateMutation = useUpdateSeries();

  const editForm = useForm<z.infer<typeof createSeriesSchema>>({
    resolver: zodResolver(createSeriesSchema),
    defaultValues: { name: "", season: new Date().getFullYear() },
  });

  const openEditDialog = (series: { id: number; name: string; season: number; classes: string[]; scoringTableId?: number | null }) => {
    setEditingSeriesId(series.id);
    editForm.reset({ name: series.name, season: series.season, scoringTableId: series.scoringTableId ?? undefined });
    setEditClassList(series.classes as string[]);
    setEditClassInput("");
    setIsEditOpen(true);
  };

  const onEditSubmit = (data: z.infer<typeof createSeriesSchema>) => {
    if (!editingSeriesId) return;
    updateMutation.mutate({
      seriesId: editingSeriesId,
      data: { name: data.name, season: data.season, classes: editClassList, scoringTableId: data.scoringTableId ?? null },
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSeriesQueryKey() });
        setIsEditOpen(false);
        toast({ title: "Series updated" });
      },
      onError: (err) => {
        toast({ title: "Failed to update", description: err.message, variant: "destructive" });
      },
    });
  };

  const form = useForm<z.infer<typeof createSeriesSchema>>({
    resolver: zodResolver(createSeriesSchema),
    defaultValues: {
      name: "",
      season: new Date().getFullYear(),
    }
  });

  const addClassItem = () => {
    const trimmed = classInput.trim();
    if (trimmed && !classList.includes(trimmed)) {
      setClassList(prev => [...prev, trimmed]);
    }
    setClassInput("");
  };

  const removeClassItem = (cls: string) => {
    setClassList(prev => prev.filter(c => c !== cls));
  };

  const onSubmit = (data: z.infer<typeof createSeriesSchema>) => {
    createMutation.mutate({
      data: {
        clubId,
        name: data.name,
        season: data.season,
        classes: classList,
        scoringTableId: data.scoringTableId ?? null,
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSeriesQueryKey() });
        setIsAddOpen(false);
        form.reset();
        setClassList([]);
        setClassInput("");
        toast({ title: "Series created successfully" });
      },
      onError: (err) => {
        toast({ title: "Failed to create series", description: err.message, variant: "destructive" });
      }
    });
  };

  const selectedSeries = seriesList?.find(s => s.id === selectedSeriesId);

  // Unique race classes from leaderboard
  const raceClasses = [...new Set((leaderboard || []).map(l => l.raceClass))].sort();
  const displayClass = selectedClass || raceClasses[0] || "";

  // Standings for the selected class
  const classStandings = (leaderboard || [])
    .filter(l => l.raceClass === displayClass)
    .sort((a, b) => a.position - b.position);

  // Events that have motos for this class (derive from first rider's breakdown)
  const eventColumns = classStandings[0]?.events || [];

  const positionCell = (pos: number, isPenalty: boolean) => {
    if (isPenalty) return <span className="text-muted-foreground text-xs italic">({pos})</span>;
    return <span className="font-bold">{pos}</span>;
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-4xl font-heading font-bold uppercase tracking-tight flex items-center gap-3">
            <Trophy className="text-primary" /> Series Management
          </h1>
          <p className="text-muted-foreground mt-1">Manage championships and view position-based standings.</p>
        </div>

        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button className="font-heading uppercase tracking-wider">
              <Plus size={16} className="mr-2" /> Create Series
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="font-heading uppercase text-xl">Create New Series</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Series Name</FormLabel>
                      <FormControl><Input placeholder="Summer Championship" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="season"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Season (Year)</FormLabel>
                      <FormControl><Input type="number" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="scoringTableId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Scoring Format</FormLabel>
                      <Select
                        value={field.value != null ? String(field.value) : "none"}
                        onValueChange={v => field.onChange(v === "none" ? undefined : Number(v))}
                      >
                        <FormControl>
                          <SelectTrigger><SelectValue placeholder="Select format..." /></SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">No format set</SelectItem>
                          {(pointsTables ?? []).map(t => (
                            <SelectItem key={t.id} value={String(t.id)}>
                              {t.isSystemDefault ? "★ " : ""}{t.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="space-y-2">
                  <label className="text-sm font-medium">Classes</label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="e.g. 450 Pro"
                      value={classInput}
                      onChange={e => setClassInput(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addClassItem(); } }}
                    />
                    <Button type="button" variant="outline" onClick={addClassItem}>
                      <Plus size={16} />
                    </Button>
                  </div>
                  {classList.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {classList.map(cls => (
                        <span key={cls} className="inline-flex items-center gap-1.5 bg-muted px-3 py-1 rounded-full text-sm font-medium">
                          {cls}
                          <button type="button" onClick={() => removeClassItem(cls)} className="text-muted-foreground hover:text-destructive transition-colors">
                            <X size={13} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="pt-4 flex justify-end">
                  <Button type="submit" disabled={createMutation.isPending} className="font-heading uppercase tracking-wider">
                    {createMutation.isPending ? "Creating..." : "Create Series"}
                  </Button>
                </div>
              </form>
            </Form>
          </DialogContent>
        </Dialog>

        {/* ── Edit Series Dialog ─────────────────────────────────────────── */}
        <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="font-heading uppercase text-xl">Edit Series</DialogTitle>
            </DialogHeader>
            <Form {...editForm}>
              <form onSubmit={editForm.handleSubmit(onEditSubmit)} className="space-y-4 pt-4">
                <FormField
                  control={editForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Series Name</FormLabel>
                      <FormControl><Input placeholder="Summer Championship" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="season"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Season (Year)</FormLabel>
                      <FormControl><Input type="number" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="scoringTableId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Scoring Format</FormLabel>
                      <Select
                        value={field.value != null ? String(field.value) : "none"}
                        onValueChange={v => field.onChange(v === "none" ? undefined : Number(v))}
                      >
                        <FormControl>
                          <SelectTrigger><SelectValue placeholder="Select format..." /></SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">No format set</SelectItem>
                          {(pointsTables ?? []).map(t => (
                            <SelectItem key={t.id} value={String(t.id)}>
                              {t.isSystemDefault ? "★ " : ""}{t.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="space-y-2">
                  <label className="text-sm font-medium">Classes</label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="e.g. 450 Pro"
                      value={editClassInput}
                      onChange={e => setEditClassInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          const t = editClassInput.trim();
                          if (t && !editClassList.includes(t)) setEditClassList(prev => [...prev, t]);
                          setEditClassInput("");
                        }
                      }}
                    />
                    <Button type="button" variant="outline" onClick={() => {
                      const t = editClassInput.trim();
                      if (t && !editClassList.includes(t)) setEditClassList(prev => [...prev, t]);
                      setEditClassInput("");
                    }}>
                      <Plus size={16} />
                    </Button>
                  </div>
                  {editClassList.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {editClassList.map(cls => (
                        <span key={cls} className="inline-flex items-center gap-1.5 bg-muted px-3 py-1 rounded-full text-sm font-medium">
                          {cls}
                          <button type="button" onClick={() => setEditClassList(prev => prev.filter(c => c !== cls))} className="text-muted-foreground hover:text-destructive transition-colors">
                            <X size={13} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="pt-4 flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setIsEditOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={updateMutation.isPending} className="font-heading uppercase tracking-wider">
                    {updateMutation.isPending ? "Saving..." : "Save Changes"}
                  </Button>
                </div>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        {/* Series list */}
        <div className="lg:col-span-1 space-y-4">
          <h3 className="font-heading font-bold uppercase text-muted-foreground tracking-wider mb-2">Your Series</h3>
          {isLoading ? (
            <div className="space-y-2">
              <Card className="h-16 animate-pulse"></Card>
              <Card className="h-16 animate-pulse"></Card>
            </div>
          ) : seriesList?.length ? (
            seriesList.map(series => (
              <Card
                key={series.id}
                className={`cursor-pointer transition-colors ${selectedSeriesId === series.id ? 'border-primary bg-primary/5' : 'hover:border-primary/50'}`}
                onClick={() => { setSelectedSeriesId(series.id); setSelectedClass(""); }}
              >
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="font-heading font-bold text-lg uppercase truncate">{series.name}</div>
                    <div className="flex items-center gap-1.5 text-sm text-muted-foreground flex-wrap">
                      <span>Season {series.season}</span>
                      {(series as any).scoringTableId && (
                        <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
                          {(pointsTables ?? []).find(t => t.id === (series as any).scoringTableId)?.name ?? "Custom"}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 ml-2 shrink-0">
                    <button
                      onClick={e => { e.stopPropagation(); openEditDialog({ id: series.id, name: series.name, season: series.season, classes: series.classes as string[], scoringTableId: (series as any).scoringTableId }); }}
                      className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                      title="Edit series"
                    >
                      <Pencil size={14} />
                    </button>
                    <ChevronRight size={16} className={selectedSeriesId === series.id ? 'text-primary' : 'text-muted-foreground'} />
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <div className="text-sm text-muted-foreground bg-muted p-4 rounded-md text-center">
              No series created yet.
            </div>
          )}
        </div>

        {/* Standings panel */}
        <div className="lg:col-span-3 space-y-4">
          {selectedSeries ? (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-heading font-bold uppercase tracking-tight">
                  {selectedSeries.name} — {selectedSeries.season}
                </h2>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Calendar size={14} />
                  {(selectedSeries.eventIds as number[])?.length ?? 0} event(s)
                </div>
              </div>

              {leaderboardLoading ? (
                <div className="p-16 text-center text-muted-foreground">Loading standings...</div>
              ) : raceClasses.length > 0 ? (
                <>
                  {/* Class pill selector */}
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
                      <CardTitle className="font-heading uppercase tracking-wider text-base text-white">
                        {displayClass} — Series Overall
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                      {classStandings.length > 0 ? (
                        <div className="overflow-x-auto">
                          <Table>
                            <TableHeader className="bg-muted/50">
                              <TableRow>
                                <TableHead className="w-16 text-center">Pos</TableHead>
                                <TableHead>Rider</TableHead>
                                {eventColumns.map(ev => (
                                  <TableHead key={ev.eventId} className="text-center text-xs min-w-28">
                                    <div className="font-medium truncate max-w-24">{ev.eventName}</div>
                                    <div className="text-muted-foreground font-normal">Score</div>
                                  </TableHead>
                                ))}
                                <TableHead className="text-center w-20">Events</TableHead>
                                <TableHead className="text-center w-24">Points</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {classStandings.map((row, idx) => (
                                <TableRow key={row.riderId} className={idx === 0 ? "bg-primary/5" : ""}>
                                  <TableCell className="text-center">
                                    {row.position === 1 ? <Medal className="mx-auto text-yellow-500" size={20} /> :
                                     row.position === 2 ? <Medal className="mx-auto text-slate-400" size={20} /> :
                                     row.position === 3 ? <Medal className="mx-auto text-amber-700" size={20} /> :
                                     <span className="font-heading font-bold">{row.position}</span>}
                                  </TableCell>
                                  <TableCell className="font-bold">{row.riderName}</TableCell>
                                  {(row.events || []).map(ev => (
                                    <TableCell key={ev.eventId} className="text-center">
                                      {ev.attended ? (
                                        <div>
                                          <div className="font-heading font-bold text-sm">{ev.eventScore}</div>
                                          <div className="text-xs text-muted-foreground font-mono">
                                            {ev.motos?.join(" · ")}
                                          </div>
                                        </div>
                                      ) : (
                                        <div>
                                          <div className="font-heading font-bold text-sm text-muted-foreground">({ev.eventScore})</div>
                                          <div className="text-xs text-destructive/70">no-show</div>
                                        </div>
                                      )}
                                    </TableCell>
                                  ))}
                                  <TableCell className="text-center">
                                    <Badge variant={row.eventsEntered > 0 ? "default" : "secondary"} className="font-mono">
                                      {row.eventsEntered}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="text-center">
                                    <span className="font-heading font-bold text-lg text-primary">{row.totalScore}</span>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      ) : (
                        <div className="p-10 text-center text-muted-foreground">
                          No completed results for <strong>{displayClass}</strong> yet.
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <p className="text-xs text-muted-foreground px-1">
                    Standings ranked by highest total points. Riders who miss an event receive 0 points for each moto missed (shown in parentheses).
                  </p>
                </>
              ) : (
                <Card>
                  <CardContent className="p-16 text-center">
                    <Trophy className="mx-auto text-muted-foreground opacity-20 mb-4" size={48} />
                    <h3 className="text-xl font-heading font-bold mb-2">No Standings Yet</h3>
                    <p className="text-muted-foreground">Standings appear once events in this series have completed motos with results.</p>
                  </CardContent>
                </Card>
              )}

              {selectedSeriesId && (
                <EmbedSeriesWidgetCard seriesId={selectedSeriesId} />
              )}
            </>
          ) : (
            <div className="h-full flex items-center justify-center p-12 border rounded-lg border-dashed text-muted-foreground">
              Select a series to view its standings.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
