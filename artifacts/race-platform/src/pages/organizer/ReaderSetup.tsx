import { useState, useEffect } from "react";
import {
  Wifi, Timer, Copy, Check, Send, RefreshCw,
  CheckCircle2, XCircle, Download, Circle, ExternalLink,
  Usb, Trash2, Plus, Radio, Pencil, X, ScanLine, Loader2, MonitorDown, Activity, Battery, AlertCircle, Play, Settings,
  KeyRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListReaders, useCreateReader, useDeleteReader, useUpdateReader, useRotateReaderToken, getListReadersQueryKey,
  useGetConnectorStatus,
  useGetRecentTags, useClearRecentTags, getGetRecentTagsQueryKey,
} from "@workspace/api-client-react";
import { ConnectionModeChooser } from "@/components/organizer/OfflineHardwareSetup";
import { ConnectLaptop } from "@/components/organizer/ConnectLaptop";
import { HandScanners } from "@/components/organizer/HandScanners";

const BASE_URL = window.location.origin;
const PING_ENDPOINT_BASE = `${BASE_URL}/api/timing/ping`;
// Hardware is programmed with a per-reader URL. The token in it identifies the
// reader and its club, so no guessable club ID is needed.
const readerTimingUrl = (token: string) => `${BASE_URL}/api/timing/readers/${token}/active/crossing`;
const readerCheckpointUrl = (token: string) => `${BASE_URL}/api/timing/readers/${token}/crossing`;
const readerPingUrl = (token: string) => `${BASE_URL}/api/timing/readers/${token}/ping`;
type ReaderType   = "impinj-r700" | "zebra-fx7500" | "generic";

interface ActiveTransponderStatus {
  connected: boolean;
  deviceIp: string | null;
  machineId: string | null;
  error: string | null;
  lastPassingAt: string | null;
  passingCount: number;
  lastHeartbeatAt: string | null;
  batteryPercent: number | null;
  reader1Working: string | null;
  reader2Working: string | null;
  loopEnabled?: [boolean, boolean];
  loopsReading?: boolean;
}

/**
 * Loops as set in RM TrackR settings; a transponder pass proves they read.
 * The reader's own loop status isn't used: some firmware reports a loop as
 * 0 (off) while it reads.
 */
type LoopShow = "reading" | "waiting" | "unused";
function loopShows(status: { loopEnabled?: [boolean, boolean]; loopsReading?: boolean }): { l1: LoopShow; l2: LoopShow } {
  const show = (enabled: boolean | undefined): LoopShow => enabled === false ? "unused" : status.loopsReading ? "reading" : "waiting";
  return { l1: show(status.loopEnabled?.[0]), l2: show(status.loopEnabled?.[1]) };
}

// ── RF Configuration (LLRP) ───────────────────────────────────────────────────

interface LlrpRfConfig {
  transmitPowerIndex: number;
  rfModeIndex: number;
  tagPopulation: number;
  tagTransitTime: number;
}

const RF_PRESETS: Record<"raceday" | "dense" | "low", LlrpRfConfig> = {
  // Max power, MaxThroughput mode, small Q (few tags at gate), 500ms dwell
  // — 500ms gives the reader ~3-5 read attempts as a rider passes at race speed
  raceday: { transmitPowerIndex: 81, rfModeIndex: 0, tagPopulation: 4,  tagTransitTime: 500  },
  // Max power still (Dense Reader M8 handles multi-antenna interference via modulation,
  // not by reducing power), Q=8 for a busy start line, 600ms dwell for grouped starts
  dense:   { transmitPowerIndex: 81, rfModeIndex: 3, tagPopulation: 8,  tagTransitTime: 600  },
  // Low power for indoor walk-through testing; longer dwell, small Q
  low:     { transmitPowerIndex: 21, rfModeIndex: 0, tagPopulation: 4,  tagTransitTime: 800  },
};


const StepBadge = ({ n }: { n: number }) => (
  <div className="w-8 h-8 shrink-0 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-heading font-bold text-sm">
    {n}
  </div>
);

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button onClick={copy} className="shrink-0 flex items-center gap-1 rounded border bg-background px-2 py-1.5 text-xs font-medium hover:bg-muted transition-colors">
      {copied ? <Check size={10} className="text-green-500" /> : <Copy size={10} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

const MiniStep = ({ n }: { n: number }) => (
  <div className="w-5 h-5 shrink-0 rounded-full bg-muted border text-xs font-bold flex items-center justify-center mt-0.5">
    {n}
  </div>
);

function ActiveTransponderGuidedSetup({
  isDesktop,
  connectorStatuses,
  readers,
}: {
  isDesktop: boolean;
  connectorStatuses: any[];
  readers: any[];
}) {
  const [address, setAddress] = useState("");
  const [activeStatus, setActiveStatus] = useState<ActiveTransponderStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Test state
  const [testMode, setTestMode] = useState(false);
  const [initialReadCount, setInitialReadCount] = useState<number | null>(null);

  // Desktop activeTransponder hook
  useEffect(() => {
    if (!isDesktop) return;
    const api = (window as any).electronAPI?.activeTransponder;
    if (!api) return;
    api.getStatus().then(setActiveStatus).catch(() => {});
    return api.onStatus(setActiveStatus);
  }, [isDesktop]);

  useEffect(() => {
    const saved = localStorage.getItem("f2000_host");
    const activeReader = readers.find(r => r.type === "active_transponder");
    if (activeReader?.hardwareAddress) {
      setAddress(activeReader.hardwareAddress);
    } else if (saved) {
      setAddress(saved);
    }
  }, [readers]);

  const handleAddressChange = (val: string) => {
    setAddress(val);
    localStorage.setItem("f2000_host", val);
  };

  const connect = async () => {
    if (!isDesktop) return; // browser flow is passive via connectorStatuses
    let finalAddress = address.trim();
    if (!finalAddress) return;
    if (!finalAddress.includes(":")) finalAddress += ":55555";

    setAddress(finalAddress);
    localStorage.setItem("f2000_host", finalAddress);

    setConnecting(true);
    setConnectError(null);
    try {
      await (window as any).electronAPI.activeTransponder.connect(finalAddress);
      setActiveStatus(await (window as any).electronAPI.activeTransponder.getStatus());
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : "Could not connect to the RM TrackR.");
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    if (!isDesktop) return;
    await (window as any).electronAPI.activeTransponder.disconnect();
    setActiveStatus(await (window as any).electronAPI.activeTransponder.getStatus());
    setConnectError(null);
    setTestMode(false);
  };

  const toggleTest = async () => {
    if (testMode) {
      // stop
      if (isDesktop && (window as any).electronAPI.activeTransponder.stopTest) {
        try { await (window as any).electronAPI.activeTransponder.stopTest(); } catch {}
      }
      setTestMode(false);
      setInitialReadCount(null);
    } else {
      // start
      const currentReads = isDesktop ? activeStatus?.passingCount ?? 0 : activeConnector?.hardware.readCount ?? 0;
      setInitialReadCount(currentReads);
      if (isDesktop && (window as any).electronAPI.activeTransponder.startTest) {
        try { await (window as any).electronAPI.activeTransponder.startTest(); } catch {}
      }
      setTestMode(true);
    }
  };

  const activeConnector = !isDesktop ? connectorStatuses.find(c => c.readerType === "active_transponder") : null;

  // Desktop configuration state
  const [activeChannel, setActiveChannel] = useState(0);
  const [activePower, setActivePower] = useState(100);
  const [loop1Enabled, setLoop1Enabled] = useState(true);
  const [loop2Enabled, setLoop2Enabled] = useState(true);
  const [applyingConfig, setApplyingConfig] = useState(false);
  const [syncingClock, setSyncingClock] = useState(false);

  // When status comes in with config properties (ready, configApplied, loopsReady), read them if possible.
  // The backend might not parse them into activeStatus yet, so we will use activeStatus direct if present.
  let isConfigApplied = false;
  let isLoopsReady = false;
  let isReady = false;

  if (isDesktop && activeStatus) {
    // If the API was updated to provide these:
    if ((activeStatus as any).configApplied) isConfigApplied = true;
    if ((activeStatus as any).loopsReady) isLoopsReady = true;
    if ((activeStatus as any).ready) isReady = true;
  } else if (!isDesktop && activeConnector) {
    // RM Connect reports readiness as a flag; its detail is plain text.
    if (activeConnector.hardware.ready) isConfigApplied = isLoopsReady = isReady = true;
  }

  const applyConfig = async () => {
    if (!isDesktop || !isConnected) return;
    setApplyingConfig(true);
    try {
      const api = (window as any).electronAPI?.activeTransponder;
      if (api?.configure) {
        await api.configure({
          activeChannel,
          activePower,
          loopEnabled: [loop1Enabled, loop2Enabled],
        });
      }
    } catch {}
    setApplyingConfig(false);
  };

  const syncClock = async () => {
    if (!isDesktop || !isConnected) return;
    setSyncingClock(true);
    try {
      const api = (window as any).electronAPI?.activeTransponder;
      if (api?.syncClock) {
        await api.syncClock();
      }
    } catch {}
    setSyncingClock(false);
  };


  let isConnected = false;
  let hasError = false;
  let readCount = 0;
  let heartbeat: string | null = null;
  let loops: { l1: LoopShow; l2: LoopShow } | null = null;
  let battery: number | null = null;
  let errorMsg = connectError;
  let machineId: string | null = null;

  if (isDesktop && activeStatus) {
    isConnected = activeStatus.connected;
    hasError = !!activeStatus.error;
    if (activeStatus.error && !errorMsg) errorMsg = activeStatus.error;
    readCount = activeStatus.passingCount;
    heartbeat = activeStatus.lastHeartbeatAt;
    battery = activeStatus.batteryPercent;
    machineId = activeStatus.machineId;
    if (activeStatus.connected) loops = loopShows(activeStatus);
  } else if (!isDesktop && activeConnector) {
    isConnected = activeConnector.hardware.connected;
    readCount = activeConnector.hardware.readCount;
    if (!isConnected && activeConnector.hardware.detail) {
      hasError = true;
      errorMsg = activeConnector.hardware.detail;
    }
  }

  const testPassed = testMode && initialReadCount != null && readCount > initialReadCount;

  return (
    <div className="space-y-8 mt-6">
      <div className="rounded-xl border-2 border-primary/20 bg-card overflow-hidden">
        <div className="px-5 py-4 bg-primary/5 border-b border-primary/10 flex items-center gap-3">
          <Activity className="text-primary shrink-0" size={24} />
          <div>
            <h3 className="font-heading font-bold uppercase tracking-wider text-sm">RM TrackR Setup</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Guided pre-flight checklist for Active Timing Reader setup.</p>
          </div>
        </div>

        <div className="p-5 space-y-8">
          {/* Step 1: Network & Address */}
          <div className="flex gap-4">
            <StepBadge n={1} />
            <div className="space-y-3 min-w-0 flex-1">
              <div>
                <p className="font-semibold text-sm">Network & Address</p>
                <p className="text-xs text-muted-foreground">
                  Connect this computer and the RM TrackR to the same network router (wired or wireless).
                </p>
              </div>

              <div className="flex flex-col sm:flex-row gap-2 max-w-md">
                <Input
                  value={address}
                  onChange={e => handleAddressChange(e.target.value)}
                  placeholder="e.g. 192.168.1.50 or 192.168.1.50:55555"
                  className="font-mono bg-background"
                  disabled={connecting || isConnected || !isDesktop}
                />
                {isDesktop && (
                  isConnected ? (
                    <Button variant="outline" onClick={disconnect}>Disconnect</Button>
                  ) : (
                    <Button onClick={connect} disabled={connecting || !address.trim()}>
                      {connecting ? <Loader2 size={14} className="animate-spin mr-2" /> : null}
                      Connect
                    </Button>
                  )
                )}
              </div>

              {!isDesktop && (
                <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
                  You are using the cloud platform. On the track laptop, open <strong className="text-foreground">RM Connect</strong>, select the Active Timing Reader, and enter this IP to bridge the connection.
                </div>
              )}
            </div>
          </div>

          {/* Step 2: Connection Status */}
          <div className="flex gap-4">
            <StepBadge n={2} />
            <div className="space-y-3 min-w-0 flex-1">
              <div>
                <p className="font-semibold text-sm">TCP Connection & Machine Identity</p>
                <p className="text-xs text-muted-foreground">
                  The software connects to port 55555 and listens for heartbeats and loop status.
                </p>
              </div>

              <div className={`rounded-xl border-2 p-4 transition-all ${
                isConnected && !hasError ? "border-green-500/40 bg-green-500/5" :
                hasError ? "border-red-500/40 bg-red-500/5" :
                connecting ? "border-amber-500/40 bg-amber-500/5" :
                "border-border bg-muted/20"
              }`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      {isConnected && !hasError ? <CheckCircle2 size={16} className="text-green-600" /> :
                       hasError ? <XCircle size={16} className="text-red-600" /> :
                       connecting ? <Loader2 size={16} className="text-amber-600 animate-spin" /> :
                       <Circle size={16} className="text-muted-foreground" />}

                      <p className={`font-semibold text-sm ${
                        isConnected && !hasError ? "text-green-700 dark:text-green-400" :
                        hasError ? "text-red-700 dark:text-red-400" :
                        connecting ? "text-amber-700 dark:text-amber-400" :
                        "text-muted-foreground"
                      }`}>
                        {isConnected && !hasError ? "Connected & Active" :
                         hasError ? "Connection Error" :
                         connecting ? "Connecting..." :
                         "Disconnected"}
                      </p>
                    </div>
                    {errorMsg && (
                      <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                        {errorMsg} — Verify the IP, port 55555, and ensure no other software is connected.
                      </p>
                    )}
                  </div>

                  {isConnected && (
                    <div className="text-right text-xs space-y-1 opacity-80">
                      {machineId && <p>ID: <strong className="font-mono">{machineId}</strong></p>}
                      {heartbeat && <p>Last beat: {new Date(heartbeat).toLocaleTimeString()}</p>}
                    </div>
                  )}
                </div>

                {isConnected && (
                  <div className="mt-4 pt-4 border-t flex gap-6 text-xs">
                    <div>
                      <p className="text-muted-foreground mb-1">Power / Battery</p>
                      <p className="font-medium flex items-center gap-1.5">
                        <Battery size={14} className={battery != null && battery < 20 ? "text-red-500" : "text-green-500"} />
                        {battery != null ? `${battery}%` : "AC Power"}
                      </p>
                    </div>
                    <div>
                         <p className="text-muted-foreground mb-1">Finish-gate coverage loops</p>
                      <div className="flex items-center gap-3 font-medium">
                        {(["l1", "l2"] as const).map((key, i) => {
                          const show = loops?.[key] ?? "waiting";
                          return (
                            <span key={key} className={show === "reading" ? "text-green-600" : "text-muted-foreground"}>
                              Loop {i + 1}{show === "reading" ? ": reading" : show === "unused" ? ": not used" : ": on, waiting for a pass"}
                            </span>
                          );
                        })}
                      </div>
                         <p className="text-[11px] text-muted-foreground mt-1">
                           Both loops cover the same finish gate; either loop reports the same crossing.
                         </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground mb-1">Read Count</p>
                      <p className="font-medium font-mono">{readCount}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Step 3: Website-managed settings */}
          <div className="flex gap-4">
            <StepBadge n={3} />
            <div className="space-y-2 min-w-0 flex-1">
              <p className="font-semibold text-sm">Device settings come from Reader Setup</p>
              <p className="text-xs text-muted-foreground">
                Active channel, power, enabled loops, and clock sync are saved in the website above. RM Connect applies them automatically whenever it connects to this reader.
              </p>
              {isConnected && (
                <p className="text-xs font-medium text-green-700 dark:text-green-400">
                  Connection is live — website settings can be sent to the reader now.
                </p>
              )}
            </div>
          </div>


          {/* Step 4: End-to-End Test */}
          <div className="flex gap-4">
            <StepBadge n={4} />
            <div className="space-y-3 min-w-0 flex-1">
              <div>
                <p className="font-semibold text-sm">Real Crossing Test</p>
                <p className="text-xs text-muted-foreground">
                  Put the system into test mode and walk an RM TrackR Transponder across the loop.
                  The test succeeds when the read count goes up.
                </p>
              </div>

              <div className="flex items-center gap-4">
                <Button
                  onClick={toggleTest}
                  disabled={!isConnected}
                  variant={testMode ? (testPassed ? "default" : "secondary") : "outline"}
                  className={`font-heading uppercase tracking-wider ${
                    testPassed ? "bg-green-600 hover:bg-green-700 text-white" :
                    testMode ? "bg-amber-100 hover:bg-amber-200 text-amber-900 border-amber-300 dark:bg-amber-900/30 dark:text-amber-100" : ""
                  }`}
                >
                  {testPassed ? <CheckCircle2 size={16} className="mr-2" /> : testMode ? <Loader2 size={16} className="mr-2 animate-spin" /> : <Play size={16} className="mr-2" />}
                  {testPassed ? "Test Successful" : testMode ? "Waiting for crossing..." : "Start System Test"}
                </Button>

                {testMode && !testPassed && (
                  <p className="text-xs text-amber-700 dark:text-amber-400 animate-pulse font-medium">
                    Walk a tag over the loop now...
                  </p>
                )}
                {testPassed && (
                  <p className="text-xs text-green-700 dark:text-green-400 font-medium">
                    Crossing received! End-to-end connection verified.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


export default function ReaderSetup() {
  const { toast } = useToast();
  const { user } = useAuth();

  const isDesktop = typeof (window as any).electronAPI !== "undefined";

  const openSerialSettings = () =>
    window.dispatchEvent(new CustomEvent("rm-open-serial-settings"));

  const queryClient = useQueryClient();

  // ── Registered readers ──
  // ── Identify mode: poll the readers list so lastSeenAt refreshes ──
  const [identifying, setIdentifying] = useState(false);
  const { data: allReaders = [] } = useListReaders({
    query: { refetchInterval: identifying ? 1500 : 10_000 } as any,
  });
  // Hand scanners have their own section (HandScanners); everything here runs through RM Connect.
  const readers = (allReaders as any[]).filter(r => r.connection !== "hand_scanner");
  // The timing URL card shows the URL of one RFID reader (the first by default).
  const rfidReaders = (readers as any[]).filter(r => r.type === "rfid");
  const [urlReaderId, setUrlReaderId] = useState<number | null>(null);
  const urlReader = rfidReaders.find(r => r.id === urlReaderId) ?? rfidReaders[0] ?? null;
  const facilityEndpoint: string | null = urlReader ? readerTimingUrl(urlReader.token) : null;
  // RM Connect live status — refresh every 10s so the card stays current
  const { data: connectorStatuses = [] } = useGetConnectorStatus({
    query: { refetchInterval: 10_000 } as any,
  });
  // Live tag scanner — poll every 2s while enabled
  const [scannerOn, setScannerOn] = useState(false);
  const { data: recentTags = [] } = useGetRecentTags({
    query: { refetchInterval: scannerOn ? 2000 : false, enabled: scannerOn } as any,
  });
  const clearTagsMutation = useClearRecentTags({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetRecentTagsQueryKey() }),
    } as any,
  });
  // Until /api/config/connector-release answers, link to the releases page
  // rather than a pinned version that goes stale.
  const RELEASES_PAGE = "https://github.com/tnelson933/RMMX-Tracker/releases";
  const [connectorDl, setConnectorDl] = useState({ macArm: RELEASES_PAGE, macX64: RELEASES_PAGE, windows: RELEASES_PAGE });
  useEffect(() => {
    fetch("/api/config/connector-release")
      .then(r => r.ok ? r.json() : null)
      .then((data: { macArm: string; macX64: string; windows: string } | null) => {
        if (data?.macArm) setConnectorDl({ macArm: data.macArm, macX64: data.macX64, windows: data.windows });
      })
      .catch(() => {});
  }, []);
  const createReaderMutation = useCreateReader();
  const deleteReaderMutation = useDeleteReader();
  const updateReaderMutation = useUpdateReader();
  const rotateReaderMutation = useRotateReaderToken();
  const [newReaderName, setNewReaderName] = useState("");
  const [newReaderType, setNewReaderType] = useState<"rfid" | "active_transponder">("rfid");
  const [newReaderAddress, setNewReaderAddress] = useState("");
  const [showAddReader, setShowAddReader] = useState(false);

  // Inline edit
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editAddress, setEditAddress] = useState("");

  // Identify reader — snapshot each reader's lastSeenAt when we start, then
  // detect which reader's value *changes* (avoids any client/server clock comparison).
  const [identifyBaseline, setIdentifyBaseline] = useState<Record<number, string | null>>({});
  const [identifiedId, setIdentifiedId] = useState<number | null>(null);

  function startIdentify() {
    setIdentifiedId(null);
    const baseline: Record<number, string | null> = {};
    for (const r of readers as any[]) baseline[r.id] = r.lastSeenAt ?? null;
    setIdentifyBaseline(baseline);
    setIdentifying(true);
    // Refetch immediately so the interval isn't the only trigger.
    queryClient.invalidateQueries({ queryKey: getListReadersQueryKey() });
  }
  function stopIdentify() {
    setIdentifying(false);
  }

  // While identifying, watch for any reader whose lastSeenAt differs from its
  // baseline. If several changed, pick the one with the most recent timestamp.
  useEffect(() => {
    if (!identifying) return;
    const changed = (readers as any[]).filter(
      r => r.lastSeenAt && r.lastSeenAt !== (identifyBaseline[r.id] ?? null),
    );
    if (changed.length === 0) return;
    const hit = changed.reduce((latest, r) =>
      new Date(r.lastSeenAt).getTime() > new Date(latest.lastSeenAt).getTime() ? r : latest,
    );
    setIdentifiedId(hit.id);
    setIdentifying(false);
    toast({ title: "Reader identified", description: `That scan came from “${hit.name}”.` });
  }, [readers, identifying, identifyBaseline, toast]);

  // Safety timeout — stop listening after 60s with no scan.
  useEffect(() => {
    if (!identifying) return;
    const id = setTimeout(() => {
      setIdentifying(false);
      toast({ title: "No scan detected", description: "Identify timed out — try again.", variant: "destructive" });
    }, 60_000);
    return () => clearTimeout(id);
  }, [identifying, toast]);

  function beginEdit(reader: any) {
    setEditingId(reader.id);
    setEditName(reader.name);
    setEditAddress(reader.hardwareAddress ?? "");
  }

  async function handleSaveReader(readerId: number) {
    const name = editName.trim();
    if (!name) return;
    const hardwareAddress = editAddress.trim() || null;
    try {
      await updateReaderMutation.mutateAsync({ readerId, data: { name, hardwareAddress } as any });
      queryClient.invalidateQueries({ queryKey: getListReadersQueryKey() });
      setEditingId(null);
      toast({ title: "Reader updated" });
    } catch {
      toast({ title: "Failed to update reader", variant: "destructive" });
    }
  }

  async function handleAddReader() {
    const name = newReaderName.trim() || (newReaderType === "active_transponder" ? "RM TrackR Reader" : "");
    if (!name || (newReaderType === "active_transponder" && !newReaderAddress.trim())) return;
    const hardwareAddress = newReaderAddress.trim() || undefined;
    try {
      await createReaderMutation.mutateAsync({ data: { name, type: newReaderType, hardwareAddress } as any });
      queryClient.invalidateQueries({ queryKey: getListReadersQueryKey() });
      setNewReaderName("");
      setNewReaderAddress("");
      setShowAddReader(false);
      toast({ title: "Reader registered" });
    } catch {
      toast({ title: "Failed to register reader", variant: "destructive" });
    }
  }

  async function handleDeleteReader(readerId: number) {
    try {
      await deleteReaderMutation.mutateAsync({ readerId });
      queryClient.invalidateQueries({ queryKey: getListReadersQueryKey() });
    } catch {
      toast({ title: "Failed to remove reader", variant: "destructive" });
    }
  }

  async function handleRotateReader(reader: { id: number; name: string }) {
    const confirmed = window.confirm(
      `Issue a new URL and token for "${reader.name}"?\n\n` +
      "The current URL and token stop working immediately. Reprogram the reader " +
      "with the new URL, and re-select the reader in RM Connect.",
    );
    if (!confirmed) return;
    try {
      await rotateReaderMutation.mutateAsync({ readerId: reader.id });
      queryClient.invalidateQueries({ queryKey: getListReadersQueryKey() });
      toast({ title: "New reader URL issued", description: "Update the reader and RM Connect with the new URL." });
    } catch {
      toast({ title: "Failed to issue a new URL", variant: "destructive" });
    }
  }

  function lastSeenLabel(lastSeenAt: string | null | undefined): { text: string; live: boolean } {
    if (!lastSeenAt) return { text: "Never seen", live: false };
    const diffMs = Date.now() - new Date(lastSeenAt).getTime();
    if (diffMs < 60_000) return { text: `${Math.round(diffMs / 1000)}s ago`, live: true };
    if (diffMs < 3_600_000) return { text: `${Math.round(diffMs / 60_000)}m ago`, live: diffMs < 300_000 };
    return { text: new Date(lastSeenAt).toLocaleTimeString(), live: false };
  }

  // ── RF config (LLRP antenna tuning) ─────────────────────────────────────────
  const [rfPreset,   setRfPreset]   = useState<"raceday" | "dense" | "low" | "custom">("raceday");
  const [rfConfig,   setRfConfig]   = useState<LlrpRfConfig>(RF_PRESETS.raceday);
  const [rfApplying, setRfApplying] = useState(false);
  const [rfResult,   setRfResult]   = useState<{ ok: boolean; message: string } | null>(null);

  async function applyRfConfig() {
    setRfApplying(true);
    setRfResult(null);
    try {
      const res = await fetch(`${BASE_URL}/api/readers/llrp-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rfConfig),
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setRfResult({ ok: false, message: data.error ?? "Failed to apply" });
      } else {
        const sent: number = data.sent ?? 0;
        setRfResult({
          ok: true,
          message: sent > 0
            ? `Applied to ${sent} connected reader${sent !== 1 ? "s" : ""}.`
            : "Settings saved. Will apply when RM Connect connects.",
        });
      }
    } catch {
      setRfResult({ ok: false, message: "Network error — check server connection." });
    } finally {
      setRfApplying(false);
    }
  }

  const [tech,       setTech]       = useState<"rfid" | "active_transponder">("rfid");
  const [readerType, setReaderType] = useState<ReaderType>("impinj-r700");
  const [readerIp,   setReaderIp]   = useState("");
  const [readerMac,  setReaderMac]  = useState("");
  const [activeConfigReaderId, setActiveConfigReaderId] = useState<number | null>(null);
  // Reader whose RM TrackR settings panel is open in the reader list.
  const [settingsReaderId, setSettingsReaderId] = useState<number | null>(null);
  const [activeTimingConfig, setActiveTimingConfig] = useState({ channel: 0, power: 100, loop1Enabled: true, loop2Enabled: true });
  const [activeTimingConfigSaving, setActiveTimingConfigSaving] = useState(false);
  const [activeTimingConfigResult, setActiveTimingConfigResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    const activeReaders = (readers as any[]).filter(reader => reader.type === "active_transponder");
    if (!activeReaders.length) {
      setActiveConfigReaderId(null);
      return;
    }
    const selected = activeReaders.find(reader => reader.id === activeConfigReaderId) ?? activeReaders[0];
    if (selected.id !== activeConfigReaderId) {
      setActiveConfigReaderId(selected.id);
      const saved = selected.activeTimingConfig;
      setActiveTimingConfig({
        channel: saved?.channel ?? 0,
        power: saved?.power ?? 100,
        loop1Enabled: saved?.loop1Enabled !== false,
        loop2Enabled: saved?.loop2Enabled !== false,
      });
    }
  }, [readers, activeConfigReaderId]);

  const selectActiveTimingReader = (readerId: number) => {
    const reader = (readers as any[]).find(item => item.id === readerId);
    if (!reader) return;
    setActiveConfigReaderId(readerId);
    const saved = reader.activeTimingConfig;
    setActiveTimingConfig({
      channel: saved?.channel ?? 0,
      power: saved?.power ?? 100,
      loop1Enabled: saved?.loop1Enabled !== false,
      loop2Enabled: saved?.loop2Enabled !== false,
    });
    setActiveTimingConfigResult(null);
  };

  const saveActiveTimingConfig = async (syncClock = false) => {
    if (!activeConfigReaderId) return;
    setActiveTimingConfigSaving(true);
    setActiveTimingConfigResult(null);
    try {
      const response = await fetch(`${BASE_URL}/api/readers/${activeConfigReaderId}/active-timing-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ config: activeTimingConfig, syncClock }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Unable to save Active Timing Reader settings.");
      queryClient.invalidateQueries({ queryKey: getListReadersQueryKey() });
      setActiveTimingConfigResult({
        ok: true,
        message: result.sent > 0
          ? `Saved and sent to RM Connect${syncClock ? "; the reader clock is syncing." : "."}`
          : "Saved. RM Connect will receive these settings as soon as it reconnects.",
      });
    } catch (error) {
      setActiveTimingConfigResult({ ok: false, message: error instanceof Error ? error.message : "Unable to save Active Timing Reader settings." });
    } finally {
      setActiveTimingConfigSaving(false);
    }
  };

  const [copiedUrl,       setCopiedUrl]       = useState(false);
  const [copiedManualUrl, setCopiedManualUrl] = useState(false);

  // The packaged desktop app connects directly to the F2000 for offline timing.
  const [activeStatus, setActiveStatus] = useState<ActiveTransponderStatus | null>(null);
  const [activeConnecting, setActiveConnecting] = useState(false);
  const [activeConnectError, setActiveConnectError] = useState<string | null>(null);

  useEffect(() => {
    if (!isDesktop || tech !== "active_transponder") return;
    const api = (window as any).electronAPI?.activeTransponder;
    if (!api) return;
    api.getStatus().then(setActiveStatus).catch(() => {});
    return api.onStatus(setActiveStatus);
  }, [isDesktop, tech]);

  async function connectActiveTransponder() {
    const address = readerIp.trim();
    if (!address) return;
    setActiveConnecting(true);
    setActiveConnectError(null);
    try {
      await (window as any).electronAPI.activeTransponder.connect(address);
      setActiveStatus(await (window as any).electronAPI.activeTransponder.getStatus());
    } catch (error) {
      setActiveConnectError(error instanceof Error ? error.message : "Could not connect to the RM TrackR.");
    } finally {
      setActiveConnecting(false);
    }
  }

  async function disconnectActiveTransponder() {
    await (window as any).electronAPI.activeTransponder.disconnect();
    setActiveStatus(await (window as any).electronAPI.activeTransponder.getStatus());
    setActiveConnectError(null);
  }

  // Test crossing
  const [os,          setOs]          = useState<"windows" | "mac">("windows");
  const [testValue,   setTestValue]   = useState("");
  const [testResult,  setTestResult]  = useState<{ ok: boolean; message: string } | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  // Test the selected reader's own URL when there is one; otherwise fall back to
  // the signed-in club ping (active timing tests and clubs with no RFID reader yet).
  const pingEndpoint = tech === "rfid" && urlReader
    ? readerPingUrl(urlReader.token)
    : user?.clubId ? `${PING_ENDPOINT_BASE}?clubId=${user.clubId}` : null;

  const sendTest = async () => {
    if (!testValue || !pingEndpoint) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      const body = tech === "active_transponder"
        ? { transponder: testValue, passingTime: new Date().toISOString() }
        : { rfidNumber: testValue };
      const res = await fetch(pingEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setTestResult({ ok: true, message: `Server received tag "${data.received}" — your reader is connected.` });
        toast({ title: "✅ Connected!" });
      } else {
        const msg = data.error ?? "Server did not accept the ping";
        setTestResult({ ok: false, message: msg });
        toast({ title: "Connection failed", description: msg, variant: "destructive" });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Could not reach the server";
      setTestResult({ ok: false, message: msg });
      toast({ title: "Connection failed", description: msg, variant: "destructive" });
    } finally {
      setTestLoading(false);
    }
  };

  const copyUrl       = () => { if (!facilityEndpoint) return; navigator.clipboard.writeText(facilityEndpoint); setCopiedUrl(true);       setTimeout(() => setCopiedUrl(false),       2000); };
  const copyManualUrl = () => { if (!facilityEndpoint) return; navigator.clipboard.writeText(facilityEndpoint); setCopiedManualUrl(true); setTimeout(() => setCopiedManualUrl(false), 2000); };

  const manualReaderUrl =
    readerType === "impinj-r700"  ? `https://${readerIp || "READER_IP"}` :
    readerType === "zebra-fx7500" ? `http://${readerIp || "READER_IP"}:8080` :
                                    `http://${readerIp || "READER_IP"}`;

  // Derive the impinj-XX-XX-XX.local mDNS URL from the last 6 MAC hex digits
  const macLocalUrl = (() => {
    const hex = readerMac.replace(/[^0-9a-fA-F]/g, "");
    if (hex.length < 6) return null;
    const last6 = hex.slice(-6);
    const parts = [last6.slice(0, 2), last6.slice(2, 4), last6.slice(4, 6)];
    return `http://impinj-${parts.join("-").toUpperCase()}.local`;
  })();

  const urlCopyButton = (
    <button onClick={copyManualUrl} className="shrink-0 flex items-center gap-1 rounded border bg-background px-2 py-1.5 text-xs font-medium hover:bg-muted transition-colors">
      {copiedManualUrl ? <Check size={10} className="text-green-500" /> : <Copy size={10} />}
      {copiedManualUrl ? "Copied" : "Copy"}
    </button>
  );

  const urlField = facilityEndpoint ? (
    <div className="flex items-center gap-2">
      <code className="flex-1 font-mono text-xs bg-background border rounded px-2.5 py-1.5 break-all text-primary">{facilityEndpoint}</code>
      {urlCopyButton}
    </div>
  ) : (
    <p className="text-xs text-amber-600">Register this reader in step 2 first. Its timing URL appears here.</p>
  );

  type Row = { step: number; label: string; content: React.ReactNode };

  const manualRows: Row[] =
    readerType === "impinj-r700" ? [
      { step: 1, label: "Open the reader's web interface",
        content: (
          <div className="space-y-1.5">
            <a href={manualReaderUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-mono text-xs text-primary underline underline-offset-2 break-all">
              {manualReaderUrl} <ExternalLink size={11} />
            </a>
            <p className="text-xs text-muted-foreground">Default login: username <strong className="text-foreground font-mono">root</strong> · password <strong className="text-foreground font-mono">impinj</strong></p>
          </div>
        ) },
      { step: 2, label: "Set the Operating Region (first time only)",
        content: <span className="text-xs text-muted-foreground">On the Home page, if <strong className="text-foreground">Operating Region</strong> shows <strong className="text-red-600 dark:text-red-400">None — RFID Disabled</strong>, click <strong className="text-foreground">Change Region</strong>, select <strong className="text-foreground">FCC</strong> (USA), click <strong className="text-foreground">Save</strong>, then click <strong className="text-foreground">Reboot</strong> and wait for it to come back online. Skip this step if a region is already set.</span> },
      { step: 3, label: "Create and start a Profile Preset",
        content: (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              Click <strong className="text-foreground">Profile Presets</strong> in the top navigation. Click <strong className="text-foreground">New</strong> (or select an existing preset).
            </p>
            <p className="text-xs text-muted-foreground font-medium text-foreground">Under Antenna Configurations, set each antenna port:</p>
            <ul className="text-xs text-muted-foreground space-y-0.5 pl-3 list-disc">
              <li>Enable <strong className="text-foreground">Antenna Port 1</strong> (and Port 2 if you have a second antenna)</li>
              <li>Set <strong className="text-foreground">Transmit Power</strong> to <strong className="text-foreground">3000 cdBm</strong> for maximum read range</li>
              <li>Set <strong className="text-foreground">Population Estimate</strong> to <strong className="text-foreground">32</strong> for a start/finish gate where many riders may pass at once (holeshot). Use <strong className="text-foreground">8</strong> for an interior timing gate where riders typically pass 1–3 at a time. This tells the reader how many tags to expect simultaneously — too low causes missed reads when riders bunch up, too high wastes inventory time.</li>
              <li>Set <strong className="text-foreground">Session</strong> to <strong className="text-foreground">2</strong> — keeps tag state persistent across inventory rounds so the same transponder can be read on every lap</li>
              <li>Set <strong className="text-foreground">Search Mode</strong> to <strong className="text-foreground">Dual Target</strong> (not Single Target) — Single Target only reads each tag once per cycle; Dual Target captures the transponder every time a rider passes the gate</li>
              <li>Set <strong className="text-foreground">FastID</strong> to <strong className="text-foreground">Enabled</strong> — embeds the tag's TID in the response without a separate memory read, giving faster reads on fast-moving riders</li>
            </ul>
            <p className="text-xs text-muted-foreground">Click <strong className="text-foreground">Save</strong>, then click the <strong className="text-foreground">Start</strong> button on the preset. The reader must have an active preset running or it won't send any reads.</p>
          </div>
        ) },
      { step: 4, label: "Configure the Webhook",
        content: (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Click <strong className="text-foreground">Event Reporting</strong> in the top navigation → <strong className="text-foreground">Webhook</strong> tab.</p>
            <ul className="text-xs text-muted-foreground space-y-0.5 pl-3 list-disc">
              <li>Check <strong className="text-foreground">Enable Webhook Output</strong></li>
              <li>Paste the timing URL below into <strong className="text-foreground">Server URL</strong></li>
              <li>Leave <strong className="text-foreground">Port</strong> blank</li>
              <li>Leave <strong className="text-foreground">Verify TLS</strong> unchecked</li>
            </ul>
            <div className="pt-1">{urlField}</div>
            <p className="text-xs text-muted-foreground">Click <strong className="text-foreground">Save</strong>. The reader starts sending tag reads immediately. This setting is saved permanently — you only need to do this once.</p>
          </div>
        ) },
    ] : readerType === "zebra-fx7500" ? [
      { step: 1, label: "Open the reader's web interface",
        content: <a href={manualReaderUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-mono text-xs text-primary underline underline-offset-2 break-all">{manualReaderUrl} <ExternalLink size={11} /></a> },
      { step: 2, label: "Log in",
        content: <span className="text-xs text-muted-foreground">Username <strong className="text-foreground font-mono">admin</strong> · Password <strong className="text-foreground font-mono">change#me</strong> (Zebra factory default — update if you changed it)</span> },
      { step: 3, label: "Navigate to IoT Connector",
        content: <span className="text-xs text-muted-foreground">In the top menu choose <strong className="text-foreground">IoT Connector</strong>, then click <strong className="text-foreground">Add Profile</strong>.</span> },
      { step: 4, label: "Set the HTTP output URL",
        content: <div className="space-y-1.5"><p className="text-xs text-muted-foreground">Under <strong className="text-foreground">HTTP Output</strong>, enable it and paste:</p>{urlField}</div> },
      { step: 5, label: "Set method and header",
        content: <span className="text-xs text-muted-foreground">Method: <strong className="text-foreground">POST</strong> · Add header <strong className="text-foreground font-mono">Content-Type: application/json</strong></span> },
      { step: 6, label: "Save and start the profile",
        content: <span className="text-xs text-muted-foreground">Click <strong className="text-foreground">Save</strong> then <strong className="text-foreground">Start</strong>. The reader starts sending laps immediately.</span> },
    ] : [
      { step: 1, label: "Open your reader's web interface",
        content: <span className="text-xs text-muted-foreground">In a browser on the same network, navigate to <strong className="text-foreground font-mono">{manualReaderUrl}</strong> or the IP shown on the reader's display.</span> },
      { step: 2, label: "Find the HTTP output settings",
        content: <span className="text-xs text-muted-foreground">Look for settings labelled <strong className="text-foreground">HTTP Output</strong>, <strong className="text-foreground">Webhook</strong>, <strong className="text-foreground">IoT Connector</strong>, or <strong className="text-foreground">Tag Event Action</strong>. Enable it.</span> },
      { step: 3, label: "Enter the timing URL",
        content: <div className="space-y-1.5"><p className="text-xs text-muted-foreground">Paste this URL into the destination / endpoint field:</p>{urlField}</div> },
      { step: 4, label: "Set method and content type",
        content: <span className="text-xs text-muted-foreground">Method: <strong className="text-foreground">POST</strong> · Header: <strong className="text-foreground font-mono">Content-Type: application/json</strong>. Payload format varies by reader — check your reader's manual if needed.</span> },
      { step: 5, label: "Save",
        content: <span className="text-xs text-muted-foreground">Save the settings. The reader will begin forwarding tag reads immediately.</span> },
    ];

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-8">

      {/* Header */}
      <div>
        <h1 className="text-3xl font-heading font-bold uppercase tracking-tight">Reader Setup</h1>
        <p className="text-muted-foreground mt-1">
          RM Connect finds your RFID readers and RM TrackR readers at the track, adds them here, and keeps them connected.
        </p>
      </div>

      {/* The desktop app can also time with no internet; that path picks the system first. */}
      {isDesktop && (
        <section className="rounded-xl border-2 border-primary/25 bg-card p-5 space-y-4">
          <div>
            <p className="font-heading font-bold uppercase tracking-wider text-sm">1. Choose your timing system</p>
            <p className="text-sm text-muted-foreground mt-1">Used by the no-internet setup below.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              onClick={() => { setTech("rfid"); setNewReaderType("rfid"); setTestResult(null); }}
              className={`flex items-center gap-3 rounded-xl border-2 p-4 text-left transition-all ${tech === "rfid" ? "border-primary bg-primary/5 shadow-sm" : "border-border hover:border-primary/40"}`}
            >
              <Wifi size={22} className={tech === "rfid" ? "text-primary" : "text-muted-foreground"} />
              <div>
                <p className="font-semibold">RFID</p>
                <p className="text-xs text-muted-foreground mt-0.5">Sticker tags read by an Impinj, Zebra, or compatible RFID reader.</p>
              </div>
            </button>
            <button
              onClick={() => { setTech("active_transponder"); setNewReaderType("active_transponder"); setTestResult(null); }}
              className={`flex items-center gap-3 rounded-xl border-2 p-4 text-left transition-all ${tech === "active_transponder" ? "border-primary bg-primary/5 shadow-sm" : "border-border hover:border-primary/40"}`}
            >
              <Timer size={22} className={tech === "active_transponder" ? "text-primary" : "text-muted-foreground"} />
              <div>
                <p className="font-semibold">RM TrackR</p>
                <p className="text-xs text-muted-foreground mt-0.5">RM TrackR reader with RM TrackR Transponders.</p>
              </div>
            </button>
          </div>
        </section>
      )}
      {isDesktop && <ConnectionModeChooser tech={tech} />}

      {/* The desktop app connects to the RM TrackR itself (it never uses RM Connect). */}
      {isDesktop && tech === "active_transponder" && (
        <details className="rounded-xl border bg-card overflow-hidden">
          <summary className="cursor-pointer list-none px-5 py-4 flex items-center gap-3 hover:bg-muted/30 transition-colors">
            <Activity size={18} className="text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <p className="font-heading font-bold uppercase tracking-wider text-sm">RM TrackR diagnostic</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Connect this computer to the RM TrackR directly, check loop status, and run an RM TrackR Transponder crossing test.
              </p>
            </div>
          </summary>
          <div className="border-t px-5 pb-5">
            <ActiveTransponderGuidedSetup
              isDesktop={isDesktop}
              connectorStatuses={connectorStatuses}
              readers={readers}
            />
          </div>
        </details>
      )}

      {/* ── RM Connect: the one place readers are set up ── */}
      <section className="rounded-xl border-2 border-primary/25 bg-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <MonitorDown size={18} className="text-primary" />
          <h2 className="font-heading font-bold uppercase tracking-tight text-lg">Set up with RM Connect</h2>
        </div>
        <div className="space-y-2 text-sm">
          <div className="flex gap-2"><MiniStep n={1} /><p>Install RM Connect on the laptop you take to the track.</p></div>
          <div className="flex gap-2"><MiniStep n={2} /><p>{isDesktop
            ? <>On the RM Roost website, open <strong>Reader Setup</strong> and click <strong>Get a pairing code</strong>, then type the 6-digit code into RM Connect. No password is needed on the laptop.</>
            : <>Click <strong>Get a pairing code</strong> below and type the 6-digit code into RM Connect. No password is needed on the laptop.</>}</p></div>
          <div className="flex gap-2"><MiniStep n={3} /><p>Power on your readers and connect them and the laptop to the same router or network switch (any home or travel router works; no internet needed). A cable straight from the laptop to a reader won't work: readers only get an address from a router. Click <strong>Find readers</strong>. RM Connect lists every reader it finds; name each one after where it sits (for example "Finish line" or "Section 3 start") and click <strong>Add</strong>. Click <strong>Test</strong> and pass a tag or transponder to check it.</p></div>
        </div>
        <p className="text-xs text-muted-foreground">
          One laptop can run several readers. Leave RM Connect running on race day: readers start and stop with each moto, and reconnect on their own if the network drops.
        </p>
        {!isDesktop && <ConnectLaptop />}
        <div className="flex flex-wrap gap-2">
          <a href={connectorDl.windows} title="Windows 10/11">
            <Button size="sm" className="font-heading uppercase tracking-wider gap-1.5 h-8 px-4 text-xs">
              <Download size={13} /> Windows
            </Button>
          </a>
          <a href={connectorDl.macArm} title="macOS Apple Silicon (M1 and newer)">
            <Button variant="outline" size="sm" className="font-heading uppercase tracking-wider gap-1.5 h-8 px-4 text-xs">
              <Download size={13} /> Mac (Apple Silicon)
            </Button>
          </a>
          <a href={connectorDl.macX64} title="macOS Intel">
            <Button variant="outline" size="sm" className="font-heading uppercase tracking-wider gap-1.5 h-8 px-4 text-xs">
              <Download size={13} /> Mac (Intel)
            </Button>
          </a>
        </div>
        <details className="rounded-lg border bg-muted/30 p-3 text-sm">
          <summary className="cursor-pointer font-semibold">Reader not showing up in RM Connect?</summary>
          <div className="mt-3 space-y-3 text-muted-foreground">
            <div>
              <p className="font-semibold text-foreground">RM TrackR</p>
              <ul className="list-disc ml-5 mt-1 space-y-0.5">
                <li>Make sure it's powered on and plugged into the same router as the laptop (or cabled straight to the laptop).</li>
                <li>On the RM TrackR, open <strong>Config → Network</strong> and choose <strong>TCP mode</strong>. Its address is under <strong>Config → About</strong>; you can type it into RM Connect under "Or enter the reader's address".</li>
                <li>Close any other timing software connected to it, then click <strong>Search again</strong>.</li>
              </ul>
            </div>
            <div>
              <p className="font-semibold text-foreground">RFID readers (Impinj, Zebra)</p>
              <ul className="list-disc ml-5 mt-1 space-y-0.5">
                <li><strong>Impinj R700</strong>: open the reader's web page (<span className="font-mono text-xs">http://impinj-xx-xx-xx.local</span>, the last 6 characters of the MAC on its label), log in, change <strong>RFID interface</strong> to <strong>LLRP</strong>, and reboot when prompted.</li>
                <li><strong>Zebra FX7500 / FX9600</strong>: LLRP is on from the factory. If it was changed, set the operating mode back to <strong>LLRP</strong> on the reader's web page.</li>
                <li>Only one program can talk to a reader at a time. Close ItemTest or other reader software first.</li>
              </ul>
            </div>
          </div>
        </details>
      </section>

      {/* ── Readers ── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="font-heading font-bold uppercase tracking-tight text-lg">Your readers</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Live status from RM Connect. Rename a reader after where it sits on the course.</p>
          </div>
          <div className="flex items-center gap-2">
            {(readers as any[]).length > 0 && (
              identifying ? (
                <Button size="sm" variant="secondary" onClick={stopIdentify} className="gap-1.5">
                  <Loader2 size={13} className="animate-spin" /> Listening… Cancel
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={startIdentify} className="gap-1.5">
                  <ScanLine size={13} /> Identify reader
                </Button>
              )
            )}
          </div>
        </div>

        {identifying && (
          <div className="rounded-lg border-2 border-primary/50 bg-primary/5 p-4 flex items-center gap-3">
            <ScanLine size={18} className="text-primary shrink-0 animate-pulse" />
            <p className="text-sm">
              <strong>Listening…</strong> Pass a tag or transponder by one of your readers while a moto or practice is running. The reader that sees it is highlighted below.
            </p>
          </div>
        )}

        {(readers as any[]).length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No readers yet. Click <strong>Find readers</strong> in RM Connect and they appear here.
          </div>
        ) : (
          <div className="rounded-xl border overflow-hidden divide-y">
            {(readers as any[]).map((reader: any) => {
              const { text: lsText } = lastSeenLabel(reader.lastSeenAt);
              const connector = (connectorStatuses as any[]).find((c: any) => c.readerId === reader.id);
              const isActive = reader.type === "active_transponder";
              const isEditing = editingId === reader.id;
              const isIdentified = identifiedId === reader.id;
              const showSettings = isActive && settingsReaderId === reader.id;
              const hw = connector?.hardware;
              const live = !!hw?.connected;
              const ready = live && (hw?.ready ?? !isActive);
              const statusText = !connector
                ? `RM Connect isn't running for this reader${reader.lastSeenAt ? ` · last read ${lsText}` : ""}`
                : !live
                  ? `RM Connect is running but can't reach the reader${hw?.detail ? ` — ${hw.detail}` : ""}`
                  : ready
                    ? `Ready${hw?.readCount ? ` · ${hw.readCount} reads` : ""}${hw?.antennaIds?.length ? ` · antennas ${hw.antennaIds.join(", ")}` : ""}`
                    : `Connected, starting up${hw?.detail ? ` — ${hw.detail}` : ""}`;
              return (
                <div
                  key={reader.id}
                  className={`p-4 space-y-3 transition-colors ${isIdentified ? "bg-primary/10 ring-2 ring-inset ring-primary" : ""}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2.5 min-w-0 flex-1">
                      <span className={`w-2.5 h-2.5 rounded-full shrink-0 mt-1.5 ${ready ? "bg-green-500" : live || connector ? "bg-amber-500" : "bg-muted-foreground/40"}`} />
                      <div className="min-w-0 flex-1">
                        {isEditing ? (
                          <div className="flex items-center gap-2">
                            <Input
                              value={editName}
                              onChange={e => setEditName(e.target.value)}
                              className="h-8 flex-1"
                              autoFocus
                              placeholder="Reader name"
                              onKeyDown={e => {
                                if (e.key === "Enter") handleSaveReader(reader.id);
                                if (e.key === "Escape") setEditingId(null);
                              }}
                            />
                            <Button size="sm" className="h-8" onClick={() => handleSaveReader(reader.id)} disabled={updateReaderMutation.isPending || !editName.trim()}>
                              {updateReaderMutation.isPending ? "Saving…" : "Save"}
                            </Button>
                            <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => setEditingId(null)} title="Cancel">
                              <X size={14} />
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-semibold text-sm truncate">{reader.name}</p>
                            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground bg-muted rounded px-1.5 py-0.5">
                              {isActive ? "RM TrackR" : hw?.kind === "impinj" ? "Impinj R700" : hw?.kind === "zebra" ? "Zebra" : "RFID"}
                            </span>
                            {isIdentified && (
                              <span className="text-[10px] font-bold uppercase tracking-wider text-primary bg-primary/15 rounded px-1.5 py-0.5">This one</span>
                            )}
                          </div>
                        )}
                        <p className="text-xs text-muted-foreground mt-1">
                          {reader.hardwareAddress && <span className="font-mono mr-1.5">{reader.hardwareAddress}</span>}
                          {statusText}
                        </p>
                      </div>
                    </div>
                    {!isEditing && (
                      <div className="flex items-center gap-1 shrink-0">
                        {isActive && (
                          <button
                            onClick={() => { if (showSettings) setSettingsReaderId(null); else { selectActiveTimingReader(reader.id); setSettingsReaderId(reader.id); } }}
                            className={`transition-colors p-1 rounded ${showSettings ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}
                            title="RM TrackR settings"
                          >
                            <Settings size={14} />
                          </button>
                        )}
                        <button onClick={() => beginEdit(reader)} className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded" title="Rename reader">
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() => handleRotateReader(reader)}
                          disabled={rotateReaderMutation.isPending}
                          className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
                          title="Issue a new token (RM Connect must add this reader again)"
                        >
                          <KeyRound size={14} />
                        </button>
                        <button
                          onClick={() => { if (window.confirm(`Remove "${reader.name}"? RM Connect stops sending its reads.`)) handleDeleteReader(reader.id); }}
                          className="text-muted-foreground hover:text-destructive transition-colors p-1 rounded"
                          title="Remove reader"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    )}
                  </div>

                  {showSettings && (
                    <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
                      <p className="text-xs text-muted-foreground">
                        The defaults (channel 0, power 100, both loops on) suit most tracks. Changes are sent to RM Connect right away.
                      </p>
                      <div className="grid grid-cols-2 gap-3 max-w-sm">
                        <div className="space-y-1.5">
                          <Label className="text-xs text-muted-foreground">Channel (0–5)</Label>
                          <Input type="number" min={0} max={5} value={activeTimingConfig.channel} onChange={event => setActiveTimingConfig(config => ({ ...config, channel: Number(event.target.value) }))} />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs text-muted-foreground">Power (0–100)</Label>
                          <Input type="number" min={0} max={100} value={activeTimingConfig.power} onChange={event => setActiveTimingConfig(config => ({ ...config, power: Number(event.target.value) }))} />
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-4">
                        <label className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" checked={activeTimingConfig.loop1Enabled} onChange={event => setActiveTimingConfig(config => ({ ...config, loop1Enabled: event.target.checked }))} /> Loop 1</label>
                        <label className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" checked={activeTimingConfig.loop2Enabled} onChange={event => setActiveTimingConfig(config => ({ ...config, loop2Enabled: event.target.checked }))} /> Loop 2</label>
                      </div>
                      <p className="text-[11px] text-muted-foreground">Both loops sit at the same timing line, so either one records a crossing.</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" onClick={() => saveActiveTimingConfig(false)} disabled={activeTimingConfigSaving} className="gap-2">
                          {activeTimingConfigSaving ? <Loader2 size={14} className="animate-spin" /> : <Settings size={14} />}
                          Save & send to RM Connect
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => saveActiveTimingConfig(true)} disabled={activeTimingConfigSaving}>
                          Sync reader clock
                        </Button>
                      </div>
                      {activeTimingConfigResult && (
                        <p className={`text-xs ${activeTimingConfigResult.ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>{activeTimingConfigResult.message}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Live Tag Scanner ── */}
      <div className="rounded-xl border-2 p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <ScanLine size={18} className="text-primary" />
              <h2 className="font-heading font-bold uppercase tracking-tight text-lg">Live Tag Scanner</h2>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Read a tag or transponder number so you can assign it to a rider. Turn the scanner on, pass it by
              a reader, and its number appears below. Tags already assigned to a rider show the rider's name.
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            {scannerOn && (recentTags as any[]).length > 0 && (
              <Button
                variant="ghost" size="sm"
                className="h-8 px-3 text-xs font-heading uppercase tracking-wider"
                onClick={() => clearTagsMutation.mutate()}
              >
                <Trash2 size={13} className="mr-1" /> Clear
              </Button>
            )}
            <Button
              variant={scannerOn ? "default" : "outline"} size="sm"
              className="h-8 px-4 text-xs font-heading uppercase tracking-wider"
              onClick={() => setScannerOn(v => !v)}
            >
              {scannerOn ? <><Loader2 size={13} className="mr-1.5 animate-spin" /> Scanning…</> : <><ScanLine size={13} className="mr-1.5" /> Start Scanning</>}
            </Button>
          </div>
        </div>

        {scannerOn && (
          (recentTags as any[]).length > 0 ? (
            <div className="rounded-lg border divide-y">
              {(recentTags as any[]).map((t: any) => (
                <div key={t.rfidNumber} className="flex items-center gap-3 p-3">
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${t.riderId ? "bg-green-500" : "bg-blue-500 animate-pulse"}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-mono font-semibold truncate">{t.rfidNumber}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.riderName ? `Assigned to ${t.riderName}` : "Not assigned to any rider"}
                      {" · "}{t.count} read{t.count === 1 ? "" : "s"}
                    </p>
                  </div>
                  <CopyButton text={t.rfidNumber} />
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 size={14} className="animate-spin shrink-0" />
              Waiting for tag reads… make sure RM Connect (or your reader) is connected, then hold a tag near an antenna.
            </div>
          )
        )}

        {scannerOn && (recentTags as any[]).some((t: any) => !t.riderId) && (
          <p className="text-xs text-muted-foreground">
            To assign an unassigned tag: copy its number, open the rider's profile under <strong>Riders</strong>, and paste it
            into the RFID number field. Practice sessions and races only count tags assigned to a rider.
          </p>
        )}
      </div>

      {/* Hand scanners post over their own cellular or Wi-Fi, to the cloud */}
      {!isDesktop && <HandScanners />}

      {/* ── Advanced: what most clubs never need ── */}
      <details className="rounded-xl border bg-card overflow-hidden">
        <summary className="cursor-pointer list-none px-5 py-4 flex items-center gap-3 hover:bg-muted/30 transition-colors">
          <Settings size={18} className="text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <p className="font-heading font-bold uppercase tracking-wider text-sm">Advanced</p>
            <p className="text-xs text-muted-foreground mt-0.5">Add a reader by hand, RFID signal settings, and readers that send reads without RM Connect.</p>
          </div>
        </summary>
        <div className="border-t p-5 space-y-8">
          {/* Add a reader by hand */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-heading font-bold uppercase tracking-wider text-sm">Add a reader by hand</p>
                <p className="text-xs text-muted-foreground mt-0.5">RM Connect adds readers for you. Use this only for a reader that sends reads on its own (below).</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => setShowAddReader(v => !v)} className="gap-1.5 shrink-0">
                <Plus size={13} /> Add reader
              </Button>
            </div>
            {showAddReader && (
              <div className="rounded-lg border p-4 space-y-3 bg-muted/20">
                <div className="flex gap-2 flex-wrap">
                  <Input
                    value={newReaderName}
                    onChange={e => setNewReaderName(e.target.value)}
                    placeholder='Name, e.g. "Finish line"'
                    className="h-9 flex-1 min-w-36"
                    onKeyDown={e => e.key === "Enter" && handleAddReader()}
                  />
                  <Select value={newReaderType} onValueChange={v => setNewReaderType(v as "rfid" | "active_transponder")}>
                    <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="rfid">RFID reader</SelectItem>
                      <SelectItem value="active_transponder">RM TrackR</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    value={newReaderAddress}
                    onChange={e => setNewReaderAddress(e.target.value)}
                    placeholder={newReaderType === "active_transponder" ? "RM TrackR IP address" : "IP address or last 6 of MAC"}
                    className="h-9 flex-1 min-w-48 font-mono text-xs"
                    onKeyDown={e => e.key === "Enter" && handleAddReader()}
                  />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleAddReader} disabled={createReaderMutation.isPending || (newReaderType === "active_transponder" ? !newReaderAddress.trim() : !newReaderName.trim())}>
                    {createReaderMutation.isPending ? "Adding…" : "Add"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setShowAddReader(false); setNewReaderName(""); setNewReaderAddress(""); }}>Cancel</Button>
                </div>
              </div>
            )}
          </div>

          {/* Readers that post reads to RM Roost themselves */}
          <div className="space-y-4">
            <div>
              <p className="font-heading font-bold uppercase tracking-wider text-sm">RFID reader without RM Connect</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                An RFID reader with internet access can send reads straight to RM Roost. Program its timing URL once on the reader's own web page.
                Don't also set up the same reader in RM Connect.
              </p>
            </div>
            <div className="rounded-xl border-2 border-primary/40 bg-primary/5 p-5 space-y-3">
              <div>
                <p className="font-heading font-bold uppercase tracking-wider text-sm">Your Timing URL</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Each reader has its own URL. Program it into that reader once. It automatically routes to whichever moto or practice is running.
                </p>
              </div>
              {urlReader ? (
                <>
                  {rfidReaders.length > 1 && (
                    <div className="flex items-center gap-2">
                      <Label className="text-xs shrink-0">Reader</Label>
                      <Select value={String(urlReader.id)} onValueChange={v => setUrlReaderId(Number(v))}>
                        <SelectTrigger className="h-8 w-full sm:w-64 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {rfidReaders.map(r => <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <code className="flex-1 font-mono text-xs bg-background border rounded-lg px-3 py-2.5 truncate text-primary">
                      {facilityEndpoint}
                    </code>
                    <button onClick={copyUrl} className="shrink-0 flex items-center gap-1.5 rounded-lg border bg-background px-3 py-2.5 text-xs font-medium hover:bg-muted transition-colors">
                      {copiedUrl ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
                      {copiedUrl ? "Copied" : "Copy"}
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Register your reader in step 2 below. Its timing URL appears here.
                </p>
              )}
            </div>
          <div className="border rounded-xl bg-card overflow-hidden divide-y">
            <div className="px-5 py-3 bg-muted/30 border-b">
              <p className="font-heading font-bold uppercase tracking-wider text-sm">Set up the reader to send reads</p>
            </div>

              <>
                {/* Step 1 */}
                <div className="flex gap-4 p-5">
                  <StepBadge n={1} />
                  <div className="space-y-2 min-w-0">
                    <p className="font-semibold">Attach a tag to each rider</p>
                    <p className="text-sm text-muted-foreground">
                      Stick an RFID tag on each rider's helmet, chest protector, or bike. Then go to{" "}
                      <strong className="text-foreground">Riders</strong> in the sidebar, open each rider's profile, and enter the tag number printed on the sticker.
                    </p>
                    <p className="text-xs bg-muted/60 border rounded-md px-3 py-2">
                      <strong>Tip:</strong> Your reader's Tag Streaming page shows live reads with the exact tag ID — use it to copy and paste tag numbers accurately.
                    </p>
                  </div>
                </div>

                {/* Step 2 */}
                <div className="flex gap-4 p-5">
                  <StepBadge n={2} />
                  <div className="space-y-4 min-w-0 w-full">
                    <div>
                      <p className="font-semibold">Configure your reader</p>
                      <p className="text-sm text-muted-foreground mt-1">
                        Select your reader model, then follow the steps to set it up through its own web interface. This only needs to be done once — settings are saved on the reader.
                      </p>
                    </div>

                    {/* Reader type selector */}
                    <div className="space-y-1.5">
                      <p className="text-xs text-muted-foreground">Reader model:</p>
                      <div className="flex flex-wrap gap-2">
                        {(["impinj-r700", "zebra-fx7500", "generic"] as const).map(rt => (
                          <button key={rt} onClick={() => setReaderType(rt)}
                            className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${readerType === rt ? "border-primary bg-primary/10 text-primary" : "border-border hover:border-primary/40"}`}>
                            {rt === "impinj-r700" ? "Impinj R700" : rt === "zebra-fx7500" ? "Zebra FX7500" : "Other / Generic"}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* IP / MAC fields */}
                    {readerType !== "generic" && (
                      <div className="space-y-3">
                        {/* R700 MAC address helper */}
                        {readerType === "impinj-r700" && (
                          <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                            <p className="text-xs font-semibold text-foreground">Open your reader by MAC address</p>
                            <p className="text-xs text-muted-foreground">Enter your reader's MAC address (printed on the label on the bottom of the unit) to get a direct link — no IP lookup needed.</p>
                            <div className="flex items-center gap-2">
                              <Input
                                value={readerMac}
                                onChange={e => setReaderMac(e.target.value)}
                                placeholder="e.g. AA:BB:CC:DD:EE:FF"
                                className="font-mono h-9 text-sm max-w-xs"
                              />
                              {macLocalUrl ? (
                                <a
                                  href={macLocalUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1.5 shrink-0 rounded-md border bg-background px-3 py-2 text-xs font-mono font-medium text-primary hover:bg-muted transition-colors"
                                >
                                  {macLocalUrl} <ExternalLink size={11} />
                                </a>
                              ) : (
                                <span className="text-xs text-muted-foreground font-mono">http://impinj-XX-XX-XX.local</span>
                              )}
                            </div>
                          </div>
                        )}
                        <div className="space-y-1.5">
                          <label className="text-xs text-muted-foreground">
                            Reader's IP address <span className="text-muted-foreground/60">(shown on the reader's screen, or check your router's connected-devices list)</span>
                          </label>
                          <Input value={readerIp} onChange={e => setReaderIp(e.target.value)}
                            placeholder="e.g. 192.168.1.50" className="font-mono h-9 text-sm max-w-xs" />
                        </div>
                      </div>
                    )}

                    {/* Step-by-step instructions */}
                    <div className="border rounded-lg divide-y overflow-hidden">
                      {manualRows.map(({ step, label, content }) => (
                        <div key={step} className="flex gap-3 px-4 py-3">
                          <MiniStep n={step} />
                          <div className="space-y-1.5 min-w-0 w-full">
                            <p className="text-sm font-medium">{label}</p>
                            <div>{content}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Step 3 */}
                <div className="flex gap-4 p-5">
                  <StepBadge n={3} />
                  <div className="space-y-2 min-w-0">
                    <p className="font-semibold">Test before race day</p>
                    <p className="text-sm text-muted-foreground">
                      Use the test tool below — enter any tag number and confirm the server receives it. No moto needs to be running.
                    </p>
                  </div>
                </div>
              </>
          </div>
          <div className="border rounded-xl bg-card overflow-hidden">
            <div className="px-5 py-3 bg-muted/30 border-b">
              <p className="font-heading font-bold uppercase tracking-wider text-sm">Test Your Connection</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                No moto needed — just enter a tag number and confirm the server receives it.
              </p>
            </div>
            <div className="p-5 space-y-4">
              <div className="flex gap-3 items-end max-w-sm">
                <div className="flex-1 space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    "Tag number (hex)"
                  </label>
                  <Input value={testValue} onChange={e => setTestValue(e.target.value)}
                    placeholder="e.g. 1A2B3C4D"
                    className="font-mono h-10"
                    onKeyDown={e => { if (e.key === "Enter") sendTest(); }} />
                </div>
                <Button onClick={sendTest} disabled={testLoading || !testValue.trim() || !pingEndpoint}
                  className="font-heading uppercase tracking-wider h-10 px-5 gap-2 shrink-0">
                  {testLoading ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />}
                  {testLoading ? "Sending…" : "Test"}
                </Button>
              </div>

              {testResult && (
                <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${testResult.ok ? "bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800" : "bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800"}`}>
                  {testResult.ok
                    ? <CheckCircle2 size={18} className="text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
                    : <XCircle size={18} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />}
                  <div>
                    <p className={`font-semibold text-sm ${testResult.ok ? "text-green-700 dark:text-green-300" : "text-red-700 dark:text-red-300"}`}>
                      {testResult.ok ? "Working!" : "Not working"}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">{testResult.message}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
          </div>

          {/* RFID signal settings */}
            <div className="border rounded-xl bg-card overflow-hidden">
              <div className="px-5 py-3 bg-muted/30 border-b">
                <p className="font-heading font-bold uppercase tracking-wider text-sm">Reader Signal Settings</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Control how your RFID reader scans for tags at the timing gate. Sent live to RM Connect when you click Apply.
                </p>
              </div>
              <div className="p-5 space-y-5">

                {/* Quick presets */}
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">Starting Points</p>
                  <div className="flex gap-2 flex-wrap">
                    {(["raceday", "dense", "low"] as const).map(key => {
                      const labels: Record<string, string> = {
                        raceday: "Race Day",
                        dense:   "Crowded Start Gate",
                        low:     "Bench Testing",
                      };
                      const descs: Record<string, string> = {
                        raceday: "Full power, fastest scanning — best for a single finish line or timing gate",
                        dense:   "Use when you have multiple readers close together or many riders crossing at once",
                        low:     "Short range — for walking a tag past the antenna slowly while setting up",
                      };
                      return (
                        <button key={key}
                          title={descs[key]}
                          onClick={() => { setRfPreset(key); setRfConfig(RF_PRESETS[key]); setRfResult(null); }}
                          className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors ${
                            rfPreset === key
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-muted/40 border-border hover:border-primary/40"
                          }`}>
                          {labels[key]}
                        </button>
                      );
                    })}
                    {rfPreset === "custom" && (
                      <span className="px-3 py-1.5 rounded-lg border text-xs font-semibold bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-700 text-amber-700 dark:text-amber-300">
                        Custom
                      </span>
                    )}
                  </div>
                </div>

                {/* Controls grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">

                  {/* Signal Strength */}
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <label className="text-xs font-medium">Signal Strength</label>
                      <span className="text-xs font-semibold text-muted-foreground">
                        {rfConfig.transmitPowerIndex <= 21 ? "Low"
                          : rfConfig.transmitPowerIndex <= 41 ? "Medium"
                          : rfConfig.transmitPowerIndex <= 61 ? "High"
                          : "Maximum"}
                      </span>
                    </div>
                    <input type="range" min={1} max={81} step={1}
                      value={rfConfig.transmitPowerIndex}
                      onChange={e => {
                        setRfConfig(c => ({ ...c, transmitPowerIndex: Number(e.target.value) }));
                        setRfPreset("custom");
                        setRfResult(null);
                      }}
                      className="w-full accent-primary" />
                    <div className="flex justify-between text-[10px] text-muted-foreground">
                      <span>Low — short range</span><span>Maximum — widest read zone</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Higher signal = wider read zone around the antenna. For outdoor timing gates, keep this at Maximum. Only turn it down if your reader is picking up tags from areas you don't want (e.g. the pits).
                    </p>
                  </div>

                  {/* Gate Crossing Time */}
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <label className="text-xs font-medium">Gate Crossing Time</label>
                      <span className="text-xs font-semibold text-muted-foreground">
                        {rfConfig.tagTransitTime < 1000
                          ? `${rfConfig.tagTransitTime} ms`
                          : `${(rfConfig.tagTransitTime / 1000).toFixed(1)} s`}
                      </span>
                    </div>
                    <input type="range" min={100} max={2000} step={50}
                      value={rfConfig.tagTransitTime}
                      onChange={e => {
                        setRfConfig(c => ({ ...c, tagTransitTime: Number(e.target.value) }));
                        setRfPreset("custom");
                        setRfResult(null);
                      }}
                      className="w-full accent-primary" />
                    <div className="flex justify-between text-[10px] text-muted-foreground">
                      <span>Very fast (100ms)</span><span>Slow walk-through (2s)</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      How long a rider is in range of the antenna as they pass. The reader uses this to decide how many times to try reading a tag. At race speed, 400–600ms is the sweet spot — long enough to catch every rider, short enough to not confuse back-to-back crossings.
                    </p>
                  </div>

                  {/* Scanning Mode */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">Scanning Mode</label>
                    <Select value={String(rfConfig.rfModeIndex)}
                      onValueChange={v => {
                        setRfConfig(c => ({ ...c, rfModeIndex: Number(v) }));
                        setRfPreset("custom");
                        setRfResult(null);
                      }}>
                      <SelectTrigger className="h-9 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">Speed Mode — reads as fast as possible</SelectItem>
                        <SelectItem value="1">Balanced — speed and reliability</SelectItem>
                        <SelectItem value="2">Multi-Reader (light) — 2–3 readers at same venue</SelectItem>
                        <SelectItem value="3">Multi-Reader (full) — 4+ readers at same venue</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Speed Mode is best if you have one timing gate. If you're running multiple readers at the same venue (start, finish, and checkpoints), switch to a Multi-Reader mode — it prevents the readers from stepping on each other's signals.
                    </p>
                  </div>

                  {/* Riders at Gate */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">Riders Expected at Gate</label>
                    <Select value={String(rfConfig.tagPopulation)}
                      onValueChange={v => {
                        setRfConfig(c => ({ ...c, tagPopulation: Number(v) }));
                        setRfPreset("custom");
                        setRfResult(null);
                      }}>
                      <SelectTrigger className="h-9 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">1 — riders come through one at a time</SelectItem>
                        <SelectItem value="2">2 — up to 2 riders at once</SelectItem>
                        <SelectItem value="4">4 — up to 4 riders at once</SelectItem>
                        <SelectItem value="8">8 — busy gate, up to 8 riders</SelectItem>
                        <SelectItem value="16">16 — mass start or very crowded gate</SelectItem>
                        <SelectItem value="32">32 — large mass start</SelectItem>
                        <SelectItem value="64">64 — very large group start</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      How many riders the reader expects to see at the gate at the same time. Matching this to reality makes the reader faster and more accurate — a lower number is quicker for single-file finish lines; a higher number is needed so no one gets missed in a pack.
                    </p>
                  </div>

                </div>

                {/* Apply button + result */}
                <div className="flex items-center gap-3 pt-1 flex-wrap">
                  <Button onClick={applyRfConfig} disabled={rfApplying}
                    className="font-heading uppercase tracking-wider h-9 px-5 gap-2 text-xs shrink-0">
                    {rfApplying
                      ? <RefreshCw size={13} className="animate-spin" />
                      : <Radio size={13} />}
                    {rfApplying ? "Applying…" : "Apply to Reader"}
                  </Button>
                  {rfResult && (
                    <div className={`flex items-center gap-2 text-xs ${rfResult.ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                      {rfResult.ok
                        ? <CheckCircle2 size={14} />
                        : <XCircle size={14} />}
                      {rfResult.message}
                    </div>
                  )}
                </div>

              </div>
            </div>


          {isDesktop && (
            <div className="border rounded-xl bg-card overflow-hidden">
              <div className="px-5 py-3 bg-muted/30 border-b">
                <p className="font-heading font-bold uppercase tracking-wider text-sm">USB / Serial Reader</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Using a USB or serial-port RFID reader connected directly to this computer?
                </p>
              </div>
              <div className="p-5">
                <Button variant="outline" className="gap-2" onClick={openSerialSettings}>
                  <Usb size={16} /> Open Serial Port Settings
                </Button>
              </div>
            </div>
          )}
        </div>
      </details>

    </div>
  );
}
