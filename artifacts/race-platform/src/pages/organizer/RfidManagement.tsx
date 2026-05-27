import { useState } from "react";
import { useListRfidTags, useAssignRfid, useListRiders, getListRfidTagsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tag, Plus, Search, CheckCircle, Clock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

export default function RfidManagement() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [search, setSearch] = useState("");
  const [isAssignOpen, setIsAssignOpen] = useState(false);
  const [riderIdStr, setRiderIdStr] = useState("");
  const [rfidInput, setRfidInput] = useState("");

  const { data: rfidTags, isLoading } = useListRfidTags();
  const { data: riders } = useListRiders({}, { query: { enabled: isAssignOpen } as any }); // Load riders when dialog opens
  
  const assignMutation = useAssignRfid();

  const handleAssign = () => {
    if (!riderIdStr || !rfidInput) return;
    
    assignMutation.mutate({
      data: {
        riderId: parseInt(riderIdStr),
        rfidNumber: rfidInput
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListRfidTagsQueryKey() });
        setIsAssignOpen(false);
        setRiderIdStr("");
        setRfidInput("");
        toast({ title: "RFID tag assigned successfully" });
      },
      onError: (err) => {
        toast({ title: "Assignment failed", description: err.message, variant: "destructive" });
      }
    });
  };

  const filteredTags = rfidTags?.filter(t => 
    t.rfidNumber.toLowerCase().includes(search.toLowerCase()) ||
    (t.riderName && t.riderName.toLowerCase().includes(search.toLowerCase()))
  ) || [];

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-4xl font-heading font-bold uppercase tracking-tight flex items-center gap-3">
            <Tag className="text-primary" size={32} /> RFID Management
          </h1>
          <p className="text-muted-foreground mt-1">Track and assign timing transponders.</p>
        </div>
        
        <Dialog open={isAssignOpen} onOpenChange={setIsAssignOpen}>
          <DialogTrigger asChild>
            <Button className="font-heading uppercase tracking-wider h-12 px-6">
              <Plus size={16} className="mr-2" /> Assign Tag
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="font-heading uppercase text-xl">Assign RFID Tag</DialogTitle>
            </DialogHeader>
            <div className="space-y-6 py-4">
              <div className="space-y-2">
                <label className="text-sm font-medium uppercase tracking-wider text-muted-foreground">Select Rider</label>
                <Select value={riderIdStr} onValueChange={setRiderIdStr}>
                  <SelectTrigger className="h-12"><SelectValue placeholder="Search/Select Rider..." /></SelectTrigger>
                  <SelectContent>
                    {riders?.map(r => (
                      <SelectItem key={r.id} value={r.id.toString()}>
                        {r.firstName} {r.lastName} {r.bibNumber ? `(Bib: ${r.bibNumber})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium uppercase tracking-wider text-muted-foreground">Scan or Enter Tag Number</label>
                <Input 
                  value={rfidInput} 
                  onChange={e => setRfidInput(e.target.value)} 
                  placeholder="e.g. 1A2B3C4D" 
                  className="font-mono text-lg h-12"
                  autoFocus
                />
              </div>
              <Button 
                onClick={handleAssign} 
                disabled={assignMutation.isPending || !riderIdStr || !rfidInput} 
                className="w-full h-12 font-heading uppercase text-lg tracking-wider mt-2"
              >
                {assignMutation.isPending ? "Assigning..." : "Link Transponder"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="border-sidebar-border overflow-hidden">
        <div className="p-4 bg-muted/30 border-b flex justify-between items-center">
          <div className="relative w-full max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
            <Input 
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search tags or riders..." 
              className="pl-10 h-10"
            />
          </div>
          <div className="text-sm font-bold text-muted-foreground uppercase tracking-wider">
            {filteredTags.length} Active Tags
          </div>
        </div>
        
        <Table>
          <TableHeader className="bg-sidebar text-sidebar-foreground">
            <TableRow className="hover:bg-sidebar">
              <TableHead className="w-1/3 text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">RFID Tag #</TableHead>
              <TableHead className="text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">Assigned To</TableHead>
              <TableHead className="w-48 text-right text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={3} className="text-center py-16">Loading tags...</TableCell></TableRow>
            ) : filteredTags.length > 0 ? (
              filteredTags.map((tag, i) => (
                <TableRow key={i} className="hover:bg-muted/50 transition-colors">
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Tag size={16} className="text-muted-foreground/50" />
                      <span className="font-mono font-bold text-lg bg-muted px-2 py-1 rounded border inline-block">{tag.rfidNumber}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {tag.riderName ? (
                      <span className="font-bold text-lg">{tag.riderName}</span>
                    ) : (
                      <span className="text-muted-foreground italic">Unassigned</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-secondary/10 text-secondary border border-secondary/20">
                      <CheckCircle size={14} /> Active
                    </span>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={3} className="text-center py-16 text-muted-foreground">
                  <Tag size={48} className="mx-auto opacity-20 mb-4" />
                  <p className="text-lg font-medium">No RFID tags assigned yet</p>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
