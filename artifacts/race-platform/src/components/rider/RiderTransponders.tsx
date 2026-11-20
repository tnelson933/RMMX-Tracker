import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Wifi, Trash2, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { riderApi, type RiderTransponder } from "@/lib/rider-api";

export const riderTranspondersKey = (riderId: number) => ["rider-transponders", riderId];

export function useRiderTransponders(riderId: number | undefined) {
  return useQuery<RiderTransponder[]>({
    queryKey: riderTranspondersKey(riderId ?? 0),
    queryFn: () => riderApi.transponders(riderId!),
    enabled: !!riderId,
  });
}

/**
 * The rider's own RM TrackRs and RFID stickers (e.g. one per bike). Any of them
 * times the rider. Riders add numbers nobody else has and remove their own; a
 * number on someone else's profile is refused (the organizer moves those).
 */
export function RiderTranspondersCard({ riderId }: { riderId: number }) {
  const queryClient = useQueryClient();
  const { data: transponders = [], isLoading, isError } = useRiderTransponders(riderId);
  const [number, setNumber] = useState("");
  const [kind, setKind] = useState<"trackr" | "rfid">("trackr");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);

  const save = (list: RiderTransponder[]) => {
    queryClient.setQueryData(riderTranspondersKey(riderId), list);
    queryClient.invalidateQueries({ queryKey: ["rider-history", riderId] });
    queryClient.invalidateQueries({ queryKey: ["rider-profiles"] });
  };

  async function add() {
    const value = number.trim();
    if (!value || saving) return;
    setSaving(true);
    setError(null);
    try {
      save(await riderApi.addTransponder(riderId, { number: value, kind, label: label.trim() || null }));
      setNumber("");
      setLabel("");
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Couldn't add it. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(t: RiderTransponder) {
    setRemovingId(t.id);
    setError(null);
    try {
      save(await riderApi.removeTransponder(riderId, t.id));
      setConfirmId(null);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Couldn't delete it. Please try again.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="space-y-4 mt-6" data-testid="rider-transponders-card">
      <div>
        <h2 className="font-heading font-bold text-lg uppercase tracking-wide flex items-center gap-2">
          <Wifi size={18} /> My Transponders
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Your RM TrackRs and RFID stickers, e.g. one per bike. Any of them times you at races and practice. Delete one you no longer have so someone else can add it.
        </p>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {isError && <p className="text-sm text-destructive">Couldn't load your transponders. Refresh the page.</p>}
      {!isLoading && !isError && transponders.length === 0 && (
        <p className="text-sm text-muted-foreground italic">None on file yet. Add the number printed on your RM TrackR below.</p>
      )}

      <div className="space-y-2">
        {transponders.map((t) => (
          <div key={t.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
            <Badge variant={t.kind === "rfid" ? "secondary" : "default"} className="flex-shrink-0">{t.kindName}</Badge>
            <span className="min-w-[8rem] flex-1">
              <span className="font-mono text-sm font-bold break-words">{t.number}</span>
              {t.label && <span className="text-xs text-muted-foreground ml-2">{t.label}</span>}
            </span>
            {confirmId === t.id ? (
              <span className="ml-auto flex gap-1">
                <Button size="sm" variant="destructive" disabled={removingId !== null} onClick={() => remove(t)}>
                  {removingId === t.id ? <Loader2 size={14} className="animate-spin" /> : "Delete"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>Keep</Button>
              </span>
            ) : (
              <Button size="icon" variant="ghost" aria-label={`Delete ${t.kindName} ${t.number}`} onClick={() => setConfirmId(t.id)}>
                <Trash2 size={15} />
              </Button>
            )}
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-dashed p-4 space-y-3">
        <div className="flex gap-2" role="radiogroup" aria-label="Kind">
          {(["trackr", "rfid"] as const).map((k) => (
            <Button key={k} type="button" size="sm" variant={kind === k ? "default" : "outline"} role="radio" aria-checked={kind === k} onClick={() => setKind(k)}>
              {k === "trackr" ? "RM TrackR" : "RFID sticker"}
            </Button>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input
            aria-label={kind === "trackr" ? "RM TrackR number" : "RFID sticker number"}
            placeholder={kind === "trackr" ? "Number printed on it" : "Sticker number"}
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            className="font-mono"
          />
          <Input
            aria-label="Bike (optional)"
            placeholder="Bike (optional)"
            value={label}
            maxLength={60}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          />
          <Button onClick={add} disabled={!number.trim() || saving}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <><Plus size={15} className="mr-1" /> Add</>}
          </Button>
        </div>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      </div>
    </div>
  );
}
