import { useState, useEffect } from "react";
import { Save, Plus, Minus, Info, RefreshCw } from "lucide-react";
import { useGetGateSettings } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";

const ORDINAL = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th",
  "11th", "12th", "13th", "14th", "15th", "16th", "17th", "18th", "19th", "20th",
  "21st", "22nd", "23rd", "24th", "25th", "26th", "27th", "28th", "29th", "30th",
  "31st", "32nd", "33rd", "34th", "35th", "36th", "37th", "38th", "39th", "40th"];

export default function GateAssignments() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: saved, isLoading } = useGetGateSettings({ query: {} as any });

  const [gateCount, setGateCount] = useState<number>(20);
  const [seeding, setSeeding] = useState<number[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!saved) return;
    const count = saved.gateCount ?? 20;
    setGateCount(count);
    if (saved.gateSeeding && saved.gateSeeding.length > 0) {
      setSeeding(saved.gateSeeding);
    } else {
      setSeeding(Array.from({ length: count }, (_, i) => i + 1));
    }
    setDirty(false);
  }, [saved]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/clubs/gate-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gateCount, gateSeeding: seeding }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed to save");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["getGateSettings"] });
      setDirty(false);
      toast({ title: "Gate settings saved" });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  function handleGateCountChange(n: number) {
    const clamped = Math.max(1, Math.min(40, n));
    setGateCount(clamped);
    if (clamped > seeding.length) {
      const next = [...seeding];
      for (let i = seeding.length + 1; i <= clamped; i++) next.push(i);
      setSeeding(next);
    } else {
      setSeeding(seeding.slice(0, clamped));
    }
    setDirty(true);
  }

  function handleSeedGateChange(seedIndex: number, value: string) {
    const num = parseInt(value, 10);
    if (isNaN(num) || num < 1 || num > gateCount) return;
    const next = [...seeding];
    next[seedIndex] = num;
    setSeeding(next);
    setDirty(true);
  }

  function resetToDefault() {
    setSeeding(Array.from({ length: gateCount }, (_, i) => i + 1));
    setDirty(true);
  }

  const usedGates = new Set(seeding);
  const hasDuplicates = usedGates.size < seeding.length;

  if (isLoading) {
    return (
      <div className="p-8 text-center text-muted-foreground text-sm animate-pulse">Loading gate settings…</div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 p-6">
      <div>
        <h1 className="font-heading font-bold text-3xl uppercase tracking-tight flex items-center gap-2">
          Gate Assignments
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Set how many gates your track has and define the seeding priority order. The fastest rider gets the 1st seed gate, 2nd fastest gets the 2nd seed gate, and so on.
        </p>
      </div>

      {/* Gate Count */}
      <div className="border rounded-xl bg-card overflow-hidden">
        <div className="px-5 py-3 border-b bg-muted/30 flex items-center gap-2">
          <h2 className="font-heading font-bold uppercase tracking-wider text-sm">Track Gate Count</h2>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p className="text-xs text-muted-foreground">How many starting gates does your track have? This also sets the default max riders per heat when using practice lap seeding.</p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="w-9 h-9 rounded-md border flex items-center justify-center text-lg font-bold hover:bg-muted transition-colors disabled:opacity-40"
              disabled={gateCount <= 1}
              onClick={() => handleGateCountChange(gateCount - 1)}
            >
              <Minus size={16} />
            </button>
            <Input
              type="number"
              min={1}
              max={40}
              value={gateCount}
              onChange={e => handleGateCountChange(parseInt(e.target.value, 10) || 1)}
              className="w-24 text-center text-xl font-heading font-bold h-10"
            />
            <button
              type="button"
              className="w-9 h-9 rounded-md border flex items-center justify-center text-lg font-bold hover:bg-muted transition-colors disabled:opacity-40"
              disabled={gateCount >= 40}
              onClick={() => handleGateCountChange(gateCount + 1)}
            >
              <Plus size={16} />
            </button>
            <span className="text-sm text-muted-foreground">gates</span>
          </div>
        </div>
      </div>

      {/* Seeding Order */}
      <div className="border rounded-xl bg-card overflow-hidden">
        <div className="px-5 py-3 border-b bg-muted/30 flex items-center justify-between">
          <div>
            <h2 className="font-heading font-bold uppercase tracking-wider text-sm">Gate Seeding Order</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Which physical gate each seeded position gets</p>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={resetToDefault}>
            <RefreshCw size={12} /> Reset to Default
          </Button>
        </div>

        {hasDuplicates && (
          <div className="mx-5 mt-4 flex items-center gap-2 text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-xs">
            <Info size={14} className="shrink-0" />
            Some gates are assigned to multiple seeds — each gate can only appear once.
          </div>
        )}

        <div className="px-5 py-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {seeding.map((gate, idx) => {
              const isDuplicate = seeding.filter(g => g === gate).length > 1;
              return (
                <div
                  key={idx}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${isDuplicate ? "border-amber-400 bg-amber-50" : "bg-background"}`}
                >
                  <div className="text-xs text-muted-foreground whitespace-nowrap w-12 shrink-0">
                    {ORDINAL[idx]} seed
                  </div>
                  <span className="text-muted-foreground text-xs">→</span>
                  <div className="flex items-center gap-1 flex-1">
                    <span className="text-xs text-muted-foreground">Gate</span>
                    <Input
                      type="number"
                      min={1}
                      max={gateCount}
                      value={gate}
                      onChange={e => handleSeedGateChange(idx, e.target.value)}
                      className={`h-7 w-14 text-center text-sm font-mono font-bold ${isDuplicate ? "border-amber-400" : ""}`}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex items-start gap-2 text-xs text-muted-foreground bg-muted/40 rounded-md px-3 py-2.5">
            <Info size={13} className="shrink-0 mt-0.5" />
            <span>
              Common seeding strategies: <strong>Inside-out</strong> (1, 2, 3…) gives inner gates to top seeds.
              <strong> Outside-in</strong> (last gate, 1st gate alternating) balances track advantages.
              Many tracks use a <strong>snake pattern</strong> like 1, 3, 5, 7… 8, 6, 4, 2 so top seeds are spread across the track.
            </span>
          </div>
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {dirty ? "You have unsaved changes." : saved?.gateCount ? `Saved: ${saved.gateCount} gates` : "Not yet configured."}
        </p>
        <Button
          className="font-heading uppercase tracking-wider gap-2"
          disabled={saveMutation.isPending || hasDuplicates}
          onClick={() => saveMutation.mutate()}
        >
          <Save size={15} />
          {saveMutation.isPending ? "Saving…" : "Save Gate Settings"}
        </Button>
      </div>
    </div>
  );
}
