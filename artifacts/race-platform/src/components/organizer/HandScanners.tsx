import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { QRCodeSVG } from "qrcode.react";
import { ChevronDown, ScanLine, Plus, Loader2, Trash2, Copy, Check, CheckCircle2, MapPin, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { usePublicOrigin } from "@/lib/publicOrigin";

// Cellular or Wi-Fi hand scanners send reads straight to RM Roost, no laptop.
// Each one is a reader: place it on the Course Map so its reads count at the
// right spot (start, a section's time check, a split, the finish).

type Scanner = {
  id: number;
  name: string;
  token: string;
  lastSeenAt: string | null;
  placements: { eventId: number; eventName: string; where: string }[];
};
type Code = { code: string; expiresAt: string };

const LIVE_MS = 2 * 60_000;

function ago(iso: string | null, now: number): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(iso).toLocaleString();
}

export function HandScanners() {
  const { toast } = useToast();
  const origin = usePublicOrigin();
  const [open, setOpen] = useState(() => { try { return localStorage.getItem("readerSetup.scannersOpen") === "1"; } catch { return false; } });
  const [scanners, setScanners] = useState<Scanner[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // The scanner whose connect panel is showing, with its code and when it opened.
  const [connecting, setConnecting] = useState<{ id: number; code: Code | null; since: number } | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(() => {
    fetch("/api/readers/hand-scanners", { credentials: "include" })
      .then(r => (r.ok ? r.json() : []))
      .then(setScanners)
      .catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { try { localStorage.setItem("readerSetup.scannersOpen", open ? "1" : "0"); } catch {} }, [open]);

  // While open, refresh so "sending reads" shows up as soon as a scan lands.
  useEffect(() => {
    if (!open) return;
    const poll = setInterval(load, connecting ? 3000 : 15_000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [open, connecting, load]);

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/readers/hand-scanners", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't add the scanner");
      setName("");
      setConnecting({ id: data.id, code: data.code ?? null, since: Date.now() });
      load();
    } catch (err) {
      toast({ title: "Couldn't add the scanner", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const connect = async (s: Scanner) => {
    setConnecting({ id: s.id, code: null, since: Date.now() });
    const res = await fetch(`/api/readers/hand-scanners/${s.id}/code`, { method: "POST", credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) setConnecting({ id: s.id, code: data, since: Date.now() });
    else toast({ title: "Couldn't create a code", description: data.error, variant: "destructive" });
  };

  const remove = async (s: Scanner) => {
    if (!window.confirm(`Remove "${s.name}"? It stops sending reads and comes off the Course Map.`)) return;
    const res = await fetch(`/api/readers/${s.id}`, { method: "DELETE", credentials: "include" });
    if (res.ok) { if (connecting?.id === s.id) setConnecting(null); load(); }
    else toast({ title: "Couldn't remove the scanner", variant: "destructive" });
  };

  const liveCount = scanners.filter(s => s.lastSeenAt && now - new Date(s.lastSeenAt).getTime() < LIVE_MS).length;

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full px-5 py-3.5 flex items-center gap-3 text-left hover:bg-muted/30 transition-colors"
        aria-expanded={open}
      >
        <ScanLine size={18} className="text-primary shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-heading font-bold uppercase tracking-wider text-sm">Add a cellular or Wi-Fi hand scanner</p>
          {!open && scanners.length > 0 && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {scanners.length} scanner{scanners.length === 1 ? "" : "s"}{liveCount ? ` · ${liveCount} sending reads` : ""}
            </p>
          )}
        </div>
        <ChevronDown size={16} className={`text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="border-t px-5 py-4 space-y-4">
          <p className="text-xs text-muted-foreground">
            For checkpoints out on the course. Each scanner sends reads over its own cell signal or Wi-Fi (Starlink works), no laptop needed.
            Add one per handheld, then place it on the event's Course Map so its reads count at the right spot.
          </p>

          <div className="flex gap-2">
            <Input
              value={name}
              onChange={e => setName(e.target.value.slice(0, 60))}
              onKeyDown={e => e.key === "Enter" && add()}
              placeholder='Where it will be, e.g. "Section 4 check"'
              className="h-9"
            />
            <Button size="sm" onClick={add} disabled={busy || !name.trim()} className="gap-1.5 shrink-0 h-9">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add scanner
            </Button>
          </div>

          {scanners.length > 0 && (
            <div className="rounded-lg border divide-y">
              {scanners.map(s => {
                const live = !!s.lastSeenAt && now - new Date(s.lastSeenAt).getTime() < LIVE_MS;
                const isConnecting = connecting?.id === s.id;
                const firstScanSince = isConnecting && s.lastSeenAt && new Date(s.lastSeenAt).getTime() >= connecting!.since - 5000;
                return (
                  <div key={s.id} className="px-3 py-2.5 space-y-2">
                    <div className="flex items-center gap-3">
                      <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${live ? "bg-green-500" : s.lastSeenAt ? "bg-amber-400" : "bg-muted-foreground/30"}`} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{s.name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {live ? `Sending reads · last ${ago(s.lastSeenAt, now)}` : s.lastSeenAt ? `Last read ${ago(s.lastSeenAt, now)}` : "No reads yet"}
                          {" · "}
                          {s.placements.length > 0
                            ? s.placements.map(p => `${p.where} at ${p.eventName}`).join("; ")
                            : "not on a Course Map yet"}
                        </p>
                      </div>
                      <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs gap-1" onClick={() => (isConnecting ? setConnecting(null) : connect(s))}>
                        <KeyRound size={12} /> {isConnecting ? "Done" : "Connect"}
                      </Button>
                      <button onClick={() => remove(s)} className="p-1 rounded text-muted-foreground hover:text-destructive" title="Remove this scanner">
                        <Trash2 size={14} />
                      </button>
                    </div>

                    {isConnecting && (
                      firstScanSince ? (
                        <div className="rounded-lg border border-green-600/30 bg-green-50 px-3 py-2.5 flex items-center gap-2 text-sm text-green-800">
                          <CheckCircle2 size={16} className="shrink-0" />
                          <span><strong>{s.name}</strong> is sending reads.</span>
                          {s.placements.length === 0 && <CourseMapHint />}
                        </div>
                      ) : (
                        <ConnectPanel scanner={s} code={connecting!.code} origin={origin} now={now} onNewCode={() => connect(s)} />
                      )
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {scanners.length > 0 && scanners.every(s => s.placements.length === 0) && <CourseMapHint />}
        </div>
      )}
    </div>
  );
}

function CourseMapHint() {
  return (
    <p className="text-xs text-muted-foreground flex items-center gap-1.5">
      <MapPin size={12} className="shrink-0" />
      Next: open the event's <strong>Course Map</strong> (Events → the event → Course Map) and drag each scanner to its spot.
      <Link href="/events" className="underline">Events</Link>
    </p>
  );
}

function ConnectPanel({ scanner, code, origin, now, onNewCode }: {
  scanner: Scanner; code: Code | null; origin: string; now: number; onNewCode: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const uploadUrl = `${origin}/api/timing/readers/${scanner.token}/crossing`;
  const host = origin.replace(/^https?:\/\//, "");
  const secondsLeft = code ? Math.max(0, Math.round((new Date(code.expiresAt).getTime() - now) / 1000)) : 0;
  const copy = () => navigator.clipboard?.writeText(uploadUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});

  return (
    <div className="rounded-lg bg-muted/30 border p-3 grid gap-4 sm:grid-cols-[auto_1fr] items-start">
      <div className="flex flex-col items-center gap-1.5">
        {code && secondsLeft > 0 ? (
          <>
            <div className="bg-white p-2 rounded-md"><QRCodeSVG value={`${origin}/scan?code=${code.code}`} size={112} /></div>
            <p className="font-mono text-xl font-bold tracking-[0.25em]">{code.code.slice(0, 3)} {code.code.slice(3)}</p>
            <p className="text-[11px] text-muted-foreground">{Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")} left</p>
          </>
        ) : code ? (
          <Button size="sm" variant="outline" onClick={onNewCode} className="h-8 text-xs">Code expired: new code</Button>
        ) : (
          <Loader2 size={20} className="animate-spin text-muted-foreground m-8" />
        )}
      </div>
      <div className="space-y-2.5 text-xs">
        <div>
          <p className="font-semibold text-sm">On the scanner</p>
          <ol className="list-decimal pl-4 space-y-0.5 text-muted-foreground mt-1">
            <li><strong className="text-foreground">Has a camera:</strong> scan the QR code.</li>
            <li><strong className="text-foreground">No camera:</strong> open <span className="font-mono text-foreground">{host}/scan</span> in its browser and type the code.</li>
            <li>Scan any tag. This turns green when the first read arrives.</li>
          </ol>
          <p className="text-muted-foreground mt-1">
            The page times each scan on the scanner the moment it reads, using RM Roost's clock, and holds scans while there's no signal.
          </p>
        </div>
        <div>
          <p className="font-semibold">Scanner app with its own upload setting?</p>
          <p className="text-muted-foreground">Enter this address as its POST/HTTP upload URL. Send the tag as <span className="font-mono">epc</span>, <span className="font-mono">tag</span> or <span className="font-mono">rfidNumber</span> (JSON, form or plain text).</p>
          <div className="flex items-center gap-1.5 mt-1">
            <code className="flex-1 min-w-0 truncate rounded bg-background border px-2 py-1 font-mono text-[11px]">{uploadUrl}</code>
            <button onClick={copy} className="p-1 rounded text-muted-foreground hover:text-foreground" title="Copy address">
              {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
            </button>
          </div>
          <p className="text-muted-foreground mt-1">Apps that upload later should include the scan time (<span className="font-mono">crossingTime</span> or <span className="font-mono">timestamp</span>); otherwise the arrival time is used.</p>
        </div>
      </div>
    </div>
  );
}
