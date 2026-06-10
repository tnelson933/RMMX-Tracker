import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDiscountCategories,
  useCreateDiscountCategory,
  useUpdateDiscountCategory,
  useDeleteDiscountCategory,
  useListDiscountCodes,
  useCreateDiscountCode,
  useUpdateDiscountCode,
  useDeleteDiscountCode,
  getListDiscountCategoriesQueryKey,
  getListDiscountCodesQueryKey,
} from "@workspace/api-client-react";
import type { DiscountCategory, DiscountCode } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import {
  Tag,
  Plus,
  Trash2,
  Pencil,
  PowerOff,
  Power,
  RefreshCw,
  Copy,
} from "lucide-react";

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function isExpired(code: DiscountCode): boolean {
  return !!code.expiresAt && new Date() > new Date(code.expiresAt);
}

// ─────────────────────────────────────────────────────────────────────────────
// Discount Code Categories section
// ─────────────────────────────────────────────────────────────────────────────

function DiscountCodeCategories() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: categories = [], isLoading } = useListDiscountCategories({ query: {} as any });
  const createMut = useCreateDiscountCategory();
  const updateMut = useUpdateDiscountCategory();
  const deleteMut = useDeleteDiscountCategory();

  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const handleCreate = () => {
    const name = newName.trim();
    if (!name) return;
    createMut.mutate({ data: { name } }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListDiscountCategoriesQueryKey() });
        setNewName("");
        toast({ title: "Category created" });
      },
      onError: () => toast({ title: "Failed to create category", variant: "destructive" }),
    });
  };

  const handleUpdate = (id: number) => {
    const name = editingName.trim();
    if (!name) return;
    updateMut.mutate({ categoryId: id, data: { name } }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListDiscountCategoriesQueryKey() });
        setEditingId(null);
        toast({ title: "Category updated" });
      },
      onError: () => toast({ title: "Failed to update category", variant: "destructive" }),
    });
  };

  const handleDelete = (id: number) => {
    deleteMut.mutate({ categoryId: id }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListDiscountCategoriesQueryKey() });
        setDeleteConfirmId(null);
        toast({ title: "Category deleted" });
      },
      onError: () => toast({ title: "Failed to delete category", variant: "destructive" }),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-heading font-bold uppercase tracking-wide flex items-center gap-2">
          <Tag size={16} />
          Discount Code Categories
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Define named categories (e.g. "Entry Fees", "Pit Passes") to restrict which discount codes apply where.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Add category row */}
        <div className="flex gap-2">
          <Input
            placeholder="New category name"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleCreate()}
            className="max-w-sm"
          />
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={!newName.trim() || createMut.isPending}
          >
            <Plus size={14} className="mr-1" />
            Add
          </Button>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">No categories yet.</p>
        ) : (
          <div className="divide-y rounded-md border">
            {categories.map((cat: DiscountCategory) => (
              <div key={cat.id} className="flex items-center gap-2 px-3 py-2">
                {editingId === cat.id ? (
                  <>
                    <Input
                      value={editingName}
                      onChange={e => setEditingName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") handleUpdate(cat.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      className="h-7 text-sm"
                      autoFocus
                    />
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleUpdate(cat.id)} disabled={updateMut.isPending}>Save</Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditingId(null)}>Cancel</Button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-sm font-medium">{cat.name}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={() => { setEditingId(cat.id); setEditingName(cat.name); }}
                    >
                      <Pencil size={13} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={() => setDeleteConfirmId(cat.id)}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={deleteConfirmId !== null} onOpenChange={() => setDeleteConfirmId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Category?</DialogTitle>
            <DialogDescription>
              This will remove the category. Existing discount codes that reference it won't be affected.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setDeleteConfirmId(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirmId !== null && handleDelete(deleteConfirmId)}
              disabled={deleteMut.isPending}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Discount Codes section
// ─────────────────────────────────────────────────────────────────────────────

type UsageType = "one_time" | "limited" | "unlimited";

interface CreateForm {
  code: string;
  autoGenerate: boolean;
  amount: string;
  usageType: UsageType;
  limitedCount: string;
  hasExpiry: boolean;
  expiresAt: string;
  categoryIds: number[];
}

const DEFAULT_FORM: CreateForm = {
  code: "",
  autoGenerate: true,
  amount: "",
  usageType: "one_time",
  limitedCount: "10",
  hasExpiry: false,
  expiresAt: "",
  categoryIds: [],
};

function DiscountCodesTable() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: codes = [], isLoading } = useListDiscountCodes({ query: {} as any });
  const { data: categories = [] } = useListDiscountCategories({ query: {} as any });
  const createMut = useCreateDiscountCode();
  const updateMut = useUpdateDiscountCode();
  const deleteMut = useDeleteDiscountCode();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(DEFAULT_FORM);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const catMap = Object.fromEntries((categories as DiscountCategory[]).map(c => [c.id, c.name]));

  const handleCreate = () => {
    const amount = parseFloat(form.amount);
    if (isNaN(amount) || amount <= 0) {
      toast({ title: "Amount must be greater than 0", variant: "destructive" });
      return;
    }

    let maxUses: number;
    if (form.usageType === "one_time") maxUses = 1;
    else if (form.usageType === "unlimited") maxUses = -1;
    else maxUses = Math.max(1, parseInt(form.limitedCount) || 1);

    const payload: any = {
      amount,
      maxUses,
      expiresAt: form.hasExpiry && form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
      categoryIds: form.categoryIds,
    };
    if (!form.autoGenerate && form.code.trim()) {
      payload.code = form.code.trim().toUpperCase();
    }

    createMut.mutate({ data: payload }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListDiscountCodesQueryKey() });
        setDrawerOpen(false);
        setForm(DEFAULT_FORM);
        toast({ title: "Discount code created" });
      },
      onError: (err: any) => {
        const msg = err?.response?.data?.error ?? "Failed to create code";
        toast({ title: msg, variant: "destructive" });
      },
    });
  };

  const handleToggleActive = (code: DiscountCode) => {
    updateMut.mutate({ codeId: code.id, data: { isActive: !code.isActive } }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListDiscountCodesQueryKey() });
        toast({ title: code.isActive ? "Code deactivated" : "Code activated" });
      },
      onError: () => toast({ title: "Failed to update code", variant: "destructive" }),
    });
  };

  const handleDelete = (id: number) => {
    deleteMut.mutate({ codeId: id }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListDiscountCodesQueryKey() });
        setDeleteConfirmId(null);
        toast({ title: "Code deleted" });
      },
      onError: () => toast({ title: "Failed to delete code", variant: "destructive" }),
    });
  };

  const getUsageBadge = (code: DiscountCode) => {
    if (code.maxUses >= 999999) return <Badge variant="secondary">Unlimited</Badge>;
    if (code.maxUses === 1) return <Badge variant="outline">One-time</Badge>;
    return <Badge variant="outline">Limited ({code.maxUses})</Badge>;
  };

  const getStatusBadge = (code: DiscountCode) => {
    if (!code.isActive) return <Badge variant="destructive">Inactive</Badge>;
    if (isExpired(code)) return <Badge variant="destructive">Expired</Badge>;
    if (code.usesCount >= code.maxUses) return <Badge variant="destructive">Used up</Badge>;
    return <Badge variant="default" className="bg-green-600">Active</Badge>;
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base font-heading font-bold uppercase tracking-wide flex items-center gap-2">
              <Tag size={16} />
              Discount Codes
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Create and manage discount codes for your club. Codes can be one-time use, limited, or unlimited.
            </p>
          </div>
          <Button size="sm" onClick={() => { setForm(DEFAULT_FORM); setDrawerOpen(true); }}>
            <Plus size={14} className="mr-1" />
            New Code
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : codes.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground">
            <Tag size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">No discount codes yet.</p>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => { setForm(DEFAULT_FORM); setDrawerOpen(true); }}>
              Create your first code
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Usage</TableHead>
                <TableHead>Uses</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Categories</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(codes as DiscountCode[]).map(code => (
                <TableRow key={code.id} className={!code.isActive || isExpired(code) ? "opacity-60" : ""}>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono font-bold tracking-wider text-sm">{code.code}</span>
                      <button
                        className="text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => { navigator.clipboard.writeText(code.code); toast({ title: "Copied!" }); }}
                        title="Copy code"
                      >
                        <Copy size={12} />
                      </button>
                    </div>
                  </TableCell>
                  <TableCell className="font-semibold">${Number(code.amount).toFixed(2)}</TableCell>
                  <TableCell>{getUsageBadge(code)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {code.maxUses >= 999999 ? `${code.usesCount} used` : `${code.usesCount} / ${code.maxUses}`}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(code.expiresAt)}</TableCell>
                  <TableCell>
                    {code.categoryIds.length === 0 ? (
                      <span className="text-xs text-muted-foreground">All</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {code.categoryIds.map(id => (
                          <Badge key={id} variant="secondary" className="text-xs">
                            {catMap[id] ?? `#${id}`}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{getStatusBadge(code)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground"
                        title={code.isActive ? "Deactivate" : "Activate"}
                        onClick={() => handleToggleActive(code)}
                        disabled={updateMut.isPending}
                      >
                        {code.isActive ? <PowerOff size={13} /> : <Power size={13} />}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        title="Delete"
                        onClick={() => setDeleteConfirmId(code.id)}
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {/* Create drawer */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent className="sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle>New Discount Code</SheetTitle>
          </SheetHeader>
          <div className="space-y-5 mt-6">
            {/* Code string */}
            <div className="space-y-2">
              <Label>Code String</Label>
              <div className="flex items-center gap-2">
                <Switch
                  checked={form.autoGenerate}
                  onCheckedChange={v => setForm(f => ({ ...f, autoGenerate: v, code: "" }))}
                  id="auto-gen"
                />
                <label htmlFor="auto-gen" className="text-sm text-muted-foreground">Auto-generate</label>
              </div>
              {!form.autoGenerate && (
                <Input
                  placeholder="e.g. SUMMER25"
                  value={form.code}
                  onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))}
                  className="font-mono uppercase"
                  maxLength={20}
                />
              )}
            </div>

            <Separator />

            {/* Amount */}
            <div className="space-y-1.5">
              <Label>Discount Amount ($)</Label>
              <Input
                type="number"
                placeholder="0.00"
                min="0.01"
                step="0.01"
                value={form.amount}
                onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
              />
            </div>

            {/* Usage type */}
            <div className="space-y-1.5">
              <Label>Usage Type</Label>
              <Select
                value={form.usageType}
                onValueChange={(v: UsageType) => setForm(f => ({ ...f, usageType: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="one_time">One-time use (max 1 use)</SelectItem>
                  <SelectItem value="limited">Limited uses (custom count)</SelectItem>
                  <SelectItem value="unlimited">Unlimited</SelectItem>
                </SelectContent>
              </Select>
              {form.usageType === "limited" && (
                <Input
                  type="number"
                  min="2"
                  value={form.limitedCount}
                  onChange={e => setForm(f => ({ ...f, limitedCount: e.target.value }))}
                  placeholder="Number of uses"
                />
              )}
            </div>

            {/* Expiry */}
            <div className="space-y-2">
              <Label>Expiration</Label>
              <div className="flex items-center gap-2">
                <Switch
                  checked={form.hasExpiry}
                  onCheckedChange={v => setForm(f => ({ ...f, hasExpiry: v, expiresAt: "" }))}
                  id="has-expiry"
                />
                <label htmlFor="has-expiry" className="text-sm text-muted-foreground">Set expiry date</label>
              </div>
              {form.hasExpiry && (
                <Input
                  type="datetime-local"
                  value={form.expiresAt}
                  onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))}
                />
              )}
            </div>

            {/* Categories */}
            {(categories as DiscountCategory[]).length > 0 && (
              <div className="space-y-2">
                <Label>Valid For Categories</Label>
                <p className="text-xs text-muted-foreground">Leave all unchecked to allow the code for any category.</p>
                <div className="space-y-2 rounded-md border p-3">
                  {(categories as DiscountCategory[]).map(cat => (
                    <div key={cat.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`cat-${cat.id}`}
                        checked={form.categoryIds.includes(cat.id)}
                        onCheckedChange={checked => {
                          setForm(f => ({
                            ...f,
                            categoryIds: checked
                              ? [...f.categoryIds, cat.id]
                              : f.categoryIds.filter(id => id !== cat.id),
                          }));
                        }}
                      />
                      <label htmlFor={`cat-${cat.id}`} className="text-sm cursor-pointer">{cat.name}</label>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setDrawerOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={createMut.isPending}>
                {createMut.isPending ? (
                  <><RefreshCw size={14} className="mr-1.5 animate-spin" /> Creating…</>
                ) : "Create Code"}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Delete confirm dialog */}
      <Dialog open={deleteConfirmId !== null} onOpenChange={() => setDeleteConfirmId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Discount Code?</DialogTitle>
            <DialogDescription>
              This will permanently remove the code. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setDeleteConfirmId(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirmId !== null && handleDelete(deleteConfirmId)}
              disabled={deleteMut.isPending}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function DiscountCodesPage() {
  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="font-heading font-bold text-2xl uppercase tracking-wide flex items-center gap-2">
          <Tag size={22} />
          Discount Codes
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Manage club-wide discount codes and the categories they apply to.
        </p>
      </div>

      <DiscountCodesTable />
      <DiscountCodeCategories />
    </div>
  );
}
