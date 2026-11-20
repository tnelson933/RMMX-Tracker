import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListRiderTransponders,
  useAddRiderTransponder,
  useRemoveRiderTransponder,
  getListRiderTranspondersQueryKey,
  getGetRiderQueryKey,
  getListRidersQueryKey,
} from "@workspace/api-client-react";
import type { RiderTransponder } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Radio, Trash2, Loader2, Plus } from "lucide-react";

/**
 * Every RM TrackR and RFID sticker a rider owns (e.g. one per bike). A read of
 * any of them times the rider. Organizers add and remove them here; a number
 * already on another rider's profile is refused with that rider's name.
 */
export function RiderTranspondersCard({ riderId }: { riderId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const listKey = getListRiderTranspondersQueryKey(riderId);
  const { data: transponders = [], isLoading, isError } = useListRiderTransponders(riderId, { query: { enabled: !!riderId } as any });
  const add = useAddRiderTransponder();
  const remove = useRemoveRiderTransponder();
  const [number, setNumber] = useState("");
  const [kind, setKind] = useState<"trackr" | "rfid">("trackr");
  const [label, setLabel] = useState("");
  const [confirmId, setConfirmId] = useState<number | null>(null);

  const refresh = (list: RiderTransponder[]) => {
    queryClient.setQueryData(listKey, list);
    queryClient.invalidateQueries({ queryKey: getGetRiderQueryKey(riderId) });
    queryClient.invalidateQueries({ queryKey: getListRidersQueryKey() });
  };

  const onAdd = () => {
    const value = number.trim();
    if (!value) return;
    add.mutate(
      { riderId, data: { number: value, kind, label: label.trim() || null } },
      {
        onSuccess: (list) => {
          refresh(list);
          setNumber("");
          setLabel("");
          toast({ title: `${kind === "rfid" ? "RFID sticker" : "RM TrackR"} ${value.toUpperCase()} added` });
        },
        onError: (err) => toast({ title: "Couldn't add it", description: err.message, variant: "destructive" }),
      },
    );
  };

  const onRemove = (t: RiderTransponder) => {
    remove.mutate(
      { riderId, transponderId: t.id },
      {
        onSuccess: (list) => {
          refresh(list);
          setConfirmId(null);
          toast({ title: `${t.kindName} ${t.number} removed` });
        },
        onError: (err) => toast({ title: "Couldn't remove it", description: err.message, variant: "destructive" }),
      },
    );
  };

  return (
    <Card className={transponders.length ? "border-primary" : "border-muted"}>
      <CardHeader className={`${transponders.length ? "bg-primary/5" : "bg-muted/30"} border-b pb-4`}>
        <CardTitle className="font-heading uppercase text-xl flex items-center gap-2">
          <Radio className={transponders.length ? "text-primary" : "text-muted-foreground"} size={20} />
          Transponders
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-4">
        <p className="text-sm text-muted-foreground">
          Every RM TrackR and RFID sticker this rider owns, e.g. one per bike. Any of them times the rider.
        </p>
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : isError ? (
          <div className="text-sm text-destructive">Couldn't load the transponders. Refresh the page.</div>
        ) : transponders.length === 0 ? (
          <div className="p-4 bg-muted/40 rounded-lg border text-center text-sm text-muted-foreground">
            None assigned. Without one the rider is checked in and timed by hand.
          </div>
        ) : (
          <ul className="space-y-2" data-testid="rider-transponders">
            {transponders.map((t) => (
              <li key={t.id} className="flex items-center gap-3 p-3 rounded-lg border bg-muted/20">
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-lg font-bold break-all">{t.number}</div>
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                    <Badge variant={t.kind === "rfid" ? "secondary" : "default"}>{t.kindName}</Badge>
                    {t.label && <span className="text-xs text-muted-foreground">{t.label}</span>}
                  </div>
                </div>
                {confirmId === t.id ? (
                  <div className="flex gap-1">
                    <Button size="sm" variant="destructive" disabled={remove.isPending} onClick={() => onRemove(t)}>
                      {remove.isPending ? <Loader2 size={14} className="animate-spin" /> : "Remove"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>Keep</Button>
                  </div>
                ) : (
                  <Button size="icon" variant="ghost" aria-label={`Remove ${t.kindName} ${t.number}`} onClick={() => setConfirmId(t.id)}>
                    <Trash2 size={16} />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="pt-4 border-t space-y-3">
          <label className="text-sm font-bold uppercase tracking-wider block" htmlFor={`add-transponder-${riderId}`}>Add a transponder</label>
          <div className="flex gap-2" role="radiogroup" aria-label="Kind">
            {(["trackr", "rfid"] as const).map((k) => (
              <Button
                key={k}
                type="button"
                size="sm"
                variant={kind === k ? "default" : "outline"}
                role="radio"
                aria-checked={kind === k}
                onClick={() => setKind(k)}
              >
                {k === "trackr" ? "RM TrackR" : "RFID sticker"}
              </Button>
            ))}
          </div>
          <Input
            id={`add-transponder-${riderId}`}
            placeholder={kind === "trackr" ? "RM TrackR ID (up to 9 numbers or letters A–F)" : "Scan or enter the sticker number"}
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onAdd(); }}
            className="font-mono"
          />
          <Input
            placeholder="Bike (optional), e.g. YZ250F"
            value={label}
            maxLength={60}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onAdd(); }}
          />
          <Button onClick={onAdd} disabled={!number.trim() || add.isPending} className="font-heading uppercase w-full">
            {add.isPending ? <Loader2 size={16} className="animate-spin" /> : <><Plus size={16} className="mr-1" /> Add</>}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
