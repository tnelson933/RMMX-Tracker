import { useCallback, useEffect, useState } from "react";
import { Laptop, Loader2, KeyRound, Trash2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

// RM Connect pairing: show a short-lived code to type into RM Connect, and list
// the laptops already connected so a lost or old laptop can be removed.

type LaptopRow = { id: number; name: string; createdAt: string; lastSeenAt: string | null };

function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function ConnectLaptop() {
  const { toast } = useToast();
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [laptops, setLaptops] = useState<LaptopRow[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);

  const loadLaptops = useCallback(() => {
    fetch("/api/readers/laptops", { credentials: "include" })
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(rows => { setLaptops(rows); setLoadFailed(false); })
      .catch(() => setLoadFailed(true));
  }, []);

  useEffect(() => { loadLaptops(); }, [loadLaptops]);

  const secondsLeft = code ? Math.max(0, Math.round((new Date(code.expiresAt).getTime() - now) / 1000)) : 0;
  const expired = code != null && secondsLeft === 0;

  // While a live code is showing, count it down and refresh the laptop list so
  // a newly paired laptop appears on its own. Stop once the code expires.
  useEffect(() => {
    if (!code || expired) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(loadLaptops, 4000);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [code, expired, loadLaptops]);

  const newCode = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/readers/pairing-codes", { method: "POST", credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't create a code");
      setCode(data);
      setNow(Date.now());
    } catch (err) {
      toast({ title: "Couldn't create a code", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (laptop: LaptopRow) => {
    if (!window.confirm(`Disconnect "${laptop.name}"? Its readers stop sending reads until the laptop is connected again with a new code.`)) return;
    const res = await fetch(`/api/readers/laptops/${laptop.id}`, { method: "DELETE", credentials: "include" });
    if (res.ok) loadLaptops();
    else toast({ title: "Couldn't disconnect the laptop", variant: "destructive" });
  };

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Laptop size={16} className="text-primary" />
          <p className="font-semibold text-sm">Connect a laptop</p>
        </div>
        <Button size="sm" onClick={newCode} disabled={busy} className="gap-1.5">
          {busy ? <Loader2 size={13} className="animate-spin" /> : code ? <RefreshCw size={13} /> : <KeyRound size={13} />}
          {code ? "New code" : "Get a pairing code"}
        </Button>
      </div>

      {code && (
        <div className={`rounded-lg border-2 p-4 text-center ${expired ? "border-dashed opacity-60" : "border-primary/40 bg-primary/5"}`}>
          <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Type this code into RM Connect</p>
          <p className="font-mono text-4xl font-bold tracking-[0.3em] mt-1 select-all">{code.code.slice(0, 3)} {code.code.slice(3)}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {expired ? "Expired. Get a new code." : `Works once, for ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")} more.`}
          </p>
        </div>
      )}

      {loadFailed && laptops.length === 0 ? (
        <p className="text-xs text-muted-foreground">Couldn't load connected laptops. <button className="underline" onClick={loadLaptops}>Try again</button></p>
      ) : laptops.length > 0 ? (
        <div className="rounded-md border divide-y">
          {laptops.map(l => (
            <div key={l.id} className="flex items-center gap-3 px-3 py-2">
              <Laptop size={14} className="text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{l.name}</p>
                <p className="text-xs text-muted-foreground">Connected {new Date(l.createdAt).toLocaleDateString()} · last active {ago(l.lastSeenAt)}</p>
              </div>
              <button onClick={() => remove(l)} className="p-1 rounded text-muted-foreground hover:text-destructive" title="Disconnect this laptop">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No laptops connected yet.</p>
      )}
    </div>
  );
}
