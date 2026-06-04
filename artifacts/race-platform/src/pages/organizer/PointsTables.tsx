import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPointsTables,
  useCreatePointsTable,
  useUpdatePointsTable,
  useDeletePointsTable,
  useAiSuggestPointsTable,
  useAiTweakPointsTable,
  getListPointsTablesQueryKey,
} from "@workspace/api-client-react";
import type { PointsTable } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
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
  Sparkles,
  ChevronDown,
  ChevronUp,
  TriangleAlert,
  Users,
  FunctionSquare,
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
  if (method === "lowest_positions") return "Lowest Positions";
  if (method === "per_rider") return "Per Rider";
  if (method === "formula") return "Custom Formula";
  return "Highest Points";
}

function getMethodIcon(method: string) {
  if (method === "lowest_positions") return TrendingDown;
  if (method === "per_rider") return Users;
  if (method === "formula") return FunctionSquare;
  return TrendingUp;
}

type ScoringMethod = "highest_points" | "lowest_positions" | "per_rider" | "formula";

interface FormState {
  name: string;
  description: string;
  scoringMethod: ScoringMethod;
  mainEventOnly: boolean;
  scaleText: string;
  scoringFormula: string;
}

const defaultForm: FormState = {
  name: "",
  description: "",
  scoringMethod: "highest_points",
  mainEventOnly: false,
  scaleText: scaleToText(SUPERCROSS_SCALE),
  scoringFormula: "",
};

// ─── Live Preview ───────────────────────────────────────────────────────────

function PointsPreview({ scale, method }: { scale: number[]; method: ScoringMethod }) {
  if (scale.length === 0) return null;
  const maxVal = method === "highest_points" ? Math.max(...scale) : Math.min(...scale);
  const isHighest = method === "highest_points";

  return (
    <div className="rounded-xl border bg-muted/30 overflow-hidden">
      <div className="px-4 py-2.5 border-b bg-muted/50 flex items-center justify-between">
        <span className="text-xs font-heading font-bold uppercase tracking-widest text-muted-foreground">
          Points Breakdown Preview — {scale.length} positions
        </span>
        <span className="text-xs text-muted-foreground font-mono">
          {isHighest ? `1st = ${scale[0]} pts` : `1st = ${scale[0]} (lower is better)`}
        </span>
      </div>
      <div className="p-3">
        {/* Bar chart visualization */}
        <div className="flex items-end gap-1 h-20 mb-2">
          {scale.slice(0, 20).map((pts, i) => {
            const barPct = isHighest
              ? (pts / maxVal) * 100
              : ((maxVal === 1 ? 1 : (scale.length - i)) / scale.length) * 100;
            const isFirst = i === 0;
            return (
              <div key={i} className="flex-1 flex flex-col items-center justify-end gap-0.5" title={`P${i + 1}: ${pts}`}>
                <div
                  className={`w-full rounded-t transition-all ${isFirst ? "bg-primary" : "bg-primary/25"}`}
                  style={{ height: `${Math.max(barPct, 4)}%` }}
                />
              </div>
            );
          })}
          {scale.length > 20 && (
            <div className="text-xs text-muted-foreground self-end pb-1">+{scale.length - 20}</div>
          )}
        </div>
        {/* Position labels */}
        <div className="flex gap-1 mt-1">
          {scale.slice(0, 20).map((pts, i) => (
            <div key={i} className="flex-1 text-center">
              <div className={`text-[9px] font-mono font-bold leading-none ${i === 0 ? "text-primary" : "text-muted-foreground"}`}>
                {pts}
              </div>
              <div className="text-[8px] text-muted-foreground/60 leading-none mt-0.5">
                {i + 1}
              </div>
            </div>
          ))}
          {scale.length > 20 && <div className="flex-1" />}
        </div>
      </div>
      {/* Table for first 10 */}
      <div className="border-t">
        <div className="grid grid-cols-2 divide-x">
          {/* Left column: positions 1-5 */}
          <div>
            {scale.slice(0, 5).map((pts, i) => (
              <div key={i} className={`flex items-center justify-between px-3 py-1.5 border-b last:border-b-0 ${i === 0 ? "bg-primary/5" : ""}`}>
                <span className="text-xs text-muted-foreground">
                  {i === 0 ? "🥇 1st" : i === 1 ? "🥈 2nd" : i === 2 ? "🥉 3rd" : `${i + 1}th`}
                </span>
                <span className={`text-xs font-mono font-bold ${i === 0 ? "text-primary" : ""}`}>{pts}</span>
              </div>
            ))}
          </div>
          {/* Right column: positions 6-10 */}
          <div>
            {scale.slice(5, 10).map((pts, i) => (
              <div key={i} className="flex items-center justify-between px-3 py-1.5 border-b last:border-b-0">
                <span className="text-xs text-muted-foreground">{i + 6}th</span>
                <span className="text-xs font-mono font-bold">{pts}</span>
              </div>
            ))}
          </div>
        </div>
        {scale.length > 10 && (
          <div className="px-3 py-1.5 text-xs text-center text-muted-foreground border-t">
            …and {scale.length - 10} more positions ({scale[scale.length - 1]} pts at {scale.length}th)
          </div>
        )}
      </div>
    </div>
  );
}

// ─── AI Result Explanation ───────────────────────────────────────────────────

const EXAMPLE_RIDERS = ["Jake Miller", "Tyler Cruz", "Marcus Reed", "Devon White", "Brett Hayes", "Jaxon Cole", "Chase Webb", "Colton Reese", "Austin Parks", "Lane Burke"];

function getPoints(method: ScoringMethod, scale: number[], formula: string, position: number, totalRiders: number): number {
  if (method === "per_rider") return Math.max(0, totalRiders - position + 1);
  if (method === "lowest_positions") return position;
  if (method === "formula") {
    try {
      // eslint-disable-next-line no-new-func
      return Math.max(0, Math.round(new Function("position", "riders", `return ${formula}`)(position, totalRiders)));
    } catch { return 0; }
  }
  return scale[position - 1] ?? 0;
}

function AiResultExplanation({ form }: { form: FormState }) {
  const method = form.scoringMethod;
  const scale = parseScale(form.scaleText);
  const isLowest = method === "lowest_positions";
  const isPerRider = method === "per_rider";
  const isFormula = method === "formula";

  // Generate example race with 10 riders
  const raceRiders = EXAMPLE_RIDERS.slice(0, 10);
  const racePts = raceRiders.map((_, i) => getPoints(method, scale, form.scoringFormula, i + 1, raceRiders.length));

  // Simulate 3 rounds with shuffled positions for championship example
  const shuffleFor = (round: number) => {
    // Deterministic shuffle based on round number
    return raceRiders.map((_, i) => {
      const order = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        [1, 0, 3, 2, 5, 4, 7, 6, 9, 8],
        [2, 3, 0, 1, 6, 7, 4, 5, 8, 9],
      ][round];
      return order[i];
    });
  };
  const rounds = [0, 1, 2].map(r => {
    const positionOf = shuffleFor(r);
    return raceRiders.map((_, i) => {
      const pos = positionOf.indexOf(i) + 1;
      return getPoints(method, scale, form.scoringFormula, pos, raceRiders.length);
    });
  });
  const totals = raceRiders.map((_, i) => rounds.reduce((s, r) => s + r[i], 0));
  const champOrder = [...raceRiders.map((name, i) => ({ name, pts: totals[i] }))]
    .sort((a, b) => isLowest ? a.pts - b.pts : b.pts - a.pts)
    .slice(0, 5);

  const scoringLabel = isLowest ? "Score (lower wins)" : isPerRider ? "Points (dynamic)" : isFormula ? "Points (formula)" : "Points";

  return (
    <div className="rounded-xl border bg-muted/20 overflow-hidden space-y-0">
      {/* Header */}
      <div className="px-4 py-3 bg-muted/40 border-b flex items-center gap-2">
        <Info size={14} className="text-primary shrink-0" />
        <span className="text-xs font-heading font-bold uppercase tracking-widest text-foreground">
          How This Scoring Works — With Examples
        </span>
      </div>

      {/* Description */}
      {form.description && (
        <div className="px-4 py-3 text-sm text-muted-foreground border-b leading-relaxed">
          {form.description}
        </div>
      )}

      {/* Method callout */}
      <div className="px-4 py-3 border-b">
        {isLowest && (
          <div className="text-xs text-muted-foreground space-y-1">
            <p><span className="font-semibold text-foreground">Olympic / Lowest Position:</span> Like golf — every finish earns a score equal to the position number. Add them up across all races. The rider with the <em>lowest</em> total wins the championship.</p>
            <p className="text-muted-foreground/70">Finishing 1st earns 1 point. Finishing 10th earns 10. Lower is better.</p>
          </div>
        )}
        {isPerRider && (
          <div className="text-xs text-muted-foreground space-y-1">
            <p><span className="font-semibold text-foreground">Per Rider (Dynamic):</span> Points scale with field size. In a 10-rider race: 1st = 10 pts, 2nd = 9 pts … 10th = 1 pt. In a 20-rider race: 1st = 20 pts, 2nd = 19 pts … 20th = 1 pt.</p>
            <p className="text-muted-foreground/70">This keeps racing competitive regardless of turnout — a win is always worth exactly as many points as riders that entered.</p>
          </div>
        )}
        {isFormula && form.scoringFormula && (
          <div className="text-xs text-muted-foreground space-y-1">
            <p><span className="font-semibold text-foreground">Custom Formula:</span> <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-xs text-primary">{form.scoringFormula}</code></p>
            <p className="text-muted-foreground/70">Calculated at race time using the actual finish position and field size. The formula above is evaluated for each rider to determine their points.</p>
          </div>
        )}
        {!isLowest && !isPerRider && !isFormula && scale.length > 0 && (
          <div className="text-xs text-muted-foreground space-y-1">
            <p><span className="font-semibold text-foreground">Fixed Scale:</span> Each finishing position earns a predetermined number of points regardless of field size. {scale[0]} points for 1st, {scale[1] ?? "—"} for 2nd, {scale[2] ?? "—"} for 3rd, and so on.</p>
            {scale.length < 10 && <p className="text-amber-600">⚠ Only {scale.length} positions are scored — riders finishing outside the top {scale.length} earn <strong>0 points</strong>.</p>}
          </div>
        )}
        {form.mainEventOnly && (
          <p className="text-xs text-primary mt-2 flex items-center gap-1.5 font-medium">
            <Zap size={11} />
            Main Event Only — heats and LCQs don't affect championship standings. Only the Main Event finish counts.
          </p>
        )}
      </div>

      {/* Race Day Example */}
      <div className="px-4 pt-3 pb-2 border-b">
        <div className="text-[10px] font-heading font-bold uppercase tracking-widest text-muted-foreground mb-2">
          Race Day Example — {raceRiders.length} Riders
        </div>
        <div className="rounded-lg border overflow-hidden text-xs">
          <div className="grid grid-cols-3 bg-muted/40 px-3 py-1.5 font-heading uppercase tracking-wider text-[10px] text-muted-foreground">
            <span>Position</span>
            <span>Rider</span>
            <span className="text-right">{scoringLabel}</span>
          </div>
          {raceRiders.slice(0, 8).map((name, i) => {
            const pts = racePts[i];
            const isScoredZero = pts === 0 && i > 0;
            return (
              <div key={name} className={`grid grid-cols-3 px-3 py-1.5 border-t items-center ${i === 0 ? "bg-primary/5" : ""}`}>
                <span className={`font-medium ${i === 0 ? "text-primary" : "text-muted-foreground"}`}>
                  {i === 0 ? "🥇 1st" : i === 1 ? "🥈 2nd" : i === 2 ? "🥉 3rd" : `${i + 1}th`}
                </span>
                <span className={i === 0 ? "font-semibold" : ""}>{name}</span>
                <span className={`text-right font-mono font-bold tabular-nums ${i === 0 ? "text-primary" : isScoredZero ? "text-muted-foreground/40" : ""}`}>
                  {isLowest ? pts : pts > 0 ? `+${pts}` : "—"}
                </span>
              </div>
            );
          })}
          {raceRiders.length > 8 && (
            <div className="grid grid-cols-3 px-3 py-1.5 border-t bg-muted/20 text-muted-foreground/60">
              <span className="col-span-2 text-[11px]">…{raceRiders.length - 8} more riders</span>
              <span className="text-right font-mono text-[11px]">
                {racePts[8] > 0 ? (isLowest ? racePts[8] : `+${racePts[8]}`) : "—"}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Championship Simulation */}
      <div className="px-4 pt-3 pb-4">
        <div className="text-[10px] font-heading font-bold uppercase tracking-widest text-muted-foreground mb-2">
          After 3 Rounds — Championship Standings (Top 5)
        </div>
        <div className="rounded-lg border overflow-hidden text-xs">
          <div className={`grid bg-muted/40 px-3 py-1.5 font-heading uppercase tracking-wider text-[10px] text-muted-foreground`}
            style={{ gridTemplateColumns: "1fr 2fr 1fr 1fr 1fr 1.2fr" }}>
            <span>Pos</span>
            <span>Rider</span>
            <span className="text-center">Rd 1</span>
            <span className="text-center">Rd 2</span>
            <span className="text-center">Rd 3</span>
            <span className="text-right">Total</span>
          </div>
          {champOrder.map(({ name, pts }, rank) => {
            const riderIdx = EXAMPLE_RIDERS.indexOf(name);
            return (
              <div
                key={name}
                className={`grid px-3 py-1.5 border-t items-center ${rank === 0 ? "bg-primary/5 font-semibold" : ""}`}
                style={{ gridTemplateColumns: "1fr 2fr 1fr 1fr 1fr 1.2fr" }}
              >
                <span className={`font-mono ${rank === 0 ? "text-primary" : "text-muted-foreground"}`}>{rank + 1}</span>
                <span className="truncate pr-1">{name}</span>
                {rounds.map((round, ri) => (
                  <span key={ri} className="text-center font-mono text-muted-foreground">{round[riderIdx]}</span>
                ))}
                <span className={`text-right font-mono font-bold tabular-nums ${rank === 0 ? "text-primary" : ""}`}>{pts}</span>
              </div>
            );
          })}
        </div>
        <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
          {isLowest
            ? "Lower total score is better. Consistent top finishes beat a single win with bad rounds."
            : "Championship leader is the rider with the most points accumulated across all rounds."}
          {form.mainEventOnly && " Only Main Event results count — heat finishes are excluded from these totals."}
        </p>
      </div>
    </div>
  );
}

// ─── AI Assist Panel ─────────────────────────────────────────────────────────

function AiAssistPanel({
  onApply,
}: {
  onApply: (result: {
    name: string;
    description: string;
    scoringMethod: ScoringMethod;
    mainEventOnly: boolean;
    pointsScale: number[];
    scoringFormula?: string | null;
    motoNotes?: string;
  }) => void;
}) {
  const [scoringDesc, setScoringDesc] = useState("");
  const [motoTerminology, setMotoTerminology] = useState<"heats" | "divisions" | "motos">("motos");
  const [motoDesc, setMotoDesc] = useState("");
  const [motoNotes, setMotoNotes] = useState<string | null>(null);
  const suggestMutation = useAiSuggestPointsTable();
  const { toast } = useToast();

  async function handleGenerate() {
    if (!scoringDesc.trim()) {
      toast({ title: "Describe how you want scoring to work first", variant: "destructive" });
      return;
    }
    try {
      const terminologyNote = motoTerminology !== "motos"
        ? `Call the races "${motoTerminology}" (not "motos"). `
        : "";
      const combinedMotoDesc = terminologyNote + (motoDesc.trim() || "");
      const result = await suggestMutation.mutateAsync({
        data: {
          scoringDescription: scoringDesc.trim(),
          motoDescription: combinedMotoDesc || undefined,
        },
      });
      setMotoNotes(result.motoNotes ?? null);
      onApply(result);
      toast({ title: "Form filled from your description ✓", description: "Review and adjust anything below." });
    } catch {
      toast({ title: "AI couldn't parse that description", description: "Try adding more detail.", variant: "destructive" });
    }
  }

  return (
    <div className="rounded-xl border-2 border-primary/20 bg-primary/5 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles size={16} className="text-primary" />
        <span className="text-sm font-heading font-bold uppercase tracking-wider text-primary">
          Describe Your Format
        </span>
        <span className="ml-auto text-[10px] font-heading uppercase tracking-wider text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
          AI fills the form
        </span>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">How should points work?</Label>
        <Textarea
          placeholder='e.g. "Winner gets 25 points, 2nd gets 22, 20 for 3rd, then drops by 1 each place down to 20 riders" or "Olympic style — lowest total position score wins, like golf"'
          rows={3}
          value={scoringDesc}
          onChange={(e) => setScoringDesc(e.target.value)}
          className="text-sm resize-none bg-background"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">What should races be called?</Label>
        <Select value={motoTerminology} onValueChange={(v) => setMotoTerminology(v as "heats" | "divisions" | "motos")}>
          <SelectTrigger className="bg-background text-sm h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="motos">Motos</SelectItem>
            <SelectItem value="heats">Heats</SelectItem>
            <SelectItem value="divisions">Divisions</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">
          How should races be structured?{" "}
          <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Textarea
          placeholder='e.g. "Run 3 motos per class, all count toward championship" or "Two qualifying heats, top 5 from each advance to a main event, only the main counts for points"'
          rows={3}
          value={motoDesc}
          onChange={(e) => setMotoDesc(e.target.value)}
          className="text-sm resize-none bg-background"
        />
      </div>

      <Button
        type="button"
        className="w-full gap-2"
        onClick={handleGenerate}
        disabled={suggestMutation.isPending || !scoringDesc.trim()}
      >
        {suggestMutation.isPending ? (
          <>
            <span className="animate-spin">✦</span>
            Generating…
          </>
        ) : (
          <>
            <Sparkles size={14} />
            Generate with AI
          </>
        )}
      </Button>

      {motoNotes && (
        <div className="rounded-lg bg-background border px-3 py-2.5 text-xs text-muted-foreground leading-relaxed">
          <div className="flex items-center gap-1.5 text-foreground font-medium mb-1">
            <Info size={11} />
            Moto structure note
          </div>
          {motoNotes}
        </div>
      )}
    </div>
  );
}

// ─── AI Tweak Panel (edit mode) ───────────────────────────────────────────────

function AiTweakPanel({
  currentForm,
  onApply,
  label = "AI Edits",
}: {
  currentForm: FormState;
  onApply: (result: {
    name: string;
    description: string;
    scoringMethod: ScoringMethod;
    mainEventOnly: boolean;
    pointsScale: number[];
    scoringFormula?: string | null;
  }) => void;
  label?: string;
}) {
  const [instruction, setInstruction] = useState("");
  const tweakMutation = useAiTweakPointsTable();
  const { toast } = useToast();

  async function handleTweak() {
    if (!instruction.trim()) {
      toast({ title: "Describe the change you want to make", variant: "destructive" });
      return;
    }
    try {
      const result = await tweakMutation.mutateAsync({
        data: {
          instruction: instruction.trim(),
          currentTable: {
            name: currentForm.name,
            description: currentForm.description,
            scoringMethod: currentForm.scoringMethod,
            mainEventOnly: currentForm.mainEventOnly,
            pointsScale: parseScale(currentForm.scaleText),
            scoringFormula: currentForm.scoringFormula || null,
          },
        },
      });
      onApply(result);
      setInstruction("");
      toast({ title: "Table updated by AI ✓", description: "Review the changes below before saving." });
    } catch {
      toast({ title: "AI couldn't apply that change", description: "Try rephrasing.", variant: "destructive" });
    }
  }

  const isRefine = label !== "AI Edits";

  return (
    <div className="rounded-xl border-2 border-primary/20 bg-primary/5 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles size={16} className="text-primary" />
        <span className="text-sm font-heading font-bold uppercase tracking-wider text-primary">
          {label}
        </span>
        <span className="ml-auto text-[10px] font-heading uppercase tracking-wider text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
          {isRefine ? "AI refines" : "Describe a change"}
        </span>
      </div>

      <div className="space-y-1.5">
        <Textarea
          placeholder={
            isRefine
              ? 'e.g. "Give 1st place 30 points instead of 25" or "Add more positions" or "Switch to 3 motos per class"'
              : 'e.g. "Give 1st place 30 points instead of 25" or "Add 5 more positions at the bottom, each 1 point less" or "Switch to lowest positions scoring"'
          }
          rows={3}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleTweak();
          }}
          className="text-sm resize-none bg-background"
        />
        <p className="text-[11px] text-muted-foreground">Tip: Press ⌘/Ctrl+Enter to apply</p>
      </div>

      <Button
        type="button"
        className="w-full gap-2"
        onClick={handleTweak}
        disabled={tweakMutation.isPending || !instruction.trim()}
      >
        {tweakMutation.isPending ? (
          <>
            <span className="animate-spin">✦</span>
            {isRefine ? "Refining…" : "Applying…"}
          </>
        ) : (
          <>
            <Sparkles size={14} />
            {isRefine ? "Refine with AI" : "Apply with AI"}
          </>
        )}
      </Button>
    </div>
  );
}

// ─── Form Dialog ─────────────────────────────────────────────────────────────

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
          scoringMethod: editingTable.scoringMethod as ScoringMethod,
          mainEventOnly: editingTable.mainEventOnly,
          scaleText: scaleToText(editingTable.pointsScale as number[]),
          scoringFormula: (editingTable as any).scoringFormula ?? "",
        }
      : defaultForm
  );
  const [showManual, setShowManual] = useState(!!editingTable);
  const [aiUsed, setAiUsed] = useState(false);

  const createMutation = useCreatePointsTable();
  const updateMutation = useUpdatePointsTable();

  const isEditing = !!editingTable;
  const isPending = createMutation.isPending || updateMutation.isPending;
  const parsedScale = parseScale(form.scaleText);

  function applyAiResult(result: {
    name: string;
    description: string;
    scoringMethod: ScoringMethod;
    mainEventOnly: boolean;
    pointsScale: number[];
    scoringFormula?: string | null;
  }) {
    setForm({
      name: result.name,
      description: result.description,
      scoringMethod: result.scoringMethod as ScoringMethod,
      mainEventOnly: result.mainEventOnly,
      scaleText: scaleToText(result.pointsScale),
      scoringFormula: result.scoringFormula ?? "",
    });
    setAiUsed(true);
    // In create mode, keep manual fields hidden so the explanation panel shows
    if (isEditing) setShowManual(true);
  }

  const isPerRider = form.scoringMethod === "per_rider";
  const isFormula = form.scoringMethod === "formula";
  const needsScale = !isPerRider && !isFormula;

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const pointsScale = needsScale ? parseScale(form.scaleText) : [];
    if (!form.name.trim()) { toast({ title: "Name is required", variant: "destructive" }); return; }
    if (needsScale && pointsScale.length === 0) { toast({ title: "Enter at least one points value", variant: "destructive" }); return; }
    if (isFormula && !form.scoringFormula.trim()) { toast({ title: "Enter a scoring formula", variant: "destructive" }); return; }

    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
      scoringMethod: form.scoringMethod,
      mainEventOnly: form.mainEventOnly,
      pointsScale,
      scoringFormula: isFormula ? form.scoringFormula.trim() : null,
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
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Points Table" : "Create Points Table"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5 pt-1">
          {/* AI panel — create (no AI yet): full generator; create (after AI): refine box; edit: tweak box */}
          {!isEditing && !aiUsed && (
            <AiAssistPanel onApply={applyAiResult} />
          )}
          {!isEditing && aiUsed && (
            <AiTweakPanel currentForm={form} onApply={applyAiResult} label="What needs to be improved?" />
          )}
          {isEditing && (
            <AiTweakPanel currentForm={form} onApply={applyAiResult} />
          )}

          {/* Toggle manual fields */}
          {!isEditing && (
            <button
              type="button"
              onClick={() => setShowManual((v) => !v)}
              className="w-full flex items-center justify-between text-xs font-heading font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors py-1 group"
            >
              <span className="flex items-center gap-2">
                <span className="h-px flex-1 bg-border w-8 inline-block" />
                {showManual ? "Hide" : "Show"} Manual Fields
              </span>
              {showManual ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          )}

          {/* AI explanation — shown after AI runs when manual fields are hidden */}
          {aiUsed && !showManual && !isEditing && (
            <AiResultExplanation form={form} />
          )}

          {(showManual || isEditing) && (
            <div className="space-y-5">
              {/* Validation notice if no scale yet */}
              {needsScale && parsedScale.length === 0 && form.scaleText.trim() !== "" && (
                <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <TriangleAlert size={13} />
                  Points scale looks invalid — use comma-separated numbers, e.g. 25, 22, 20
                </div>
              )}

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
                  rows={2}
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Scoring Method</Label>
                  <Select
                    value={form.scoringMethod}
                    onValueChange={(v) => setForm((f) => ({ ...f, scoringMethod: v as ScoringMethod }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="highest_points">
                        <span className="flex items-center gap-2">
                          <TrendingUp size={14} />
                          Highest Points wins
                        </span>
                      </SelectItem>
                      <SelectItem value="lowest_positions">
                        <span className="flex items-center gap-2">
                          <TrendingDown size={14} />
                          Lowest Positions wins
                        </span>
                      </SelectItem>
                      <SelectItem value="per_rider">
                        <span className="flex items-center gap-2">
                          <Users size={14} />
                          Per Rider (dynamic)
                        </span>
                      </SelectItem>
                      <SelectItem value="formula">
                        <span className="flex items-center gap-2">
                          <FunctionSquare size={14} />
                          Custom Formula
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Presets</Label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="flex-1 text-xs"
                      onClick={() => setForm((f) => ({ ...f, scoringMethod: "highest_points", scaleText: scaleToText(SUPERCROSS_SCALE) }))}
                    >
                      AMA
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="flex-1 text-xs"
                      onClick={() => setForm((f) => ({ ...f, scoringMethod: "lowest_positions", scaleText: scaleToText(OLYMPIC_SCALE) }))}
                    >
                      Olympic
                    </Button>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Switch
                  id="pt-main"
                  checked={form.mainEventOnly}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, mainEventOnly: v }))}
                />
                <div>
                  <Label htmlFor="pt-main" className="cursor-pointer flex items-center gap-1.5">
                    <Zap size={13} className="text-primary" />
                    Main Event Only
                  </Label>
                  <p className="text-xs text-muted-foreground">Only the Main Event moto counts for championship points</p>
                </div>
              </div>

              {isPerRider ? (
                <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
                  <Users size={15} className="text-primary mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-foreground">Dynamic — no fixed scale needed</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Points are calculated at the time results are saved: 1st place receives <strong>N</strong> points
                      (where N = number of riders who started), 2nd gets N−1, last place gets 1.
                      With 26 starters: 1st = 26 pts, 2nd = 25 pts, … 26th = 1 pt.
                    </p>
                  </div>
                </div>
              ) : isFormula ? (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="pt-formula">Scoring Formula</Label>
                    <Input
                      id="pt-formula"
                      placeholder="e.g. riders - position + 1"
                      value={form.scoringFormula}
                      onChange={(e) => setForm((f) => ({ ...f, scoringFormula: e.target.value }))}
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      A JavaScript expression. Available variables:{" "}
                      <code className="bg-muted px-1 rounded text-xs">position</code> (1 = winner),{" "}
                      <code className="bg-muted px-1 rounded text-xs">riders</code> (total starters).
                      Result is rounded and clamped to ≥ 0.
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/30 divide-y text-xs font-mono">
                    <div className="px-3 py-1.5 text-muted-foreground font-sans font-medium text-[11px] uppercase tracking-wider">Examples</div>
                    {[
                      ["riders - position + 1", "Same as Per Rider (26 starters → 1st = 26)"],
                      ["Math.max(0, 50 - position * 2)", "50 pts for 1st, drops 2 per place"],
                      ["position <= 3 ? (4 - position) * 10 : 0", "30/20/10 for podium only, 0 elsewhere"],
                      ["Math.round(riders / position)", "Ratio-based: scales with field size"],
                    ].map(([expr, desc]) => (
                      <div
                        key={expr}
                        className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer transition-colors"
                        onClick={() => setForm((f) => ({ ...f, scoringFormula: expr }))}
                      >
                        <span className="text-primary flex-shrink-0">{expr}</span>
                        <span className="text-muted-foreground font-sans text-[11px] truncate">{desc}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="pt-scale">Points per Position</Label>
                  <Textarea
                    id="pt-scale"
                    placeholder="25, 22, 20, 18, 16, ..."
                    rows={2}
                    value={form.scaleText}
                    onChange={(e) => setForm((f) => ({ ...f, scaleText: e.target.value }))}
                    className="font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    Comma-separated. First value = 1st place.
                    {parsedScale.length > 0 && (
                      <span className="ml-1 text-primary font-medium">
                        {parsedScale.length} positions scored.
                      </span>
                    )}
                  </p>
                </div>
              )}

              {/* Live preview — only for fixed scale methods */}
              {needsScale && parsedScale.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-heading font-bold uppercase tracking-wider text-muted-foreground">
                      Preview
                    </span>
                    <div className="flex-1 h-px bg-border" />
                  </div>
                  <PointsPreview scale={parsedScale} method={form.scoringMethod} />
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2 border-t">
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

// ─── Detail Sheet ─────────────────────────────────────────────────────────────

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
                <Badge variant="outline" className="gap-1 font-heading uppercase tracking-wider text-[10px]">
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

          <PointsPreview scale={scale} method={table.scoringMethod as "highest_points" | "lowest_positions"} />

          <div>
            <div className="text-xs font-heading font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Full Breakdown — {scale.length} positions scored
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
                <Button variant="outline" size="sm" className="gap-2" onClick={() => onEdit(table)}>
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

// ─── Table Card ───────────────────────────────────────────────────────────────

function TableCard({ table, onClick }: { table: PointsTable; onClick: () => void }) {
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

// ─── Page ─────────────────────────────────────────────────────────────────────

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
    } catch (err: any) {
      const message = err?.message || err?.response?.data?.error || "Could not delete this scoring table.";
      toast({ title: "Failed to delete", description: message, variant: "destructive" });
    }
  }

  function onSaved() {
    queryClient.invalidateQueries({ queryKey: getListPointsTablesQueryKey() });
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-heading font-bold text-2xl uppercase tracking-wider text-foreground flex items-center gap-3">
            <ListOrdered size={24} className="text-primary" />
            Points Scoring Tables
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Choose from system templates or create your own — just describe how you want it to work
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
                  Describe your scoring format in plain English — AI will set it all up
                </p>
                <Button variant="outline" size="sm" onClick={openCreate} className="gap-2">
                  <Sparkles size={14} />
                  Create with AI
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

      <TableDetailSheet
        table={selectedTable}
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onEdit={openEdit}
        onDelete={handleDelete}
      />

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
