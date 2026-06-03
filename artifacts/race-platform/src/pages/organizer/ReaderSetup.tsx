import { useState } from "react";
import { useListEvents, useListMotos } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Wifi, Copy, Check, Send, RefreshCw, Circle, Tag, Globe, Settings, PlayCircle, ClipboardList, FlaskConical, Download, WifiOff, ShieldCheck, Terminal } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

const BASE_URL = window.location.origin;
const ENDPOINT = `${BASE_URL}/api/timing/crossing`;

const PAYLOAD_EXAMPLE = `{
  "rfidNumber": "1A2B3C4D",
  "motoId": 12,
  "crossingTime": "2026-05-27T14:32:01.123456Z",
  "readerId": "finish-line-1",
  "antennaId": 1
}`;

const RESPONSE_EXAMPLE = `{
  "ok": true,
  "crossingId": 4501,
  "lapNumber": 3,
  "lapTime": "1:52.34",
  "lapTimeMs": 112340
}`;

type Crossing = {
  id: number;
  rfidNumber: string;
  riderName: string | null;
  lapNumber: number;
  lapTime: string | null;
  crossingTime: string;
  readerId: string | null;
};

export default function ReaderSetup() {
  const { toast } = useToast();
  const [copiedUrl, setCopiedUrl] = useState(false);

  const [selectedEventId, setSelectedEventId] = useState("");
  const [selectedMotoId, setSelectedMotoId] = useState("");
  const [testRfid, setTestRfid] = useState("");
  const [testReaderId, setTestReaderId] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; body: string } | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  const [crossings, setCrossings] = useState<Crossing[]>([]);
  const [crossingsLoading, setCrossingsLoading] = useState(false);

  const { data: events } = useListEvents({}, { query: {} as any });
  const eventId = parseInt(selectedEventId) || 0;
  const { data: motos } = useListMotos(eventId, { query: { enabled: !!eventId } as any });

  const selectedEventTech = ((events?.find(e => e.id.toString() === selectedEventId) as any)?.timingTechnology ?? "rfid") as "rfid" | "mylaps";
  const isMylaps = selectedEventTech === "mylaps";

  const copyUrl = () => {
    navigator.clipboard.writeText(ENDPOINT);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const loadCrossings = async (motoId: string) => {
    if (!motoId) return;
    setCrossingsLoading(true);
    try {
      const res = await fetch(`/api/timing/crossings/${motoId}`);
      const data = await res.json();
      setCrossings(Array.isArray(data) ? data.slice(-20).reverse() : []);
    } catch {
      setCrossings([]);
    } finally {
      setCrossingsLoading(false);
    }
  };

  const handleMotoChange = (motoId: string) => {
    setSelectedMotoId(motoId);
    setTestResult(null);
    loadCrossings(motoId);
  };

  const sendTest = async () => {
    if (!testRfid || !selectedMotoId) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      const body: Record<string, unknown> = {
        rfidNumber: testRfid,
        motoId: parseInt(selectedMotoId),
      };
      if (testReaderId) body.readerId = testReaderId;

      const res = await fetch("/api/timing/crossing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setTestResult({ ok: res.ok, body: JSON.stringify(data, null, 2) });
      if (res.ok) {
        toast({ title: "Test crossing accepted", description: `Lap ${data.lapNumber} — ${data.lapTime}` });
        loadCrossings(selectedMotoId);
      } else {
        toast({ title: "Crossing rejected", description: data.error, variant: "destructive" });
      }
    } catch (err: any) {
      setTestResult({ ok: false, body: err.message });
      toast({ title: "Request failed", description: err.message, variant: "destructive" });
    } finally {
      setTestLoading(false);
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-8">
      <div>
        <h1 className="text-4xl font-heading font-bold uppercase tracking-tight flex items-center gap-3">
          <Wifi className="text-primary" size={32} /> Reader Setup
        </h1>
        <p className="text-muted-foreground mt-1">
          Configure your RFID hardware to push lap crossings to this platform.
        </p>
      </div>

      {/* Setup Guide */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <CardTitle className="font-heading uppercase tracking-wider text-base">Setup Guide</CardTitle>
          <p className="text-sm text-muted-foreground mt-0.5">
            Any RFID reader that can send an HTTP POST request over the network is compatible. Follow these steps to go from unboxed hardware to live lap times.
          </p>
        </CardHeader>
        <CardContent className="pt-5 space-y-0 divide-y">

          {/* Step 1 */}
          <div className="flex gap-4 py-5 first:pt-0">
            <div className="flex-shrink-0 flex items-start gap-3 w-7">
              <div className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-heading font-bold">1</div>
            </div>
            <div className="space-y-1.5 min-w-0">
              <div className="flex items-center gap-2">
                <Globe size={15} className="text-primary shrink-0" />
                <p className="font-semibold text-sm">Connect the reader to your scoring computer</p>
              </div>
              <p className="text-sm text-muted-foreground">
                Readers can connect to your scoring laptop over the network <span className="font-semibold text-foreground">or</span> via USB — choose whichever your hardware supports:
              </p>
              <ul className="text-sm text-muted-foreground space-y-2 mt-1 ml-1">
                <li className="flex gap-2">
                  <span className="font-semibold text-foreground shrink-0">Network (Ethernet / Wi-Fi)</span>
                  <span>— Plug the reader into your race-day router or connect it to the same Wi-Fi as your laptop. The reader needs a valid IP address and must be able to reach the API endpoint URL. Verify connectivity with a ping before race day.</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold text-foreground shrink-0">USB</span>
                  <span>— Connect the reader via USB and install any manufacturer drivers. Most USB readers expose a serial (COM) port or present as a virtual network adapter. Use the reader's companion software or a bridge utility (e.g. a serial-to-HTTP forwarder) to forward tag reads as HTTP POST requests to the endpoint below.</span>
                </li>
              </ul>
              <div className="bg-muted/60 border rounded-md px-3 py-2 text-xs text-muted-foreground mt-2">
                <span className="font-bold text-foreground">Tip:</span> If running on a private field network with no internet, host this platform on a local laptop and point the reader at <code className="font-mono">http://&lt;laptop-local-ip&gt;/api/timing/crossing</code> instead of the public URL.
              </div>
            </div>
          </div>

          {/* Step 2 */}
          <div className="flex gap-4 py-5">
            <div className="flex-shrink-0">
              <div className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-heading font-bold">2</div>
            </div>
            <div className="space-y-1.5 min-w-0">
              <div className="flex items-center gap-2">
                <Tag size={15} className="text-primary shrink-0" />
                <p className="font-semibold text-sm">Assign RFID tags to riders</p>
              </div>
              <p className="text-sm text-muted-foreground">
                Before race day, go to <span className="font-semibold text-foreground">Riders</span> in the sidebar and open each rider's profile. Enter the transponder number printed on their tag (e.g. <code className="font-mono bg-muted px-1 rounded">1A2B3C4D</code>) in the RFID Tag field. This is how the system maps a raw tag read to a named rider and their lap history.
              </p>
              <div className="bg-muted/60 border rounded-md px-3 py-2 text-xs text-muted-foreground mt-2">
                <span className="font-bold text-foreground">Note:</span> Crossings from unassigned tags are still recorded but will show as "Unknown" in the lap feed. You can assign tags at any time and past crossings will update automatically.
              </div>
            </div>
          </div>

          {/* Step 3 */}
          <div className="flex gap-4 py-5">
            <div className="flex-shrink-0">
              <div className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-heading font-bold">3</div>
            </div>
            <div className="space-y-1.5 min-w-0">
              <div className="flex items-center gap-2">
                <ClipboardList size={15} className="text-primary shrink-0" />
                <p className="font-semibold text-sm">Create your event and motos</p>
              </div>
              <p className="text-sm text-muted-foreground">
                In the <span className="font-semibold text-foreground">Events</span> section, create the race event and open it. On the <span className="font-semibold text-foreground">Motos</span> tab, add a moto for each class / heat. Each moto gets a unique <code className="font-mono bg-muted px-1 rounded">motoId</code> — this is the ID your reader sends with every crossing so the system knows which race is currently running.
              </p>
            </div>
          </div>

          {/* Step 4 */}
          <div className="flex gap-4 py-5">
            <div className="flex-shrink-0">
              <div className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-heading font-bold">4</div>
            </div>
            <div className="space-y-1.5 min-w-0">
              <div className="flex items-center gap-2">
                <Settings size={15} className="text-primary shrink-0" />
                <p className="font-semibold text-sm">Configure the reader's HTTP output</p>
              </div>
              <p className="text-sm text-muted-foreground">
                In your reader's configuration software, set the output type to <span className="font-semibold text-foreground">HTTP POST</span> and enter the endpoint URL shown in the <span className="font-semibold text-foreground">API Endpoint</span> section below. Set the Content-Type header to <code className="font-mono bg-muted px-1 rounded">application/json</code> and configure the JSON body to include at minimum:
              </p>
              <ul className="text-sm text-muted-foreground space-y-1 mt-1 ml-4 list-disc">
                <li><code className="font-mono bg-muted px-1 rounded text-xs">rfidNumber</code> — the tag ID reported by the reader</li>
                <li><code className="font-mono bg-muted px-1 rounded text-xs">motoId</code> — the ID of the active moto (update this before each heat)</li>
                <li><code className="font-mono bg-muted px-1 rounded text-xs">crossingTime</code> — ISO 8601 timestamp from the reader's clock (optional; server time used if omitted)</li>
                <li><code className="font-mono bg-muted px-1 rounded text-xs">readerId</code> — a name for this reader, e.g. <code className="font-mono bg-muted px-1 rounded text-xs">"finish-line-1"</code> (optional, for diagnostics)</li>
              </ul>
              <div className="bg-muted/60 border rounded-md px-3 py-2 text-xs text-muted-foreground mt-2">
                <span className="font-bold text-foreground">Common readers:</span> Impinj Speedway, Alien ALR-9900, Zebra FX Series, and any reader with a configurable TCP/HTTP webhook output. For Arduino or Raspberry Pi builds, use any HTTP client library to POST to the endpoint.
              </div>
            </div>
          </div>

          {/* Step 5 */}
          <div className="flex gap-4 py-5">
            <div className="flex-shrink-0">
              <div className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-heading font-bold">5</div>
            </div>
            <div className="space-y-1.5 min-w-0">
              <div className="flex items-center gap-2">
                <PlayCircle size={15} className="text-primary shrink-0" />
                <p className="font-semibold text-sm">Start the moto before each heat</p>
              </div>
              <p className="text-sm text-muted-foreground">
                On the event's <span className="font-semibold text-foreground">Motos</span> tab, set the moto status to <span className="font-semibold text-foreground">In Progress</span> immediately before the gate drops. The platform only accepts crossings while the moto is in progress — any crossing sent before the moto starts or after it ends is rejected with a <code className="font-mono bg-muted px-1 rounded text-xs">409</code> response. End the moto when the heat finishes to stop recording.
              </p>
            </div>
          </div>

          {/* Step 6 */}
          <div className="flex gap-4 py-5 last:pb-0">
            <div className="flex-shrink-0">
              <div className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-heading font-bold">6</div>
            </div>
            <div className="space-y-1.5 min-w-0">
              <div className="flex items-center gap-2">
                <FlaskConical size={15} className="text-primary shrink-0" />
                <p className="font-semibold text-sm">Test the connection</p>
              </div>
              <p className="text-sm text-muted-foreground">
                Use the <span className="font-semibold text-foreground">Test Connection</span> tool below to fire a simulated crossing before you go live. Select an in-progress moto, enter a known RFID tag number, and click <span className="font-semibold text-foreground">Send Test Crossing</span>. A green "Accepted" response confirms the endpoint is reachable and the moto is active. You should also see the crossing appear in the <span className="font-semibold text-foreground">Recent Crossings</span> table below.
              </p>
            </div>
          </div>

        </CardContent>
      </Card>

      {/* Local Bridge — offline-safe option */}
      <Card className="border-amber-200 dark:border-amber-800/60 bg-amber-50/50 dark:bg-amber-950/20">
        <CardHeader className="pb-3 border-b border-amber-200 dark:border-amber-800/40">
          <div className="flex items-center gap-2">
            <WifiOff size={18} className="text-amber-600 dark:text-amber-400 shrink-0" />
            <CardTitle className="font-heading uppercase tracking-wider text-base">Poor Track Internet? Use the Local Bridge</CardTitle>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Cell signal at outdoor venues is unreliable. The <strong>Local RFID Bridge</strong> is a free Python script
            you run on your scoring laptop. It caches every lap locally and automatically replays them —
            with their original hardware timestamps — the moment your connection is restored. No laps are ever lost.
          </p>
        </CardHeader>
        <CardContent className="pt-5 space-y-5">

          {/* How it works */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div className="flex flex-col gap-1.5 bg-background rounded-lg border p-3">
              <div className="flex items-center gap-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                <ShieldCheck size={13} className="text-green-500" /> When online
              </div>
              <p className="text-muted-foreground text-xs">Tag reads forwarded to the cloud instantly. Zero latency change vs. direct reader → cloud.</p>
            </div>
            <div className="flex flex-col gap-1.5 bg-background rounded-lg border p-3">
              <div className="flex items-center gap-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                <WifiOff size={13} className="text-amber-500" /> When offline
              </div>
              <p className="text-muted-foreground text-xs">Crossings queued in a local SQLite file on the laptop. Reader gets an instant 200 OK so it keeps firing.</p>
            </div>
            <div className="flex flex-col gap-1.5 bg-background rounded-lg border p-3">
              <div className="flex items-center gap-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                <Wifi size={13} className="text-blue-500" /> On reconnect
              </div>
              <p className="text-muted-foreground text-xs">Bridge auto-replays the cache in chronological order using the reader's original hardware timestamps.</p>
            </div>
          </div>

          {/* Setup steps */}
          <div className="space-y-3">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Setup (3 steps)</p>

            <div className="space-y-2 text-sm">
              <div className="flex gap-3 items-start">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold mt-0.5">1</span>
                <div>
                  <p className="font-medium">Install Python 3.8+ and download the bridge script</p>
                  <p className="text-muted-foreground text-xs mt-0.5">Python is free at <code className="font-mono bg-muted px-1 rounded">python.org</code>. No extra packages needed — the script uses only the standard library.</p>
                  <a
                    href="/rfid_bridge.py"
                    download="rfid_bridge.py"
                    className="inline-flex items-center gap-1.5 mt-2 bg-primary text-primary-foreground hover:bg-primary/90 text-xs font-heading uppercase tracking-wider px-3 py-1.5 rounded-md transition-colors"
                  >
                    <Download size={13} /> Download rfid_bridge.py
                  </a>
                </div>
              </div>

              <div className="flex gap-3 items-start">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold mt-0.5">2</span>
                <div>
                  <p className="font-medium">Run the bridge on your scoring laptop</p>
                  <p className="text-muted-foreground text-xs mt-0.5">Open a terminal (Command Prompt on Windows) in the folder where you saved the script and run:</p>
                  <pre className="mt-1.5 bg-gray-900 text-green-400 font-mono text-xs px-3 py-2 rounded border border-gray-700 overflow-x-auto">
{`python rfid_bridge.py --api-url ${BASE_URL}`}
                  </pre>
                  <p className="text-muted-foreground text-xs mt-1.5">A status page appears at <code className="font-mono bg-muted px-1 rounded">http://localhost:5555</code> showing live sync counts.</p>
                </div>
              </div>

              <div className="flex gap-3 items-start">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold mt-0.5">3</span>
                <div>
                  <p className="font-medium">Point your reader at the bridge instead of the cloud</p>
                  <p className="text-muted-foreground text-xs mt-0.5">In your reader's HTTP output config, change the endpoint from:</p>
                  <pre className="mt-1 bg-muted font-mono text-xs px-3 py-2 rounded border overflow-x-auto text-muted-foreground line-through">{ENDPOINT}</pre>
                  <p className="text-muted-foreground text-xs mt-1">to:</p>
                  <pre className="mt-1 bg-gray-900 text-green-400 font-mono text-xs px-3 py-2 rounded border border-gray-700 overflow-x-auto">http://localhost:5555/timing/crossing</pre>
                  <p className="text-muted-foreground text-xs mt-1.5">That's it. The bridge accepts the same JSON payload your reader already sends.</p>
                </div>
              </div>
            </div>
          </div>

          {/* Optional flags */}
          <div className="bg-background rounded-lg border p-3 space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">
              <Terminal size={12} /> Optional flags
            </div>
            <div className="font-mono text-xs space-y-1 text-muted-foreground">
              <p><span className="text-foreground">--port 5555</span>   &nbsp;Local port (default 5555)</p>
              <p><span className="text-foreground">--retry 10</span>  &nbsp;Seconds between retry attempts when offline (default 10)</p>
              <p><span className="text-foreground">--db path</span>   &nbsp;SQLite cache file location (default: rfid_bridge_cache.sqlite3)</p>
            </div>
          </div>

        </CardContent>
      </Card>

      {/* Endpoint reference */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="font-heading uppercase tracking-wider text-base">API Endpoint</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center gap-3">
            <Badge className="font-mono font-bold px-3 py-1 bg-primary text-primary-foreground text-sm">POST</Badge>
            <code className="flex-1 font-mono text-sm bg-muted px-3 py-2 rounded border overflow-x-auto">
              {ENDPOINT}
            </code>
            <Button variant="outline" size="sm" onClick={copyUrl} className="shrink-0 gap-2">
              {copiedUrl ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Request Body</p>
              <pre className="bg-muted font-mono text-xs p-4 rounded border whitespace-pre overflow-x-auto leading-relaxed">
                {PAYLOAD_EXAMPLE}
              </pre>
              <div className="text-xs text-muted-foreground space-y-1.5">
                <p><span className="font-bold text-foreground">rfidNumber</span> — EPC tag ID reported by the reader (required)</p>
                <p><span className="font-bold text-foreground">motoId</span> — active moto ID (required)</p>
                <p>
                  <span className="font-bold text-foreground">crossingTime</span> — ISO 8601 timestamp assigned by the reader hardware at the moment of RF detection.
                  {" "}<span className="font-semibold text-amber-600 dark:text-amber-400">Map from the reader's <code className="font-mono">FirstSeenTimestampUTC</code> field</span> — do not use the PC system clock. The reader timestamps the tag read at the hardware level (microsecond precision) before any network latency is introduced.
                </p>
                <p><span className="font-bold text-foreground">readerId</span> — device identifier, e.g. <code className="font-mono">"finish-line-1"</code> (optional, for diagnostics)</p>
                <p><span className="font-bold text-foreground">antennaId</span> — integer port number (1–4) of the antenna that detected the tag (optional). Useful for multi-antenna gantry setups to identify dead zones.</p>
              </div>
              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 rounded-md px-3 py-2 text-xs text-amber-800 dark:text-amber-300 mt-2">
                <span className="font-bold">Burst debounce:</span> The server automatically ignores duplicate reads of the same tag within a 30-second window. A single antenna pass that generates 50 raw reads will be recorded as exactly one lap crossing — no configuration needed.
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Success Response (200)</p>
              <pre className="bg-muted font-mono text-xs p-4 rounded border whitespace-pre overflow-x-auto leading-relaxed">
                {RESPONSE_EXAMPLE}
              </pre>
              <div className="text-xs text-muted-foreground space-y-1">
                <p><span className="font-bold text-foreground">409</span> — moto not in progress, or invalid moto</p>
                <p><span className="font-bold text-foreground">400</span> — missing rfidNumber or motoId</p>
                <p>Set header: <span className="font-mono font-bold text-foreground">Content-Type: application/json</span></p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Test connection */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="font-heading uppercase tracking-wider text-base">Test Connection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm text-muted-foreground">
            Select an active moto and fire a test crossing to verify your reader can reach the server.
            The moto must be <span className="font-bold text-foreground">In Progress</span> for crossings to be accepted.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Event</label>
              <Select value={selectedEventId} onValueChange={v => { setSelectedEventId(v); setSelectedMotoId(""); setTestResult(null); setCrossings([]); }}>
                <SelectTrigger className="h-11"><SelectValue placeholder="Select event..." /></SelectTrigger>
                <SelectContent>
                  {events?.map(e => (
                    <SelectItem key={e.id} value={e.id.toString()}>
                      {e.name} <span className="text-muted-foreground ml-1">({e.status})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Moto</label>
              <Select value={selectedMotoId} onValueChange={handleMotoChange} disabled={!selectedEventId}>
                <SelectTrigger className="h-11"><SelectValue placeholder="Select moto..." /></SelectTrigger>
                <SelectContent>
                  {motos?.map(m => (
                    <SelectItem key={m.id} value={m.id.toString()}>
                      <span className="flex items-center gap-2">
                        {m.name}
                        <Badge variant={m.status === "in_progress" ? "default" : "secondary"} className="text-[10px] px-1.5 py-0 font-mono">
                          {m.status}
                        </Badge>
                      </span>
                    </SelectItem>
                  ))}
                  {motos?.length === 0 && <SelectItem value="__none" disabled>No motos for this event</SelectItem>}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{isMylaps ? "MyLaps Transponder Number" : "RFID Tag Number"}</label>
              <Input
                value={testRfid}
                onChange={e => setTestRfid(e.target.value)}
                placeholder="e.g. 1A2B3C4D"
                className="font-mono h-11"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Reader ID (optional)</label>
              <Input
                value={testReaderId}
                onChange={e => setTestReaderId(e.target.value)}
                placeholder="e.g. finish-line-1"
                className="font-mono h-11"
              />
            </div>
          </div>

          <Button
            onClick={sendTest}
            disabled={testLoading || !testRfid || !selectedMotoId}
            className="font-heading uppercase tracking-wider h-11 px-6 gap-2"
          >
            {testLoading ? <RefreshCw size={16} className="animate-spin" /> : <Send size={16} />}
            {testLoading ? "Sending..." : "Send Test Crossing"}
          </Button>

          {testResult && (
            <div className={`rounded border p-4 space-y-1 ${testResult.ok ? "border-secondary/40 bg-secondary/5" : "border-destructive/40 bg-destructive/5"}`}>
              <div className="flex items-center gap-2 mb-2">
                <Circle size={10} className={`fill-current ${testResult.ok ? "text-secondary" : "text-destructive"}`} />
                <span className={`text-xs font-bold uppercase tracking-widest ${testResult.ok ? "text-secondary" : "text-destructive"}`}>
                  {testResult.ok ? "Accepted" : "Rejected"}
                </span>
              </div>
              <pre className="font-mono text-xs whitespace-pre-wrap">{testResult.body}</pre>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent crossings */}
      {selectedMotoId && (
        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <CardTitle className="font-heading uppercase tracking-wider text-base">Recent Crossings — Moto {selectedMotoId}</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => loadCrossings(selectedMotoId)} disabled={crossingsLoading} className="gap-1.5">
              <RefreshCw size={14} className={crossingsLoading ? "animate-spin" : ""} />
              Refresh
            </Button>
          </CardHeader>
          <CardContent>
            {crossingsLoading ? (
              <p className="text-sm text-muted-foreground py-4 text-center">Loading crossings...</p>
            ) : crossings.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No crossings recorded for this moto yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs font-bold uppercase tracking-widest text-muted-foreground">
                      <th className="pb-2 pr-4">Time</th>
                      <th className="pb-2 pr-4">{isMylaps ? "Transponder #" : "RFID Tag"}</th>
                      <th className="pb-2 pr-4">Rider</th>
                      <th className="pb-2 pr-4">Lap #</th>
                      <th className="pb-2 pr-4">Lap Time</th>
                      <th className="pb-2">Reader</th>
                    </tr>
                  </thead>
                  <tbody>
                    {crossings.map(c => (
                      <tr key={c.id} className="border-b last:border-0 hover:bg-muted/40 transition-colors">
                        <td className="py-2 pr-4 font-mono text-xs text-muted-foreground whitespace-nowrap">
                          {format(new Date(c.crossingTime), "HH:mm:ss.SSS")}
                        </td>
                        <td className="py-2 pr-4">
                          <span className="font-mono font-bold bg-muted px-1.5 py-0.5 rounded text-xs border">{c.rfidNumber}</span>
                        </td>
                        <td className="py-2 pr-4 font-medium">
                          {c.riderName ?? <span className="text-muted-foreground italic text-xs">Unknown</span>}
                        </td>
                        <td className="py-2 pr-4">
                          <Badge variant="outline" className="font-mono font-bold text-xs">L{c.lapNumber}</Badge>
                        </td>
                        <td className="py-2 pr-4 font-mono font-bold text-primary">{c.lapTime ?? "—"}</td>
                        <td className="py-2 text-xs text-muted-foreground font-mono">{c.readerId ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
