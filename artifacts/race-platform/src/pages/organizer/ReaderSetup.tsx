import { useState, useEffect } from "react";
import {
  Wifi, Timer, Copy, Check, Send, RefreshCw,
  CheckCircle2, XCircle, Download, Circle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";

const BASE_URL = window.location.origin;
const FACILITY_ENDPOINT_BASE = `${BASE_URL}/api/timing/active/crossing`;
const BRIDGE_URL = "http://localhost:5555";
const AMBRC_BODY = `{\n  "transponder": "%TRANSPONDER%",\n  "passingTime": "%PASSTIME_ISO%"\n}`;

type BridgeStatus = "checking" | "running" | "offline";

export default function ReaderSetup() {
  const { toast } = useToast();
  const { user } = useAuth();

  const facilityEndpoint = user?.clubId
    ? `${FACILITY_ENDPOINT_BASE}?clubId=${user.clubId}`
    : `${FACILITY_ENDPOINT_BASE}?clubId=YOUR_CLUB_ID`;

  const bridgeCmd = `python rfid_bridge.py --api-url ${BASE_URL}`;

  // ── Technology toggle ────────────────────────────────────────────────────
  const [tech, setTech] = useState<"rfid" | "mylaps">("rfid");

  // ── Copy states ──────────────────────────────────────────────────────────
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedBody, setCopiedBody] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);

  // ── Bridge detection ─────────────────────────────────────────────────────
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>("checking");

  useEffect(() => {
    if (tech !== "rfid") return;
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
  }, [tech]);

  // ── Reader auto-configure ────────────────────────────────────────────────
  const [readerType, setReaderType] = useState<"impinj-r700" | "zebra-fx7500">("impinj-r700");
  const [readerIp, setReaderIp] = useState("");
  const [configuring, setConfiguring] = useState(false);
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

  // ── Test crossing ────────────────────────────────────────────────────────
  const [testValue, setTestValue] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  const sendTest = async () => {
    if (!testValue) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      const body = tech === "mylaps"
        ? { transponder: testValue, passingTime: new Date().toISOString() }
        : { rfidNumber: testValue };
      const res = await fetch(facilityEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        const lap = data.lapNumber ?? data.results?.[0]?.lapNumber;
        const msg = lap ? `Lap ${lap} recorded` : "Crossing accepted";
        setTestResult({ ok: true, message: msg });
        toast({ title: "✅ Working!", description: msg });
      } else {
        const raw = data.error ?? "Crossing rejected";
        const msg = raw === "No active moto" || raw.includes("no active")
          ? "No moto is currently running — start a moto first, then test again."
          : raw === "Rider not found"
          ? "Tag not recognised — make sure it is saved on a rider profile first."
          : raw;
        setTestResult({ ok: false, message: msg });
        toast({ title: "Not accepted", description: msg, variant: "destructive" });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Could not reach the server";
      setTestResult({ ok: false, message: msg });
      toast({ title: "Connection failed", description: msg, variant: "destructive" });
    } finally {
      setTestLoading(false);
    }
  };

  // ── Helpers ──────────────────────────────────────────────────────────────
  const copyUrl = () => { navigator.clipboard.writeText(facilityEndpoint); setCopiedUrl(true); setTimeout(() => setCopiedUrl(false), 2000); };
  const copyBody = () => { navigator.clipboard.writeText(AMBRC_BODY); setCopiedBody(true); setTimeout(() => setCopiedBody(false), 2000); };
  const copyCmd = () => { navigator.clipboard.writeText(bridgeCmd); setCopiedCmd(true); setTimeout(() => setCopiedCmd(false), 2000); };

  const Step = ({ n }: { n: number }) => (
    <div className="w-8 h-8 shrink-0 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-heading font-bold text-sm">
      {n}
    </div>
  );

  const BridgeDot = () => {
    if (bridgeStatus === "checking") return <RefreshCw size={12} className="animate-spin text-muted-foreground" />;
    if (bridgeStatus === "running") return <Circle size={10} className="fill-green-500 text-green-500" />;
    return <Circle size={10} className="fill-amber-400 text-amber-400" />;
  };

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-8">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-3xl font-heading font-bold uppercase tracking-tight">Reader Setup</h1>
        <p className="text-muted-foreground mt-1">Get your timing hardware connected in a few minutes.</p>
      </div>

      {/* ── Your URL — always visible ───────────────────────────────────────── */}
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

      {/* ── Hardware type toggle ────────────────────────────────────────────── */}
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

      {/* ── Steps ──────────────────────────────────────────────────────────── */}
      <div className="border rounded-xl bg-card overflow-hidden divide-y">
        <div className="px-5 py-3 bg-muted/30 border-b">
          <p className="font-heading font-bold uppercase tracking-wider text-sm">
            {tech === "rfid" ? "RFID Setup — 3 Steps" : "MyLaps / AMB Setup — 3 Steps"}
          </p>
        </div>

        {tech === "rfid" ? (
          <>
            {/* Step 1 — Tag riders */}
            <div className="flex gap-4 p-5">
              <Step n={1} />
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

            {/* Step 2 — Auto-configure reader */}
            <div className="flex gap-4 p-5">
              <Step n={2} />
              <div className="space-y-4 min-w-0 w-full">
                <div>
                  <p className="font-semibold">Configure your reader automatically</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Our bridge script programs the reader for you — no need to open the reader's own web interface. Do this once at home or in the shop; the reader remembers the settings forever.
                  </p>
                </div>

                {/* Bridge status + download + command */}
                <div className="border rounded-lg bg-muted/20 p-4 space-y-3">
                  <div className="flex items-center gap-2 text-sm">
                    <BridgeDot />
                    <span className={bridgeStatus === "running" ? "text-green-700 dark:text-green-400 font-medium" : "text-muted-foreground"}>
                      {bridgeStatus === "checking" && "Checking for bridge…"}
                      {bridgeStatus === "running" && "Bridge is running — form unlocked below"}
                      {bridgeStatus === "offline" && "Bridge not detected — start it first"}
                    </span>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground font-medium">
                      {bridgeStatus === "running" ? "Bridge is already running. Skip to the form below." : "Start the bridge on your laptop:"}
                    </p>
                    <div className="space-y-2">
                      <a
                        href="/rfid_bridge.py"
                        download="rfid_bridge.py"
                        className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md border bg-background hover:bg-muted transition-colors"
                      >
                        <Download size={13} /> Download rfid_bridge.py
                      </a>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 font-mono text-xs bg-background border rounded-lg px-3 py-2 truncate">
                          {bridgeCmd}
                        </code>
                        <button onClick={copyCmd} className="shrink-0 flex items-center gap-1.5 rounded-lg border bg-background px-2.5 py-2 text-xs font-medium hover:bg-muted transition-colors">
                          {copiedCmd ? <Check size={11} className="text-green-500" /> : <Copy size={11} />}
                          {copiedCmd ? "Copied" : "Copy"}
                        </button>
                      </div>
                      <p className="text-xs text-muted-foreground">Python 3.8+ only — no extra packages needed. Keep the terminal window open while configuring.</p>
                    </div>
                  </div>
                </div>

                {/* Configure form — unlocks when bridge is running */}
                <div className={`border rounded-lg p-4 space-y-3 transition-opacity ${bridgeStatus === "running" ? "opacity-100" : "opacity-40 pointer-events-none"}`}>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {bridgeStatus === "running" ? "Configure your reader" : "Start the bridge above first"}
                  </p>

                  {/* Reader type */}
                  <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">What reader model do you have?</p>
                    <div className="flex gap-2">
                      {(["impinj-r700", "zebra-fx7500"] as const).map(rt => (
                        <button
                          key={rt}
                          onClick={() => setReaderType(rt)}
                          className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${readerType === rt ? "border-primary bg-primary/10 text-primary" : "border-border hover:border-primary/40"}`}
                        >
                          {rt === "impinj-r700" ? "Impinj R700" : "Zebra FX7500"}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* IP address */}
                  <div className="space-y-1.5">
                    <label className="text-xs text-muted-foreground">
                      Reader's IP address <span className="text-muted-foreground/60">(plug reader into your laptop — check your network settings for its IP)</span>
                    </label>
                    <div className="flex gap-2 max-w-sm">
                      <Input
                        value={readerIp}
                        onChange={e => setReaderIp(e.target.value)}
                        placeholder="e.g. 192.168.1.50"
                        className="font-mono h-9 text-sm"
                        onKeyDown={e => { if (e.key === "Enter") configureReader(); }}
                      />
                      <Button
                        onClick={configureReader}
                        disabled={configuring || !readerIp.trim() || bridgeStatus !== "running"}
                        className="font-heading uppercase tracking-wider h-9 px-4 gap-1.5 shrink-0 text-xs"
                      >
                        {configuring ? <RefreshCw size={13} className="animate-spin" /> : null}
                        {configuring ? "Configuring…" : "Configure Reader"}
                      </Button>
                    </div>
                  </div>

                  {/* Result */}
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
            </div>

            {/* Step 3 — Test */}
            <div className="flex gap-4 p-5">
              <Step n={3} />
              <div className="space-y-2 min-w-0">
                <p className="font-semibold">Test before race day</p>
                <p className="text-sm text-muted-foreground">
                  Go to the <strong className="text-foreground">Motos</strong> tab and start a moto, then use the test tool below to confirm laps are being received.
                </p>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* MyLaps Step 1 — Link transponders */}
            <div className="flex gap-4 p-5">
              <Step n={1} />
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

            {/* MyLaps Step 2 — AMBrc */}
            <div className="flex gap-4 p-5">
              <Step n={2} />
              <div className="space-y-3 min-w-0">
                <p className="font-semibold">Set up AMBrc to send data here</p>
                <p className="text-sm text-muted-foreground">
                  In AMBrc go to <strong className="text-foreground">Settings → Passings Output → HTTP Output</strong>, turn it on, and enter:
                </p>
                <div className="border rounded-lg divide-y text-sm overflow-hidden">
                  <div className="grid grid-cols-[80px_1fr] gap-3 items-center px-4 py-2.5">
                    <span className="text-muted-foreground text-xs font-medium">URL</span>
                    <code className="font-mono text-xs text-primary truncate">{facilityEndpoint}</code>
                  </div>
                  <div className="grid grid-cols-[80px_1fr] gap-3 items-center px-4 py-2.5">
                    <span className="text-muted-foreground text-xs font-medium">Method</span>
                    <span className="font-semibold">POST</span>
                  </div>
                  <div className="grid grid-cols-[80px_1fr] gap-3 items-center px-4 py-2.5">
                    <span className="text-muted-foreground text-xs font-medium">Header</span>
                    <code className="font-mono text-xs">Content-Type: application/json</code>
                  </div>
                  <div className="px-4 py-2.5 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground text-xs font-medium">Body template</span>
                      <button onClick={copyBody} className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border bg-background hover:bg-muted transition-colors">
                        {copiedBody ? <Check size={11} className="text-green-500" /> : <Copy size={11} />}
                        {copiedBody ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <pre className="font-mono text-xs bg-muted px-3 py-2 rounded">{AMBRC_BODY}</pre>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Save — these settings work for every event and every heat. You never need to change them again.
                </p>
                <p className="text-xs bg-muted/60 border rounded-md px-3 py-2">
                  <strong>Compatible with:</strong> AMBrc 5+, Orbits 4. Works with AMB TranX, AMB RC4, AMB MX, MyLaps X2, and P3 Flex decoders.
                </p>
              </div>
            </div>

            {/* MyLaps Step 3 — Test */}
            <div className="flex gap-4 p-5">
              <Step n={3} />
              <div className="space-y-2 min-w-0">
                <p className="font-semibold">Test before race day</p>
                <p className="text-sm text-muted-foreground">
                  Go to the <strong className="text-foreground">Motos</strong> tab and start a moto, then use the test tool below to confirm crossings are being received.
                </p>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Test Connection ─────────────────────────────────────────────────── */}
      <div className="border rounded-xl bg-card overflow-hidden">
        <div className="px-5 py-3 bg-muted/30 border-b">
          <p className="font-heading font-bold uppercase tracking-wider text-sm">Test Your Connection</p>
          <p className="text-xs text-muted-foreground mt-0.5">A moto must be set to "In Progress" before testing.</p>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex gap-3 items-end max-w-sm">
            <div className="flex-1 space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                {tech === "mylaps" ? "Transponder number" : "Tag number"}
              </label>
              <Input
                value={testValue}
                onChange={e => setTestValue(e.target.value)}
                placeholder={tech === "mylaps" ? "e.g. 12345" : "e.g. 1A2B3C4D"}
                className="font-mono h-10"
                onKeyDown={e => { if (e.key === "Enter") sendTest(); }}
              />
            </div>
            <Button
              onClick={sendTest}
              disabled={testLoading || !testValue.trim()}
              className="font-heading uppercase tracking-wider h-10 px-5 gap-2 shrink-0"
            >
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
