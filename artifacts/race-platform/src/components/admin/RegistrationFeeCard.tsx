import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { DollarSign } from "lucide-react";

/**
 * Admin → Clubs: RM Roost's flat service fee per registration paid by card.
 * Riders pay it on top of the entry (a "Service fee" line at checkout); the
 * club still gets the entry price. Cash, comp and free entries have none, and
 * refunds keep it.
 */
interface FeeData {
  defaultCents: number;
  maxCents: number;
  switchDeadline: string | null;
  clubs: Array<{ id: number; name: string; overrideCents: number | null; mustSwitch: boolean; entries12mo: number; cardEntries12mo: number }>;
}

const KEY = ["admin-registration-fee"];
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** "1", "1.5", "$0.50" → cents; "" → null; anything else → NaN. */
function toCents(text: string): number | null {
  const t = text.replace(/[$\s]/g, "");
  if (t === "") return null;
  return /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : NaN;
}

async function put(url: string, cents: number | null): Promise<void> {
  await putJson(url, { cents });
}

async function putJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Couldn't save the fee. Try again.");
}

export function RegistrationFeeCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const res = await fetch("/api/admin/registration-fee", { credentials: "include" });
      if (!res.ok) throw new Error("Couldn't load the registration fee.");
      return res.json() as Promise<FeeData>;
    },
  });
  const [defaultText, setDefaultText] = useState<string | null>(null);
  const [clubText, setClubText] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [showClubs, setShowClubs] = useState(false);

  if (isLoading || !data) return null;
  const max = money(data.maxCents);
  const overrides = data.clubs.filter(c => c.overrideCents != null).length;

  async function save(id: string, url: string, text: string, allowBlank: boolean) {
    const cents = toCents(text);
    if ((cents === null && !allowBlank) || (cents !== null && (Number.isNaN(cents) || cents > data!.maxCents))) {
      toast({ title: `Enter a fee from $0.00 to ${max}.`, variant: "destructive" });
      return;
    }
    setSaving(id);
    try {
      await put(url, cents);
      await qc.invalidateQueries({ queryKey: KEY });
      toast({ title: "Registration fee saved" });
      if (id === "default") setDefaultText(null);
      else setClubText(t => { const n = { ...t }; delete n[Number(id)]; return n; });
    } catch (err) {
      toast({ title: (err as Error).message, variant: "destructive" });
    } finally {
      setSaving(null);
    }
  }

  const defaultValue = defaultText ?? (data.defaultCents / 100).toFixed(2);

  return (
    <div className="mb-8 rounded-lg border bg-card p-5">
      <div className="flex items-center gap-2 mb-1">
        <DollarSign size={18} className="text-primary" />
        <h2 className="font-heading font-bold uppercase tracking-wide">RM Roost service fee</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Added to the rider's checkout as a "Service fee" line for each registration (class entry) paid by card.
        Clubs still get their full entry price. Cash, comp and free entries have no fee, and refunds keep it. Tell clubs before you change it.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm font-medium">
          Fee per registration, all clubs
          <div className="relative mt-1 w-32">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
            <Input inputMode="decimal" className="pl-6" value={defaultValue}
              onChange={e => setDefaultText(e.target.value)} aria-label="Fee per registration, all clubs" />
          </div>
        </label>
        <Button disabled={saving === "default" || defaultText === null}
          onClick={() => save("default", "/api/admin/registration-fee", defaultValue, false)}>
          {saving === "default" ? "Saving…" : "Save"}
        </Button>
        <span className="text-xs text-muted-foreground pb-2">Up to {max}. $0.00 turns the fee off.</span>
      </div>

      <button type="button" className="mt-4 text-sm text-primary underline-offset-2 hover:underline"
        onClick={() => setShowClubs(s => !s)}>
        {showClubs ? "Hide per-club fees" : "Set a fee per club"}{overrides > 0 ? ` (${overrides} club${overrides === 1 ? "" : "s"} with their own fee)` : ""}
      </button>
      {showClubs && (
        <div className="mt-3 divide-y border rounded-md">
          <p className="px-3 py-2 text-xs text-muted-foreground bg-muted/40">
            Give a club its own fee, for example a higher one for a small club whose entries don't cover its hardware.
            Entries are the last 12 months, by event date; the fee only applies to card-paid entries. Fewest card entries first.
          </p>
          {[...data.clubs].sort((a, b) => a.cardEntries12mo - b.cardEntries12mo || a.name.localeCompare(b.name)).map(c => {
            const feeCents = c.overrideCents ?? data.defaultCents;
            const text = clubText[c.id] ?? (c.overrideCents == null ? "" : (c.overrideCents / 100).toFixed(2));
            const dirty = clubText[c.id] !== undefined;
            return (
              <div key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="flex-1 min-w-[10rem] text-sm">
                  {c.name}
                  <span className="block text-xs text-muted-foreground">
                    {c.cardEntries12mo.toLocaleString()} card {c.cardEntries12mo === 1 ? "entry" : "entries"} of {c.entries12mo.toLocaleString()} in 12 months
                    {feeCents > 0 && c.cardEntries12mo > 0 ? ` · about ${money(c.cardEntries12mo * feeCents)} a year at ${money(feeCents)}` : ""}
                  </span>
                </span>
                <div className="relative w-28">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                  <Input inputMode="decimal" className="pl-6 h-8" value={text}
                    placeholder={(data.defaultCents / 100).toFixed(2)}
                    onChange={e => setClubText(t => ({ ...t, [c.id]: e.target.value }))}
                    aria-label={`Registration fee for ${c.name}`} />
                </div>
                <Button size="sm" variant="outline" disabled={!dirty || saving === String(c.id)}
                  onClick={() => save(String(c.id), `/api/admin/clubs/${c.id}/registration-fee`, text, true)}>
                  {saving === String(c.id) ? "Saving…" : "Save"}
                </Button>
                <span className="w-full sm:w-auto text-xs text-muted-foreground">
                  {c.overrideCents == null ? `Uses ${money(data.defaultCents)}` : "Own fee. Clear it to use the all-clubs fee."}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
