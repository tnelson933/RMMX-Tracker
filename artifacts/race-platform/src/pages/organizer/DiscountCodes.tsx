import { useState, useRef, useEffect } from "react";
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
  useGetDiscountCodeUsage,
  useListRiders,
  getListDiscountCategoriesQueryKey,
  getListDiscountCodesQueryKey,
} from "@workspace/api-client-react";
import type { DiscountCategory, DiscountCode, DiscountCodeUsageEntry, Rider } from "@workspace/api-client-react";
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
  History,
  User,
  X,
  ChevronDown,
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
type DiscountTypeVal = "fixed" | "percentage";

interface CreateForm {
  code: string;
  autoGenerate: boolean;
  discountType: DiscountTypeVal;
  amount: string;
  usageType: UsageType;
  limitedCount: string;
  hasExpiry: boolean;
  expiresAt: string;
  categoryIds: number[];
  riderId: number | null;
  riderSearch: string;
}

const DEFAULT_FORM: CreateForm = {
  code: "",
  autoGenerate: true,
  discountType: "fixed",
  amount: "",
  usageType: "one_time",
  limitedCount: "10",
  hasExpiry: false,
  expiresAt: "",
  categoryIds: [],
  riderId: null,
  riderSearch: "",
};

function DiscountCodesTable() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: codes = [], isLoading } = useListDiscountCodes(undefined, { query: {} as any });
  const { data: categories = [] } = useListDiscountCategories({ query: {} as any });
  const { data: allRiders = [] } = useListRiders({}, { query: {} as any });
  const createMut = useCreateDiscountCode();
  const updateMut = useUpdateDiscountCode();
  const deleteMut = useDeleteDiscountCode();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingCodeId, setEditingCodeId] = useState<number | null>(null);
  const [form, setForm] = useState<CreateForm>(DEFAULT_FORM);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [usagePanelCode, setUsagePanelCode] = useState<DiscountCode | null>(null);
  const [riderDropdownOpen, setRiderDropdownOpen] = useState(false);
  const riderDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (riderDropdownRef.current && !riderDropdownRef.current.contains(e.target as Node)) {
        setRiderDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const catMap = Object.fromEntries((categories as DiscountCategory[]).map(c => [c.id, c.name]));

  const handleCreate = () => {
    const amount = parseFloat(form.amount);
    if (isNaN(amount) || amount <= 0) {
      toast({ title: "Amount must be greater than 0", variant: "destructive" });
      return;
    }
    if (form.discountType === "percentage" && amount > 100) {
      toast({ title: "Percentage cannot exceed 100%", variant: "destructive" });
      return;
    }

    let maxUses: number;
    if (form.usageType === "one_time") maxUses = 1;
    else if (form.usageType === "unlimited") maxUses = -1;
    else maxUses = Math.max(1, parseInt(form.limitedCount) || 1);

    const payload: any = {
      discountType: form.discountType,
      amount,
      maxUses,
      expiresAt: form.hasExpiry && form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
      categoryIds: form.categoryIds,
    };
    if (!form.autoGenerate && form.code.trim()) {
      payload.code = form.code.trim().toUpperCase();
    }
    if (form.riderId !== null) {
      payload.riderId = form.riderId;
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

  const handleOpenEdit = (code: DiscountCode) => {
    const usageType: UsageType =
      code.maxUses >= 999999 ? "unlimited" :
      code.maxUses === 1 ? "one_time" : "limited";
    setForm({
      code: code.code,
      autoGenerate: false,
      discountType: code.discountType as DiscountTypeVal,
      amount: String(code.amount),
      usageType,
      limitedCount: code.maxUses > 1 && code.maxUses < 999999 ? String(code.maxUses) : "10",
      hasExpiry: !!code.expiresAt,
      expiresAt: code.expiresAt ? new Date(code.expiresAt).toISOString().slice(0, 16) : "",
      categoryIds: (code.categoryIds as number[]) ?? [],
      riderId: code.riderId ?? null,
      riderSearch: "",
    });
    setEditingCodeId(code.id);
    setDrawerOpen(true);
  };

  const handleSaveEdit = () => {
    if (!editingCodeId) return;
    const amount = parseFloat(form.amount);
    if (isNaN(amount) || amount <= 0) {
      toast({ title: "Amount must be greater than 0", variant: "destructive" });
      return;
    }
    if (form.discountType === "percentage" && amount > 100) {
      toast({ title: "Percentage cannot exceed 100%", variant: "destructive" });
      return;
    }
    let maxUses: number;
    if (form.usageType === "one_time") maxUses = 1;
    else if (form.usageType === "unlimited") maxUses = -1;
    else maxUses = Math.max(1, parseInt(form.limitedCount) || 1);

    updateMut.mutate({
      codeId: editingCodeId,
      data: {
        discountType: form.discountType,
        amount,
        maxUses,
        expiresAt: form.hasExpiry && form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
        categoryIds: form.categoryIds,
        riderId: form.riderId ?? null,
      } as any,
    }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListDiscountCodesQueryKey() });
        setDrawerOpen(false);
        setEditingCodeId(null);
        setForm(DEFAULT_FORM);
        toast({ title: "Discount code updated" });
      },
      onError: () => toast({ title: "Failed to update code", variant: "destructive" }),
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
          <Button size="sm" onClick={() => { setForm(DEFAULT_FORM); setEditingCodeId(null); setDrawerOpen(true); }}>
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
                <TableHead>Discount</TableHead>
                <TableHead>Assigned To</TableHead>
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
                  <TableCell className="font-semibold">
                    {code.discountType === "percentage"
                      ? <><span className="text-blue-600">{Number(code.amount).toFixed(0)}%</span> <span className="text-xs font-normal text-muted-foreground">off</span></>
                      : <>${Number(code.amount).toFixed(2)}</>
                    }
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {code.riderName
                      ? <span className="flex items-center gap-1"><User size={12} className="shrink-0" /><span className="truncate max-w-[120px]" title={code.riderName}>{code.riderName}</span></span>
                      : code.eventName
                        ? <span className="truncate max-w-[120px] block" title={code.eventName}>{code.eventName}</span>
                        : <span className="text-xs italic">Club-level</span>
                    }
                  </TableCell>
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
                        title="Edit code"
                        onClick={() => handleOpenEdit(code)}
                      >
                        <Pencil size={13} />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground"
                        title="View usage history"
                        onClick={() => setUsagePanelCode(code)}
                      >
                        <History size={13} />
                      </Button>
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

      {/* Create / Edit drawer */}
      <Sheet open={drawerOpen} onOpenChange={open => { setDrawerOpen(open); if (!open) { setEditingCodeId(null); setForm(DEFAULT_FORM); } }}>
        <SheetContent className="sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle>
              {editingCodeId
                ? <span className="flex items-center gap-2">Edit Code <span className="font-mono text-primary">{form.code}</span></span>
                : "New Discount Code"
              }
            </SheetTitle>
          </SheetHeader>
          <div className="space-y-5 mt-6">
            {/* Code string — read-only badge in edit mode, toggle+input in create mode */}
            {editingCodeId ? (
              <div className="space-y-1.5">
                <Label>Code String</Label>
                <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/40 px-3 py-2">
                  <span className="font-mono font-bold tracking-wider text-sm flex-1">{form.code}</span>
                  <span className="text-xs text-muted-foreground">Cannot be changed</span>
                </div>
              </div>
            ) : (
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
            )}

            <Separator />

            {/* Discount Type */}
            <div className="space-y-1.5">
              <Label>Discount Type</Label>
              <div className="flex rounded-md border overflow-hidden">
                <button
                  type="button"
                  className={`flex-1 py-2 text-sm font-medium transition-colors ${form.discountType === "fixed" ? "bg-primary text-primary-foreground" : "bg-transparent text-muted-foreground hover:bg-muted"}`}
                  onClick={() => setForm(f => ({ ...f, discountType: "fixed" }))}
                >
                  $ Fixed Amount
                </button>
                <button
                  type="button"
                  className={`flex-1 py-2 text-sm font-medium transition-colors ${form.discountType === "percentage" ? "bg-primary text-primary-foreground" : "bg-transparent text-muted-foreground hover:bg-muted"}`}
                  onClick={() => setForm(f => ({ ...f, discountType: "percentage" }))}
                >
                  % Percentage
                </button>
              </div>
            </div>

            {/* Amount */}
            <div className="space-y-1.5">
              <Label>{form.discountType === "percentage" ? "Discount Percentage (1–100)" : "Discount Amount ($)"}</Label>
              <div className="relative">
                {form.discountType === "fixed" && (
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                )}
                <Input
                  type="number"
                  placeholder={form.discountType === "percentage" ? "10" : "0.00"}
                  min="0.01"
                  max={form.discountType === "percentage" ? "100" : undefined}
                  step={form.discountType === "percentage" ? "1" : "0.01"}
                  value={form.amount}
                  onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                  className={form.discountType === "fixed" ? "pl-7" : ""}
                />
                {form.discountType === "percentage" && (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
                )}
              </div>
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

            <Separator />

            {/* Assign to rider */}
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <User size={14} />
                Assign to Rider <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <p className="text-xs text-muted-foreground">
                Lock this code to a specific rider. Only that rider can use it at registration.
              </p>

              {form.riderId !== null ? (
                <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
                  <User size={14} className="text-primary shrink-0" />
                  <span className="flex-1 text-sm font-medium text-primary">
                    {(allRiders as Rider[]).find(r => r.id === form.riderId)
                      ? `${(allRiders as Rider[]).find(r => r.id === form.riderId)!.firstName} ${(allRiders as Rider[]).find(r => r.id === form.riderId)!.lastName}`
                      : `Rider #${form.riderId}`}
                  </span>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => setForm(f => ({ ...f, riderId: null, riderSearch: "" }))}
                    title="Remove assignment"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <div className="relative" ref={riderDropdownRef}>
                  <div className="relative">
                    <Input
                      placeholder="Search by name or email…"
                      value={form.riderSearch}
                      onChange={e => {
                        setForm(f => ({ ...f, riderSearch: e.target.value }));
                        setRiderDropdownOpen(true);
                      }}
                      onFocus={() => setRiderDropdownOpen(true)}
                      className="pr-8"
                    />
                    <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  </div>
                  {riderDropdownOpen && (
                    <div className="absolute z-50 w-full mt-1 bg-background border rounded-md shadow-lg max-h-48 overflow-y-auto">
                      {(() => {
                        const search = form.riderSearch.toLowerCase();
                        const filtered = (allRiders as Rider[]).filter(r =>
                          !search ||
                          `${r.firstName} ${r.lastName}`.toLowerCase().includes(search) ||
                          (r.email ?? "").toLowerCase().includes(search)
                        ).slice(0, 20);
                        if (filtered.length === 0) {
                          return <div className="px-3 py-2 text-sm text-muted-foreground">No riders found</div>;
                        }
                        return filtered.map(r => (
                          <button
                            key={r.id}
                            type="button"
                            className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors flex flex-col"
                            onClick={() => {
                              setForm(f => ({ ...f, riderId: r.id, riderSearch: "" }));
                              setRiderDropdownOpen(false);
                            }}
                          >
                            <span className="font-medium">{r.firstName} {r.lastName}</span>
                            {r.email && <span className="text-xs text-muted-foreground">{r.email}</span>}
                          </button>
                        ));
                      })()}
                    </div>
                  )}
                </div>
              )}

              {form.riderId !== null && (
                <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1 bg-amber-50 dark:bg-amber-950/30 rounded-md px-2 py-1.5">
                  <span>⚠</span>
                  <span>This code will be locked to the selected rider. Only they can use it at registration.</span>
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setDrawerOpen(false)}>Cancel</Button>
              {editingCodeId ? (
                <Button onClick={handleSaveEdit} disabled={updateMut.isPending}>
                  {updateMut.isPending ? (
                    <><RefreshCw size={14} className="mr-1.5 animate-spin" /> Saving…</>
                  ) : "Save Changes"}
                </Button>
              ) : (
                <Button onClick={handleCreate} disabled={createMut.isPending}>
                  {createMut.isPending ? (
                    <><RefreshCw size={14} className="mr-1.5 animate-spin" /> Creating…</>
                  ) : "Create Code"}
                </Button>
              )}
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

      {/* Usage history sheet */}
      <Sheet open={usagePanelCode !== null} onOpenChange={open => { if (!open) setUsagePanelCode(null); }}>
        <SheetContent className="sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <History size={16} />
              Usage History
            </SheetTitle>
          </SheetHeader>
          {usagePanelCode && (
            <UsageHistoryPanel code={usagePanelCode} />
          )}
        </SheetContent>
      </Sheet>
    </Card>
  );
}

function UsageHistoryPanel({ code }: { code: DiscountCode }) {
  const { data: entries = [], isLoading } = useGetDiscountCodeUsage(code.id, { query: {} as any });

  return (
    <div className="mt-4 space-y-4">
      <div className="rounded-md border bg-muted/40 px-4 py-3 space-y-0.5">
        <p className="font-mono font-bold tracking-wider text-sm">{code.code}</p>
        <p className="text-xs text-muted-foreground">
          ${Number(code.amount).toFixed(2)} discount · {code.usesCount} {code.usesCount === 1 ? "use" : "uses"} recorded
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
      ) : entries.length === 0 ? (
        <div className="py-10 text-center text-muted-foreground">
          <History size={28} className="mx-auto mb-2 opacity-30" />
          <p className="text-sm">No uses recorded for this code yet.</p>
        </div>
      ) : (
        <div className="divide-y rounded-md border">
          {entries.map((entry: DiscountCodeUsageEntry) => (
            <div key={entry.registrationId} className="px-4 py-3 space-y-0.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm">{entry.riderName}</span>
                <span className="text-xs text-muted-foreground">{formatDate(entry.usedAt)}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{entry.eventName}</span>
                <span>·</span>
                <span>{entry.raceClass}</span>
                <span>·</span>
                <span className="font-medium text-foreground">${Number(entry.discountAmount).toFixed(2)} off</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
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
