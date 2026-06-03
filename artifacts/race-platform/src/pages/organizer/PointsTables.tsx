import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPointsTables,
  useCreatePointsTable,
  useUpdatePointsTable,
  useDeletePointsTable,
  getListPointsTablesQueryKey,
} from "@workspace/api-client-react";
import type { PointsTable } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  ListOrdered,
  Plus,
  Pencil,
  Trash2,
  ChevronRight,
  TrendingUp,
  TrendingDown,
  Zap,
  Info,
} from "lucide-react";

const SUPERCROSS_SCALE = [25, 22, 20, 18, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
const OLYMPIC_SCALE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

function scaleToText(scale: number[]): string {
  return scale.join(", ");
}

function parseScale(text: string): number[] {
  return text
    .split(/[,\s]+/)
    .map((v) => Number(v.trim()))
    .filter((v) => !isNaN(v) && v > 0);
}

function getMethodLabel(method: string) {
  return method === "lowest_positions" ? "Lowest Positions" : "Highest Points";
}

function getMethodIcon(method: string) {
  return method === "lowest_positions" ? TrendingDown : TrendingUp;
}

interface FormState {
  name: string;
  description: string;
  scoringMethod: "highest_points" | "lowest_positions";
  mainEventOnly: boolean;
  scaleText: string;
}

const defaultForm: FormState = {
  name: "",
  description: "",
  scoringMethod: "highest_points",
  mainEventOnly: false,
  scaleText: scaleToText(SUPERCROSS_SCALE),
};

function TableDetailSheet({
  table,
  open,
  onClose,
  onEdit,
  onDelete,
}: {
  table: PointsTable | null;
  open: boolean;
  onClose: () => void;
  onEdit: (table: PointsTable) => void;
  onDelete: (table: PointsTable) => void;
}) {
  if (!table) return null;
  const MethodIcon = getMethodIcon(table.scoringMethod);
  const scale = table.pointsScale as number[];

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader className="pr-6">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 p-2 rounded-lg bg-primary/10">
              <ListOrdered size={20} className="text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <SheetTitle className="text-xl leading-tight">{table.name}</SheetTitle>
              <div className="flex flex-wrap gap-2 mt-2">
                {table.isSystemDefault && (
                  <Badge variant="secondary" className="font-heading uppercase tracking-wider text-[10px]">
                    System Default
                  </Badge>
                )}
                {!table.isSystemDefault && (
                  <Badge variant="outline" className="font-heading uppercase tracking-wider text-[10px]">
                    Custom
                  </Badge>
                )}
                <Badge
                  variant="outline"
                  className="gap-1 font-heading uppercase tracking-wider text-[10px]"
                >
                  <MethodIcon size={10} />
                  {getMethodLabel(table.scoringMethod)}
                </Badge>
                {table.mainEventOnly && (
                  <Badge variant="outline" className="gap-1 font-heading uppercase tracking-wider text-[10px]">
                    <Zap size={10} />
                    Main Event Only
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {table.description && (
            <div className="rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground leading-relaxed">
              <div className="flex items-center gap-2 mb-2 text-foreground font-medium text-xs uppercase tracking-wider font-heading">
                <Info size={12} />
                How it works
              </div>
              {table.description}
            </div>
          )}

          <div>
            <div className="text-xs font-heading font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Points Breakdown — {scale.length} positions scored
            </div>
            <div className="rounded-lg border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30">
                    <TableHead className="font-heading uppercase tracking-wider text-xs w-1/2 py-2">
                      Position
                    </TableHead>
                    <TableHead className="font-heading uppercase tracking-wider text-xs py-2">
                      {table.scoringMethod === "lowest_positions" ? "Score (lower = better)" : "Points"}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scale.map((pts, i) => (
                    <TableRow key={i} className={i === 0 ? "bg-primary/5" : ""}>
                      <TableCell className="py-1.5 font-medium text-sm">
                        <span className={`inline-flex items-center gap-1.5 ${i === 0 ? "text-primary font-bold" : ""}`}>
                          {i === 0 && "🥇"}
                          {i === 1 && "🥈"}
                          {i === 2 && "🥉"}
                          {i > 2 && <span className="text-muted-foreground">{i + 1}th</span>}
                          {i === 0 && "1st"}
                          {i === 1 && "2nd"}
                          {i === 2 && "3rd"}
                        </span>
                      </TableCell>
                      <TableCell className={`py-1.5 font-mono text-sm ${i === 0 ? "font-bold text-primary" : ""}`}>
                        {pts}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          {!table.isSystemDefault && (
            <>
              <Separator />
              <div className="flex gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => onEdit(table)}
                >
                  <Pencil size={14} />
                  Edit Table
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 text-destructive hover:text-destructive border-destructive/30 hover:border-destructive/60 hover:bg-destructive/5"
                  onClick={() => onDelete(table)}
                >
                  <Trash2 size={14} />
                  Delete
                </Button>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function TableFormDialog({
  open,
  onClose,
  editingTable,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  editingTable: PointsTable | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(() =>
    editingTable
      ? {
          name: editingTable.name,
          description: editingTable.description,
          scoringMethod: editingTable.scoringMethod as "highest_points" | "lowest_positions",
          mainEventOnly: editingTable.mainEventOnly,
          scaleText: scaleToText(editingTable.pointsScale as number[]),
        }
      : defaultForm
  );

  const createMutation = useCreatePointsTable();
  const updateMutation = useUpdatePointsTable();

  const isEditing = !!editingTable;
  const isPending = createMutation.isPending || updateMutation.isPending;

  function applyPreset(method: "highest_points" | "lowest_positions") {
    const scale = method === "lowest_positions" ? OLYMPIC_SCALE : SUPERCROSS_SCALE;
    setForm((f) => ({ ...f, scoringMethod: method, scaleText: scaleToText(scale) }));
  }

  function handleMethodChange(method: "highest_points" | "lowest_positions") {
    applyPreset(method);
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const pointsScale = parseScale(form.scaleText);
    if (!form.name.trim()) { toast({ title: "Name is required", variant: "destructive" }); return; }
    if (pointsScale.length === 0) { toast({ title: "Enter at least one points value", variant: "destructive" }); return; }

    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
      scoringMethod: form.scoringMethod,
      mainEventOnly: form.mainEventOnly,
      pointsScale,
    };

    try {
      if (isEditing) {
        await updateMutation.mutateAsync({ tableId: editingTable!.id, data: payload });
        toast({ title: "Points table updated" });
      } else {
        await createMutation.mutateAsync({ data: payload });
        toast({ title: "Points table created" });
      }
      onSaved();
      onClose();
    } catch {
      toast({ title: "Something went wrong", variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Points Table" : "Create Points Table"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5 pt-2">
          <div className="space-y-2">
            <Label htmlFor="pt-name">Name</Label>
            <Input
              id="pt-name"
              placeholder="e.g. Club Standard, Youth Series..."
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="pt-desc">Description</Label>
            <Textarea
              id="pt-desc"
              placeholder="Explain how this scoring system works..."
              rows={3}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>

          <div className="space-y-2">
            <Label>Scoring Method</Label>
            <Select
              value={form.scoringMethod}
              onValueChange={(v) => handleMethodChange(v as "highest_points" | "lowest_positions")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="highest_points">
                  <span className="flex items-center gap-2">
                    <TrendingUp size={14} />
                    Highest Points Total wins
                  </span>
                </SelectItem>
                <SelectItem value="lowest_positions">
                  <span className="flex items-center gap-2">
                    <TrendingDown size={14} />
                    Lowest Positions Total wins
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {form.scoringMethod === "lowest_positions"
                ? "Rider with the fewest total position points wins (Olympic style). 1st = 1, 2nd = 2, etc."
                : "Rider with the highest total points wins. 1st place earns the most points."}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Switch
              id="pt-main"
              checked={form.mainEventOnly}
              onCheckedChange={(v) => setForm((f) => ({ ...f, mainEventOnly: v }))}
            />
            <div>
              <Label htmlFor="pt-main" className="cursor-pointer">Main Event Only</Label>
              <p className="text-xs text-muted-foreground">Only count points from the Main Event moto</p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="pt-scale">Points per Position</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs px-2"
                  onClick={() => setForm((f) => ({ ...f, scaleText: scaleToText(SUPERCROSS_SCALE) }))}
                >
                  AMA preset
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs px-2"
                  onClick={() => setForm((f) => ({ ...f, scaleText: scaleToText(OLYMPIC_SCALE) }))}
                >
                  Olympic preset
                </Button>
              </div>
            </div>
            <Textarea
              id="pt-scale"
              placeholder="25, 22, 20, 18, 16, ..."
              rows={3}
              value={form.scaleText}
              onChange={(e) => setForm((f) => ({ ...f, scaleText: e.target.value }))}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Enter points for each finishing position, comma-separated. First value = 1st place.
              {parseScale(form.scaleText).length > 0 && (
                <span className="ml-1 text-primary font-medium">
                  {parseScale(form.scaleText).length} positions scored.
                </span>
              )}
            </p>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving..." : isEditing ? "Save Changes" : "Create Table"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TableCard({
  table,
  onClick,
}: {
  table: PointsTable;
  onClick: () => void;
}) {
  const scale = table.pointsScale as number[];
  const MethodIcon = getMethodIcon(table.scoringMethod);

  return (
    <button
      onClick={onClick}
      className="group w-full text-left rounded-xl border bg-card hover:border-primary/40 hover:shadow-md transition-all duration-200 p-5 flex flex-col gap-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-heading font-semibold text-base leading-tight mb-1.5">
            {table.name}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {table.isSystemDefault ? (
              <Badge variant="secondary" className="font-heading uppercase tracking-wider text-[10px]">
                System Default
              </Badge>
            ) : (
              <Badge variant="outline" className="font-heading uppercase tracking-wider text-[10px]">
                Custom
              </Badge>
            )}
            <Badge variant="outline" className="gap-1 font-heading uppercase tracking-wider text-[10px]">
              <MethodIcon size={9} />
              {getMethodLabel(table.scoringMethod)}
            </Badge>
            {table.mainEventOnly && (
              <Badge variant="outline" className="gap-1 font-heading uppercase tracking-wider text-[10px]">
                <Zap size={9} />
                Main Event Only
              </Badge>
            )}
          </div>
        </div>
        <ChevronRight size={16} className="text-muted-foreground/40 group-hover:text-primary transition-colors shrink-0 mt-1" />
      </div>

      {table.description && (
        <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed">
          {table.description}
        </p>
      )}

      <div className="flex items-center gap-2 pt-1 border-t">
        <div className="flex items-center gap-1 flex-wrap">
          {scale.slice(0, 5).map((pts, i) => (
            <div key={i} className="flex flex-col items-center">
              <span className="text-[10px] text-muted-foreground leading-none mb-0.5">{i + 1}</span>
              <span className={`text-xs font-mono font-bold leading-none ${i === 0 ? "text-primary" : "text-foreground"}`}>
                {pts}
              </span>
            </div>
          ))}
          {scale.length > 5 && (
            <span className="text-xs text-muted-foreground font-mono ml-1">
              ···{scale.length - 5} more
            </span>
          )}
        </div>
        <span className="ml-auto text-[10px] text-muted-foreground font-heading uppercase tracking-wider">
          {scale.length} positions
        </span>
      </div>
    </button>
  );
}

export default function PointsTables() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: tables = [], isLoading } = useListPointsTables({ query: {} as any });
  const deleteMutation = useDeletePointsTable();

  const [selectedTable, setSelectedTable] = useState<PointsTable | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTable, setEditingTable] = useState<PointsTable | null>(null);

  const systemTables = tables.filter((t) => t.isSystemDefault);
  const customTables = tables.filter((t) => !t.isSystemDefault);

  function openDetail(table: PointsTable) {
    setSelectedTable(table);
    setSheetOpen(true);
  }

  function openCreate() {
    setEditingTable(null);
    setDialogOpen(true);
  }

  function openEdit(table: PointsTable) {
    setEditingTable(table);
    setSheetOpen(false);
    setDialogOpen(true);
  }

  async function handleDelete(table: PointsTable) {
    if (!confirm(`Delete "${table.name}"? This cannot be undone.`)) return;
    try {
      await deleteMutation.mutateAsync({ tableId: table.id });
      toast({ title: "Points table deleted" });
      setSheetOpen(false);
      queryClient.invalidateQueries({ queryKey: getListPointsTablesQueryKey() });
    } catch {
      toast({ title: "Failed to delete", variant: "destructive" });
    }
  }

  function onSaved() {
    queryClient.invalidateQueries({ queryKey: getListPointsTablesQueryKey() });
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-heading font-bold text-2xl uppercase tracking-wider text-foreground flex items-center gap-3">
            <ListOrdered size={24} className="text-primary" />
            Points Scoring Tables
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Choose from system templates or create your own custom scoring scale
          </p>
        </div>
        <Button onClick={openCreate} className="gap-2">
          <Plus size={16} />
          Create Table
        </Button>
      </div>

      {isLoading ? (
        <div className="text-center py-16 text-muted-foreground">Loading...</div>
      ) : (
        <div className="space-y-8">
          {/* System defaults */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <h2 className="font-heading font-semibold text-sm uppercase tracking-widest text-muted-foreground">
                System Templates
              </h2>
              <div className="flex-1 h-px bg-border" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {systemTables.map((table) => (
                <TableCard key={table.id} table={table} onClick={() => openDetail(table)} />
              ))}
            </div>
          </section>

          {/* Custom tables */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <h2 className="font-heading font-semibold text-sm uppercase tracking-widest text-muted-foreground">
                My Custom Tables
              </h2>
              <div className="flex-1 h-px bg-border" />
            </div>
            {customTables.length === 0 ? (
              <div className="rounded-xl border-2 border-dashed p-10 text-center">
                <ListOrdered size={32} className="mx-auto text-muted-foreground/30 mb-3" />
                <p className="font-heading font-semibold text-sm text-muted-foreground mb-1">
                  No custom tables yet
                </p>
                <p className="text-xs text-muted-foreground mb-4">
                  Create a custom points scale tailored to your club's format
                </p>
                <Button variant="outline" size="sm" onClick={openCreate} className="gap-2">
                  <Plus size={14} />
                  Create Table
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {customTables.map((table) => (
                  <TableCard key={table.id} table={table} onClick={() => openDetail(table)} />
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* Detail sheet */}
      <TableDetailSheet
        table={selectedTable}
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onEdit={openEdit}
        onDelete={handleDelete}
      />

      {/* Create / edit dialog */}
      {dialogOpen && (
        <TableFormDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          editingTable={editingTable}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}
