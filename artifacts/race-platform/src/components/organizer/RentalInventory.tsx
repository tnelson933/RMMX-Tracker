import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Radio, Plus, Trash2, Loader2, AlertTriangle, Archive, Search } from "lucide-react";
import { responseErrorMessage } from "@/lib/friendlyErrors";

export interface RentalUnit {
  id: number;
  transponderNumber: string;
  label: string | null;
  notes: string | null;
  missing: boolean;
  retired: boolean;
  status: "available" | "out" | "missing" | "retired";
  current: { registrationId: number; eventId: number; eventName: string; eventDate: string; riderName: string } | null;
}

export const RENTAL_UNITS_KEY = ["/api/rental-transponders"];

export function useRentalUnits(enabled = true) {
  return useQuery<RentalUnit[]>({
    queryKey: RENTAL_UNITS_KEY,
    enabled,
    queryFn: async () => {
      const res = await fetch("/api/rental-transponders", { credentials: "include" });
      if (!res.ok) throw new Error(responseErrorMessage(res.status));
      return res.json();
    },
  });
}

const STATUS_STYLE: Record<RentalUnit["status"], string> = {
  available: "bg-green-500/10 text-green-700 border-green-600/30",
  out: "bg-amber-500/10 text-amber-800 border-amber-500/40",
  missing: "bg-red-500/10 text-red-700 border-red-500/40",
  retired: "bg-muted text-muted-foreground border-border",
};
const STATUS_LABEL: Record<RentalUnit["status"], string> = { available: "Available", out: "Out", missing: "Missing", retired: "Retired" };

/**
 * Admin → Rental Transponders: the club's rental units. A unit is "Out" while
 * an event rental with its number isn't marked returned; check-in offers the
 * available ones. A rider only has a rental for that event: the timing link
 * is removed automatically after it (or as soon as it's marked returned).
 */
export function RentalInventory() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: units = [], isLoading, isError, refetch } = useRentalUnits();
  const [numbers, setNumbers] = useState("");
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [filter, setFilter] = useState("");

  const refresh = () => queryClient.invalidateQueries({ queryKey: RENTAL_UNITS_KEY });

  async function add() {
    setAdding(true);
    try {
      const res = await fetch("/api/rental-transponders", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numbers }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(responseErrorMessage(res.status, body));
      const parts = [`${body.added} added`];
      if (body.alreadyListed) parts.push(`${body.alreadyListed} already listed`);
      if (body.invalid?.length) parts.push(`not valid: ${body.invalid.slice(0, 5).join(", ")}`);
      toast({ title: "Rental transponders updated", description: parts.join(" · "), variant: body.invalid?.length ? "destructive" : undefined });
      if (!body.invalid?.length) setNumbers("");
      await refresh();
    } catch (err: any) {
      toast({ title: "Couldn't add units", description: String(err?.message ?? err), variant: "destructive" });
    } finally {
      setAdding(false);
    }
  }

  async function update(unit: RentalUnit, patch: Partial<Pick<RentalUnit, "missing" | "retired" | "label">>) {
    setBusyId(unit.id);
    try {
      const res = await fetch(`/api/rental-transponders/${unit.id}`, {
        method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(responseErrorMessage(res.status, body));
      await refresh();
    } catch (err: any) {
      toast({ title: "Couldn't update the unit", description: String(err?.message ?? err), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  async function remove(unit: RentalUnit) {
    if (!window.confirm(`Remove ${unit.label ?? unit.transponderNumber.toUpperCase()} from your rental units?`)) return;
    setBusyId(unit.id);
    try {
      const res = await fetch(`/api/rental-transponders/${unit.id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(responseErrorMessage(res.status, body));
      }
      await refresh();
    } catch (err: any) {
      toast({ title: "Couldn't remove the unit", description: String(err?.message ?? err), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  const counts = { available: 0, out: 0, missing: 0, retired: 0 } as Record<RentalUnit["status"], number>;
  for (const u of units) counts[u.status]++;
  const q = filter.trim().toLowerCase();
  const shown = q
    ? units.filter(u => u.transponderNumber.includes(q) || (u.label ?? "").toLowerCase().includes(q) || (u.current?.riderName ?? "").toLowerCase().includes(q))
    : units;

  return (
    <div className="rounded-xl border bg-card p-6 mb-6 space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <Radio size={18} className="text-primary" />
        </div>
        <div>
          <h2 className="font-heading font-semibold text-base uppercase tracking-wider">Rental Transponders</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            The units your club rents out. Check-in offers the available ones. A rental belongs to the rider only for that event: it's removed from them automatically after the event, or as soon as it's marked returned.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        {(["available", "out", "missing", "retired"] as const).map(s => (
          <span key={s} className={`rounded-full border px-2.5 py-0.5 font-semibold ${STATUS_STYLE[s]}`}>{STATUS_LABEL[s]}: {counts[s]}</span>
        ))}
      </div>

      <div className="rounded-lg border bg-muted/20 p-4 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Add units</p>
        <Textarea
          value={numbers}
          onChange={e => setNumbers(e.target.value)}
          placeholder="Transponder numbers, one per line or separated by commas (e.g. 1A2B3C)"
          rows={3}
          aria-label="Rental transponder numbers to add"
        />
        <Button onClick={add} disabled={adding || !numbers.trim()} className="gap-1.5">
          {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add to rental units
        </Button>
        <p className="text-[11px] text-muted-foreground">Units handed out at check-in are added here automatically too.</p>
      </div>

      {isError ? (
        <div className="text-sm text-muted-foreground">
          Couldn't load rental units. <button className="underline" onClick={() => refetch()}>Try again</button>
        </div>
      ) : isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : units.length === 0 ? (
        <p className="text-sm text-muted-foreground">No rental units yet. Add your transponder numbers above.</p>
      ) : (
        <div className="space-y-2">
          {units.length > 8 && (
            <div className="relative max-w-xs">
              <Search size={14} className="absolute left-2.5 top-2.5 text-muted-foreground" />
              <Input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Find a unit or rider" className="pl-8 h-9" aria-label="Find a rental unit" />
            </div>
          )}
          {shown.map(u => (
            <div key={u.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border bg-muted/30 px-4 py-3">
              <span className="font-mono font-bold text-sm uppercase">{u.transponderNumber}</span>
              <Input
                defaultValue={u.label ?? ""}
                placeholder="Label (e.g. Rental 12)"
                className="h-8 w-40 text-sm"
                aria-label={`Label for ${u.transponderNumber}`}
                onBlur={e => { const v = e.target.value.trim(); if (v !== (u.label ?? "")) void update(u, { label: v || null } as any); }}
              />
              <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[u.status]}`}>{STATUS_LABEL[u.status]}</span>
              {u.current && (
                <span className="text-xs text-muted-foreground">
                  with {u.current.riderName} ·{" "}
                  <Link href={`/events/${u.current.eventId}/transponder-rentals`} className="underline">{u.current.eventName}</Link>
                  {" "}({u.current.eventDate})
                </span>
              )}
              <span className="flex-1" />
              {busyId === u.id ? <Loader2 size={14} className="animate-spin text-muted-foreground" /> : (
                <div className="flex items-center gap-1">
                  {!u.retired && (
                    <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => update(u, { missing: !u.missing })}
                      title={u.missing ? "Found it: available again" : "Report the unit lost"}>
                      <AlertTriangle size={12} /> {u.missing ? "Found" : "Missing"}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => update(u, { retired: !u.retired })}
                    title={u.retired ? "Put back in service" : "Take out of service (not offered at check-in)"}>
                    <Archive size={12} /> {u.retired ? "Restore" : "Retire"}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" onClick={() => remove(u)}
                    aria-label={`Remove ${u.transponderNumber}`} title="Remove unit">
                    <Trash2 size={13} />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
