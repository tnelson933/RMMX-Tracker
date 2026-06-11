import { useState, useEffect } from "react";
import {
  Wifi, Timer, Copy, Check, Send, RefreshCw,
  CheckCircle2, XCircle, Download, Circle, ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";

const BASE_URL = window.location.origin;
const FACILITY_ENDPOINT_BASE = `${BASE_URL}/api/timing/active/crossing`;
const PING_ENDPOINT_BASE = `${BASE_URL}/api/timing/ping`;
const BRIDGE_URL = "http://localhost:5555";

type BridgeStatus = "checking" | "running" | "offline";
type SetupMethod  = "auto" | "manual";
type ReaderType   = "impinj-r700" | "zebra-fx7500" | "generic";

// ── Small presentational helpers — defined OUTSIDE so they're never remounted ──
const StepBadge = ({ n }: { n: number }) => (
  <div className="w-8 h-8 shrink-0 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-heading font-bold text-sm">
    {n}
  </div>
);

const MiniStep = ({ n }: { n: number }) => (
  <div className="w-5 h-5 shrink-0 rounded-full bg-muted border text-xs font-bold flex items-center justify-center mt-0.5">
    {n}
  </div>
);

export default function ReaderSetup() {
  const { toast } = useToast();
  const { user } = useAuth();

  const facilityEndpoint = user?.clubId
    ? `${FACILITY_ENDPOINT_BASE}?clubId=${user.clubId}`
    : `${FACILITY_ENDPOINT_BASE}?clubId=YOUR_CLUB_ID`;

  const pingEndpoint = user?.clubId
    ? `${PING_ENDPOINT_BASE}?clubId=${user.clubId}`
    : null;

  const bridgeCmd = `python rfid_bridge.py --api-url ${BASE_URL}`;

  // ── Technology & setup-method toggles ────────────────────────────────────
  const [tech,        setTech]        = useState<"rfid" | "mylaps">("rfid");
  const [setupMethod, setSetupMethod] = useState<SetupMethod>("auto");

  // ── Shared reader fields ──────────────────────────────────────────────────
  const [readerType, setReaderType] = useState<ReaderType>("impinj-r700");
  const [readerIp,   setReaderIp]   = useState("");

  // ── Copy states ──────────────────────────────────────────────────────────
  const [copiedUrl,       setCopiedUrl]       = useState(false);
  const [copiedCmd,       setCopiedCmd]       = useState(false);
  const [copiedManualUrl, setCopiedManualUrl] = useState(false);

  // ── Bridge detection ──────────────────────────────────────────────────────
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>("checking");

  useEffect(() => {
    const shouldCheck = (tech === "rfid" && setupMethod === "auto") || tech === "mylaps";
    if (!shouldCheck) return;
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
  }, [tech, setupMethod]);

  // ── Reader auto-configure ─────────────────────────────────────────────────
  const [configuring,  setConfiguring]  = useState(false);
  const [configResult, setConfigResult] = useState<{ ok: boolean; message: string } | null>(null);

  const configureReader = async () => {
    setConfiguring(true);
    setConfigResult(null);
    try {
      const res = await fetch(`${BRIDGE_URL}/configure-reader`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ readerType, readerIp, targetUrl: facilityEndpoint }),
      });
      const data = await res.json();
      const msg = data.ok ? data.message : (data.error ?? "Something went wrong.");
      setConfigResult({ ok: data.ok, message: msg });
      toast({ title: data.ok ? "Reader configured!" : "Configuration failed", description: msg, variant: data.ok ? "default" : "destructive" });
    } catch {
      const msg = "Could not reach the bridge. Make sure it is running on your computer.";
      setConfigResult({ ok: false, message: msg });
      toast({ title: "Connection failed", description: msg, variant: "destructive" });
    } finally {
      setConfiguring(false);
    }
  };

  // ── Test crossing ─────────────────────────────────────────────────────────
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

  // ── Derived commands ──────────────────────────────────────────────────────
  const mylapsBridgeCmd = `python rfid_bridge.py --mylaps ${readerIp || "<decoder-ip>"} --club-id ${user?.clubId ?? "YOUR_CLUB_ID"} --api-url ${BASE_URL}`;

  // ── Copy helpers ──────────────────────────────────────────────────────────
  const copyUrl       = () => { navigator.clipboard.writeText(facilityEndpoint); setCopiedUrl(true);       setTimeout(() => setCopiedUrl(false),       2000); };
  const copyCmd       = () => { navigator.clipboard.writeText(tech === "mylaps" ? mylapsBridgeCmd : bridgeCmd); setCopiedCmd(true); setTimeout(() => setCopiedCmd(false), 2000); };
  const copyManualUrl = () => { navigator.clipboard.writeText(facilityEndpoint); setCopiedManualUrl(true); setTimeout(() => setCopiedManualUrl(false), 2000); };

  // ── Launcher download ─────────────────────────────────────────────────────
  const downloadLauncher = (platform: "windows" | "mac", mode: "rfid" | "mylaps") => {
    const cmd  = mode === "mylaps" ? mylapsBridgeCmd : bridgeCmd;
    const cmd3 = cmd.replace(/^python /, "python3 ");
    let content: string;
    let filename: string;
    if (platform === "windows") {
      content = [
        "@echo off",
        "title Rocky Mountain Race Timing Bridge",
        "echo ================================================",
        "echo   Rocky Mountain Race Timing Bridge",
        "echo ================================================",
        "echo.",
        "echo Starting... Keep this window open while racing.",
        "echo.",
        "set SCRIPT_DIR=%~dp0",
        'cd /d "%SCRIPT_DIR%"',
        cmd,
        "echo.",
        "echo Bridge stopped. Press any key to close.",
        "pause > nul",
      ].join("\r\n");
      filename = "start-timing.bat";
    } else {
      content = [
        "#!/bin/bash",
        'cd "$(dirname "$0")"',
        "echo '================================================'",
        "echo '  Rocky Mountain Race Timing Bridge'",
        "echo '================================================'",
        "echo ''",
        "echo 'Starting... Keep this window open while racing.'",
        "echo ''",
        cmd3,
        "echo ''",
        "echo 'Bridge stopped.'",
      ].join("\n");
      filename = "start-timing.command";
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

  // ── Bridge status dot ─────────────────────────────────────────────────────
  const bridgeDot =
    bridgeStatus === "checking" ? <RefreshCw size={12} className="animate-spin text-muted-foreground" /> :
    bridgeStatus === "running"  ? <Circle size={10} className="fill-green-500 text-green-500" /> :
                                  <Circle size={10} className="fill-amber-400 text-amber-400" />;

  // ── Manual instructions rows (computed, not a component) ──────────────────
  const manualReaderUrl =
    readerType === "impinj-r700"  ? `https://${readerIp || "READER_IP"}` :
    readerType === "zebra-fx7500" ? `http://${readerIp || "READER_IP"}:8080` :
                                    `http://${readerIp || "READER_IP"}`;

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
        content: <a href={manualReaderUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-mono text-xs text-primary underline underline-offset-2 break-all">{manualReaderUrl} <ExternalLink size={11} /></a> },
      { step: 2, label: "Log in",
        content: <span className="text-xs text-muted-foreground">Username <strong className="text-foreground font-mono">admin</strong> · Password <strong className="text-foreground font-mono">change#me</strong> (Impinj factory default — update if you changed it)</span> },
      { step: 3, label: "Navigate to Profiles",
        content: <span className="text-xs text-muted-foreground">In the left sidebar choose <strong className="text-foreground">Profiles</strong>, then click <strong className="text-foreground">New Profile</strong>.</span> },
      { step: 4, label: "Set the HTTP destination",
        content: <div className="space-y-1.5"><p className="text-xs text-muted-foreground">Under <strong className="text-foreground">Event Handlers → Tag Inventory Event → Actions</strong>, choose <strong className="text-foreground">HTTP</strong> and paste:</p>{urlField}</div> },
      { step: 5, label: "Set method and header",
        content: <span className="text-xs text-muted-foreground">Method: <strong className="text-foreground">POST</strong> · Add header <strong className="text-foreground font-mono">Content-Type: application/json</strong></span> },
      { step: 6, label: "Save and activate",
        content: <span className="text-xs text-muted-foreground">Click <strong className="text-foreground">Save</strong>, then set this profile as <strong className="text-foreground">Active</strong>. The reader starts sending laps immediately.</span> },
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

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="p-8 max-w-2xl mx-auto space-y-8">

      {/* Header */}
      <div>
        <h1 className="text-3xl font-heading font-bold uppercase tracking-tight">Reader Setup</h1>
        <p className="text-muted-foreground mt-1">Get your timing hardware connected in a few minutes.</p>
      </div>

      {/* Timing URL — RFID only (MyLaps uses TCP pull, not HTTP push) */}
      {tech === "rfid" && (
        <div className="rounded-xl border-2 border-primary/40 bg-primary/5 p-5 space-y-3">
          <div>
            <p className="font-heading font-bold uppercase tracking-wider text-sm">Your Timing URL</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              This gets programmed into your hardware once — it automatically routes to whichever heat is running.
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

      {/* Hardware toggle */}
      <div className="space-y-3">
        <p className="text-sm font-medium">What timing hardware do you have?</p>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => { setTech("rfid"); setTestResult(null); setConfigResult(null); }}
            className={`flex items-center gap-3 rounded-xl border-2 p-4 text-left transition-all ${tech === "rfid" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
          >
            <Wifi size={22} className={tech === "rfid" ? "text-primary" : "text-muted-foreground"} />
            <div>
              <p className="font-semibold text-sm">RFID Sticker Tags</p>
              <p className="text-xs text-muted-foreground">Passive tags on helmets or bikes</p>
            </div>
          </button>
          <button
            onClick={() => { setTech("mylaps"); setTestResult(null); setConfigResult(null); }}
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
                  <strong>Tip:</strong> Your reader's test mode shows the exact tag number — copy and paste it to avoid typos.
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
                    Choose how to configure it based on how your reader is connected.
                  </p>
                </div>

                {/* Method toggle */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => { setSetupMethod("auto"); setConfigResult(null); }}
                    className={`flex flex-col gap-1 rounded-lg border-2 px-4 py-3 text-left transition-all ${setupMethod === "auto" ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"}`}
                  >
                    <span className="text-sm font-semibold">Auto-configure</span>
                    <span className="text-xs text-muted-foreground">Reader plugged into this laptop — bridge programs it for you</span>
                  </button>
                  <button
                    onClick={() => { setSetupMethod("manual"); setBridgeStatus("checking"); }}
                    className={`flex flex-col gap-1 rounded-lg border-2 px-4 py-3 text-left transition-all ${setupMethod === "manual" ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"}`}
                  >
                    <span className="text-sm font-semibold">Manual setup</span>
                    <span className="text-xs text-muted-foreground">Reader on the track network — configure through its own web interface</span>
                  </button>
                </div>

                {/* ── Auto path ─────────────────────────────────────────────── */}
                {setupMethod === "auto" && (
                  <div className="space-y-3">
                    <div className="border rounded-lg bg-muted/20 p-4 space-y-3">
                      <div className="flex items-center gap-2 text-sm">
                        {bridgeDot}
                        <span className={bridgeStatus === "running" ? "text-green-700 dark:text-green-400 font-medium" : "text-muted-foreground"}>
                          {bridgeStatus === "checking" && "Checking for bridge…"}
                          {bridgeStatus === "running"  && "Bridge is running — form unlocked below"}
                          {bridgeStatus === "offline"  && "Bridge not detected — start it first"}
                        </span>
                      </div>
                      {bridgeStatus === "running" ? (
                        <p className="text-xs text-green-700 dark:text-green-400 font-medium">Bridge is running — configure your reader in the form below.</p>
                      ) : (
                        <div className="space-y-3">
                          <div className="border rounded-lg divide-y overflow-hidden">
                            <div className="flex gap-3 px-3 py-2.5">
                              <MiniStep n={1} />
                              <div className="space-y-1.5 min-w-0">
                                <p className="text-xs font-medium">Download the bridge script</p>
                                <a href="/rfid_bridge.py" download="rfid_bridge.py"
                                  className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background hover:bg-muted transition-colors">
                                  <Download size={12} /> Download rfid_bridge.py
                                </a>
                              </div>
                            </div>
                            <div className="flex gap-3 px-3 py-2.5">
                              <MiniStep n={2} />
                              <div className="space-y-1.5 min-w-0">
                                <p className="text-xs font-medium">Install Python — one time only</p>
                                <div className="flex flex-wrap gap-2">
                                  <a href="https://www.python.org/ftp/python/3.13.3/python-3.13.3-amd64.exe"
                                    className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background hover:bg-muted transition-colors">
                                    <Download size={12} /> Python for Windows
                                  </a>
                                  <a href="https://www.python.org/ftp/python/3.13.3/python-3.13.3-macos11.pkg"
                                    className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background hover:bg-muted transition-colors">
                                    <Download size={12} /> Python for Mac
                                  </a>
                                </div>
                                <p className="text-xs text-muted-foreground">Click through the installer. Check <strong>"Add Python to PATH"</strong> if it appears.</p>
                              </div>
                            </div>
                            <div className="flex gap-3 px-3 py-2.5">
                              <MiniStep n={3} />
                              <div className="space-y-2 min-w-0 w-full">
                                <p className="text-xs font-medium">Download the launcher for your computer</p>
                                <p className="text-xs text-muted-foreground">Save it in the same folder as rfid_bridge.py. Then just double-click it — a window opens and the bridge starts automatically.</p>
                                <div className="flex flex-wrap gap-2">
                                  <button onClick={() => downloadLauncher("windows", "rfid")}
                                    className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background hover:bg-muted transition-colors">
                                    <Download size={12} /> Windows (.bat)
                                  </button>
                                  <button onClick={() => downloadLauncher("mac", "rfid")}
                                    className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background hover:bg-muted transition-colors">
                                    <Download size={12} /> Mac / Linux (.command)
                                  </button>
                                </div>
                                <p className="text-xs text-muted-foreground opacity-70">Mac only: right-click the file → Open the first time to allow it past Gatekeeper.</p>
                              </div>
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground">Keep the window open while configuring — closing it disconnects the reader.</p>
                        </div>
                      )}
                    </div>

                    <div className={`border rounded-lg p-4 space-y-3 transition-opacity ${bridgeStatus === "running" ? "opacity-100" : "opacity-40 pointer-events-none"}`}>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        {bridgeStatus === "running" ? "Configure your reader" : "Start the bridge above first"}
                      </p>
                      <div className="space-y-1.5">
                        <p className="text-xs text-muted-foreground">Reader model:</p>
                        <div className="flex gap-2">
                          {(["impinj-r700", "zebra-fx7500"] as const).map(rt => (
                            <button key={rt} onClick={() => setReaderType(rt)}
                              className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${readerType === rt ? "border-primary bg-primary/10 text-primary" : "border-border hover:border-primary/40"}`}>
                              {rt === "impinj-r700" ? "Impinj R700" : "Zebra FX7500"}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs text-muted-foreground">
                          Reader's IP address <span className="text-muted-foreground/60">(check your network settings after plugging it in)</span>
                        </label>
                        <div className="flex gap-2 max-w-sm">
                          <Input value={readerIp} onChange={e => setReaderIp(e.target.value)}
                            placeholder="e.g. 192.168.1.50" className="font-mono h-9 text-sm"
                            onKeyDown={e => { if (e.key === "Enter") configureReader(); }} />
                          <Button onClick={configureReader}
                            disabled={configuring || !readerIp.trim() || bridgeStatus !== "running"}
                            className="font-heading uppercase tracking-wider h-9 px-4 gap-1.5 shrink-0 text-xs">
                            {configuring ? <RefreshCw size={13} className="animate-spin" /> : null}
                            {configuring ? "Configuring…" : "Configure"}
                          </Button>
                        </div>
                      </div>
                      {configResult && (
                        <div className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 ${configResult.ok ? "bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800" : "bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800"}`}>
                          {configResult.ok
                            ? <CheckCircle2 size={16} className="text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
                            : <XCircle size={16} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />}
                          <p className={`text-xs font-medium ${configResult.ok ? "text-green-700 dark:text-green-300" : "text-red-700 dark:text-red-300"}`}>
                            {configResult.message}
                          </p>
                        </div>
                      )}
                    </div>

                    <p className="text-xs text-muted-foreground">
                      After configuring, unplug the reader and move it to your race-day network. It will send laps directly to the platform — no laptop needed on race day.
                    </p>
                  </div>
                )}

                {/* ── Manual path (inlined — no sub-component) ──────────────── */}
                {setupMethod === "manual" && (
                  <div className="space-y-3">
                    {/* Reader type */}
                    <div className="space-y-1.5">
                      <p className="text-xs text-muted-foreground">Select your reader model:</p>
                      <div className="flex flex-wrap gap-2">
                        {(["impinj-r700", "zebra-fx7500", "generic"] as const).map(rt => (
                          <button key={rt} onClick={() => setReaderType(rt)}
                            className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${readerType === rt ? "border-primary bg-primary/10 text-primary" : "border-border hover:border-primary/40"}`}>
                            {rt === "impinj-r700" ? "Impinj R700" : rt === "zebra-fx7500" ? "Zebra FX7500" : "Other / Generic"}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* IP field */}
                    {readerType !== "generic" && (
                      <div className="space-y-1.5">
                        <label className="text-xs text-muted-foreground">
                          Reader's IP address <span className="text-muted-foreground/60">(check your router or the reader's display)</span>
                        </label>
                        <Input value={readerIp} onChange={e => setReaderIp(e.target.value)}
                          placeholder="e.g. 192.168.1.50" className="font-mono h-9 text-sm max-w-xs" />
                      </div>
                    )}

                    {/* Step-by-step instructions */}
                    <div className="border rounded-lg divide-y overflow-hidden">
                      {manualRows.map(({ step, label, content }) => (
                        <div key={step} className="flex gap-3 px-4 py-3">
                          <MiniStep n={step} />
                          <div className="space-y-1.5 min-w-0">
                            <p className="text-sm font-medium">{label}</p>
                            <div>{content}</div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <p className="text-xs text-muted-foreground">
                      Settings are saved permanently on the reader — you only need to do this once. After saving, the reader will work on any network that has internet access.
                    </p>
                  </div>
                )}
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
                <p className="font-semibold">Run the bridge script with your decoder's IP</p>
                <p className="text-sm text-muted-foreground">
                  The bridge connects directly to your decoder over the local network — no AMBrc configuration needed.
                  Download the script, enter your decoder's IP, and run the command shown below.
                </p>
                <div className="border rounded-lg bg-muted/20 p-4 space-y-3">
                  <div className="flex items-center gap-2 text-sm">
                    {bridgeDot}
                    <span className={bridgeStatus === "running" ? "text-green-700 dark:text-green-400 font-medium" : "text-muted-foreground"}>
                      {bridgeStatus === "checking" && "Checking for bridge…"}
                      {bridgeStatus === "running"  && "Bridge is running — decoder connected"}
                      {bridgeStatus === "offline"  && "Bridge not detected — start it with the command below"}
                    </span>
                  </div>
                  {bridgeStatus === "running" ? (
                    <p className="text-xs text-green-700 dark:text-green-400 font-medium">Bridge is running — decoder connected.</p>
                  ) : (
                    <div className="space-y-3">
                      <div className="border rounded-lg divide-y overflow-hidden">
                        <div className="flex gap-3 px-3 py-2.5">
                          <MiniStep n={1} />
                          <div className="space-y-1.5 min-w-0">
                            <p className="text-xs font-medium">Download the bridge script</p>
                            <a href="/rfid_bridge.py" download="rfid_bridge.py"
                              className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background hover:bg-muted transition-colors">
                              <Download size={12} /> Download rfid_bridge.py
                            </a>
                          </div>
                        </div>
                        <div className="flex gap-3 px-3 py-2.5">
                          <MiniStep n={2} />
                          <div className="space-y-1.5 min-w-0">
                            <p className="text-xs font-medium">Install Python — one time only</p>
                            <div className="flex flex-wrap gap-2">
                              <a href="https://www.python.org/ftp/python/3.13.3/python-3.13.3-amd64.exe"
                                className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background hover:bg-muted transition-colors">
                                <Download size={12} /> Python for Windows
                              </a>
                              <a href="https://www.python.org/ftp/python/3.13.3/python-3.13.3-macos11.pkg"
                                className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background hover:bg-muted transition-colors">
                                <Download size={12} /> Python for Mac
                              </a>
                            </div>
                            <p className="text-xs text-muted-foreground">Click through the installer. Check <strong>"Add Python to PATH"</strong> if it appears.</p>
                          </div>
                        </div>
                        <div className="flex gap-3 px-3 py-2.5">
                          <MiniStep n={3} />
                          <div className="space-y-2 min-w-0 w-full">
                            <p className="text-xs font-medium">Enter your decoder IP, then download the launcher</p>
                            <div className="space-y-1">
                              <label className="text-xs text-muted-foreground">
                                Decoder IP address <span className="opacity-60">(printed on the decoder or shown in AMBrc)</span>
                              </label>
                              <Input value={readerIp} onChange={e => setReaderIp(e.target.value)}
                                placeholder="e.g. 192.168.1.50" className="font-mono h-8 text-xs max-w-xs" />
                            </div>
                            <p className="text-xs text-muted-foreground">Save the launcher in the same folder as rfid_bridge.py. Double-click it — a window opens and the bridge starts automatically with your decoder IP already configured.</p>
                            <div className="flex flex-wrap gap-2">
                              <button onClick={() => downloadLauncher("windows", "mylaps")}
                                disabled={!readerIp.trim()}
                                className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background transition-colors ${readerIp.trim() ? "hover:bg-muted" : "opacity-40 cursor-not-allowed"}`}>
                                <Download size={12} /> Windows (.bat)
                              </button>
                              <button onClick={() => downloadLauncher("mac", "mylaps")}
                                disabled={!readerIp.trim()}
                                className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border bg-background transition-colors ${readerIp.trim() ? "hover:bg-muted" : "opacity-40 cursor-not-allowed"}`}>
                                <Download size={12} /> Mac / Linux (.command)
                              </button>
                            </div>
                            {!readerIp.trim() && (
                              <p className="text-xs text-amber-600 dark:text-amber-400">Enter the decoder IP above to enable the download.</p>
                            )}
                            <p className="text-xs text-muted-foreground opacity-70">Mac only: right-click the file → Open the first time to allow it past Gatekeeper.</p>
                          </div>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">Keep the window open while racing — closing it disconnects from the decoder.</p>
                    </div>
                  )}
                </div>
                <p className="text-xs bg-muted/60 border rounded-md px-3 py-2">
                  <strong>Compatible hardware:</strong> AMB TranX 160/260, AMB RC4, AMB RC4-WA, AMB MX, MyLaps X2, P3 Flex — any decoder supported by AMBrc 4.x/5.x.
                </p>
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
                {tech === "mylaps" ? "Transponder number" : "Tag number"}
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

    </div>
  );
}
