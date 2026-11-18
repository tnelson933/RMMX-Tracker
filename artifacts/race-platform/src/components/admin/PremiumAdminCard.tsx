import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Crown } from "lucide-react";

/**
 * Admin → Clubs: RM Roost Premium for riders ($4.99/month or $49.99/year).
 * Off by default: every rider gets everything. On: past stats, unlimited
 * Rocky (free riders get 1 question per 24 hours) and live streams need
 * Premium. Billing isn't built yet, so for now Premium can only be granted here.
 */
interface PremiumData {
  enforced: boolean;
  rockyQuestionsLast24h: number;
  accounts: Array<{ email: string; until: string | null; source: string | null }>;
}

const KEY = ["admin-premium"];

async function put(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Couldn't save. Try again.");
}

export function PremiumAdminCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data } = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const res = await fetch("/api/admin/premium", { credentials: "include" });
      if (!res.ok) throw new Error("Couldn't load Premium settings.");
      return res.json() as Promise<PremiumData>;
    },
  });
  const [email, setEmail] = useState("");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  if (!data) return null;

  async function run(fn: () => Promise<void>, done: string) {
    setBusy(true);
    try { await fn(); await qc.invalidateQueries({ queryKey: KEY }); toast({ title: done }); }
    catch (err) { toast({ title: (err as Error).message, variant: "destructive" }); }
    finally { setBusy(false); }
  }

  function toggle() {
    const on = !data!.enforced;
    if (on && !window.confirm("Turn Premium on? Past stats, more than 1 Rocky question a day, and live streams will need Premium. Riders can't buy it yet until billing is built.")) return;
    void run(() => put("/api/admin/premium", { enforced: on }), on ? "Premium is on" : "Premium is off: everything is free");
  }

  return (
    <div className="mb-8 rounded-lg border bg-card p-5">
      <div className="flex items-center gap-2 mb-1">
        <Crown size={18} className="text-primary" />
        <h2 className="font-heading font-bold uppercase tracking-wide">RM Roost Premium for riders</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        $4.99/month or $49.99/year. When on, past stats and history, Rocky beyond 1 question a day, and watching live
        streams need Premium. Today's lap times, registration and check-in stay free. When off, everything is free.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <span className={`text-sm font-semibold ${data.enforced ? "text-green-700" : "text-muted-foreground"}`}>
          Premium is {data.enforced ? "ON" : "OFF (everything free)"}
        </span>
        <Button variant={data.enforced ? "outline" : "default"} disabled={busy} onClick={toggle}>
          {data.enforced ? "Turn off" : "Turn on"}
        </Button>
        <span className="text-xs text-muted-foreground">Rocky questions in the last 24 hours: {data.rockyQuestionsLast24h}</span>
      </div>

      <div className="mt-5 border-t pt-4">
        <h3 className="font-heading font-bold uppercase tracking-wide text-sm mb-1">Give Premium to a rider account</h3>
        <p className="text-xs text-muted-foreground mb-2">For promotions and testing. Leave the date empty to remove it.</p>
        <div className="flex flex-wrap items-end gap-2">
          <Input className="w-64" type="email" placeholder="rider@example.com" value={email} onChange={e => setEmail(e.target.value)} aria-label="Rider account email" />
          <Input className="w-44" type="date" value={until} onChange={e => setUntil(e.target.value)} aria-label="Premium until" />
          <Button variant="outline" disabled={busy || !email.trim()}
            onClick={() => run(() => put("/api/admin/premium/grant", { email, until: until || null }), until ? "Premium given" : "Premium removed")}>
            Save
          </Button>
        </div>
        {data.accounts.length > 0 && (
          <ul className="mt-3 text-sm space-y-1">
            {data.accounts.map(a => (
              <li key={a.email}>{a.email}: until {a.until ? new Date(a.until).toLocaleDateString("en-US", { timeZone: "UTC" }) : "?"} ({a.source ?? "unknown"})</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
