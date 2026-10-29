import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, AlertTriangle, WifiOff, Loader2, ScanLine, MapPin } from "lucide-react";

/**
 * RM Roost scanner page for handheld RFID scanners on cellular or Wi-Fi.
 *
 * Most handhelds type each tag they read into the focused field and press
 * Enter ("keyboard" output); typing a tag by hand works the same way. Each
 * scan is timed here the moment it's read, on RM Roost's clock (corrected for
 * the phone's own clock), and kept in a queue on the device until RM Roost
 * confirms it, so a dead spot on the course loses nothing.
 */

type Paired = { token: string; name: string };
type Scan = {
  id: string;
  tag: string;
  at: number; // RM Roost time of the read (ms)
  status: "pending" | "sent" | "not_counted";
  note?: string;
};
type Info = { name: string; placements: { eventId: number; eventName: string; where: string }[]; serverTime: string };

const PAIR_KEY = "rmroost.scanner";
const QUEUE_KEY = "rmroost.scanner.queue";
const DEDUPE_MS = 3000;

function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; }
}
function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

export default function HandScanner() {
  const [paired, setPaired] = useState<Paired | null>(() => load<Paired | null>(PAIR_KEY, null));
  const urlCode = new URLSearchParams(window.location.search).get("code") ?? "";

  // A QR code (?code=) always pairs, even over an earlier pairing.
  useEffect(() => {
    if (urlCode) setPaired(null);
  }, [urlCode]);

  if (!paired) {
    return <PairScreen initialCode={urlCode} onPaired={p => {
      save(PAIR_KEY, p);
      window.history.replaceState(null, "", "/scan");
      setPaired(p);
    }} />;
  }
  return <ScanScreen paired={paired} onUnpair={() => {
    // Scans waiting under this pairing can't be sent under another one.
    try { localStorage.removeItem(PAIR_KEY); localStorage.removeItem(QUEUE_KEY); } catch {}
    setPaired(null);
  }} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-gray-950 text-white flex flex-col">
      <div className="px-4 py-3 border-b border-white/10 flex items-center gap-2">
        <ScanLine size={18} className="text-red-500" />
        <span className="font-heading font-bold uppercase tracking-wider text-sm">RM Roost Scanner</span>
      </div>
      <div className="flex-1 flex flex-col p-4 max-w-lg w-full mx-auto">{children}</div>
    </div>
  );
}

function PairScreen({ initialCode, onPaired }: { initialCode: string; onPaired: (p: Paired) => void }) {
  const [code, setCode] = useState(initialCode.replace(/\D/g, "").slice(0, 6));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const tried = useRef(false);

  const pair = useCallback(async (value: string) => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/scanner/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "That code didn't work.");
      onPaired({ token: data.token, name: data.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reach RM Roost. Check the signal and try again.");
    } finally {
      setBusy(false);
    }
  }, [onPaired]);

  // Scanned from the QR code: pair straight away.
  useEffect(() => {
    if (code.length === 6 && initialCode && !tried.current) { tried.current = true; void pair(code); }
  }, [code, initialCode, pair]);

  return (
    <Shell>
      <div className="flex-1 flex flex-col justify-center gap-4">
        <h1 className="font-heading text-2xl font-bold uppercase">Connect this scanner</h1>
        <p className="text-white/60 text-sm">
          On Reader Setup, open <strong className="text-white">Add a cellular or Wi-Fi hand scanner</strong>, click Connect next to this
          scanner, and type the 6-digit code here.
        </p>
        <input
          value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onKeyDown={e => e.key === "Enter" && code.length === 6 && pair(code)}
          inputMode="numeric"
          autoFocus
          placeholder="000000"
          className="w-full rounded-lg bg-white/10 border border-white/20 px-4 py-4 text-center font-mono text-4xl tracking-[0.3em] text-white placeholder:text-white/20 focus:outline-none focus:border-red-500"
        />
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button
          onClick={() => pair(code)}
          disabled={busy || code.length !== 6}
          className="w-full rounded-full bg-red-600 hover:bg-red-700 disabled:opacity-40 py-3.5 font-heading font-bold uppercase tracking-wider flex items-center justify-center gap-2"
        >
          {busy && <Loader2 size={16} className="animate-spin" />} Connect
        </button>
      </div>
    </Shell>
  );
}

function beep(ok: boolean) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = ok ? 1320 : 330;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + (ok ? 0.08 : 0.25));
    osc.onended = () => ctx.close();
  } catch { /* no audio */ }
}

function ScanScreen({ paired, onUnpair }: { paired: Paired; onUnpair: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [gone, setGone] = useState(false);
  // RM Roost clock minus this device's clock.
  const offsetRef = useRef(0);
  const [scans, setScans] = useState<Scan[]>(() => load<Scan[]>(QUEUE_KEY, []));
  const scansRef = useRef(scans);
  const [online, setOnline] = useState(true);
  const [flash, setFlash] = useState<{ tag: string; ok: boolean } | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const sending = useRef(false);

  const update = useCallback((fn: (prev: Scan[]) => Scan[]) => {
    setScans(prev => {
      const next = fn(prev).slice(0, 200);
      scansRef.current = next;
      save(QUEUE_KEY, next);
      return next;
    });
  }, []);

  // Name, placement and RM Roost's clock (midpoint of the round trip).
  const refreshInfo = useCallback(async () => {
    try {
      const sent = Date.now();
      const res = await fetch(`/api/timing/readers/${encodeURIComponent(paired.token)}/scanner`, { cache: "no-store" });
      const received = Date.now();
      if (res.status === 404) { setGone(true); return; }
      if (!res.ok) return;
      const data = await res.json() as Info;
      offsetRef.current = new Date(data.serverTime).getTime() - (sent + received) / 2;
      setInfo(data);
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, [paired.token]);

  useEffect(() => {
    void refreshInfo();
    const t = setInterval(refreshInfo, 60_000);
    return () => clearInterval(t);
  }, [refreshInfo]);

  // Send waiting scans in order; keep them on any network or server failure.
  const flush = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      for (;;) {
        const next = [...scansRef.current].reverse().find(s => s.status === "pending");
        if (!next) break;
        let res: Response;
        try {
          res = await fetch(`/api/timing/readers/${encodeURIComponent(paired.token)}/crossing`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rfidNumber: next.tag, crossingTime: new Date(next.at).toISOString(), source: "hand_scanner_page" }),
          });
        } catch {
          setOnline(false);
          break;
        }
        setOnline(true);
        if (res.status === 404) { setGone(true); break; }
        if (res.status >= 500) break; // RM Roost hiccup: try again shortly
        const body = await res.json().catch(() => ({})) as { ok?: boolean; message?: string };
        const counted = res.ok && body.ok !== false;
        const reason = body.message && /no active|no moto|not accepting|race_day/i.test(body.message)
          ? "Not timed: nothing is running on RM Roost right now."
          : body.message;
        update(prev => prev.map(s => s.id === next.id
          ? { ...s, status: counted ? "sent" : "not_counted", note: counted ? undefined : reason ?? `Not counted (${res.status})` }
          : s));
      }
    } finally {
      sending.current = false;
    }
  }, [paired.token, update]);

  useEffect(() => {
    void flush();
    const t = setInterval(flush, 4000);
    const onOnline = () => { void flush(); };
    window.addEventListener("online", onOnline);
    return () => { clearInterval(t); window.removeEventListener("online", onOnline); };
  }, [flush]);

  // Keep the screen on and the field focused for the scanner's keyboard output.
  useEffect(() => {
    let lock: { release(): Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } };
    const acquire = () => { nav.wakeLock?.request("screen").then(l => { lock = l; }).catch(() => {}); };
    acquire();
    const onVis = () => { if (document.visibilityState === "visible") { acquire(); inputRef.current?.focus(); } };
    document.addEventListener("visibilitychange", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); void lock?.release().catch(() => {}); };
  }, []);

  const record = (raw: string) => {
    const tag = raw.replace(/\s+/g, "").toUpperCase();
    if (!tag) return;
    // Time it now, before anything else, on RM Roost's clock.
    const at = Date.now() + offsetRef.current;
    const dup = scansRef.current.find(s => s.tag === tag && at - s.at < DEDUPE_MS);
    if (!dup) {
      update(prev => [{ id: `${at}-${Math.random().toString(36).slice(2, 7)}`, tag, at, status: "pending" }, ...prev]);
      void flush();
    }
    setFlash({ tag, ok: true });
    beep(true);
    navigator.vibrate?.(60);
    setTimeout(() => setFlash(f => (f?.tag === tag ? null : f)), 1200);
  };

  const pending = scans.filter(s => s.status === "pending").length;

  if (gone) {
    return (
      <Shell>
        <div className="flex-1 flex flex-col justify-center gap-4 text-center">
          <AlertTriangle size={40} className="mx-auto text-amber-400" />
          <p className="text-lg font-bold">This scanner was removed or reconnected elsewhere.</p>
          <p className="text-white/60 text-sm">Get a new code from Reader Setup to connect it again.</p>
          <button onClick={onUnpair} className="rounded-full bg-red-600 py-3 font-heading font-bold uppercase tracking-wider">Enter a code</button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="space-y-1 mb-4">
        <h1 className="font-heading text-2xl font-bold uppercase leading-tight">{info?.name ?? paired.name}</h1>
        {info && (info.placements.length > 0 ? (
          info.placements.map(p => (
            <p key={`${p.eventId}-${p.where}`} className="text-sm text-white/70 flex items-center gap-1.5">
              <MapPin size={13} className="text-red-500 shrink-0" /> {p.where} · {p.eventName}
            </p>
          ))
        ) : (
          <p className="text-sm text-amber-300 flex items-center gap-1.5">
            <MapPin size={13} className="shrink-0" /> Not on a Course Map yet: reads only count once the organizer places this scanner.
          </p>
        ))}
        <p className={`text-xs flex items-center gap-1.5 ${online ? "text-green-400" : "text-amber-300"}`}>
          {online ? <span className="h-2 w-2 rounded-full bg-green-400" /> : <WifiOff size={12} />}
          {online ? "Connected to RM Roost" : "No signal: scans are saved and send when it's back"}
          {pending > 0 && ` · ${pending} waiting to send`}
        </p>
      </div>

      <div
        className={`rounded-2xl border-2 p-5 text-center transition-colors ${flash ? "border-green-400 bg-green-500/20" : "border-white/15 bg-white/5"}`}
        onClick={() => inputRef.current?.focus()}
      >
        {flash ? (
          <>
            <CheckCircle2 size={40} className="mx-auto text-green-400" />
            <p className="font-mono text-lg mt-2 break-all">{flash.tag}</p>
          </>
        ) : (
          <>
            <ScanLine size={40} className="mx-auto text-white/40" />
            <p className="mt-2 text-white/70">Ready. Scan a tag.</p>
          </>
        )}
        <form onSubmit={e => { e.preventDefault(); record(value); setValue(""); }} className="mt-4">
          <input
            ref={inputRef}
            value={value}
            onChange={e => setValue(e.target.value)}
            onBlur={() => setTimeout(() => inputRef.current?.focus(), 300)}
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="Tag number (scanners type it here)"
            className="w-full rounded-lg bg-black/40 border border-white/20 px-3 py-2.5 text-center font-mono text-white placeholder:text-white/30 focus:outline-none focus:border-red-500"
          />
        </form>
      </div>

      <div className="mt-5 flex-1">
        <p className="text-xs uppercase tracking-wider text-white/40 font-bold mb-2">Recent scans</p>
        {scans.length === 0 ? (
          <p className="text-sm text-white/40">Nothing scanned yet.</p>
        ) : (
          <ul className="divide-y divide-white/10 text-sm">
            {scans.slice(0, 25).map(s => (
              <li key={s.id} className="py-1.5 flex flex-wrap items-center gap-x-2">
                {s.status === "sent" ? <CheckCircle2 size={14} className="text-green-400 shrink-0" />
                  : s.status === "pending" ? <Loader2 size={14} className="text-amber-300 animate-spin shrink-0" />
                  : <AlertTriangle size={14} className="text-amber-400 shrink-0" />}
                <span className="font-mono truncate flex-1">{s.tag}</span>
                <span className="text-white/50 tabular-nums">{new Date(s.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                {s.note && <span className="basis-full pl-6 text-xs text-amber-300">{s.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <button
        onClick={() => {
          if (pending > 0 && !window.confirm(`${pending} scan${pending === 1 ? " hasn't" : "s haven't"} been sent yet and will be lost. Disconnect anyway?`)) return;
          try { localStorage.removeItem(QUEUE_KEY); } catch {}
          onUnpair();
        }}
        className="mt-6 text-xs text-white/40 underline self-center"
      >
        Disconnect this scanner
      </button>
    </Shell>
  );
}
