import { useState, useEffect } from "react";
import {
  Wifi, Timer, Copy, Check, Send, RefreshCw,
  CheckCircle2, XCircle, Download, Circle, ExternalLink,
  Usb, Trash2, Plus, Radio, Pencil, X, ScanLine, Loader2, MonitorDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListReaders, useCreateReader, useDeleteReader, useUpdateReader, getListReadersQueryKey,
  useGetConnectorStatus,
} from "@workspace/api-client-react";

const BASE_URL = window.location.origin;
const FACILITY_ENDPOINT_BASE = `${BASE_URL}/api/timing/active/crossing`;
const PING_ENDPOINT_BASE = `${BASE_URL}/api/timing/ping`;
const BRIDGE_URL = "http://localhost:5555";

type BridgeStatus = "checking" | "running" | "offline";
type ReaderType   = "impinj-r700" | "zebra-fx7500" | "generic";

interface MyLapsStatus {
  connected: boolean;
  decoderIp: string | null;
  error: string | null;
  lastPassingAt: string | null;
  passingCount: number;
}

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

export default function ReaderSetup() {
  const { toast } = useToast();
  const { user } = useAuth();

  const isDesktop = typeof (window as any).electronAPI !== "undefined";

  const openSerialSettings = () =>
    window.dispatchEvent(new CustomEvent("rm-open-serial-settings"));

  const facilityEndpoint = user?.clubId
    ? `${FACILITY_ENDPOINT_BASE}?clubId=${user.clubId}`
    : `${FACILITY_ENDPOINT_BASE}?clubId=YOUR_CLUB_ID`;

  const pingEndpoint = user?.clubId
    ? `${PING_ENDPOINT_BASE}?clubId=${user.clubId}`
    : null;

  const queryClient = useQueryClient();

  // ── Registered readers ──
  // ── Identify mode: poll the readers list so lastSeenAt refreshes ──
  const [identifying, setIdentifying] = useState(false);
  const { data: readers = [] } = useListReaders({
    query: { refetchInterval: identifying ? 1500 : false } as any,
  });
  // RM Connect live status — refresh every 10s so the card stays current
  const { data: connectorStatuses = [] } = useGetConnectorStatus({
    query: { refetchInterval: 10_000 } as any,
  });
  const [connectorDl, setConnectorDl] = useState({
    macArm:  "https://github.com/tnelson933/RMMX-Tracker/releases/download/connector-v1.0.0/RM-Connect-arm64.dmg",
    macX64:  "https://github.com/tnelson933/RMMX-Tracker/releases/download/connector-v1.0.0/RM-Connect-x64.dmg",
    windows: "https://github.com/tnelson933/RMMX-Tracker/releases/download/connector-v1.0.0/RM-Connect-Setup.exe",
  });
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
  const [newReaderName, setNewReaderName] = useState("");
  const [newReaderType, setNewReaderType] = useState<"rfid" | "mylaps">("rfid");
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
    const name = newReaderName.trim();
    if (!name) return;
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

  function readerIngestUrl(token: string) {
    return `${BASE_URL}/api/timing/readers/${token}/crossing`;
  }

  function lastSeenLabel(lastSeenAt: string | null | undefined): { text: string; live: boolean } {
    if (!lastSeenAt) return { text: "Never seen", live: false };
    const diffMs = Date.now() - new Date(lastSeenAt).getTime();
    if (diffMs < 60_000) return { text: `${Math.round(diffMs / 1000)}s ago`, live: true };
    if (diffMs < 3_600_000) return { text: `${Math.round(diffMs / 60_000)}m ago`, live: diffMs < 300_000 };
    return { text: new Date(lastSeenAt).toLocaleTimeString(), live: false };
  }

  const [tech,       setTech]       = useState<"rfid" | "mylaps">("rfid");
  const [readerType, setReaderType] = useState<ReaderType>("impinj-r700");
  const [readerIp,   setReaderIp]   = useState("");
  const [readerMac,  setReaderMac]  = useState("");

  const [copiedUrl,       setCopiedUrl]       = useState(false);
  const [copiedManualUrl, setCopiedManualUrl] = useState(false);

  // Bridge detection — only needed for MyLaps browser mode
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>("checking");

  useEffect(() => {
    if (tech !== "mylaps" || isDesktop) return;
    setBridgeStatus("checking");
    const check = async () => {
      try {
        const res = await fetch(`${BRIDGE_URL}/api-status`);
        setBridgeStatus(res.ok ? "running" : "offline");
      } catch {
        setBridgeStatus("offline");
      }
    };
    check();
    const id = setInterval(check, 5000);
    return () => clearInterval(id);
  }, [tech, isDesktop]);

  // MyLaps desktop TCP connection
  const [myLapsStatus,       setMyLapsStatus]       = useState<MyLapsStatus | null>(null);
  const [myLapsConnecting,   setMyLapsConnecting]   = useState(false);
  const [myLapsConnectError, setMyLapsConnectError] = useState<string | null>(null);

  useEffect(() => {
    if (!isDesktop || tech !== "mylaps") return;
    const api = (window as any).electronAPI;
    if (!api?.mylaps) return;
    api.mylaps.getStatus().then(setMyLapsStatus).catch(() => {});
    const unsub = api.mylaps.onStatus(setMyLapsStatus);
    return unsub;
  }, [isDesktop, tech]);

  const handleMyLapsConnect = async () => {
    if (!readerIp.trim()) return;
    const api = (window as any).electronAPI;
    setMyLapsConnecting(true);
    setMyLapsConnectError(null);
    try {
      await api.mylaps.connect(readerIp.trim());
    } catch (err: unknown) {
      setMyLapsConnectError(err instanceof Error ? err.message : "Could not connect to decoder.");
    } finally {
      setMyLapsConnecting(false);
    }
  };

  const handleMyLapsDisconnect = async () => {
    const api = (window as any).electronAPI;
    await api.mylaps.disconnect().catch(() => {});
    setMyLapsConnectError(null);
  };

  // Test crossing
  const [os,          setOs]          = useState<"windows" | "mac">("windows");
  const [testValue,   setTestValue]   = useState("");
  const [testResult,  setTestResult]  = useState<{ ok: boolean; message: string } | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  const sendTest = async () => {
    if (!testValue || !pingEndpoint) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      const body = tech === "mylaps"
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

  const mylapsBridgeCmd = `python rfid_bridge.py --mylaps ${readerIp || "<decoder-ip>"} --club-id ${user?.clubId ?? "YOUR_CLUB_ID"} --api-url ${BASE_URL}`;

  const copyUrl       = () => { navigator.clipboard.writeText(facilityEndpoint); setCopiedUrl(true);       setTimeout(() => setCopiedUrl(false),       2000); };
  const copyManualUrl = () => { navigator.clipboard.writeText(facilityEndpoint); setCopiedManualUrl(true); setTimeout(() => setCopiedManualUrl(false), 2000); };

  const downloadLauncher = (platform: "windows" | "mac") => {
    const cmd  = mylapsBridgeCmd;
    const cmd3 = cmd.replace(/^python /, "python3 ");
    const bridgeUrl = `${BASE_URL}/rfid_bridge.py`;
    let content: string;
    let filename: string;
    if (platform === "windows") {
      content = [
        "@echo off",
        "title RM Tracker Setup Tool",
        "echo ================================================",
        "echo   RM Tracker — MyLaps Bridge",
        "echo ================================================",
        "echo.",
        "echo Keep this window open while racing.",
        "echo.",
        "set SCRIPT_DIR=%~dp0",
        'cd /d "%SCRIPT_DIR%"',
        "echo Checking for updates...",
        `curl -s -L -o rfid_bridge_update.py "${bridgeUrl}" && move /y rfid_bridge_update.py rfid_bridge.py`,
        "echo.",
        cmd,
        "echo.",
        "echo Bridge stopped. Press any key to close.",
        "pause > nul",
      ].join("\r\n");
      filename = "start-mylaps.bat";
    } else {
      content = [
        "#!/bin/bash",
        'cd "$(dirname "$0")"',
        "echo '================================================'",
        "echo '  RM Tracker — MyLaps Bridge'",
        "echo '================================================'",
        "echo ''",
        "echo 'Keep this window open while racing.'",
        "echo ''",
        "echo 'Checking for updates...'",
        `curl -s -L -o rfid_bridge_update.py "${bridgeUrl}" && mv rfid_bridge_update.py rfid_bridge.py`,
        "echo ''",
        cmd3,
        "echo ''",
        "echo 'Bridge stopped.'",
      ].join("\n");
      filename = "start-mylaps.command";
    }
    const blob = new Blob([content], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const bridgeDot =
    bridgeStatus === "checking" ? <RefreshCw size={12} className="animate-spin text-muted-foreground" /> :
    bridgeStatus === "running"  ? <Circle size={10} className="fill-green-500 text-green-500" /> :
                                  <Circle size={10} className="fill-amber-400 text-amber-400" />;

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

  const urlField = (
    <div className="flex items-center gap-2">
      <code className="flex-1 font-mono text-xs bg-background border rounded px-2.5 py-1.5 break-all text-primary">{facilityEndpoint}</code>
      {urlCopyButton}
    </div>
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
        <p className="text-muted-foreground mt-1">Get your timing hardware connected in a few minutes.</p>
      </div>

      {/* Timing URL — RFID only */}
      {tech === "rfid" && (
        <div className="rounded-xl border-2 border-primary/40 bg-primary/5 p-5 space-y-3">
          <div>
            <p className="font-heading font-bold uppercase tracking-wider text-sm">Your Timing URL</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              This gets programmed into your hardware once — it automatically routes to whichever moto is running.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs bg-background border rounded-lg px-3 py-2.5 truncate text-primary">
              {facilityEndpoint}
            </code>
            <button onClick={copyUrl} className="shrink-0 flex items-center gap-1.5 rounded-lg border bg-background px-3 py-2.5 text-xs font-medium hover:bg-muted transition-colors">
              {copiedUrl ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
              {copiedUrl ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {/* ── Registered Readers ── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-heading font-bold uppercase tracking-tight text-lg">Registered Readers</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Name each physical reader — the system gives it a unique URL you paste into the hardware.</p>
          </div>
          <div className="flex items-center gap-2">
            {(readers as any[]).length > 0 && (
              identifying ? (
                <Button size="sm" variant="secondary" onClick={stopIdentify} className="gap-1.5">
                  <Loader2 size={13} className="animate-spin" /> Listening… Cancel
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={startIdentify} className="gap-1.5">
                  <ScanLine size={13} /> Identify Reader
                </Button>
              )
            )}
            <Button size="sm" variant="outline" onClick={() => setShowAddReader(v => !v)} className="gap-1.5">
              <Plus size={13} /> Add Reader
            </Button>
          </div>
        </div>

        {identifying && (
          <div className="rounded-lg border-2 border-primary/50 bg-primary/5 p-4 flex items-center gap-3">
            <ScanLine size={18} className="text-primary shrink-0 animate-pulse" />
            <p className="text-sm">
              <strong>Listening for a scan…</strong> Hold a tag up to one of your readers. The reader that picks it up will be highlighted below.
            </p>
          </div>
        )}

        {showAddReader && (
          <div className="rounded-lg border p-4 space-y-3 bg-muted/20">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">New Reader</p>
            <div className="flex gap-2 flex-wrap">
              <Input
                value={newReaderName}
                onChange={e => setNewReaderName(e.target.value)}
                placeholder='e.g. "Start Gate"'
                className="h-9 flex-1 min-w-36"
                onKeyDown={e => e.key === "Enter" && handleAddReader()}
              />
              <Select value={newReaderType} onValueChange={(v: "rfid" | "mylaps") => setNewReaderType(v)}>
                <SelectTrigger className="h-9 w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rfid">RFID</SelectItem>
                  <SelectItem value="mylaps">MyLaps</SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={newReaderAddress}
                onChange={e => setNewReaderAddress(e.target.value)}
                placeholder={newReaderType === "mylaps" ? "IP address (e.g. 192.168.1.50)" : "Last 6 of MAC (e.g. 3A:4B:5C)"}
                className="h-9 flex-1 min-w-48 font-mono text-xs"
                onKeyDown={e => e.key === "Enter" && handleAddReader()}
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleAddReader} disabled={createReaderMutation.isPending || !newReaderName.trim()}>
                {createReaderMutation.isPending ? "Adding…" : "Add"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setShowAddReader(false); setNewReaderName(""); setNewReaderAddress(""); }}>Cancel</Button>
            </div>
          </div>
        )}

        {(readers as any[]).length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No readers registered yet — add one above to get its unique timing URL.
          </div>
        ) : (
          <div className="rounded-xl border overflow-hidden divide-y">
            {(readers as any[]).map((reader: any) => {
              const { text: lsText, live } = lastSeenLabel(reader.lastSeenAt);
              const url = readerIngestUrl(reader.token);
              const isEditing = editingId === reader.id;
              const isIdentified = identifiedId === reader.id;
              return (
                <div
                  key={reader.id}
                  className={`p-4 space-y-3 transition-colors ${isIdentified ? "bg-primary/10 ring-2 ring-inset ring-primary" : ""}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Radio size={14} className={`shrink-0 mt-0.5 ${isIdentified ? "text-primary" : "text-muted-foreground"}`} />
                      <div className="min-w-0 flex-1">
                        {isEditing ? (
                          <div className="space-y-2">
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
                            </div>
                            <div className="flex items-center gap-2">
                              <Input
                                value={editAddress}
                                onChange={e => setEditAddress(e.target.value)}
                                className="h-8 flex-1 font-mono text-xs"
                                placeholder={reader.type === "mylaps" ? "IP address" : "Last 6 of MAC (e.g. 3A:4B:5C)"}
                                onKeyDown={e => {
                                  if (e.key === "Enter") handleSaveReader(reader.id);
                                  if (e.key === "Escape") setEditingId(null);
                                }}
                              />
                              <Button
                                size="sm"
                                className="h-8"
                                onClick={() => handleSaveReader(reader.id)}
                                disabled={updateReaderMutation.isPending || !editName.trim()}
                              >
                                {updateReaderMutation.isPending ? "Saving…" : "Save"}
                              </Button>
                              <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => setEditingId(null)} title="Cancel">
                                <X size={14} />
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center gap-2">
                              <p className="font-semibold text-sm truncate">{reader.name}</p>
                              {isIdentified && (
                                <span className="text-[10px] font-bold uppercase tracking-wider text-primary bg-primary/15 rounded px-1.5 py-0.5 shrink-0">
                                  This one
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                              <span className="text-xs text-muted-foreground uppercase">{reader.type === "mylaps" ? "MyLaps / AMB" : "RFID"}</span>
                              {reader.hardwareAddress ? (
                                <span className="text-xs font-mono text-muted-foreground bg-muted rounded px-1.5 py-0.5">{reader.hardwareAddress}</span>
                              ) : (
                                <span className="text-xs text-amber-500">No address set</span>
                              )}
                              <span className={`text-xs font-medium ${live ? "text-green-500" : "text-muted-foreground"}`}>
                                {live ? "● " : "○ "}{lsText}
                              </span>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                    {!isEditing && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => beginEdit(reader)}
                          className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
                          title="Rename reader"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() => handleDeleteReader(reader.id)}
                          className="text-muted-foreground hover:text-destructive transition-colors p-1 rounded"
                          title="Remove reader"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 bg-muted/40 rounded-lg px-3 py-2">
                    <code className="flex-1 font-mono text-xs truncate text-primary">{url}</code>
                    <CopyButton text={url} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── RM Connect ── */}
      <div className="rounded-xl border-2 p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <MonitorDown size={18} className="text-primary" />
              <h2 className="font-heading font-bold uppercase tracking-tight text-lg">RM Connect</h2>
              <span className="text-[10px] font-bold uppercase tracking-wider text-primary bg-primary/15 rounded px-1.5 py-0.5">Recommended</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              A tiny app that runs in your laptop's system tray at the track. It talks to your Impinj R700 or
              MyLaps decoder directly and streams crossings to the cloud — no hardware configuration needed.
              Readers start and stop automatically when you start or complete a moto here in the web app.
            </p>
          </div>
        </div>

        {(connectorStatuses as any[]).length > 0 ? (
          <div className="rounded-lg border divide-y">
            {(connectorStatuses as any[]).map((c: any) => (
              <div key={c.readerId} className="flex items-center gap-3 p-3">
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${c.hardware?.connected ? "bg-green-500" : "bg-amber-500"}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold truncate">{c.readerName}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.hardware?.kind === "impinj" ? "Impinj R700" : c.hardware?.kind === "zebra" ? "Zebra reader" : c.hardware?.kind === "generic" ? "LLRP reader" : c.hardware?.kind === "mylaps" ? "MyLaps decoder" : "Hardware"}
                    {" — "}
                    {c.hardware?.connected ? "connected" : (c.hardware?.detail || "not connected")}
                    {c.hardware?.readCount > 0 && ` · ${c.hardware.readCount} reads`}
                  </p>
                </div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-green-500 bg-green-500/10 rounded px-1.5 py-0.5 shrink-0">
                  App online
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No RM Connect app is currently connected for your club.
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <a href={connectorDl.macArm} title="macOS Apple Silicon (M1/M2/M3)">
            <Button variant="outline" size="sm" className="font-heading uppercase tracking-wider gap-1.5 h-8 px-4 text-xs">
              <Download size={13} /> Mac (Apple Silicon)
            </Button>
          </a>
          <a href={connectorDl.macX64} title="macOS Intel">
            <Button variant="outline" size="sm" className="font-heading uppercase tracking-wider gap-1.5 h-8 px-4 text-xs">
              <Download size={13} /> Mac (Intel)
            </Button>
          </a>
          <a href={connectorDl.windows} title="Windows 10/11">
            <Button variant="outline" size="sm" className="font-heading uppercase tracking-wider gap-1.5 h-8 px-4 text-xs">
              <Download size={13} /> Windows
            </Button>
          </a>
        </div>

        <div className="space-y-2 text-sm">
          <div className="flex gap-2"><MiniStep n={1} /><p>Download and install RM Connect on the laptop you bring to the track.</p></div>
          <div className="flex gap-2"><MiniStep n={2} /><p>Sign in with your organizer email, pick a reader registration from the list above, choose your hardware (Impinj R700, Zebra FX7500/FX9600, other LLRP reader, or MyLaps), and enter its address (Impinj: last 6 of the MAC on the label · Zebra/other: IP address · MyLaps: decoder IP).</p></div>
          <div className="flex gap-2"><MiniStep n={3} /><p>That's it — leave it running in the tray. When you press <strong>Start Moto</strong> here, the reader starts reading automatically.</p></div>
        </div>

        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm space-y-1.5">
          <p className="font-semibold text-amber-700 dark:text-amber-400">RFID readers: make sure LLRP is enabled first</p>
          <p className="text-muted-foreground">
            RM Connect talks to RFID readers over LLRP. If the reader's LLRP interface is off, it will refuse the connection and
            RM Connect will show "Reader disconnected."
          </p>
          <ol className="list-decimal ml-5 space-y-0.5 text-muted-foreground">
            <li><strong>Impinj R700</strong>: open the reader's web page at <span className="font-mono text-xs">http://impinj-xx-xx-xx.local</span> (last 6 of the MAC) or its IP. Log in, change the <strong>RFID interface</strong> setting from "Impinj IoT device interface" to <strong>LLRP</strong>, and reboot when prompted.</li>
            <li><strong>Zebra FX7500 / FX9600</strong>: open <span className="font-mono text-xs">http://READER_IP</span>, log in (default admin / change#me), and make sure the operating mode is <strong>LLRP</strong> (this is the factory default).</li>
            <li><strong>Other LLRP readers</strong>: enable LLRP in the reader's admin page — RM Connect connects on TCP port 5084.</li>
            <li>Once LLRP is on, RM Connect connects automatically within a few seconds.</li>
          </ol>
          <p className="text-muted-foreground text-xs">
            Tip: if the <span className="font-mono">.local</span> address won't load, find the reader's IP in your router's device list and enter the IP in RM Connect instead.
          </p>
        </div>
      </div>

      {/* Hardware toggle */}
      <div className="space-y-3">
        <p className="text-sm font-medium">What timing hardware do you have?</p>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => { setTech("rfid"); setTestResult(null); }}
            className={`flex items-center gap-3 rounded-xl border-2 p-4 text-left transition-all ${tech === "rfid" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
          >
            <Wifi size={22} className={tech === "rfid" ? "text-primary" : "text-muted-foreground"} />
            <div>
              <p className="font-semibold text-sm">RFID Sticker Tags</p>
              <p className="text-xs text-muted-foreground">Passive tags on helmets or bikes</p>
            </div>
          </button>
          <button
            onClick={() => { setTech("mylaps"); setTestResult(null); }}
            className={`flex items-center gap-3 rounded-xl border-2 p-4 text-left transition-all ${tech === "mylaps" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
          >
            <Timer size={22} className={tech === "mylaps" ? "text-primary" : "text-muted-foreground"} />
            <div>
              <p className="font-semibold text-sm">MyLaps / AMB</p>
              <p className="text-xs text-muted-foreground">Active transponders on riders</p>
            </div>
          </button>
        </div>
      </div>

      {/* OS picker — only needed for MyLaps browser bridge download */}
      {tech === "mylaps" && !isDesktop && (
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium text-muted-foreground">My laptop runs:</span>
          <button
            onClick={() => setOs("windows")}
            className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${os === "windows" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
          >Windows</button>
          <button
            onClick={() => setOs("mac")}
            className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${os === "mac" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
          >Mac</button>
        </div>
      )}

      {/* Steps */}
      <div className="border rounded-xl bg-card overflow-hidden divide-y">
        <div className="px-5 py-3 bg-muted/30 border-b">
          <p className="font-heading font-bold uppercase tracking-wider text-sm">
            {tech === "rfid" ? "RFID Setup — 3 Steps" : "MyLaps / AMB Setup — 3 Steps"}
          </p>
        </div>

        {tech === "rfid" ? (
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
        ) : (
          <>
            {/* MyLaps Step 1 */}
            <div className="flex gap-4 p-5">
              <StepBadge n={1} />
              <div className="space-y-2 min-w-0">
                <p className="font-semibold">Link transponders to riders</p>
                <p className="text-sm text-muted-foreground">
                  Go to <strong className="text-foreground">Riders</strong> in the sidebar and open each rider's profile. Enter the number printed on or programmed into their MyLaps transponder.
                </p>
                <p className="text-xs bg-muted/60 border rounded-md px-3 py-2">
                  <strong>Good to know:</strong> Unknown transponders are still logged — you can link them after the race and all crossings update automatically.
                </p>
              </div>
            </div>

            {/* MyLaps Step 2 */}
            <div className="flex gap-4 p-5">
              <StepBadge n={2} />
              <div className="space-y-3 min-w-0 w-full">

                {isDesktop ? (
                  <>
                    <div>
                      <p className="font-semibold">Connect to your decoder</p>
                      <p className="text-sm text-muted-foreground mt-1">
                        Enter your decoder's IP address and click Connect. The app talks to it directly — no scripts or extra software needed.
                      </p>
                    </div>

                    <div className="flex gap-2 max-w-sm">
                      <Input
                        value={readerIp}
                        onChange={e => { setReaderIp(e.target.value); setMyLapsConnectError(null); }}
                        placeholder="e.g. 192.168.1.50"
                        className="font-mono h-9 text-sm"
                        disabled={myLapsStatus?.connected}
                        onKeyDown={e => { if (e.key === "Enter" && !myLapsStatus?.connected) handleMyLapsConnect(); }}
                      />
                      <Button
                        onClick={myLapsStatus?.connected ? handleMyLapsDisconnect : handleMyLapsConnect}
                        disabled={myLapsConnecting || (!myLapsStatus?.connected && !readerIp.trim())}
                        variant={myLapsStatus?.connected ? "outline" : "default"}
                        className="h-9 px-4 shrink-0 gap-1.5"
                      >
                        {myLapsConnecting && <RefreshCw size={13} className="animate-spin" />}
                        {myLapsConnecting ? "Connecting…" : myLapsStatus?.connected ? "Disconnect" : "Connect"}
                      </Button>
                    </div>

                    {myLapsStatus?.connected && (
                      <div className="flex items-center gap-2 text-sm">
                        <Circle size={10} className="fill-green-500 text-green-500 shrink-0" />
                        <span className="text-green-700 dark:text-green-400 font-medium">
                          Connected to {myLapsStatus.decoderIp}
                        </span>
                        {(myLapsStatus.passingCount ?? 0) > 0 && (
                          <span className="text-muted-foreground">
                            — {myLapsStatus.passingCount} passing{myLapsStatus.passingCount !== 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                    )}

                    {(myLapsConnectError || (myLapsStatus?.error && !myLapsStatus.connected)) && (
                      <div className="flex items-start gap-2 text-sm text-destructive">
                        <XCircle size={14} className="shrink-0 mt-0.5" />
                        <span>{myLapsConnectError ?? myLapsStatus?.error}</span>
                      </div>
                    )}

                    <p className="text-xs bg-muted/60 border rounded-md px-3 py-2">
                      <strong>Compatible hardware:</strong> AMB TranX 160/260, AMB RC4, AMB RC4-WA, AMB MX, MyLaps X2, P3 Flex — any decoder supported by AMBrc 4.x/5.x. The decoder must be on the same local network as this computer.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-semibold">Run the bridge script with your decoder's IP</p>
                    <p className="text-sm text-muted-foreground">
                      The bridge connects directly to your decoder over the local network — no AMBrc configuration needed.
                      Download the script, enter your decoder's IP, and run the command shown below.
                    </p>
                    <div className="border rounded-lg bg-muted/20 p-4 space-y-3">
                      <div className="space-y-3">
                        <div className="border rounded-lg divide-y overflow-hidden">
                          <div className="flex gap-3 px-3 py-2.5">
                            <MiniStep n={1} />
                            <div className="space-y-1.5 min-w-0">
                              <p className="text-xs font-medium">Install Python — one time only</p>
                              <a href={os === "windows" ? "https://www.python.org/ftp/python/3.13.3/python-3.13.3-amd64.exe" : "https://www.python.org/ftp/python/3.13.3/python-3.13.3-macos11.pkg"}
                                className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background hover:bg-muted transition-colors">
                                <Download size={12} /> {os === "windows" ? "Python for Windows" : "Python for Mac"}
                              </a>
                              <p className="text-xs text-muted-foreground">
                                Click through the installer.{os === "windows" && <> Check <strong>"Add Python to PATH"</strong> if it appears.</>}
                              </p>
                            </div>
                          </div>
                          <div className="flex gap-3 px-3 py-2.5">
                            <MiniStep n={2} />
                            <div className="space-y-2 min-w-0 w-full">
                              <p className="text-xs font-medium">Enter your decoder IP, then download the launcher</p>
                              <div className="space-y-1">
                                <label className="text-xs text-muted-foreground">
                                  Decoder IP address <span className="opacity-60">(printed on the decoder or shown in AMBrc)</span>
                                </label>
                                <Input value={readerIp} onChange={e => setReaderIp(e.target.value)}
                                  placeholder="e.g. 192.168.1.50" className="font-mono h-8 text-xs max-w-xs" />
                              </div>
                              <button onClick={() => downloadLauncher(os)}
                                disabled={!readerIp.trim()}
                                className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background transition-colors ${readerIp.trim() ? "hover:bg-muted" : "opacity-40 cursor-not-allowed"}`}>
                                <Download size={12} /> {os === "windows" ? "start-mylaps.bat" : "start-mylaps.command"}
                              </button>
                              {!readerIp.trim() && (
                                <p className="text-xs text-amber-600 dark:text-amber-400">Enter the decoder IP above to enable the download.</p>
                              )}
                              <p className="text-xs text-muted-foreground">Save it anywhere and double-click it — it downloads the latest bridge code automatically each time it runs. A terminal opens and the bridge starts with your decoder IP already set.</p>
                              {os === "mac" && <p className="text-xs text-muted-foreground opacity-70">Right-click → Open the first time to allow it past Gatekeeper.</p>}
                            </div>
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground">Keep the window open while racing — closing it disconnects from the decoder.</p>
                      </div>
                      <div className="flex items-center gap-2 pt-2 border-t text-sm">
                        {bridgeDot}
                        <span className={bridgeStatus === "running" ? "text-green-700 dark:text-green-400 font-medium" : "text-muted-foreground"}>
                          {bridgeStatus === "checking" && "Checking for bridge…"}
                          {bridgeStatus === "running"  && "Bridge connected — decoder linked"}
                          {bridgeStatus === "offline"  && `Waiting for bridge — open Downloads and double-click ${os === "windows" ? "start-mylaps.bat" : "start-mylaps.command"}`}
                        </span>
                      </div>
                    </div>
                    <p className="text-xs bg-muted/60 border rounded-md px-3 py-2">
                      <strong>Compatible hardware:</strong> AMB TranX 160/260, AMB RC4, AMB RC4-WA, AMB MX, MyLaps X2, P3 Flex — any decoder supported by AMBrc 4.x/5.x.
                    </p>
                  </>
                )}
              </div>
            </div>

            {/* MyLaps Step 3 */}
            <div className="flex gap-4 p-5">
              <StepBadge n={3} />
              <div className="space-y-2 min-w-0">
                <p className="font-semibold">Test before race day</p>
                <p className="text-sm text-muted-foreground">
                  Use the test tool below — enter a transponder number and confirm the server receives it. No moto needs to be running.
                </p>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Test Connection */}
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
                {tech === "mylaps" ? "Transponder number" : "Tag number (hex)"}
              </label>
              <Input value={testValue} onChange={e => setTestValue(e.target.value)}
                placeholder={tech === "mylaps" ? "e.g. 12345" : "e.g. 1A2B3C4D"}
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

      {/* Desktop RFID / Serial section */}
      {isDesktop && tech === "rfid" && (
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
  );
}
