import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Crown } from "lucide-react";

/**
 * Admin → Clubs (RM Roost super admins only): RM Roost Premium for riders.
 * Off by default: every rider gets everything. On: past stats, unlimited Rocky
 * (free riders get 1 question every 72 hours) and live streaming beyond 30 free
 * minutes need Premium. Individual covers 1 rider and 1 phone; Family covers
 * up to 4 riders and 4 phones. Riders buy it in the app (Apple / Google) or on
 * the website (Stripe); it works in both. Super admins can also give it here.
 */
interface PremiumData {
  enforced: boolean;
  rockyQuestionsLast24h: number;
  accounts: Array<{ email: string; until: string | null; source: string | null; plan: "individual" | "family"; riders: string[] }>;
}
interface AccountLookup {
  email: string;
  riders: Array<{ id: number; name: string }>;
  premium: { active: boolean; plan: "individual" | "family" | null; riderIds: number[]; until: string | null };
}

const KEY = ["admin-premium"];
const SLOTS = { individual: 1, family: 4 } as const;

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
  const [found, setFound] = useState<AccountLookup | null>(null);
  const [plan, setPlan] = useState<"individual" | "family">("individual");
  const [picked, setPicked] = useState<number[]>([]);
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
    if (on && !window.confirm("Turn Premium on? Past stats, more than 1 Rocky question every 72 hours, and live streaming beyond 30 free minutes will need Premium, and accounts will be limited to 1 phone (4 on Family). Riders can buy it on the website right away, and in the app once the store setup is done.")) return;
    void run(() => put("/api/admin/premium", { enforced: on }), on ? "Premium is on" : "Premium is off: everything is free");
  }

  async function findAccount() {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/premium/account?email=${encodeURIComponent(email.trim())}`, { credentials: "include" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Couldn't find that account.");
      const acct = body as AccountLookup;
      setFound(acct);
      setPlan(acct.premium.plan ?? (acct.riders.length > 1 ? "family" : "individual"));
      setPicked(acct.premium.riderIds.length ? acct.premium.riderIds : acct.riders.slice(0, 1).map(r => r.id));
      setUntil(acct.premium.until ? acct.premium.until.slice(0, 10) : "");
    } catch (err) {
      setFound(null);
      toast({ title: (err as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const slots = SLOTS[plan];
  const pick = (id: number, on: boolean) => setPicked(prev => {
    if (!on) return prev.filter(x => x !== id);
    const next = [...prev.filter(x => x !== id), id];
    return next.slice(-slots);
  });

  return (
    <div className="mb-8 rounded-lg border bg-card p-5">
      <div className="flex items-center gap-2 mb-1">
        <Crown size={18} className="text-primary" />
        <h2 className="font-heading font-bold uppercase tracking-wide">RM Roost Premium for riders</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Individual ($4.99/month or $49.99/year): 1 rider, 1 phone signed in. Family ($79.99/year): up to 4 riders, up to 4 phones.
        When on, past stats, Rocky beyond 1 question every 72 hours, and live streaming beyond 30 free minutes need Premium, and signing in on
        one phone too many signs out the oldest. Today's results, registration and check-in stay free. When off, everything is free.
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
        <p className="text-xs text-muted-foreground mb-2">RM Roost super admins only, for promotions and testing.</p>
        <div className="flex flex-wrap items-end gap-2">
          <Input className="w-64" type="email" placeholder="rider@example.com" value={email}
            onChange={e => { setEmail(e.target.value); setFound(null); }} aria-label="Rider account email" />
          <Button variant="outline" disabled={busy || !email.trim()} onClick={findAccount}>Find account</Button>
        </div>

        {found && (
          <div className="mt-3 rounded-md border p-3 space-y-3">
            <div className="text-sm">
              <span className="font-semibold">{found.email}</span>
              {found.premium.active && <span className="text-muted-foreground"> · has {found.premium.plan} Premium until {new Date(found.premium.until!).toLocaleDateString("en-US", { timeZone: "UTC" })}</span>}
            </div>
            <div className="flex gap-4 text-sm">
              {(["individual", "family"] as const).map(p => (
                <label key={p} className="flex items-center gap-1.5">
                  <input type="radio" name="premium-plan" checked={plan === p} onChange={() => { setPlan(p); setPicked(prev => prev.slice(0, SLOTS[p])); }} />
                  {p === "individual" ? "Individual (1 rider)" : "Family (up to 4 riders)"}
                </label>
              ))}
            </div>
            {found.riders.length === 0 ? (
              <p className="text-sm text-muted-foreground">This account has no rider profiles yet. Premium will apply once a rider is picked in the app.</p>
            ) : (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Riders Premium covers ({picked.length} of {slots}):</p>
                {found.riders.map(r => (
                  <label key={r.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={picked.includes(r.id)} onChange={e => pick(r.id, e.target.checked)} />
                    {r.name}
                  </label>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-sm">
                Premium until
                <Input className="mt-1 w-44" type="date" value={until} onChange={e => setUntil(e.target.value)} aria-label="Premium until" />
              </label>
              <Button disabled={busy || !until}
                onClick={() => run(() => put("/api/admin/premium/grant", { email: found.email, until, plan, riderIds: picked }), "Premium given")}>
                Give Premium
              </Button>
              {found.premium.active && (
                <Button variant="outline" disabled={busy}
                  onClick={() => run(async () => { await put("/api/admin/premium/grant", { email: found.email, until: null }); setFound(null); }, "Premium removed")}>
                  Remove Premium
                </Button>
              )}
            </div>
          </div>
        )}

        {data.accounts.length > 0 && (
          <ul className="mt-3 text-sm space-y-1">
            {data.accounts.map(a => (
              <li key={a.email}>
                {a.email}: {a.plan === "family" ? "Family" : "Individual"} until {a.until ? new Date(a.until).toLocaleDateString("en-US", { timeZone: "UTC" }) : "?"}
                {" "}({a.riders.length ? a.riders.join(", ") : "no rider picked yet"}; {a.source ?? "unknown"})
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
