import { useState } from "react";
import { useRoute } from "wouter";
import { useListRegistrations, useCreateRegistration, useUpdateRegistration, useGetEvent, getListRegistrationsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Search, Check, X, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import * as XLSX from "xlsx";
import { format } from "date-fns";

export default function Registrations() {
  const [match, params] = useRoute("/events/:eventId/registrations");
  const eventId = parseInt(params?.eventId || "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [search, setSearch] = useState("");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newReg, setNewReg] = useState({ riderId: "", raceClass: "", bibNumber: "" });

  const { data: event } = useGetEvent(eventId, { query: { enabled: !!eventId } as any });
  const { data: registrations, isLoading } = useListRegistrations(eventId, { query: { enabled: !!eventId } as any });
  
  const createMutation = useCreateRegistration();
  const updateMutation = useUpdateRegistration();

  const handleCreate = () => {
    createMutation.mutate({
      eventId,
      data: {
        riderId: parseInt(newReg.riderId),
        raceClass: newReg.raceClass,
        bibNumber: newReg.bibNumber || undefined,
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListRegistrationsQueryKey(eventId) });
        setIsAddOpen(false);
        setNewReg({ riderId: "", raceClass: "", bibNumber: "" });
        toast({ title: "Registration added" });
      },
      onError: (err) => {
        toast({ title: "Failed to add", description: err.message, variant: "destructive" });
      }
    });
  };

  const handleUpdateStatus = (regId: number, status: string) => {
    updateMutation.mutate({
      registrationId: regId,
      data: { status }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListRegistrationsQueryKey(eventId) });
      }
    });
  };

  const filteredRegs = registrations?.filter(r => 
    r.riderName.toLowerCase().includes(search.toLowerCase()) ||
    (r.bibNumber && r.bibNumber.includes(search))
  ) || [];

  const handleExport = () => {
    const rows = (registrations ?? []).map((r) => ({
      "Registration ID": r.id,
      "Rider Name": r.riderName,
      "Race Class": r.raceClass,
      "Bib #": r.bibNumber ?? "",
      "Status": r.status,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Registrations");
    const slug = (event?.name ?? `event-${eventId}`).replace(/[^a-z0-9]/gi, "_").toLowerCase();
    const dateStr = format(new Date(), "yyyy-MM-dd");
    XLSX.writeFile(wb, `${slug}_registrations_${dateStr}.xlsx`);
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
        <div className="relative w-full max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
          <Input 
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search registrations..." 
            className="pl-10"
          />
        </div>
        
        <div className="flex gap-2 w-full sm:w-auto">
          {(registrations?.length ?? 0) > 0 && (
            <Button
              variant="outline"
              onClick={handleExport}
              className="font-heading uppercase tracking-wider w-full sm:w-auto"
            >
              <Download size={16} className="mr-2" /> Export Excel
            </Button>
          )}
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button className="font-heading uppercase tracking-wider w-full sm:w-auto">
                <Plus size={16} className="mr-2" /> Add Registration
              </Button>
            </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="font-heading uppercase text-xl">Add Registration</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Rider ID</label>
                <Input value={newReg.riderId} onChange={e => setNewReg({...newReg, riderId: e.target.value})} placeholder="e.g. 123" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Race Class</label>
                <Select value={newReg.raceClass} onValueChange={v => setNewReg({...newReg, raceClass: v})}>
                  <SelectTrigger><SelectValue placeholder="Select Class" /></SelectTrigger>
                  <SelectContent>
                    {event?.raceClasses?.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Bib Number (Optional)</label>
                <Input value={newReg.bibNumber} onChange={e => setNewReg({...newReg, bibNumber: e.target.value})} placeholder="e.g. 741" />
              </div>
              <Button 
                onClick={handleCreate} 
                disabled={createMutation.isPending || !newReg.riderId || !newReg.raceClass} 
                className="w-full font-heading uppercase"
              >
                Submit
              </Button>
            </div>
          </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card>
        <div className="rounded-md border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="w-16">ID</TableHead>
                <TableHead className="font-heading font-bold uppercase tracking-wider">Rider</TableHead>
                <TableHead className="font-heading font-bold uppercase tracking-wider">Class</TableHead>
                <TableHead className="font-heading font-bold uppercase tracking-wider">Bib</TableHead>
                <TableHead className="font-heading font-bold uppercase tracking-wider">Status</TableHead>
                <TableHead className="text-right font-heading font-bold uppercase tracking-wider">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6} className="text-center py-8">Loading...</TableCell></TableRow>
              ) : filteredRegs.length > 0 ? (
                filteredRegs.map(reg => (
                  <TableRow key={reg.id}>
                    <TableCell className="text-muted-foreground font-mono">{reg.id}</TableCell>
                    <TableCell className="font-bold">{reg.riderName}</TableCell>
                    <TableCell>
                      <span className="bg-secondary/10 text-secondary px-2 py-1 rounded text-xs font-bold uppercase tracking-wider">
                        {reg.raceClass}
                      </span>
                    </TableCell>
                    <TableCell>
                      {reg.bibNumber ? (
                        <span className="font-mono bg-muted px-2 py-1 rounded border">{reg.bibNumber}</span>
                      ) : "-"}
                    </TableCell>
                    <TableCell>
                      <span className={`px-2 py-1 rounded text-xs font-bold uppercase tracking-wider border ${
                        reg.status === 'confirmed' ? 'bg-secondary/10 text-secondary border-secondary/20' : 
                        reg.status === 'pending' ? 'bg-amber-500/10 text-amber-600 border-amber-500/20' : 
                        'bg-muted text-muted-foreground'
                      }`}>
                        {reg.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      {reg.status !== 'confirmed' && (
                        <Button variant="ghost" size="icon" onClick={() => handleUpdateStatus(reg.id, 'confirmed')} className="text-secondary hover:text-secondary hover:bg-secondary/10">
                          <Check size={18} />
                        </Button>
                      )}
                      {reg.status !== 'void' && (
                        <Button variant="ghost" size="icon" onClick={() => handleUpdateStatus(reg.id, 'void')} className="text-destructive hover:text-destructive hover:bg-destructive/10">
                          <X size={18} />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No registrations found.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
