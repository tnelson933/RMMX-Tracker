import { useState } from "react";
import {
  Wifi, Timer, Copy, Check, Send, RefreshCw,
  CheckCircle2, XCircle, ChevronDown, ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";

const BASE_URL = window.location.origin;
const FACILITY_ENDPOINT_BASE = `${BASE_URL}/api/timing/active/crossing`;

const AMBRC_BODY = `{\n  "transponder": "%TRANSPONDER%",\n  "passingTime": "%PASSTIME_ISO%"\n}`;

export default function ReaderSetup() {
  const { toast } = useToast();
  const { user } = useAuth();

  const facilityEndpoint = user?.clubId
    ? `${FACILITY_ENDPOINT_BASE}?clubId=${user.clubId}`
    : `${FACILITY_ENDPOINT_BASE}?clubId=YOUR_CLUB_ID`;

  const [tech, setTech] = useState<"rfid" | "mylaps">("rfid");
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedBody, setCopiedBody] = useState(false);
  const [readerDetailsOpen, setReaderDetailsOpen] = useState(false);

  const [testValue, setTestValue] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  const copyUrl = () => {
    navigator.clipboard.writeText(facilityEndpoint);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const copyBody = () => {
    navigator.clipboard.writeText(AMBRC_BODY);
    setCopiedBody(true);
    setTimeout(() => setCopiedBody(false), 2000);
  };

  const sendTest = async () => {
    if (!testValue) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      const body =
        tech === "mylaps"
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
        const msg =
          raw === "No active moto" || raw.includes("no active")
            ? "No moto is currently running — start a moto first, then test again."
            : raw === "Rider not found"
            ? "Tag not recognised — make sure it's saved on a rider profile first."
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

  const Step = ({ n }: { n: number }) => (
    <div className="w-8 h-8 shrink-0 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-heading font-bold text-sm">
      {n}
    </div>
  );

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-8">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-3xl font-heading font-bold uppercase tracking-tight">Reader Setup</h1>
        <p className="text-muted-foreground mt-1">
          Get your timing hardware connected in a few minutes.
        </p>
      </div>

      {/* ── Your URL — always visible ───────────────────────────────────────── */}
      <div className="rounded-xl border-2 border-primary/40 bg-primary/5 p-5 space-y-3">
        <div>
          <p className="font-heading font-bold uppercase tracking-wider text-sm">Your Timing URL</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Enter this once into your hardware — it automatically routes to whichever heat or moto is currently running. You never need to change it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 font-mono text-xs bg-background border rounded-lg px-3 py-2.5 truncate text-primary">
            {facilityEndpoint}
          </code>
          <button
            onClick={copyUrl}
            className="shrink-0 flex items-center gap-1.5 rounded-lg border bg-background px-3 py-2.5 text-xs font-medium hover:bg-muted transition-colors"
          >
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
            onClick={() => { setTech("rfid"); setTestResult(null); setReaderDetailsOpen(false); }}
            className={`flex items-center gap-3 rounded-xl border-2 p-4 text-left transition-all ${
              tech === "rfid"
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/40"
            }`}
          >
            <Wifi size={22} className={tech === "rfid" ? "text-primary" : "text-muted-foreground"} />
            <div>
              <p className="font-semibold text-sm">RFID Sticker Tags</p>
              <p className="text-xs text-muted-foreground">Passive tags on helmets or bikes</p>
            </div>
          </button>
          <button
            onClick={() => { setTech("mylaps"); setTestResult(null); setReaderDetailsOpen(false); }}
            className={`flex items-center gap-3 rounded-xl border-2 p-4 text-left transition-all ${
              tech === "mylaps"
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/40"
            }`}
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
                  Stick an RFID tag on each rider's helmet, chest protector, or bike frame.
                  Then go to <strong className="text-foreground">Riders</strong> in the sidebar,
                  open each rider's profile, and type in the tag number printed on the sticker.
                </p>
                <p className="text-xs bg-muted/60 border rounded-md px-3 py-2">
                  <strong>Tip:</strong> Your reader's test mode will show you the exact tag number — you can copy and paste it to avoid typos.
                </p>
              </div>
            </div>

            {/* Step 2 — Configure reader */}
            <div className="flex gap-4 p-5">
              <Step n={2} />
              <div className="space-y-2 min-w-0">
                <p className="font-semibold">Point your reader at your URL</p>
                <p className="text-sm text-muted-foreground">
                  Open your reader's web interface, find the <strong className="text-foreground">HTTP Output</strong> settings,
                  paste in the URL from above, and set the method to <strong className="text-foreground">POST</strong>.
                </p>
                <button
                  onClick={() => setReaderDetailsOpen(v => !v)}
                  className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline mt-1"
                >
                  {readerDetailsOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  Where to find this setting on my reader
                </button>
                {readerDetailsOpen && (
                  <div className="mt-1 space-y-3 border rounded-lg p-4 bg-muted/30 text-xs text-muted-foreground">
                    <div>
                      <p className="font-semibold text-foreground mb-0.5">Impinj R700</p>
                      <p>Log in to the reader's IoT Connector UI → <em>Add Profile</em> → choose <em>LLRP</em> → <em>HTTP</em> → paste the URL, set method POST.</p>
                    </div>
                    <div>
                      <p className="font-semibold text-foreground mb-0.5">Zebra FX7500</p>
                      <p>Log in to the IoT Connector UI → <em>Add Profile</em> → <em>LLRP</em> → <em>HTTP</em> → paste the URL, method POST, JSON format.</p>
                    </div>
                    <div>
                      <p className="font-semibold text-foreground mb-0.5">Other readers</p>
                      <p>Look for <em>HTTP Output</em>, <em>Webhook</em>, or <em>REST Output</em> in your reader's settings. Paste the URL and set method POST. Enable JSON format if asked.</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Step 3 — Test */}
            <div className="flex gap-4 p-5">
              <Step n={3} />
              <div className="space-y-2 min-w-0">
                <p className="font-semibold">Test before race day</p>
                <p className="text-sm text-muted-foreground">
                  Go to the <strong className="text-foreground">Motos</strong> tab and start a moto, then
                  use the test tool below to confirm the connection is working.
                </p>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* Step 1 — Link transponders */}
            <div className="flex gap-4 p-5">
              <Step n={1} />
              <div className="space-y-2 min-w-0">
                <p className="font-semibold">Link transponders to riders</p>
                <p className="text-sm text-muted-foreground">
                  Go to <strong className="text-foreground">Riders</strong> in the sidebar and open each rider's profile.
                  Enter the number printed on or programmed into their MyLaps transponder.
                </p>
                <p className="text-xs bg-muted/60 border rounded-md px-3 py-2">
                  <strong>Good to know:</strong> Unknown transponders are still logged as laps — you can link them after the race and all crossings will update automatically.
                </p>
              </div>
            </div>

            {/* Step 2 — AMBrc config */}
            <div className="flex gap-4 p-5">
              <Step n={2} />
              <div className="space-y-3 min-w-0">
                <p className="font-semibold">Set up AMBrc to send data here</p>
                <p className="text-sm text-muted-foreground">
                  In AMBrc, go to <strong className="text-foreground">Settings → Passings Output → HTTP Output</strong>,
                  turn it on, and enter the following:
                </p>
                <div className="border rounded-lg divide-y text-sm overflow-hidden">
                  <div className="grid grid-cols-[80px_1fr] gap-3 items-center px-4 py-2.5">
                    <span className="text-muted-foreground text-xs font-medium">URL</span>
                    <code className="font-mono text-xs text-primary truncate">{facilityEndpoint}</code>
                  </div>
                  <div className="grid grid-cols-[80px_1fr] gap-3 items-center px-4 py-2.5">
                    <span className="text-muted-foreground text-xs font-medium">Method</span>
                    <span className="font-semibold text-sm">POST</span>
                  </div>
                  <div className="grid grid-cols-[80px_1fr] gap-3 items-center px-4 py-2.5">
                    <span className="text-muted-foreground text-xs font-medium">Header</span>
                    <code className="font-mono text-xs">Content-Type: application/json</code>
                  </div>
                  <div className="px-4 py-2.5 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground text-xs font-medium">Body template</span>
                      <button
                        onClick={copyBody}
                        className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border bg-background hover:bg-muted transition-colors"
                      >
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

            {/* Step 3 — Test */}
            <div className="flex gap-4 p-5">
              <Step n={3} />
              <div className="space-y-2 min-w-0">
                <p className="font-semibold">Test before race day</p>
                <p className="text-sm text-muted-foreground">
                  Go to the <strong className="text-foreground">Motos</strong> tab and start a moto, then
                  use the test tool below to confirm crossings are being received.
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
          <p className="text-xs text-muted-foreground mt-0.5">
            A moto must be set to "In Progress" before testing.
          </p>
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
              {testLoading
                ? <RefreshCw size={14} className="animate-spin" />
                : <Send size={14} />}
              {testLoading ? "Sending…" : "Test"}
            </Button>
          </div>

          {testResult && (
            <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${
              testResult.ok
                ? "bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800"
                : "bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800"
            }`}>
              {testResult.ok
                ? <CheckCircle2 size={18} className="text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
                : <XCircle size={18} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />}
              <div>
                <p className={`font-semibold text-sm ${
                  testResult.ok ? "text-green-700 dark:text-green-300" : "text-red-700 dark:text-red-300"
                }`}>
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
