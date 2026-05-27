import { useState } from "react";
import { useRoute } from "wouter";
import { useListMotos, useGenerateLineups, useUpdateMoto, useGetEvent, getListMotosQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Settings, Play, CheckCircle, Flag, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function Motos() {
  const [match, params] = useRoute("/events/:eventId/motos");
  const eventId = parseInt(params?.eventId || "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [isGenerateOpen, setIsGenerateOpen] = useState(false);
  const [format, setFormat] = useState<"one_moto" | "two_moto" | "three_moto">("two_moto");

  const { data: event } = useGetEvent(eventId, { query: { enabled: !!eventId } as any });
  const { data: motos, isLoading } = useListMotos(eventId, { query: { enabled: !!eventId } as any });
  
  const generateMutation = useGenerateLineups();
  const updateMutation = useUpdateMoto();

  const handleGenerate = () => {
    if (!event?.raceClasses) return;
    
    generateMutation.mutate({
      eventId,
      data: {
        raceFormat: format,
        classes: event.raceClasses,
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
        setIsGenerateOpen(false);
        toast({ title: "Lineups generated" });
      },
      onError: (err) => {
        toast({ title: "Failed to generate", description: err.message, variant: "destructive" });
      }
    });
  };

  const handleStatusUpdate = (motoId: number, status: string) => {
    updateMutation.mutate({
      motoId,
      data: { status }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
      }
    });
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-heading font-bold uppercase tracking-tight">Moto Management</h2>
          <p className="text-muted-foreground">Manage heats, mains, and starting lineups.</p>
        </div>
        
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
              <p className="text-sm text-muted-foreground">This will generate motos based on checked-in riders for all classes.</p>
              
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
              
              <Button 
                onClick={handleGenerate} 
                disabled={generateMutation.isPending} 
                className="w-full font-heading uppercase"
              >
                {generateMutation.isPending ? "Generating..." : "Generate Lineups"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {[...Array(4)].map((_, i) => <Card key={i} className="h-64 animate-pulse"></Card>)}
        </div>
      ) : motos?.length ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
          {motos.sort((a,b) => (a.motoNumber || 0) - (b.motoNumber || 0)).map(moto => (
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
                    moto.status === 'in_progress' ? 'bg-primary/20 text-primary border-primary/30' :
                    moto.status === 'completed' ? 'bg-secondary/20 text-secondary border-secondary/30' :
                    'bg-sidebar-accent text-sidebar-foreground/80 border-transparent'
                  }`}>
                    {moto.status.replace('_', ' ')}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="p-0 flex-1 flex flex-col">
                <div className="flex-1 overflow-y-auto max-h-64 border-b">
                  <Table>
                    <TableHeader className="bg-muted/50 sticky top-0">
                      <TableRow>
                        <TableHead className="w-12 text-center text-xs">Gate</TableHead>
                        <TableHead className="text-xs">Rider</TableHead>
                        <TableHead className="w-16 text-right text-xs">Bib</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {moto.lineup && moto.lineup.length > 0 ? (
                        moto.lineup.map(entry => (
                          <TableRow key={entry.riderId} className="h-8">
                            <TableCell className="text-center font-heading font-bold">{entry.position}</TableCell>
                            <TableCell className="font-medium">{entry.riderName}</TableCell>
                            <TableCell className="text-right font-mono text-sm">{entry.bibNumber || "-"}</TableCell>
                          </TableRow>
                        ))
                      ) : (
                        <TableRow><TableCell colSpan={3} className="text-center py-4 text-muted-foreground text-sm">No lineup generated</TableCell></TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
                <div className="p-3 bg-muted/30 flex gap-2 justify-end">
                  {moto.status === 'scheduled' && (
                    <Button size="sm" onClick={() => handleStatusUpdate(moto.id, 'in_progress')} className="font-heading uppercase text-xs">
                      <Play size={14} className="mr-1" /> Start
                    </Button>
                  )}
                  {moto.status === 'in_progress' && (
                    <Button size="sm" variant="outline" className="text-secondary border-secondary/50 font-heading uppercase text-xs" onClick={() => handleStatusUpdate(moto.id, 'completed')}>
                      <CheckCircle size={14} className="mr-1" /> Finish
                    </Button>
                  )}
                  {moto.status === 'completed' && (
                    <Button size="sm" variant="ghost" className="text-muted-foreground font-heading uppercase text-xs" onClick={() => handleStatusUpdate(moto.id, 'in_progress')}>
                      <RefreshCw size={14} className="mr-1" /> Reopen
                    </Button>
                  )}
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
    </div>
  );
}
