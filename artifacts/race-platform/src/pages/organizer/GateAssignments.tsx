import { useState, useEffect, useCallback } from "react";
import { Save, Plus, Trash2, ChevronDown, ChevronRight, RefreshCw, Info, AlertTriangle, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

interface GateConfig {
  id: string;
  name: string;
  gateCount: number;
  gatePriorities: number[]; // gatePriorities[i] = seed priority for gate (i+1); 1 = best/fastest seed
}

function makeId() {
  return `gc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeDefaultPriorities(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i + 1);
}

function makeDefaultConfig(name = "New Track Config"): GateConfig {
  return { id: makeId(), name, gateCount: 20, gatePriorities: makeDefaultPriorities(20) };
}

function hasDuplicates(arr: number[]): boolean {
  return new Set(arr).size < arr.length;
}

function hasInvalid(priorities: number[], gateCount: number): boolean {
  return priorities.some(p => isNaN(p) || p < 1 || p > gateCount);
}

// ── Single Gate Config Panel ──────────────────────────────────────────────────

interface ConfigPanelProps {
  config: GateConfig;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onChange: (updated: GateConfig) => void;
  onDelete: () => void;
  isOnly: boolean;
}

function ConfigPanel({ config, isCollapsed, onToggleCollapse, onChange, onDelete, isOnly }: ConfigPanelProps) {
  const dupes = hasDuplicates(config.gatePriorities);
  const invalid = hasInvalid(config.gatePriorities, config.gateCount);
  const hasError = dupes || invalid;

  function handleNameChange(name: string) {
    onChange({ ...config, name });
  }

  function handleGateCountChange(n: number) {
    const count = Math.max(1, Math.min(40, n));
    const priorities = [...config.gatePriorities];
    if (count > priorities.length) {
      for (let i = priorities.length + 1; i <= count; i++) priorities.push(i);
    } else {
      priorities.splice(count);
    }
    onChange({ ...config, gateCount: count, gatePriorities: priorities });
  }

  function handlePriorityChange(gateIdx: number, value: string) {
    const num = parseInt(value, 10);
    const priorities = [...config.gatePriorities];
    priorities[gateIdx] = isNaN(num) ? 0 : num;
    onChange({ ...config, gatePriorities: priorities });
  }

  function resetToDefault() {
    onChange({ ...config, gatePriorities: makeDefaultPriorities(config.gateCount) });
  }

  return (
    <div className="border rounded-xl bg-card overflow-hidden">
      {/* Header */}
      <div
        className="px-4 py-3 flex items-center gap-3 cursor-pointer select-none bg-muted/30 border-b hover:bg-muted/50 transition-colors"
        onClick={onToggleCollapse}
      >
        <button
          type="button"
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          onClick={e => { e.stopPropagation(); onToggleCollapse(); }}
        >
          {isCollapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
        </button>
        <div className="flex-1 flex items-center gap-1 min-w-0" onClick={e => e.stopPropagation()}>
          <Input
            value={config.name}
            onChange={e => handleNameChange(e.target.value)}
            placeholder="Track name…"
            className="flex-1 h-8 text-sm font-heading font-bold uppercase tracking-wide border-0 bg-transparent shadow-none focus-visible:ring-1 px-1"
          />
          <Pencil size={12} className="shrink-0 text-muted-foreground/50" />
        </div>
        {hasError && (
          <AlertTriangle size={16} className="text-amber-500 shrink-0" />
        )}
        <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">
          {config.gateCount} gates
        </span>
        {!isOnly && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onDelete(); }}
            className="shrink-0 text-muted-foreground hover:text-destructive transition-colors p-1 rounded"
            title="Delete this config"
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>

      {/* Body */}
      {!isCollapsed && (
        <div className="px-5 py-4 space-y-5">
          {/* Gate Count */}
          <div className="flex items-center gap-4">
            <div>
              <div className="text-xs font-medium mb-1.5 text-muted-foreground uppercase tracking-wider">Number of Gates</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="w-8 h-8 rounded-md border flex items-center justify-center font-bold hover:bg-muted transition-colors disabled:opacity-40"
                  disabled={config.gateCount <= 1}
                  onClick={() => handleGateCountChange(config.gateCount - 1)}
                >
                  –
                </button>
                <Input
                  type="number"
                  min={1}
                  max={40}
                  value={config.gateCount}
                  onChange={e => handleGateCountChange(parseInt(e.target.value, 10) || 1)}
                  className="w-20 text-center text-lg font-heading font-bold h-8"
                />
                <button
                  type="button"
                  className="w-8 h-8 rounded-md border flex items-center justify-center font-bold hover:bg-muted transition-colors disabled:opacity-40"
                  disabled={config.gateCount >= 40}
                  onClick={() => handleGateCountChange(config.gateCount + 1)}
                >
                  +
                </button>
              </div>
            </div>
            <div className="ml-auto">
              <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={resetToDefault}>
                <RefreshCw size={12} /> Reset to 1, 2, 3…
              </Button>
            </div>
          </div>

          {/* Validation warnings */}
          {dupes && (
            <div className="flex items-center gap-2 text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-xs">
              <AlertTriangle size={14} className="shrink-0" />
              Two or more gates have the same seed number — each gate must have a unique seed priority.
            </div>
          )}
          {invalid && !dupes && (
            <div className="flex items-center gap-2 text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-xs">
              <AlertTriangle size={14} className="shrink-0" />
              Some seed numbers are out of range — each priority must be between 1 and {config.gateCount}.
            </div>
          )}

          {/* Gate grid */}
          <div>
            <div className="grid grid-cols-[auto_1fr_auto] items-center text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 px-1 gap-3">
              <span className="w-20">Gate</span>
              <span />
              <span className="w-24 text-center">Seed Priority</span>
            </div>
            <div className="space-y-1.5">
              {Array.from({ length: config.gateCount }, (_, i) => {
                const priority = config.gatePriorities[i] ?? 0;
                const isDupe = config.gatePriorities.filter(p => p === priority).length > 1;
                const isOutOfRange = priority < 1 || priority > config.gateCount;
                const hasRowError = isDupe || isOutOfRange;
                return (
                  <div
                    key={i}
                    className={`grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg px-3 py-2 border ${
                      hasRowError ? "border-amber-400 bg-amber-50/60" : "bg-background border-border"
                    }`}
                  >
                    {/* Gate number badge */}
                    <div className="w-20 flex items-center gap-2">
                      <span className={`inline-flex items-center justify-center w-8 h-8 rounded-md text-sm font-heading font-bold border ${
                        hasRowError ? "border-amber-400 bg-amber-100 text-amber-800" : "border-border bg-muted text-foreground"
                      }`}>
                        {i + 1}
                      </span>
                      <span className="text-xs text-muted-foreground">Gate</span>
                    </div>

                    {/* Arrow */}
                    <div className="text-center">
                      <span className="text-muted-foreground text-xs">→ receives seed</span>
                    </div>

                    {/* Seed priority input */}
                    <div className="w-24 flex items-center gap-1.5 justify-end">
                      <Input
                        type="number"
                        min={1}
                        max={config.gateCount}
                        value={priority || ""}
                        onChange={e => handlePriorityChange(i, e.target.value)}
                        placeholder="–"
                        className={`h-8 w-16 text-center text-sm font-mono font-bold ${
                          hasRowError ? "border-amber-400" : ""
                        }`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Tip */}
          <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/40 rounded-md px-3 py-2.5">
            <Info size={13} className="shrink-0 mt-0.5" />
            <span>
              Enter the seed priority for each physical gate. <strong>Seed 1</strong> = fastest/top qualifier.
              For example, if Gate 3 has the biggest advantage (inside line, best soil), assign it Seed 1.
              Common patterns: inside-out (1, 2, 3…), outside-in, or a snake pattern.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function GateAssignments() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [configs, setConfigs] = useState<GateConfig[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["gateConfigs"],
    queryFn: async () => {
      const res = await fetch("/api/clubs/gate-settings", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load gate settings");
      return res.json() as Promise<{ gateConfigs: GateConfig[] }>;
    },
  });

  useEffect(() => {
    if (!data) return;
    const loaded = data.gateConfigs ?? [];
    setConfigs(loaded);
    // Collapse all panels except the first on initial load
    setCollapsed(new Set(loaded.slice(1).map(c => c.id)));
    setDirty(false);
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/clubs/gate-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gateConfigs: configs }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed to save");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gateConfigs"] });
      setDirty(false);
      toast({ title: "Gate configurations saved" });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const handleChange = useCallback((id: string, updated: GateConfig) => {
    setConfigs(prev => prev.map(c => c.id === id ? updated : c));
    setDirty(true);
  }, []);

  const handleDelete = useCallback((id: string) => {
    setConfigs(prev => prev.filter(c => c.id !== id));
    setCollapsed(prev => { const next = new Set(prev); next.delete(id); return next; });
    setDirty(true);
  }, []);

  const handleToggleCollapse = useCallback((id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  function addConfig() {
    const cfg = makeDefaultConfig("New Track Config");
    setConfigs(prev => [...prev, cfg]);
    setCollapsed(prev => { const next = new Set(prev); prev.forEach(id => next.add(id)); return next; }); // collapse others, leave new open
    setDirty(true);
  }

  const hasErrors = configs.some(c => hasDuplicates(c.gatePriorities) || hasInvalid(c.gatePriorities, c.gateCount));

  if (isLoading) {
    return <div className="p-8 text-center text-muted-foreground text-sm animate-pulse">Loading gate settings…</div>;
  }

  return (
    <div className="max-w-2xl mx-auto space-y-5 p-6">
      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-heading font-bold text-3xl uppercase tracking-tight">Gate Assignments</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Set up gate seeding for each track you use. For each gate, enter which seed priority gets that starting position.
          </p>
        </div>
        <Button variant="outline" className="gap-1.5 shrink-0" onClick={addConfig}>
          <Plus size={15} /> Add Track Config
        </Button>
      </div>

      {/* Empty state */}
      {configs.length === 0 && (
        <div className="border-2 border-dashed rounded-xl p-12 text-center space-y-3">
          <div className="text-4xl">🏁</div>
          <p className="font-heading font-bold text-lg uppercase">No Gate Configs Yet</p>
          <p className="text-muted-foreground text-sm">Create a config for each track you run events at.</p>
          <Button className="font-heading uppercase tracking-wider gap-2" onClick={addConfig}>
            <Plus size={15} /> Add Track Config
          </Button>
        </div>
      )}

      {/* Config panels */}
      {configs.map(config => (
        <ConfigPanel
          key={config.id}
          config={config}
          isCollapsed={collapsed.has(config.id)}
          onToggleCollapse={() => handleToggleCollapse(config.id)}
          onChange={updated => handleChange(config.id, updated)}
          onDelete={() => handleDelete(config.id)}
          isOnly={configs.length === 1}
        />
      ))}

      {/* Footer */}
      {configs.length > 0 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-xs text-muted-foreground">
            {dirty ? "You have unsaved changes." : `${configs.length} config${configs.length !== 1 ? "s" : ""} saved.`}
          </p>
          <Button
            className="font-heading uppercase tracking-wider gap-2"
            disabled={saveMutation.isPending || hasErrors || !dirty}
            onClick={() => saveMutation.mutate()}
          >
            <Save size={15} />
            {saveMutation.isPending ? "Saving…" : "Save All Configs"}
          </Button>
        </div>
      )}
    </div>
  );
}
