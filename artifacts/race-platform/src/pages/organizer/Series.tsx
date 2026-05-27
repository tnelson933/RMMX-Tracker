import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useListSeries, useCreateSeries, useGetSeriesLeaderboard, getListSeriesQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import { Trophy, Plus, ChevronRight, Medal } from "lucide-react";

const createSeriesSchema = z.object({
  name: z.string().min(1, "Name is required"),
  season: z.coerce.number().min(2000),
  classes: z.string().optional(),
});

export default function SeriesManagement() {
  const { user } = useAuth();
  const clubId = user?.clubId || 0;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [selectedSeriesId, setSelectedSeriesId] = useState<number | null>(null);

  const { data: seriesList, isLoading } = useListSeries();
  const { data: leaderboard, isLoading: leaderboardLoading } = useGetSeriesLeaderboard(selectedSeriesId || 0, {
    query: { enabled: !!selectedSeriesId } as any
  });

  // Set default selection
  if (seriesList?.length && !selectedSeriesId) {
    setSelectedSeriesId(seriesList[0].id);
  }

  const createMutation = useCreateSeries();

  const form = useForm<z.infer<typeof createSeriesSchema>>({
    resolver: zodResolver(createSeriesSchema),
    defaultValues: {
      name: "",
      season: new Date().getFullYear(),
      classes: "",
    }
  });

  const onSubmit = (data: z.infer<typeof createSeriesSchema>) => {
    createMutation.mutate({
      data: {
        clubId,
        name: data.name,
        season: data.season,
        classes: data.classes ? data.classes.split(",").map(s => s.trim()) : [],
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSeriesQueryKey() });
        setIsAddOpen(false);
        form.reset();
        toast({ title: "Series created successfully" });
      },
      onError: (err) => {
        toast({ title: "Failed to create series", description: err.message, variant: "destructive" });
      }
    });
  };

  const selectedSeries = seriesList?.find(s => s.id === selectedSeriesId);
  const classes = Array.from(new Set(leaderboard?.map(l => l.raceClass) || []));

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-4xl font-heading font-bold uppercase tracking-tight flex items-center gap-3">
            <Trophy className="text-primary" /> Series Management
          </h1>
          <p className="text-muted-foreground mt-1">Manage championships and view leaderboards.</p>
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
                  name="classes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Classes (comma separated)</FormLabel>
                      <FormControl><Input placeholder="250 Pro, 450 Pro" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="pt-4 flex justify-end">
                  <Button type="submit" disabled={createMutation.isPending} className="font-heading uppercase tracking-wider">
                    {createMutation.isPending ? "Creating..." : "Create Series"}
                  </Button>
                </div>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
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
                onClick={() => setSelectedSeriesId(series.id)}
              >
                <CardContent className="p-4 flex items-center justify-between">
                  <div>
                    <div className="font-heading font-bold text-lg uppercase">{series.name}</div>
                    <div className="text-sm text-muted-foreground">Season {series.season}</div>
                  </div>
                  <ChevronRight size={16} className={selectedSeriesId === series.id ? 'text-primary' : 'text-muted-foreground'} />
                </CardContent>
              </Card>
            ))
          ) : (
            <div className="text-sm text-muted-foreground bg-muted p-4 rounded-md text-center">
              No series created yet.
            </div>
          )}
        </div>

        <div className="lg:col-span-3">
          {selectedSeries ? (
            <Card>
              <CardHeader className="bg-sidebar text-sidebar-foreground border-b pb-4 rounded-t-lg">
                <CardTitle className="font-heading uppercase text-2xl text-white">
                  {selectedSeries.name} - {selectedSeries.season} Leaderboard
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {leaderboardLoading ? (
                  <div className="p-16 text-center text-muted-foreground">Loading standings...</div>
                ) : classes.length > 0 ? (
                  <div className="divide-y">
                    {classes.map(raceClass => {
                      const classStandings = leaderboard?.filter(l => l.raceClass === raceClass).sort((a,b) => a.position - b.position) || [];
                      return (
                        <div key={raceClass} className="p-6">
                          <h3 className="text-xl font-heading font-bold uppercase mb-4 text-primary">{raceClass}</h3>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-16 text-center">Pos</TableHead>
                                <TableHead>Rider</TableHead>
                                <TableHead className="text-center w-24">Events</TableHead>
                                <TableHead className="text-right w-24">Points</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {classStandings.map(standing => (
                                <TableRow key={standing.riderId}>
                                  <TableCell className="text-center font-heading font-bold text-lg">
                                    {standing.position === 1 ? <Medal className="mx-auto text-yellow-500" size={20} /> :
                                     standing.position === 2 ? <Medal className="mx-auto text-gray-400" size={20} /> :
                                     standing.position === 3 ? <Medal className="mx-auto text-amber-700" size={20} /> :
                                     standing.position}
                                  </TableCell>
                                  <TableCell className="font-bold">{standing.riderName}</TableCell>
                                  <TableCell className="text-center font-mono text-muted-foreground">{standing.eventsEntered || 0}</TableCell>
                                  <TableCell className="text-right font-heading font-bold text-xl text-primary">{standing.totalPoints}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="p-16 text-center">
                    <Trophy className="mx-auto text-muted-foreground opacity-20 mb-4" size={48} />
                    <h3 className="text-xl font-heading font-bold mb-2">No Standings Yet</h3>
                    <p className="text-muted-foreground">Results will appear here once events are completed and scored.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          ) : (
            <div className="h-full flex items-center justify-center p-12 border rounded-lg border-dashed text-muted-foreground">
              Select a series to view its leaderboard.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
