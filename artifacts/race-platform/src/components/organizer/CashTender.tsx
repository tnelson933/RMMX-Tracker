import { useState } from "react";
import { AlertCircle, Banknote, DollarSign, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Change due in cents-safe dollars, or null while the amount tendered is short or blank. */
export function changeDue(due: number, tendered: number): number | null {
  if (!Number.isFinite(tendered) || tendered + 0.005 < due) return null;
  return Math.round((tendered - due) * 100) / 100;
}

/** Bills a rider is likely to hand over for this amount: exact, then the next round amounts up. */
function quickAmounts(due: number): number[] {
  const out = new Set<number>([Math.round(due * 100) / 100]);
  for (const step of [5, 10, 20, 50, 100]) {
    const up = Math.ceil(due / step) * step;
    if (up > due) out.add(up);
  }
  return [...out].sort((a, b) => a - b).slice(0, 5);
}

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Cash at the gate: the amount the rider hands over and the change to give back.
 * The payment is recorded at the amount due; the amount tendered and change are
 * logged with it so the cash drawer reconciles.
 */
export function CashTender({ due, busy, error, onConfirm, onBack }: {
  due: number;
  busy?: boolean;
  error?: string | null;
  onConfirm: (tendered: number) => void;
  onBack: () => void;
}) {
  const [tendered, setTendered] = useState("");
  const tenderedNum = parseFloat(tendered);
  const change = tendered.trim() ? changeDue(due, tenderedNum) : null;
  const short = tendered.trim() !== "" && Number.isFinite(tenderedNum) && change === null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between rounded-lg bg-muted px-4 py-3">
        <span className="text-sm text-muted-foreground font-heading uppercase tracking-wide">Amount due</span>
        <span className="text-2xl font-heading font-bold">{money(due)}</span>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="cash-tendered">Amount tendered ($)</label>
        <div className="relative">
          <DollarSign size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="cash-tendered"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={tendered}
            onChange={e => setTendered(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && change !== null && !busy) onConfirm(tenderedNum); }}
            className="pl-8 text-lg font-mono h-12"
            placeholder="0.00"
            autoFocus
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {quickAmounts(due).map(a => (
            <Button key={a} type="button" variant="outline" size="sm" className="h-8 font-mono" onClick={() => setTendered(a.toFixed(2))}>
              {a === Math.round(due * 100) / 100 ? `Exact ${money(a)}` : money(a)}
            </Button>
          ))}
        </div>
      </div>

      <div className={`flex items-baseline justify-between rounded-lg border px-4 py-3 ${change !== null && change > 0 ? "border-green-600/40 bg-green-50 dark:bg-green-950/30" : "bg-background"}`}>
        <span className="text-sm text-muted-foreground font-heading uppercase tracking-wide">Change due</span>
        <span className={`text-2xl font-heading font-bold ${change !== null && change > 0 ? "text-green-700 dark:text-green-400" : ""}`}>
          {change !== null ? money(change) : "—"}
        </span>
      </div>
      {short && (
        <p className="text-sm text-destructive">That's {money(due - tenderedNum)} short of the amount due.</p>
      )}

      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 rounded-lg p-3">
          <AlertCircle size={16} className="flex-shrink-0" />
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <Button type="button" variant="outline" className="flex-1 font-heading uppercase" onClick={onBack} disabled={busy}>← Back</Button>
        <Button type="button" className="flex-1 font-heading uppercase gap-1.5" onClick={() => onConfirm(tenderedNum)} disabled={busy || change === null}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Banknote size={16} />}
          {busy ? "Recording…" : "Record Payment"}
        </Button>
      </div>
    </div>
  );
}
