import { useEffect, useState } from "react";
import {
  CheckCircle2, Circle, Clock, Globe, Loader2, Pencil, Play, Plus, Radar, RefreshCw, Router, Settings, Square,
  Trash2, WifiOff, XCircle,
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
interface DiscoveredDevice { address: string; port: number; kind: DeviceKind; hostname: string | null; adapter: string; hardware?: RfidHardware | null }
interface ScanResult { devices: DiscoveredDevice[]; scannedHosts: number; skippedAdapters: string[] }
interface RfidNetworkStatus {
  connected: boolean; connecting: boolean; reading: boolean; host: string | null; error: string | null;
  lastReadAt: string | null; readCount: number; antennaIds: number[]; reconnecting: boolean;
}
interface ActiveStatus {
  connected: boolean; state: string; deviceIp: string | null; error: string | null; diagnosis: string;
  passingCount: number; ready: boolean;
  machineId?: string | null; batteryPercent?: number | null;
  activeChannel?: number; activePower?: number; loopEnabled?: [boolean, boolean]; loopsReading?: boolean;
  /** The RM TrackR's own counters and loop telemetry (machineState). */
  totalTagsRead?: number | null; differentTagsRead?: number | null;
  reader1Working?: string | null; reader2Working?: string | null;
}

/** The loop state as the RM TrackR reports it, in words. */
function loopTelemetryText(value: string | null | undefined): string {
  if (value == null || value.trim() === "") return "no report";
  if (/^(1|true|enabled)$/i.test(value.trim()) || /working|running|open/i.test(value)) return "running";
  if (/^(0|false|disabled)$/i.test(value.trim()) || /stop|closed|off/i.test(value)) return "stopped";
  return value;
}

// Several readers at once: each has its own id and name, sent with every read.
type ReaderKind = "rm_trackr" | "rfid";
type ReaderState = "disconnected" | "connecting" | "connected_idle" | "reading" | "testing" | "retrying" | "error";
interface ReaderStatus {
  id: string; name: string; kind: ReaderKind; address: string; hardware: RfidHardware | null; autoConnect: boolean;
  state: ReaderState; connected: boolean; error: string | null; message: string;
  readCount: number; lastReadAt: string | null;
  active: ActiveStatus | null; rfid: RfidNetworkStatus | null;
}
interface ReaderSettings { activeChannel: number; activePower: number; loopEnabled: [boolean, boolean] }
interface ReadersApi {
  list(): Promise<ReaderStatus[]>;
  add(input: { name?: string; kind: ReaderKind; address: string; hardware?: RfidHardware }): Promise<ReaderStatus>;
  update(id: string, changes: { name?: string; address?: string; hardware?: RfidHardware }): Promise<ReaderStatus>;
  remove(id: string): Promise<void>;
  connect(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  startTest(id: string): Promise<void>;
  stopTest(id: string): Promise<void>;
  configure(id: string, settings: ReaderSettings): Promise<void>;
  syncClock(id: string): Promise<void>;
  onStatus(cb: (s: ReaderStatus) => void): () => void;
  onChanged(cb: (list: ReaderStatus[]) => void): () => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);
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
  /** Missing on older desktop builds, which connect one reader of each kind. */
  readers?: ReadersApi;
}

function desktopApi(): DesktopApi | null {
  const api = (window as unknown as { electronAPI?: Partial<DesktopApi> }).electronAPI;
  // Older desktop builds have no network API; the page then keeps its normal flow.
  return api?.network && api.rfidNetwork ? (api as DesktopApi) : null;
}

export function hasOfflineHardwareSupport(): boolean {
  return desktopApi() !== null;
}

/**
 * Desktop app: the reader always connects straight to this computer, with or
 * without internet (RM Connect is only for timing through the website). With
 * internet, results also go live; without it, they upload when it's back.
 */
export function ConnectionModeChooser({ tech }: { tech: Tech }) {
  const api = desktopApi();
  const [internet, setInternet] = useState<boolean | null>(null);

  useEffect(() => {
    if (!api) return;
    api.network.getInfo().then(info => setInternet(info.internet)).catch(() => {});
  }, []);

  if (!api) return null;

  return (
    <>
    <section className="rounded-xl border-2 border-primary/25 bg-card p-5 space-y-4">
      <div>
        <p className="font-heading font-bold uppercase tracking-wider text-sm">2. Connect the reader to this computer</p>
        <p className="text-sm text-muted-foreground mt-1 flex items-start gap-2">
          {internet === null ? <span>Checking this computer's connection…</span>
            : internet
              ? <><Globe size={16} className="mt-0.5 shrink-0 text-green-600" /><span>This computer is online: results go live as riders cross.</span></>
              : <><WifiOff size={16} className="mt-0.5 shrink-0" /><span>This computer has no internet right now. Timing works the same, and results upload when you're back online.</span></>}
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          The reader only needs to share a local network (a router) with this computer. Nothing else to install.
          {api.readers && " Timing with more than one reader (a finish line plus section or split readers)? Add each one here and give it a name."}
        </p>
      </div>
      <OfflineHardwareSetup tech={tech} api={api} />
    </section>
    {api.readers && <ReadersPanel readers={api.readers} />}
    </>
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
  const [info, setInfo] = useState<NetworkInfo | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [address, setAddress] = useState("");
  /** Reader make guessed from the network name of a found device. */
  const [foundHardware, setFoundHardware] = useState<RfidHardware | null>(null);
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
        {/* Every reader (RFID, and the RM TrackR in TCP server mode) only gets an
            address from a router, so a router or switch is required. */}
        <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
          <li><strong className="text-foreground">A router or switch is required.</strong> Any home or travel router works without internet: it still gives every device an address.</li>
          <li>Plug the reader into a LAN port and connect this computer by cable or the router's Wi-Fi.</li>
          <li>A cable straight from this computer to the reader won't work: the reader only gets an address from a router.</li>
          {tech === "rfid" ? (
            <li>Impinj R700 and Zebra readers need Power over Ethernet: use a PoE switch or a PoE injector between the router and the reader.</li>
          ) : (
            <li>On the RM TrackR, open <strong className="text-foreground">Config → Network</strong> and choose TCP server mode. The router gives it an address, shown under <strong className="text-foreground">Config → About</strong>; its first three numbers should match this computer's address in step 2.</li>
          )}
          <li>Wait about a minute after power-up, then scan below.</li>
        </ul>
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
          <p className="text-xs text-amber-700 dark:text-amber-400">This computer has a 169.254 address, so it isn't on a router. Connect it and the reader to a router, then scan.</p>
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
                <Button size="sm" variant="outline" onClick={() => { setAddress(d.address); setFoundHardware(d.hardware ?? null); setCheckResult(null); }}>Use</Button>
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

      {api.readers ? (
        <Step n={4} title="Name it and add it">
          <AddReader readers={api.readers} tech={tech} address={address} suggestedHardware={foundHardware} onAdded={() => { setAddress(""); setFoundHardware(null); setCheckResult(null); }} />
        </Step>
      ) : (
        <Step n={4} title="Connect and test">
          {tech === "rfid"
            ? <RfidConnect api={api} address={address} setAddress={setAddress} />
            : <ActiveConnect api={api} address={address} />}
        </Step>
      )}
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
          <p className="text-xs text-muted-foreground">Reads are timed whenever a moto or practice is running. Close any other program connected to this reader: it accepts only one connection.</p>
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

// ── Several readers at once ───────────────────────────────────────────────────

function AddReader({ readers, tech, address, suggestedHardware, onAdded }: { readers: ReadersApi; tech: Tech; address: string; suggestedHardware?: RfidHardware | null; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [hardware, setHardware] = useState<RfidHardware>("impinj");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // A found Zebra must not be added as an Impinj: it would get Impinj-only
  // commands, fail to connect and keep retrying.
  useEffect(() => { if (suggestedHardware) setHardware(suggestedHardware); }, [suggestedHardware]);

  async function add() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const added = await readers.add({
        name: name.trim() || undefined,
        kind: tech === "rfid" ? "rfid" : "rm_trackr",
        address,
        hardware: tech === "rfid" ? hardware : undefined,
      });
      setName("");
      onAdded();
      try {
        await readers.connect(added.id);
        setNote(`${added.name} is added and connected. It's in the reader list below.`);
      } catch (err) {
        setNote(`${added.name} is added, but it isn't answering yet. This computer keeps trying by itself. (${errorText(err)})`);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Input value={name} onChange={e => setName(e.target.value)} maxLength={60}
          placeholder="Name, e.g. Finish line or Section 3 start" className="h-9 text-sm w-64" />
        {tech === "rfid" && (
          <Select value={hardware} onValueChange={v => setHardware(v as RfidHardware)}>
            <SelectTrigger className="w-48 h-9 bg-background"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="impinj">Impinj (R700, Speedway)</SelectItem>
              <SelectItem value="zebra">Zebra (FX7500, FX9600)</SelectItem>
              <SelectItem value="generic">Other LLRP reader</SelectItem>
            </SelectContent>
          </Select>
        )}
        <Button size="sm" className="h-9 gap-1.5" onClick={add} disabled={busy || !address.trim()}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Add reader{address.trim() ? ` at ${address.trim()}` : ""}
        </Button>
      </div>
      {!address.trim() && <p className="text-xs text-muted-foreground">Pick a reader from the scan or enter its address in step 3 first.</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
      <p className="text-xs text-muted-foreground">
        The name tells you which reader a read came from, so use where it sits on the course. To add another reader, repeat step 3 and add it with its own name.
      </p>
    </div>
  );
}

const STATE_LABEL: Record<ReaderState, string> = {
  connected_idle: "Connected, idle",
  reading: "Reading",
  testing: "Loop test running",
  connecting: "Connecting…",
  retrying: "Not connected, retrying",
  error: "Needs attention",
  disconnected: "Not connected",
};

function stateTone(state: ReaderState): { box: string; text: string } {
  if (state === "connected_idle" || state === "reading") return { box: "bg-emerald-500/5 border-emerald-500/30", text: "text-emerald-700 dark:text-emerald-400" };
  if (state === "error") return { box: "bg-red-500/5 border-red-500/30", text: "text-red-700 dark:text-red-400" };
  if (state === "disconnected") return { box: "bg-muted/20 border-border", text: "text-muted-foreground" };
  return { box: "bg-amber-500/5 border-amber-500/30", text: "text-amber-700 dark:text-amber-400" };
}

function ReadersPanel({ readers }: { readers: ReadersApi }) {
  const [list, setList] = useState<ReaderStatus[] | null>(null);

  useEffect(() => {
    readers.list().then(setList).catch(() => setList([]));
    const offChanged = readers.onChanged(setList);
    const offStatus = readers.onStatus(status => setList(prev => prev ? prev.map(r => (r.id === status.id ? status : r)) : prev));
    return () => { offChanged(); offStatus(); };
  }, []);

  return (
    <section className="rounded-xl border-2 border-primary/25 bg-card p-5 space-y-4">
      <div>
        <p className="font-heading font-bold uppercase tracking-wider text-sm">3. Readers on this computer</p>
        <p className="text-sm text-muted-foreground mt-1">
          Every reader here times at once. Connected readers reconnect by themselves when the app opens, and keep retrying if a cable or the network drops.
        </p>
      </div>
      {list === null ? (
        <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading readers…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No readers yet. Find one above, give it a name, and add it.</p>
      ) : (
        <div className="space-y-3">
          {list.map(reader => <ReaderRow key={reader.id} reader={reader} readers={readers} />)}
        </div>
      )}
    </section>
  );
}

function ReaderRow({ reader, readers }: { reader: ReaderStatus; readers: ReadersApi }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(reader.name);
  const [address, setAddress] = useState(reader.address);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [testStartCount, setTestStartCount] = useState<number | null>(null);

  const tone = stateTone(reader.state);
  const isRmTrackr = reader.kind === "rm_trackr";
  const wanted = reader.state !== "disconnected";
  const testing = reader.state === "testing";
  const testRead = testing && testStartCount !== null && reader.readCount > testStartCount;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    await run(async () => {
      await readers.update(reader.id, {
        name: name.trim(),
        address: address.trim() !== reader.address ? address.trim() : undefined,
      });
      setEditing(false);
    });
  }

  return (
    <div className={`rounded-lg border p-3 space-y-2 ${tone.box}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-sm truncate">{reader.name}</p>
          <p className="text-xs text-muted-foreground">
            {isRmTrackr ? "RM TrackR" : "RFID reader"} · <span className="font-mono">{reader.address}</span>
            {reader.active?.machineId ? <> · ID <span className="font-mono">{reader.active.machineId}</span></> : null}
          </p>
        </div>
        <p className={`text-sm font-semibold flex items-center gap-1.5 ${tone.text}`}>
          {reader.state === "connecting" || reader.state === "retrying" || reader.state === "testing"
            ? <Loader2 size={15} className="animate-spin" />
            : reader.state === "error" ? <XCircle size={15} />
              : reader.state === "disconnected" ? <Circle size={15} />
                : <CheckCircle2 size={15} />}
          {STATE_LABEL[reader.state]}
        </p>
      </div>

      {reader.state !== "disconnected" && (
        <p className={`text-sm ${reader.state === "error" ? "text-red-700 dark:text-red-400" : "text-muted-foreground"}`}>
          {reader.state === "error" ? reader.error ?? reader.message : reader.message}
        </p>
      )}

      {reader.connected && (
        <p className="text-xs text-muted-foreground">
          <strong className="text-foreground tabular-nums">{reader.readCount}</strong> reads
          {reader.lastReadAt ? ` · last at ${new Date(reader.lastReadAt).toLocaleTimeString()}` : ""}
          {isRmTrackr && reader.active?.loopEnabled
            ? ` · loops ${[reader.active.loopEnabled[0] ? "1" : null, reader.active.loopEnabled[1] ? "2" : null].filter(Boolean).join(" and ") || "off"}${reader.active.loopsReading ? ": reading" : ""}`
            : ""}
          {isRmTrackr && reader.active?.batteryPercent != null ? ` · battery ${reader.active.batteryPercent}%` : ""}
          {!isRmTrackr && reader.rfid?.antennaIds.length ? ` · antennas ${reader.rfid.antennaIds.join(", ")}` : ""}
        </p>
      )}

      {/* What the RM TrackR itself reports. If its own count goes up while the reads
          above don't, the reader is seeing transponders but they aren't reaching this
          computer; if neither moves, the loops aren't picking the transponder up. */}
      {reader.connected && isRmTrackr && reader.active && (reader.active.totalTagsRead != null || reader.active.reader1Working != null || reader.active.reader2Working != null) && (
        <p className="text-xs text-muted-foreground">
          Reader reports:
          {reader.active.totalTagsRead != null ? <> <strong className="text-foreground tabular-nums">{reader.active.totalTagsRead}</strong> tags counted</> : null}
          {reader.active.differentTagsRead != null ? ` (${reader.active.differentTagsRead} different)` : ""}
          {reader.active.loopEnabled?.[0] !== false ? ` · loop 1 ${loopTelemetryText(reader.active.reader1Working)}` : ""}
          {reader.active.loopEnabled?.[1] !== false ? ` · loop 2 ${loopTelemetryText(reader.active.reader2Working)}` : ""}
        </p>
      )}

      {testing && (
        <p className={`text-sm font-medium ${testRead ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}`}>
          {testRead ? "Read received. This reader works." : "Pass an RM TrackR Transponder over a loop now…"}
        </p>
      )}

      {editing ? (
        <div className="flex flex-wrap gap-2 pt-1">
          <Input value={name} onChange={e => setName(e.target.value)} maxLength={60} placeholder="Reader name" className="h-9 text-sm w-56" />
          <Input value={address} onChange={e => setAddress(e.target.value)} placeholder="Address" className="h-9 text-sm w-56 font-mono" />
          <Button size="sm" className="h-9" onClick={saveEdit} disabled={busy || !name.trim() || !address.trim()}>Save</Button>
          <Button size="sm" variant="ghost" className="h-9" onClick={() => { setEditing(false); setName(reader.name); setAddress(reader.address); setError(null); }}>Cancel</Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 pt-1">
          {wanted ? (
            <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => run(() => readers.disconnect(reader.id))}>Disconnect</Button>
          ) : (
            // A reader that doesn't answer isn't an error here: the row shows
            // "Not connected, retrying" with the reason while the app keeps trying.
            <Button size="sm" className="h-8 gap-1.5" disabled={busy} onClick={() => run(() => readers.connect(reader.id).catch(() => {}))}>
              {busy && <Loader2 size={14} className="animate-spin" />} Connect
            </Button>
          )}
          {isRmTrackr && reader.connected && (
            testing ? (
              <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={busy}
                onClick={() => run(async () => { await readers.stopTest(reader.id); setTestStartCount(null); })}>
                <Square size={13} /> Stop loop test
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={busy}
                onClick={() => run(async () => { setTestStartCount(reader.readCount); await readers.startTest(reader.id); })}>
                <Play size={13} /> Loop test
              </Button>
            )
          )}
          {isRmTrackr && (
            <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={() => setShowSettings(v => !v)}>
              <Settings size={13} /> Settings
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={() => { setName(reader.name); setAddress(reader.address); setEditing(true); }}>
            <Pencil size={13} /> Rename
          </Button>
          {confirmRemove ? (
            <>
              <Button size="sm" variant="destructive" className="h-8" disabled={busy} onClick={() => run(() => readers.remove(reader.id))}>Remove {reader.name}</Button>
              <Button size="sm" variant="ghost" className="h-8" onClick={() => setConfirmRemove(false)}>Keep</Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={() => setConfirmRemove(true)}>
              <Trash2 size={13} /> Remove
            </Button>
          )}
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {isRmTrackr && showSettings && <RmTrackrSettings reader={reader} readers={readers} />}
    </div>
  );
}

/** Channel, power, enabled loops and clock for one RM TrackR. Saved per reader and applied on every connect. */
function RmTrackrSettings({ reader, readers }: { reader: ReaderStatus; readers: ReadersApi }) {
  const [channel, setChannel] = useState(reader.active?.activeChannel ?? 0);
  const [power, setPower] = useState(String(reader.active?.activePower ?? 100));
  const [loop1, setLoop1] = useState(reader.active?.loopEnabled?.[0] ?? true);
  const [loop2, setLoop2] = useState(reader.active?.loopEnabled?.[1] ?? true);
  const [busy, setBusy] = useState<"apply" | "clock" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const powerNumber = Number(power);
  const powerValid = power.trim() !== "" && Number.isInteger(powerNumber) && powerNumber >= 0 && powerNumber <= 100;
  const identified = reader.connected && !!reader.active?.machineId;

  async function apply() {
    setBusy("apply");
    setResult(null);
    try {
      await readers.configure(reader.id, { activeChannel: channel, activePower: powerNumber, loopEnabled: [loop1, loop2] });
      setResult({ ok: true, message: reader.connected ? "Settings sent to the reader and saved." : "Settings saved. They are sent when the reader connects." });
    } catch (err) {
      setResult({ ok: false, message: errorText(err) });
    } finally {
      setBusy(null);
    }
  }

  async function syncClock() {
    setBusy("clock");
    setResult(null);
    try {
      await readers.syncClock(reader.id);
      setResult({ ok: true, message: "The reader's clock now matches this computer." });
    } catch (err) {
      setResult({ ok: false, message: errorText(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border bg-background/60 p-3 space-y-3">
      <div className="flex flex-wrap items-end gap-4">
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">Channel</span>
          <Select value={String(channel)} onValueChange={v => setChannel(Number(v))}>
            <SelectTrigger className="w-24 h-9 bg-background"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[0, 1, 2, 3, 4, 5].map(n => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">Power (0 to 100)</span>
          <Input type="number" min={0} max={100} step={1} value={power} onChange={e => setPower(e.target.value)} className="h-9 w-24 text-sm" />
        </label>
        <div className="space-y-1">
          <span className="block text-xs text-muted-foreground">Loops in use</span>
          <div className="flex items-center gap-4 h-9 text-sm">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={loop1} onChange={e => setLoop1(e.target.checked)} /> Loop 1</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={loop2} onChange={e => setLoop2(e.target.checked)} /> Loop 2</label>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" className="h-8 gap-1.5" onClick={apply} disabled={busy !== null || !powerValid || (!loop1 && !loop2)}>
          {busy === "apply" && <Loader2 size={14} className="animate-spin" />} Apply settings
        </Button>
        <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={syncClock} disabled={busy !== null || !identified}>
          {busy === "clock" ? <Loader2 size={14} className="animate-spin" /> : <Clock size={13} />} Sync clock
        </Button>
      </div>
      {!powerValid && <p className="text-xs text-amber-700 dark:text-amber-400">Power must be a whole number from 0 to 100.</p>}
      {!loop1 && !loop2 && <p className="text-xs text-amber-700 dark:text-amber-400">Keep at least one loop in use.</p>}
      {result && <p className={`text-sm ${result.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}`}>{result.message}</p>}
      <p className="text-xs text-muted-foreground">
        Readers close to each other should use different channels. The clock is also set every time the reader connects.
        {!identified && " Sync clock needs the reader connected."}
      </p>
    </div>
  );
}
