import { useEffect, useState } from "react";
import {
  Cable, CheckCircle2, Globe, Loader2, Radar, RefreshCw, Router, WifiOff, XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Desktop-only: connect timing hardware over a local network with no internet.
// The F2000 (TCP 55555) and LLRP RFID readers (TCP 5084) both talk directly
// to this computer, reads go into the desktop's local timing server, and the
// sync engine uploads them once internet returns.

type Tech = "rfid" | "active_transponder";
type DeviceKind = "active_transponder" | "rfid";
type RfidHardware = "impinj" | "zebra" | "generic";

interface NetworkAdapter { name: string; address: string; prefixLength: number; kind: "private" | "link-local" | "other" }
interface NetworkInfo { adapters: NetworkAdapter[]; internet: boolean }
interface DiscoveredDevice { address: string; port: number; kind: DeviceKind; hostname: string | null; adapter: string }
interface ScanResult { devices: DiscoveredDevice[]; scannedHosts: number; skippedAdapters: string[] }
interface RfidNetworkStatus {
  connected: boolean; connecting: boolean; reading: boolean; host: string | null; error: string | null;
  lastReadAt: string | null; readCount: number; antennaIds: number[]; reconnecting: boolean;
}
interface ActiveStatus {
  connected: boolean; state: string; deviceIp: string | null; error: string | null; diagnosis: string;
  passingCount: number; ready: boolean;
}

interface DesktopApi {
  network: {
    getInfo(): Promise<NetworkInfo>;
    scan(): Promise<ScanResult>;
    probe(host: string): Promise<{ resolved: string | null; kinds: DeviceKind[] }>;
  };
  rfidNetwork: {
    getSettings(): Promise<{ address?: string; hardware?: RfidHardware }>;
    getStatus(): Promise<RfidNetworkStatus>;
    connect(address: string, hardware: RfidHardware): Promise<void>;
    disconnect(): Promise<void>;
    onStatus(cb: (s: RfidNetworkStatus) => void): () => void;
  };
  activeTransponder: {
    connect(address?: string): Promise<void>;
    disconnect(): Promise<void>;
    getStatus(): Promise<ActiveStatus>;
    onStatus(cb: (s: ActiveStatus) => void): () => void;
  };
}

const MODE_KEY = "rm-hardware-connection-mode";

function desktopApi(): DesktopApi | null {
  const api = (window as unknown as { electronAPI?: Partial<DesktopApi> }).electronAPI;
  // Older desktop builds have no network API; the page then keeps its normal flow.
  return api?.network && api.rfidNetwork ? (api as DesktopApi) : null;
}

export function hasOfflineHardwareSupport(): boolean {
  return desktopApi() !== null;
}

function readMode(): "internet" | "offline" | null {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    return saved === "internet" || saved === "offline" ? saved : null;
  } catch { return null; }
}

/** "With internet" vs "No internet" choice; renders the local-network setup when offline is chosen. */
export function ConnectionModeChooser({ tech }: { tech: Tech }) {
  const api = desktopApi();
  const [mode, setMode] = useState<"internet" | "offline" | null>(readMode);
  const [internet, setInternet] = useState<boolean | null>(null);

  useEffect(() => {
    if (!api) return;
    api.network.getInfo().then(info => {
      setInternet(info.internet);
      // First visit: suggest the mode that matches what this computer has right now.
      setMode(current => current ?? (info.internet ? "internet" : "offline"));
    }).catch(() => {});
  }, []);

  if (!api) return null;

  const choose = (next: "internet" | "offline") => {
    setMode(next);
    try { localStorage.setItem(MODE_KEY, next); } catch { /* per-viewer convenience only */ }
  };

  return (
    <section className="rounded-xl border-2 border-primary/25 bg-card p-5 space-y-4">
      <div>
        <p className="font-heading font-bold uppercase tracking-wider text-sm">2. Will the track have internet?</p>
        <p className="text-sm text-muted-foreground mt-1">
          {internet === null ? "Checking this computer's connection…"
            : internet ? "This computer is online right now." : "This computer has no internet right now."}
          {" "}The reader only needs to share a local network with this computer either way.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ModeButton active={mode === "internet"} onClick={() => choose("internet")} icon={<Globe size={22} />}
          title="Yes, connect with internet" detail="Use the standard setup below. Results go live as riders cross." />
        <ModeButton active={mode === "offline"} onClick={() => choose("offline")} icon={<WifiOff size={22} />}
          title="No, connect without internet" detail="Reader and computer on a local network. Results upload when you're back online." />
      </div>
      {mode === "offline" && <OfflineHardwareSetup tech={tech} api={api} />}
    </section>
  );
}

function ModeButton({ active, onClick, icon, title, detail }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; title: string; detail: string;
}) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-3 rounded-xl border-2 p-4 text-left transition-all ${active ? "border-primary bg-primary/5 shadow-sm" : "border-border hover:border-primary/40"}`}>
      <span className={active ? "text-primary" : "text-muted-foreground"}>{icon}</span>
      <div>
        <p className="font-semibold">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{detail}</p>
      </div>
    </button>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 px-4 py-4">
      <span className="h-6 w-6 shrink-0 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">{n}</span>
      <div className="space-y-2 min-w-0 w-full">
        <p className="text-sm font-semibold">{title}</p>
        {children}
      </div>
    </div>
  );
}

function OfflineHardwareSetup({ tech, api }: { tech: Tech; api: DesktopApi }) {
  const [layout, setLayout] = useState<"router" | "direct">("router");
  const [info, setInfo] = useState<NetworkInfo | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [address, setAddress] = useState("");
  const [checkResult, setCheckResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [checking, setChecking] = useState(false);

  const refreshInfo = () => api.network.getInfo().then(setInfo).catch(() => {});
  useEffect(() => { refreshInfo(); }, []);

  const wantedKind: DeviceKind = tech;
  const kindLabel = (kind: DeviceKind) => kind === "rfid" ? "RFID reader (LLRP)" : "RM TrackR reader";

  async function runScan() {
    setScanning(true);
    setScan(null);
    try {
      await refreshInfo();
      setScan(await api.network.scan());
    } finally {
      setScanning(false);
    }
  }

  async function checkAddress() {
    if (!address.trim()) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const result = await api.network.probe(address);
      if (!result.resolved) {
        setCheckResult({ ok: false, message: `Couldn't find "${address.trim()}" on this network. Check the cable and the address.` });
      } else if (result.kinds.includes(wantedKind)) {
        setCheckResult({ ok: true, message: `Found a ${kindLabel(wantedKind)} at ${result.resolved}.` });
      } else if (result.kinds.length) {
        setCheckResult({ ok: false, message: `${result.resolved} answers, but as a ${kindLabel(result.kinds[0])}. Pick the other timing system above or check the address.` });
      } else {
        setCheckResult({ ok: false, message: `${result.resolved} is reachable but isn't accepting a timing connection on port ${tech === "rfid" ? 5084 : 55555}. Make sure it's powered on and in ${tech === "rfid" ? "LLRP" : "TCP"} mode.` });
      }
    } finally {
      setChecking(false);
    }
  }

  const adapters = info?.adapters ?? [];
  const linkLocal = adapters.some(a => a.kind === "link-local");
  const matches = scan?.devices.filter(d => d.kind === wantedKind) ?? [];
  const others = scan?.devices.filter(d => d.kind !== wantedKind) ?? [];

  return (
    <div className="border rounded-lg divide-y overflow-hidden bg-background/40">
      <Step n={1} title="Put the reader and this computer on one network">
        {/* RFID readers only get an address from a router; a direct cable is
            offered for the RM TrackR only, with fixed IPs set on both ends. */}
        {tech !== "rfid" && (
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant={layout === "router" ? "default" : "outline"} className="gap-1.5" onClick={() => setLayout("router")}>
              <Router size={14} /> Router or switch
            </Button>
            <Button size="sm" variant={layout === "direct" ? "default" : "outline"} className="gap-1.5" onClick={() => setLayout("direct")}>
              <Cable size={14} /> Direct cable (fixed IPs)
            </Button>
          </div>
        )}
        {layout === "router" || tech === "rfid" ? (
          <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
            <li><strong className="text-foreground">Recommended.</strong> Any home or travel router works without internet: it still gives every device an address.</li>
            <li>Plug the reader into a LAN port and connect this computer by cable or the router's Wi-Fi.</li>
            <li>A cable straight from this computer to the reader won't work on automatic settings: the reader only gets an address from a router.</li>
            {tech === "rfid" ? (
              <li>Impinj R700 and Zebra readers need Power over Ethernet: use a PoE switch or a PoE injector between the router and the reader.</li>
            ) : (
              <li>On the RM TrackR, open <strong className="text-foreground">Config → Network</strong> and choose TCP mode. Its IP is under <strong className="text-foreground">Config → About</strong>: the first three numbers must match this computer's address in step 2. If they don't, set a free fixed IP there that does (e.g. <code className="font-mono text-xs">192.168.1.200</code> on a 192.168.1.x router).</li>
            )}
            <li>Wait about a minute after power-up, then scan below.</li>
          </ul>
        ) : (
          <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
            <li>Only with fixed IPs on both ends: on automatic settings the RM TrackR gets no address without a router. If you can, use a router instead.</li>
            <li>Cable the RM TrackR's Ethernet port straight to this computer.</li>
            <li>On the RM TrackR, open <strong className="text-foreground">Config → Network</strong>, choose TCP mode, and set a fixed IP: <code className="font-mono text-xs">192.168.1.200</code>, mask <code className="font-mono text-xs">255.255.255.0</code>.</li>
            <li>Give this computer's Ethernet adapter a fixed IP on the same network: <code className="font-mono text-xs">192.168.1.10</code>, mask <code className="font-mono text-xs">255.255.255.0</code>, no gateway.
              <span className="block text-xs mt-0.5">Windows: Settings → Network &amp; internet → Ethernet → IP assignment → Edit → Manual. Mac: System Settings → Network → Ethernet → Details → TCP/IP → Configure IPv4: Manually.</span>
            </li>
            <li>Then enter <code className="font-mono text-xs">192.168.1.200</code> below. Set the adapter back to automatic after the race.</li>
          </ul>
        )}
      </Step>

      <Step n={2} title="Check this computer's network">
        {info === null ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Reading network adapters…</p>
        ) : adapters.length === 0 ? (
          <p className="text-sm text-amber-600 dark:text-amber-400">No network connection found. Plug in the cable or join the router's Wi-Fi, then refresh.</p>
        ) : (
          <ul className="text-sm space-y-1">
            {adapters.map(a => (
              <li key={`${a.name}-${a.address}`} className="flex items-center gap-2">
                <span className="font-mono text-xs">{a.address}/{a.prefixLength}</span>
                <span className="text-muted-foreground">{a.name}</span>
                {a.kind === "link-local" && <span className="text-[11px] rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 px-2">no router: automatic 169.254 address</span>}
              </li>
            ))}
          </ul>
        )}
        {info && <p className="text-xs text-muted-foreground">Internet: {info.internet ? "connected" : "not connected (that's fine for this setup)"}</p>}
        <Button size="sm" variant="ghost" className="gap-1.5 -ml-2" onClick={refreshInfo}><RefreshCw size={13} /> Refresh</Button>
      </Step>

      <Step n={3} title={`Find the ${tech === "rfid" ? "RFID reader" : "RM TrackR"}`}>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="gap-1.5" onClick={runScan} disabled={scanning}>
            {scanning ? <Loader2 size={14} className="animate-spin" /> : <Radar size={14} />}
            {scanning ? "Scanning…" : "Scan this network"}
          </Button>
        </div>
        {linkLocal && !scanning && (
          <p className="text-xs text-amber-700 dark:text-amber-400">This computer has a 169.254 address, so it isn't on a router. Connect it and the reader to a router (or use the RM TrackR fixed-IP setup above), then scan.</p>
        )}
        {scan && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Checked {scan.scannedHosts} addresses.</p>
            {matches.length === 0 && (
              <p className="text-sm text-muted-foreground">No {kindLabel(wantedKind)} found. Check power and cabling, wait a minute after power-up, or enter the address below.</p>
            )}
            {matches.map(d => (
              <div key={`${d.address}:${d.port}`} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                <CheckCircle2 size={15} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm">{d.address}</p>
                  {d.hostname && <p className="text-xs text-muted-foreground truncate">{d.hostname}</p>}
                </div>
                <Button size="sm" variant="outline" onClick={() => { setAddress(d.address); setCheckResult(null); }}>Use</Button>
              </div>
            ))}
            {others.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Also found: {others.map(d => `${kindLabel(d.kind)} at ${d.address}`).join(", ")}.
              </p>
            )}
          </div>
        )}
        <div className="flex gap-2 pt-1">
          <Input value={address} onChange={e => { setAddress(e.target.value); setCheckResult(null); }}
            placeholder={tech === "rfid" ? "IP or hostname, e.g. impinj-16-25-b2.local" : "IP, e.g. 192.168.1.200"}
            className="font-mono h-9 text-sm" />
          <Button size="sm" variant="outline" className="h-9" onClick={checkAddress} disabled={checking || !address.trim()}>
            {checking ? <Loader2 size={14} className="animate-spin" /> : "Check"}
          </Button>
        </div>
        {checkResult && (
          <p className={`text-sm flex items-start gap-1.5 ${checkResult.ok ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}`}>
            {checkResult.ok ? <CheckCircle2 size={15} className="mt-0.5 shrink-0" /> : <XCircle size={15} className="mt-0.5 shrink-0" />}
            {checkResult.message}
          </p>
        )}
      </Step>

      <Step n={4} title="Connect and test">
        {tech === "rfid"
          ? <RfidConnect api={api} address={address} setAddress={setAddress} />
          : <ActiveConnect api={api} address={address} />}
      </Step>
    </div>
  );
}

function RfidConnect({ api, address, setAddress }: { api: DesktopApi; address: string; setAddress: (a: string) => void }) {
  const [hardware, setHardware] = useState<RfidHardware>("impinj");
  const [status, setStatus] = useState<RfidNetworkStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.rfidNetwork.getStatus().then(setStatus).catch(() => {});
    api.rfidNetwork.getSettings().then(saved => {
      if (saved.hardware) setHardware(saved.hardware);
      if (saved.address && !address) setAddress(saved.address);
    }).catch(() => {});
    return api.rfidNetwork.onStatus(setStatus);
  }, []);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      await api.rfidNetwork.connect(address, hardware);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
    } finally {
      setBusy(false);
    }
  }

  const connected = !!status?.connected;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Select value={hardware} onValueChange={v => setHardware(v as RfidHardware)} disabled={connected}>
          <SelectTrigger className="w-48 h-9 bg-background"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="impinj">Impinj (R700, Speedway)</SelectItem>
            <SelectItem value="zebra">Zebra (FX7500, FX9600)</SelectItem>
            <SelectItem value="generic">Other LLRP reader</SelectItem>
          </SelectContent>
        </Select>
        {connected ? (
          <Button size="sm" variant="outline" className="h-9" onClick={() => api.rfidNetwork.disconnect()}>Disconnect</Button>
        ) : (
          <Button size="sm" className="h-9 gap-1.5" onClick={connect} disabled={busy || !address.trim()}>
            {busy && <Loader2 size={14} className="animate-spin" />} Connect to {address.trim() || "reader"}
          </Button>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {status?.reconnecting && <p className="text-sm text-amber-700 dark:text-amber-400">Connection lost. Reconnecting to {status.host}…</p>}
      {connected && (
        <div className="rounded-lg border bg-emerald-500/5 border-emerald-500/30 p-3 text-sm space-y-1">
          <p className="font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5"><CheckCircle2 size={15} /> Connected to {status!.host}</p>
          <p>Hold a tag near an antenna: the read count should go up. <strong>{status!.readCount}</strong> reads{status!.antennaIds.length ? ` · antennas ${status!.antennaIds.join(", ")}` : ""}.</p>
          <p className="text-xs text-muted-foreground">Reads are timed whenever a moto or practice is running. Close RM Connect if it's open: a reader accepts only one connection.</p>
        </div>
      )}
    </div>
  );
}

function ActiveConnect({ api, address }: { api: DesktopApi; address: string }) {
  const [status, setStatus] = useState<ActiveStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.activeTransponder.getStatus().then(setStatus).catch(() => {});
    return api.activeTransponder.onStatus(setStatus);
  }, []);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      await api.activeTransponder.connect(address.trim() || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
    } finally {
      setBusy(false);
    }
  }

  const connected = !!status?.connected;
  return (
    <div className="space-y-3">
      {connected ? (
        <Button size="sm" variant="outline" className="h-9" onClick={() => api.activeTransponder.disconnect()}>Disconnect</Button>
      ) : (
        <Button size="sm" className="h-9 gap-1.5" onClick={connect} disabled={busy || !address.trim()}>
          {busy && <Loader2 size={14} className="animate-spin" />} Connect to {address.trim() || "RM TrackR"}
        </Button>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {connected && (
        <div className={`rounded-lg border p-3 text-sm space-y-1 ${status!.ready ? "bg-emerald-500/5 border-emerald-500/30" : "bg-amber-500/5 border-amber-500/30"}`}>
          <p className={`font-semibold flex items-center gap-1.5 ${status!.ready ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}`}>
            {status!.ready ? <CheckCircle2 size={15} /> : <Loader2 size={15} className="animate-spin" />}
            {status!.ready ? `RM TrackR ready at ${status!.deviceIp}` : `Connected to ${status!.deviceIp}, waiting for the loops to start`}
          </p>
          <p className="text-muted-foreground">{status!.diagnosis}</p>
          <p>Pass an RM TrackR Transponder through the loop: <strong>{status!.passingCount}</strong> passings so far. Use the RM TrackR diagnostic below for a full crossing test.</p>
        </div>
      )}
    </div>
  );
}
