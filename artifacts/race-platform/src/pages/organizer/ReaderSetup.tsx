import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Wifi, Copy, Check, Send, RefreshCw, Circle, Tag, Globe, Settings, PlayCircle,
  ClipboardList, FlaskConical, Download, WifiOff, ShieldCheck, Terminal, FileDown,
  Info, Timer, ChevronRight, ArrowLeft, Cpu, Zap, Radio, Anchor,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";

const BASE_URL = window.location.origin;
const GENERIC_ENDPOINT = `${BASE_URL}/api/timing/crossing`;
const MYLAPS_NATIVE_ENDPOINT_BASE = `${BASE_URL}/api/timing/mylaps-crossing`;
const FACILITY_ENDPOINT_BASE = `${BASE_URL}/api/timing/active/crossing`;

type RfidReader = "none" | "impinj-r700" | "zebra-fx7500" | "generic";

const READER_LABEL: Record<Exclude<RfidReader, "none">, string> = {
  "impinj-r700": "Impinj R700",
  "zebra-fx7500": "Zebra FX7500",
  "generic": "Generic / Other",
};

// ── Payload examples ──────────────────────────────────────────────────────────
const IMPINJ_PAYLOAD = `{
  "events": [
    {
      "type": "tagInventoryEvent",
      "tagInventoryEvent": {
        "epcHex": "300833B2DDD9014000000003",
        "antennaPort": 1,
        "peakRssiCdbm": -5325,
        "firstSeenTime": "2026-05-27T14:32:01.000000Z",
        "lastSeenTime": "2026-05-27T14:32:01.000000Z"
      }
    }
  ]
}`;

const ZEBRA_PAYLOAD = `{
  "data": {
    "type": "RFID",
    "id": "FX7500_0A1B2C",
    "timestamp": "2026-05-27T14:32:01.000Z",
    "tags": [
      {
        "idHex": "E2003411B802011820000D4E",
        "antennaPort": 1,
        "peakRssi": -54.0,
        "firstSeenTimestamp": "2026-05-27T14:32:01.000Z",
        "seenCount": 1
      }
    ]
  }
}`;

const GENERIC_PAYLOAD = `{
  "rfidNumber": "1A2B3C4D",
  "motoId": 12,
  "crossingTime": "2026-05-27T14:32:01.123456Z",
  "readerId": "finish-line-1",
  "antennaId": 1
}`;

export default function ReaderSetup() {
  const { toast } = useToast();
  const { user } = useAuth();

  // Facility (club-level) endpoint — set once, works for every future event
  const facilityEndpoint = user?.clubId
    ? `${FACILITY_ENDPOINT_BASE}?clubId=${user.clubId}`
    : `${FACILITY_ENDPOINT_BASE}?clubId=YOUR_CLUB_ID`;

  // ── Technology + reader selection ──────────────────────────────────────────
  const [tech, setTech] = useState<"none" | "rfid" | "mylaps">("none");
  const [rfidReader, setRfidReader] = useState<RfidReader>("none");
  const isMylaps = tech === "mylaps";
  const isNativeReader = rfidReader === "impinj-r700" || rfidReader === "zebra-fx7500";

  // ── Copy states ────────────────────────────────────────────────────────────
  const [copiedFacility, setCopiedFacility] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedPayload, setCopiedPayload] = useState(false);
  const [copiedAmbrcBody, setCopiedAmbrcBody] = useState(false);
  const [copiedRmonitor, setCopiedRmonitor] = useState(false);

  // ── Generic / test state ───────────────────────────────────────────────────
  const [testRfid, setTestRfid] = useState("");
  const [testReaderId, setTestReaderId] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; body: string } | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  // ── Native reader test state ───────────────────────────────────────────────
  const [nativeTestEpc, setNativeTestEpc] = useState("");
  const [nativeTestResult, setNativeTestResult] = useState<{ ok: boolean; body: string } | null>(null);
  const [nativeTestLoading, setNativeTestLoading] = useState(false);

  // ── AMBrc / MyLaps native state ────────────────────────────────────────────
  const [ambrcReaderId, setAmbrcReaderId] = useState("finish-line-1");
  const [mylapsTestTransponder, setMylapsTestTransponder] = useState("");
  const [mylapsTestResult, setMylapsTestResult] = useState<{ ok: boolean; body: string } | null>(null);
  const [mylapsTestLoading, setMylapsTestLoading] = useState(false);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const copyUrl = () => {
    navigator.clipboard.writeText(facilityEndpoint);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const copyPayloadExample = () => {
    const payload = rfidReader === "impinj-r700" ? IMPINJ_PAYLOAD
      : rfidReader === "zebra-fx7500" ? ZEBRA_PAYLOAD
      : GENERIC_PAYLOAD;
    navigator.clipboard.writeText(payload);
    setCopiedPayload(true);
    setTimeout(() => setCopiedPayload(false), 2000);
  };

  // Generic test crossing — fires at the facility endpoint, moto auto-discovered
  const sendTest = async () => {
    if (!testRfid) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      const body: Record<string, unknown> = { rfidNumber: testRfid };
      if (testReaderId) body.readerId = testReaderId;
      const res = await fetch(facilityEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setTestResult({ ok: res.ok, body: JSON.stringify(data, null, 2) });
      if (res.ok) {
        toast({ title: "Test crossing accepted", description: `Moto ${data.motoId} — Lap ${data.lapNumber ?? "?"}` });
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

  // MyLaps native test crossing — fires at the facility endpoint
  const sendMylapsNativeTest = async () => {
    if (!mylapsTestTransponder) return;
    setMylapsTestLoading(true);
    setMylapsTestResult(null);
    try {
      const body = {
        transponder: mylapsTestTransponder,
        passingTime: new Date().toISOString(),
        loopId: "finish-line-1",
      };
      const res = await fetch(facilityEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setMylapsTestResult({ ok: res.ok, body: JSON.stringify(data, null, 2) });
      if (res.ok) {
        if (data.debounced) {
          toast({ title: "Debounced (duplicate burst)", description: "Transponder was seen too recently — normal behaviour." });
        } else {
          toast({ title: "Test crossing accepted", description: `Moto ${data.motoId} — Lap ${data.lapNumber ?? "?"}` });
        }
      } else {
        toast({ title: "Crossing rejected", description: data.error, variant: "destructive" });
      }
    } catch (err: any) {
      setMylapsTestResult({ ok: false, body: err.message });
      toast({ title: "Request failed", description: err.message, variant: "destructive" });
    } finally {
      setMylapsTestLoading(false);
    }
  };

  // Native reader test crossing (Impinj or Zebra format) — fires at the facility endpoint
  const sendNativeTest = async () => {
    if (!nativeTestEpc) return;
    setNativeTestLoading(true);
    setNativeTestResult(null);
    try {
      let body: object;
      const now = new Date().toISOString();

      if (rfidReader === "impinj-r700") {
        body = {
          events: [{
            type: "tagInventoryEvent",
            tagInventoryEvent: {
              epcHex: nativeTestEpc,
              antennaPort: 1,
              peakRssiCdbm: -5325,
              firstSeenTime: now,
              lastSeenTime: now,
            },
          }],
        };
      } else {
        body = {
          data: {
            type: "RFID",
            id: "TEST_READER",
            timestamp: now,
            tags: [{
              idHex: nativeTestEpc,
              antennaPort: 1,
              peakRssi: -54.0,
              firstSeenTimestamp: now,
              seenCount: 1,
            }],
          },
        };
      }

      const res = await fetch(facilityEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setNativeTestResult({ ok: res.ok, body: JSON.stringify(data, null, 2) });
      if (res.ok) {
        const processed = data.results?.[0];
        if (processed?.debounced) {
          toast({ title: "Debounced (duplicate burst)", description: "Tag was read too recently — this is normal." });
        } else {
          toast({ title: "Test crossing accepted", description: `Moto ${data.motoId} — Lap ${processed?.lapNumber ?? "?"}` });
        }
      } else {
        toast({ title: "Crossing rejected", description: data.error, variant: "destructive" });
      }
    } catch (err: any) {
      setNativeTestResult({ ok: false, body: err.message });
      toast({ title: "Request failed", description: err.message, variant: "destructive" });
    } finally {
      setNativeTestLoading(false);
    }
  };

  // AMBrc body template — always available, no event selection needed
  const ambrcBodyTemplate = `{\n  "transponder": "%TRANSPONDER%",\n  "passingTime": "%PASSTIME_ISO%"${ambrcReaderId ? `,\n  "loopId": "${ambrcReaderId}"` : ""}\n}`;

  const copyAmbrcBody = () => {
    navigator.clipboard.writeText(ambrcBodyTemplate);
    setCopiedAmbrcBody(true);
    setTimeout(() => setCopiedAmbrcBody(false), 2000);
  };

  const downloadAmbrcConfig = () => {
    const config = {
      _readme: [
        "AMBrc HTTP Output Configuration — Rocky Mountain Race Platform",
        `Generated: ${new Date().toISOString()}`,
        "",
        "HOW TO USE IN AMBrc:",
        "  1. Open AMBrc → Settings → Passings Output → HTTP Output",
        "  2. Enable HTTP output / check 'Send passings via HTTP'",
        "  3. Set URL to the value in 'facilityEndpoint' below",
        "  4. Set Method to POST",
        "  5. Add header  Content-Type: application/json",
        "  6. Copy the JSON from 'bodyTemplate' into the Body / Template field",
        "  7. Save — you never need to change the URL or template between events or heats",
        "",
        "IMPORTANT: This uses the facility endpoint (/api/timing/active/crossing?clubId=N).",
        "The platform auto-discovers whichever moto is In Progress for your club.",
        "No eventId or motoId needed — the server resolves the active moto automatically.",
      ],
      facilityEndpoint,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      bodyTemplate: {
        transponder: "%TRANSPONDER%",
        passingTime: "%PASSTIME_ISO%",
        ...(ambrcReaderId ? { loopId: ambrcReaderId } : {}),
      },
      variableNotes: {
        "%TRANSPONDER%": "Transponder number / passing code — AMBrc built-in variable",
        "%PASSTIME_ISO%": "ISO 8601 hardware timestamp from the decoder's clock",
      },
    };
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ambrc-config.json";
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Config downloaded", description: "ambrc-config.json" });
  };

  // ── Step number helper ──────────────────────────────────────────────────────
  const Step = ({ n }: { n: number }) => (
    <div className="flex-shrink-0">
      <div className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-heading font-bold">{n}</div>
    </div>
  );

  // ══════════════════════════════════════════════════════════════════════════════
  // Screen 1 — Technology picker
  // ══════════════════════════════════════════════════════════════════════════════
  if (tech === "none") {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <div className="mb-10">
          <h1 className="text-4xl font-heading font-bold uppercase tracking-tight flex items-center gap-3">
            <Wifi className="text-primary" size={32} /> Reader Setup
          </h1>
          <p className="text-muted-foreground mt-1">
            Select the timing technology you are using — the setup instructions will adapt to your hardware.
          </p>
        </div>

        {/* ── Facility Endpoint — set once, never touch again ─────────────────── */}
        <div className="mb-8 rounded-xl border-2 border-primary/40 bg-primary/5 p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/15 flex items-center justify-center flex-shrink-0">
              <Anchor size={20} className="text-primary" />
            </div>
            <div>
              <h2 className="text-lg font-heading font-bold uppercase tracking-tight">Facility Endpoint — Set Once</h2>
              <p className="text-sm text-muted-foreground">
                Point your hardware at this URL one time. The platform automatically routes every crossing to whichever moto is currently running — no reconfiguring between events.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Your permanent crossing URL</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-background border border-border rounded-lg px-3 py-2.5 font-mono truncate text-primary">
                POST {facilityEndpoint}
              </code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(facilityEndpoint);
                  setCopiedFacility(true);
                  setTimeout(() => setCopiedFacility(false), 2000);
                }}
                className="flex-shrink-0 flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2.5 text-xs font-medium hover:bg-muted transition-colors"
              >
                {copiedFacility ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
                {copiedFacility ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div className="flex items-start gap-2 bg-background rounded-lg border border-border p-3">
              <Check size={13} className="text-green-500 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">All hardware formats</p>
                <p className="text-muted-foreground mt-0.5">Generic, Impinj, Zebra, AMBrc / MyLaps — one URL handles them all</p>
              </div>
            </div>
            <div className="flex items-start gap-2 bg-background rounded-lg border border-border p-3">
              <Check size={13} className="text-green-500 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Auto-routes to active moto</p>
                <p className="text-muted-foreground mt-0.5">Heats, LCQs, mains — server finds whatever is in progress</p>
              </div>
            </div>
            <div className="flex items-start gap-2 bg-background rounded-lg border border-border p-3">
              <Check size={13} className="text-green-500 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Move tracks freely</p>
                <p className="text-muted-foreground mt-0.5">If you change facilities, the URL stays the same — only the hardware moves</p>
              </div>
            </div>
          </div>

          {user?.clubId && (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Info size={12} />
              Your club ID is <span className="font-mono font-bold text-foreground">{user.clubId}</span> — this is already embedded in the URL above.
            </p>
          )}
        </div>

        <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">Choose your hardware type for detailed setup instructions</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* RFID card */}
          <button
            onClick={() => setTech("rfid")}
            className="group text-left rounded-xl border-2 border-border hover:border-primary bg-card hover:bg-primary/5 p-6 transition-all duration-150 space-y-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <div className="flex items-start justify-between">
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                <Wifi size={24} className="text-primary" />
              </div>
              <ChevronRight size={20} className="text-muted-foreground group-hover:text-primary transition-colors mt-1" />
            </div>
            <div>
              <h2 className="text-xl font-heading font-bold uppercase tracking-tight">RFID / UHF Readers</h2>
              <p className="text-sm text-muted-foreground mt-1.5">
                Fixed-mount UHF readers with passive sticker tags on helmets or bikes.
              </p>
            </div>
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              <li className="flex items-center gap-2"><Check size={12} className="text-primary shrink-0" /> Impinj R700 — native IoT Connector support</li>
              <li className="flex items-center gap-2"><Check size={12} className="text-primary shrink-0" /> Zebra FX7500 — native IoT Connector support</li>
              <li className="flex items-center gap-2"><Check size={12} className="text-primary shrink-0" /> Generic HTTP POST readers — any brand</li>
              <li className="flex items-center gap-2"><Check size={12} className="text-primary shrink-0" /> Offline-safe Python bridge included</li>
            </ul>
            <div className="pt-1">
              <span className="inline-flex items-center gap-1.5 bg-primary text-primary-foreground text-xs font-heading font-bold uppercase tracking-wider px-4 py-2 rounded-lg group-hover:bg-primary/90 transition-colors">
                Select RFID <ChevronRight size={13} />
              </span>
            </div>
          </button>

          {/* MyLaps card */}
          <button
            onClick={() => setTech("mylaps")}
            className="group text-left rounded-xl border-2 border-border hover:border-primary bg-card hover:bg-primary/5 p-6 transition-all duration-150 space-y-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <div className="flex items-start justify-between">
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                <Timer size={24} className="text-primary" />
              </div>
              <ChevronRight size={20} className="text-muted-foreground group-hover:text-primary transition-colors mt-1" />
            </div>
            <div>
              <h2 className="text-xl font-heading font-bold uppercase tracking-tight">MyLaps / AMB Transponders</h2>
              <p className="text-sm text-muted-foreground mt-1.5">
                Active transponders carried by riders, read by AMB / MyLaps loop decoders.
              </p>
            </div>
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              <li className="flex items-center gap-2"><Check size={12} className="text-primary shrink-0" /> AMB TranX, AMB RC4, MyLaps X2, P3 Flex</li>
              <li className="flex items-center gap-2"><Check size={12} className="text-primary shrink-0" /> Works with AMBrc ≥ 5 and Orbits 4</li>
              <li className="flex items-center gap-2"><Check size={12} className="text-primary shrink-0" /> Numeric transponder IDs, standard protocol</li>
              <li className="flex items-center gap-2"><Check size={12} className="text-primary shrink-0" /> AMBrc config generator + downloadable file</li>
            </ul>
            <div className="pt-1">
              <span className="inline-flex items-center gap-1.5 bg-primary text-primary-foreground text-xs font-heading font-bold uppercase tracking-wider px-4 py-2 rounded-lg group-hover:bg-primary/90 transition-colors">
                Select MyLaps <ChevronRight size={13} />
              </span>
            </div>
          </button>
        </div>

        <p className="text-xs text-muted-foreground text-center mt-8">
          Not sure? Check the timing technology set on your event — it's shown in the event creation form.
        </p>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Screen 2 — RFID reader model sub-picker
  // ══════════════════════════════════════════════════════════════════════════════
  if (tech === "rfid" && rfidReader === "none") {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <div className="mb-8">
          <button
            onClick={() => setTech("none")}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
          >
            <ArrowLeft size={15} /> Back to technology selection
          </button>
          <h1 className="text-4xl font-heading font-bold uppercase tracking-tight flex items-center gap-3">
            <Wifi className="text-primary" size={32} /> Select Your Reader
          </h1>
          <p className="text-muted-foreground mt-1">
            Pick your specific reader model — the setup instructions, endpoint format, and configuration steps will adapt to match it exactly.
          </p>
        </div>

        <div className="space-y-4">
          {/* Impinj R700 */}
          <button
            onClick={() => setRfidReader("impinj-r700")}
            className="group w-full text-left rounded-xl border-2 border-border hover:border-primary bg-card hover:bg-primary/5 p-5 transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors shrink-0">
                <Zap size={22} className="text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-lg font-heading font-bold uppercase tracking-tight">Impinj R700</h2>
                  <Badge className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 border-green-300 dark:border-green-700 text-[10px] font-bold uppercase tracking-wider">Recommended</Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Industry-leading UHF reader with native IoT Connector webhook support. Auto-discovers your active moto — no manual motoId needed.
                </p>
                <p className="text-xs text-muted-foreground mt-1.5">
                  Uses endpoint: <code className="font-mono bg-muted px-1 rounded">/api/timing/impinj-crossing?eventId=N</code>
                </p>
              </div>
              <ChevronRight size={20} className="text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
            </div>
          </button>

          {/* Zebra FX7500 */}
          <button
            onClick={() => setRfidReader("zebra-fx7500")}
            className="group w-full text-left rounded-xl border-2 border-border hover:border-primary bg-card hover:bg-primary/5 p-5 transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors shrink-0">
                <Cpu size={22} className="text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-lg font-heading font-bold uppercase tracking-tight">Zebra FX7500</h2>
                  <Badge variant="secondary" className="text-[10px] font-bold uppercase tracking-wider">Budget Pick</Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Enterprise-grade fixed reader with Zebra IoT Connector. Native format support — auto-discovers active moto by eventId.
                </p>
                <p className="text-xs text-muted-foreground mt-1.5">
                  Uses endpoint: <code className="font-mono bg-muted px-1 rounded">/api/timing/zebra-crossing?eventId=N</code>
                </p>
              </div>
              <ChevronRight size={20} className="text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
            </div>
          </button>

          {/* Generic */}
          <button
            onClick={() => setRfidReader("generic")}
            className="group w-full text-left rounded-xl border-2 border-border hover:border-primary bg-card hover:bg-primary/5 p-5 transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors shrink-0">
                <Wifi size={22} className="text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-lg font-heading font-bold uppercase tracking-tight">Generic / Other</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Any UHF reader with HTTP POST output. Sends our standard JSON format — you include <code className="font-mono bg-muted px-1 rounded text-xs">rfidNumber</code> + <code className="font-mono bg-muted px-1 rounded text-xs">motoId</code> in every request.
                </p>
                <p className="text-xs text-muted-foreground mt-1.5">
                  Compatible with: Alien ALR-9900, Speedway Revolution, Arduino/Pi builds, custom firmware
                </p>
              </div>
              <ChevronRight size={20} className="text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
            </div>
          </button>
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Screen 3 — Setup instructions (RFID or MyLaps)
  // ══════════════════════════════════════════════════════════════════════════════

  const readerLabel = !isMylaps && rfidReader !== "none" ? READER_LABEL[rfidReader as Exclude<RfidReader, "none">] : null;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-8">

      {/* Header */}
      <div>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-4xl font-heading font-bold uppercase tracking-tight flex items-center gap-3">
              {isMylaps ? <Timer className="text-primary" size={32} /> : <Wifi className="text-primary" size={32} />}
              Reader Setup
            </h1>
            <p className="text-muted-foreground mt-1">
              {isMylaps
                ? "Configure your MyLaps / AMB decoder to push lap crossings to this platform."
                : isNativeReader
                ? `Configure your ${readerLabel} to push lap crossings in its native format — no custom payload mapping needed.`
                : "Configure your RFID reader to push lap crossings using our standard JSON format."}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap mt-1">
            {!isMylaps && rfidReader !== "none" && (
              <button
                onClick={() => setRfidReader("none")}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0"
              >
                <ArrowLeft size={14} />
                <span>
                  Change reader
                  <span className="ml-2 inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                    {readerLabel}
                  </span>
                </span>
              </button>
            )}
            <button
              onClick={() => { setTech("none"); setRfidReader("none"); }}
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0"
            >
              <ArrowLeft size={15} />
              <span>
                Change technology
                <span className={`ml-2 inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${isMylaps ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300" : "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300"}`}>
                  {isMylaps ? <Timer size={10} /> : <Wifi size={10} />}
                  {isMylaps ? "MyLaps" : "RFID"}
                </span>
              </span>
            </button>
          </div>
        </div>

        {/* Native reader info banner */}
        {isNativeReader && (
          <div className="mt-4 flex items-start gap-2 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800/40 rounded-lg px-4 py-3 text-sm text-green-800 dark:text-green-300">
            <Zap size={16} className="shrink-0 mt-0.5 text-green-600 dark:text-green-400" />
            <div>
              <span className="font-semibold">Native format mode.</span>{" "}
              The {readerLabel} sends its own JSON format — you don't need to configure a custom payload template.
              Just enter your event ID in the URL and the platform automatically finds whichever moto is in progress.
            </div>
          </div>
        )}
      </div>

      {/* Setup Guide */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <CardTitle className="font-heading uppercase tracking-wider text-base">Setup Guide</CardTitle>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isMylaps
              ? "Compatible with AMBrc and Orbits 4 software connected to any AMB / MyLaps decoder."
              : isNativeReader
              ? `Step-by-step guide for the ${readerLabel}. From unboxed hardware to live lap times.`
              : "Any RFID reader that can send HTTP POST requests over the network is compatible."}
          </p>
        </CardHeader>
        <CardContent className="pt-5 space-y-0 divide-y">

          {isMylaps ? (
            <>
              {/* MyLaps steps — native endpoint, no motoId needed */}
              <div className="flex gap-4 py-5 first:pt-0">
                <Step n={1} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><Globe size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Connect the decoder to your network</p></div>
                  <p className="text-sm text-muted-foreground">Power on your AMB / MyLaps decoder and connect it via Ethernet to your race-day router. The decoder needs a valid IP address and must be able to reach the cloud API URL. Note the decoder's IP address for AMBrc / Orbits 4 configuration.</p>
                  <div className="bg-muted/60 border rounded-md px-3 py-2 text-xs text-muted-foreground mt-2"><span className="font-bold text-foreground">Tip:</span> Assign a static IP to the decoder via your router's DHCP reservation feature so the address stays consistent across events.</div>
                </div>
              </div>
              <div className="flex gap-4 py-5">
                <Step n={2} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><Tag size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Assign transponder numbers to riders</p></div>
                  <p className="text-sm text-muted-foreground">Use the <span className="font-semibold text-foreground">Transponder Management</span> page in the sidebar to link each rider's MyLaps transponder number to their profile. The number is the 4–8 digit numeric ID printed on or programmed into each unit.</p>
                  <div className="bg-muted/60 border rounded-md px-3 py-2 text-xs text-muted-foreground mt-2"><span className="font-bold text-foreground">Note:</span> Crossings from unregistered transponders are still recorded as "Unknown." You can link them at any time — past crossings update automatically.</div>
                </div>
              </div>
              <div className="flex gap-4 py-5">
                <Step n={3} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><ClipboardList size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Create your event in this platform</p></div>
                  <p className="text-sm text-muted-foreground">In <span className="font-semibold text-foreground">Events</span>, create the race event (select <span className="font-semibold text-foreground">MyLaps Transponders</span> as timing technology). Note the <span className="font-semibold text-foreground">Event ID</span> — you'll embed it once in the endpoint URL. On the <span className="font-semibold text-foreground">Motos</span> tab, add a moto for each class / heat.</p>
                  <div className="bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800/40 rounded-md px-3 py-2 text-xs text-green-800 dark:text-green-300 mt-2 flex gap-2">
                    <Zap size={12} className="shrink-0 mt-0.5 text-green-600 dark:text-green-400" />
                    <span><span className="font-bold">Set it once.</span> The native endpoint auto-detects the active moto — you never need to update the URL or body template between heats.</span>
                  </div>
                </div>
              </div>
              <div className="flex gap-4 py-5">
                <Step n={4} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><Settings size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Configure AMBrc HTTP output with the native endpoint</p></div>
                  <p className="text-sm text-muted-foreground">In AMBrc, navigate to <span className="font-semibold text-foreground">Settings → Passings Output → HTTP Output</span>. Use these settings:</p>
                  <ol className="text-sm text-muted-foreground space-y-1.5 mt-2 ml-1 list-decimal list-inside">
                    <li>Enable HTTP output / check <span className="font-semibold text-foreground">Send passings via HTTP</span>.</li>
                    <li>Set <span className="font-semibold text-foreground">URL</span> to the native endpoint from the section below (includes your <code className="font-mono bg-muted px-1 rounded text-xs">?eventId=N</code>).</li>
                    <li>Set <span className="font-semibold text-foreground">Method</span> to <span className="font-semibold text-foreground">POST</span>.</li>
                    <li>Add header: <code className="font-mono bg-muted px-1 rounded text-xs">Content-Type: application/json</code>.</li>
                    <li>Set body template to just: <code className="font-mono bg-muted px-1 rounded text-xs">{"{"}"transponder": "%TRANSPONDER%", "passingTime": "%PASSTIME_ISO%"{"}"}</code></li>
                    <li>Save. That's it — you never need to change the URL or body again.</li>
                  </ol>
                  <div className="bg-muted/60 border rounded-md px-3 py-2 text-xs text-muted-foreground mt-2"><span className="font-bold text-foreground">Compatible decoders:</span> AMB TranX, AMB RC4, AMB MX, MyLaps X2, P3 Flex (AMBrc ≥ 5 or Orbits 4).</div>
                </div>
              </div>
              <div className="flex gap-4 py-5">
                <Step n={5} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><PlayCircle size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Start each moto before the gate drops</p></div>
                  <p className="text-sm text-muted-foreground">On the event's <span className="font-semibold text-foreground">Motos</span> tab, set the moto to <span className="font-semibold text-foreground">In Progress</span> immediately before the start. The platform only accepts crossings while a moto is in progress — crossings received when none is active return <code className="font-mono bg-muted px-1 rounded text-xs">409</code>. End each moto when the heat finishes so the next one can begin.</p>
                </div>
              </div>
              <div className="flex gap-4 py-5 last:pb-0">
                <Step n={6} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><FlaskConical size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Test the connection</p></div>
                  <p className="text-sm text-muted-foreground">Use the <span className="font-semibold text-foreground">Test Connection</span> tool below to fire a simulated transponder crossing in native AMBrc format. Select your event, enter a transponder number, and click <span className="font-semibold text-foreground">Send Test Crossing</span>. A green "Accepted" confirms the endpoint is live and the active moto is being scored.</p>
                </div>
              </div>
            </>
          ) : rfidReader === "impinj-r700" ? (
            <>
              <div className="flex gap-4 py-5 first:pt-0">
                <Step n={1} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><Globe size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Connect the R700 to your race-day network</p></div>
                  <p className="text-sm text-muted-foreground">Plug the R700 into your race-day router via Ethernet. Power it on — the reader broadcasts a setup Wi-Fi network (<code className="font-mono bg-muted px-1 rounded">ImpinjSetup-XXXXXX</code>) by default until you configure it. Connect your laptop to that network to reach the reader's web interface.</p>
                  <div className="bg-muted/60 border rounded-md px-3 py-2 text-xs text-muted-foreground mt-2"><span className="font-bold text-foreground">Default address:</span> <code className="font-mono">http://192.168.1.1</code> on the setup network, or use the IP assigned by your router once connected via Ethernet. Impinj IoT Connector UI is on port 80.</div>
                </div>
              </div>
              <div className="flex gap-4 py-5">
                <Step n={2} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><Tag size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Assign RFID tags to riders</p></div>
                  <p className="text-sm text-muted-foreground">Go to <span className="font-semibold text-foreground">Riders</span> in the sidebar and open each rider's profile. Enter the EPC printed on their tag (e.g. <code className="font-mono bg-muted px-1 rounded">300833B2DDD9014000000003</code>) in the RFID field. The R700 reports the tag's EPC hex string — that's the identifier you're linking here.</p>
                  <div className="bg-muted/60 border rounded-md px-3 py-2 text-xs text-muted-foreground mt-2"><span className="font-bold text-foreground">Tip:</span> Scan each tag through the R700's test mode (in the IoT Connector UI → Tags tab) to see the exact EPC string before race day — copy/paste it into the rider profile to avoid typos.</div>
                </div>
              </div>
              <div className="flex gap-4 py-5">
                <Step n={3} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><ClipboardList size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Create your event in this platform</p></div>
                  <p className="text-sm text-muted-foreground">In <span className="font-semibold text-foreground">Events</span>, create your race event (set timing technology to <span className="font-semibold text-foreground">RFID</span>). Note the event ID — you'll embed it in the endpoint URL in the next step. On the <span className="font-semibold text-foreground">Motos</span> tab, add a moto for each class / heat.</p>
                  <div className="bg-muted/60 border rounded-md px-3 py-2 text-xs text-muted-foreground mt-2"><span className="font-bold text-foreground">Key difference vs. generic readers:</span> The R700 sends one endpoint URL for the whole event. The platform automatically scores crossings against whichever moto is currently In Progress — you never need to update the URL between heats.</div>
                </div>
              </div>
              <div className="flex gap-4 py-5">
                <Step n={4} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><Settings size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Configure the Impinj IoT Connector for HTTP output</p></div>
                  <p className="text-sm text-muted-foreground">In the R700's web interface (IoT Connector UI):</p>
                  <ol className="text-sm text-muted-foreground space-y-1.5 mt-2 ml-1 list-decimal list-inside">
                    <li>Go to <span className="font-semibold text-foreground">Operation → [Reader Name] → Profiles</span> and ensure an inventory profile is active.</li>
                    <li>Go to <span className="font-semibold text-foreground">Operation → [Reader Name] → Event Output</span>.</li>
                    <li>Set <span className="font-semibold text-foreground">Delivery Mode</span> to <span className="font-semibold text-foreground">HTTP POST</span>.</li>
                    <li>Paste the endpoint URL from the section below into the <span className="font-semibold text-foreground">HTTP Destination</span> field.</li>
                    <li>Set <span className="font-semibold text-foreground">Format</span> to <span className="font-semibold text-foreground">JSON</span>.</li>
                    <li>Leave auth headers blank (the platform validates by <code className="font-mono bg-muted px-1 rounded text-xs">eventId</code>).</li>
                    <li>Click <span className="font-semibold text-foreground">Save & Apply</span>.</li>
                  </ol>
                  <div className="bg-muted/60 border rounded-md px-3 py-2 text-xs text-muted-foreground mt-2"><span className="font-bold text-foreground">Antenna setup:</span> Set antenna power to 30 dBm for outdoor finish arch. Mount antennas facing down from the crossbar at roughly 2 m height, one per side. Test reads at race speed before the event.</div>
                </div>
              </div>
              <div className="flex gap-4 py-5">
                <Step n={5} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><PlayCircle size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Start each moto before the gate drops</p></div>
                  <p className="text-sm text-muted-foreground">On the event's <span className="font-semibold text-foreground">Motos</span> tab, set the moto to <span className="font-semibold text-foreground">In Progress</span> immediately before the start. The platform only accepts crossings while a moto is in progress — crossings received when no moto is active return a <code className="font-mono bg-muted px-1 rounded text-xs">409</code>. End each moto when the heat finishes.</p>
                </div>
              </div>
              <div className="flex gap-4 py-5 last:pb-0">
                <Step n={6} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><FlaskConical size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Test with a live tag read or the simulator below</p></div>
                  <p className="text-sm text-muted-foreground">Use the <span className="font-semibold text-foreground">Test Connection</span> section below to send a simulated Impinj-format crossing. Select your event, enter a tag EPC, and click <span className="font-semibold text-foreground">Send Test</span>. A successful response confirms the endpoint is reachable and the platform is scoring correctly.</p>
                </div>
              </div>
            </>
          ) : rfidReader === "zebra-fx7500" ? (
            <>
              <div className="flex gap-4 py-5 first:pt-0">
                <Step n={1} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><Globe size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Connect the FX7500 to your network</p></div>
                  <p className="text-sm text-muted-foreground">Plug the FX7500 into your race-day router via Ethernet. The reader gets a DHCP address — check your router's client list or use the Zebra IP Discovery Utility to find it. Access the web UI at <code className="font-mono bg-muted px-1 rounded">http://reader-ip</code> (default login: <code className="font-mono bg-muted px-1 rounded">admin / change</code>).</p>
                  <div className="bg-muted/60 border rounded-md px-3 py-2 text-xs text-muted-foreground mt-2"><span className="font-bold text-foreground">Tip:</span> Assign the reader a static IP (via DHCP reservation) so the address stays consistent across race days.</div>
                </div>
              </div>
              <div className="flex gap-4 py-5">
                <Step n={2} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><Tag size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Assign RFID tags to riders</p></div>
                  <p className="text-sm text-muted-foreground">Go to <span className="font-semibold text-foreground">Riders</span> in the sidebar and enter each rider's tag EPC (the <code className="font-mono bg-muted px-1 rounded">idHex</code> value the FX7500 reports, e.g. <code className="font-mono bg-muted px-1 rounded">E2003411B802011820000D4E</code>). Use the FX7500's inventory test in its web UI to pre-scan tags and confirm the exact EPC string.</p>
                </div>
              </div>
              <div className="flex gap-4 py-5">
                <Step n={3} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><ClipboardList size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Create your event in this platform</p></div>
                  <p className="text-sm text-muted-foreground">In <span className="font-semibold text-foreground">Events</span>, create your race event with timing technology set to <span className="font-semibold text-foreground">RFID</span>. Note the event ID — you'll embed it in the endpoint URL. Add motos on the <span className="font-semibold text-foreground">Motos</span> tab. The FX7500 endpoint URL stays the same for the whole event — the platform auto-detects the active moto.</p>
                </div>
              </div>
              <div className="flex gap-4 py-5">
                <Step n={4} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><Settings size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Configure the Zebra IoT Connector</p></div>
                  <p className="text-sm text-muted-foreground">In the FX7500 web interface:</p>
                  <ol className="text-sm text-muted-foreground space-y-1.5 mt-2 ml-1 list-decimal list-inside">
                    <li>Go to <span className="font-semibold text-foreground">Settings → IoT Connector</span> (install the Zebra IoT Connector application if not already present).</li>
                    <li>Under <span className="font-semibold text-foreground">HTTP Push Client</span>, set <span className="font-semibold text-foreground">Server URL</span> to the endpoint shown below.</li>
                    <li>Set <span className="font-semibold text-foreground">HTTP Method</span> to <span className="font-semibold text-foreground">POST</span>.</li>
                    <li>Set <span className="font-semibold text-foreground">Content-Type</span> header to <code className="font-mono bg-muted px-1 rounded text-xs">application/json</code>.</li>
                    <li>Enable <span className="font-semibold text-foreground">Send tag reports</span> and set the report interval to match your desired update frequency (1–2 seconds recommended).</li>
                    <li>Save and start the IoT Connector application.</li>
                  </ol>
                  <div className="bg-muted/60 border rounded-md px-3 py-2 text-xs text-muted-foreground mt-2"><span className="font-bold text-foreground">Antenna power:</span> Set to 27–30 dBm for an outdoor finish arch. Mount antennas at approximately 2 m height, positioned to read tags on helmets as riders pass beneath.</div>
                </div>
              </div>
              <div className="flex gap-4 py-5">
                <Step n={5} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><PlayCircle size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Start each moto before the gate drops</p></div>
                  <p className="text-sm text-muted-foreground">On the event's <span className="font-semibold text-foreground">Motos</span> tab, set the moto to <span className="font-semibold text-foreground">In Progress</span> immediately before the start. Crossings received when no moto is active return <code className="font-mono bg-muted px-1 rounded text-xs">409</code>. End each moto when the heat finishes.</p>
                </div>
              </div>
              <div className="flex gap-4 py-5 last:pb-0">
                <Step n={6} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><FlaskConical size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Test with the simulator below</p></div>
                  <p className="text-sm text-muted-foreground">Use the <span className="font-semibold text-foreground">Test Connection</span> section below to send a simulated Zebra-format crossing. Select your event, enter a tag EPC, and click <span className="font-semibold text-foreground">Send Test</span>. A successful response confirms the pipeline is working end-to-end.</p>
                </div>
              </div>
            </>
          ) : (
            /* Generic RFID steps */
            <>
              <div className="flex gap-4 py-5 first:pt-0">
                <Step n={1} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><Globe size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Connect the reader to your scoring computer</p></div>
                  <p className="text-sm text-muted-foreground">Readers can connect over Ethernet / Wi-Fi or via USB. For network readers: plug into your race-day router and confirm the reader has a valid IP. For USB readers: install manufacturer drivers and use a serial-to-HTTP bridge to forward tag reads as POST requests.</p>
                  <div className="bg-muted/60 border rounded-md px-3 py-2 text-xs text-muted-foreground mt-2"><span className="font-bold text-foreground">Offline option:</span> On a private field network, host the platform locally and point the reader at <code className="font-mono">http://&lt;laptop-ip&gt;/api/timing/crossing</code>.</div>
                </div>
              </div>
              <div className="flex gap-4 py-5">
                <Step n={2} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><Tag size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Assign RFID tags to riders</p></div>
                  <p className="text-sm text-muted-foreground">Go to <span className="font-semibold text-foreground">Riders</span> in the sidebar and enter each rider's tag ID (e.g. <code className="font-mono bg-muted px-1 rounded">1A2B3C4D</code>) in the RFID Tag field. Crossings from unassigned tags are still recorded as "Unknown" and can be linked at any time.</p>
                </div>
              </div>
              <div className="flex gap-4 py-5">
                <Step n={3} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><ClipboardList size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Create your event and motos</p></div>
                  <p className="text-sm text-muted-foreground">In <span className="font-semibold text-foreground">Events</span>, create the race event. On the <span className="font-semibold text-foreground">Motos</span> tab, add a moto for each class / heat. The facility endpoint auto-routes to whichever moto is currently In Progress — no moto ID needed in your payload.</p>
                </div>
              </div>
              <div className="flex gap-4 py-5">
                <Step n={4} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><Settings size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Configure the reader's HTTP output</p></div>
                  <p className="text-sm text-muted-foreground">In your reader's configuration software, set output type to <span className="font-semibold text-foreground">HTTP POST</span>. Set Content-Type to <code className="font-mono bg-muted px-1 rounded">application/json</code> and configure the JSON body to include at minimum:</p>
                  <ul className="text-sm text-muted-foreground space-y-1 mt-1 ml-4 list-disc">
                    <li><code className="font-mono bg-muted px-1 rounded text-xs">rfidNumber</code> — tag ID reported by the reader</li>
                    <li><code className="font-mono bg-muted px-1 rounded text-xs">crossingTime</code> — ISO 8601 timestamp (optional; server time used if omitted)</li>
                    <li><code className="font-mono bg-muted px-1 rounded text-xs">readerId</code> — e.g. <code className="font-mono bg-muted px-1 rounded text-xs">"finish-line-1"</code> (optional, for diagnostics)</li>
                  </ul>
                  <div className="bg-muted/60 border rounded-md px-3 py-2 text-xs text-muted-foreground mt-2"><span className="font-bold text-foreground">Common readers:</span> Alien ALR-9900, Impinj Speedway Revolution (legacy), Zebra FX Series (generic mode), Arduino / Raspberry Pi builds.</div>
                </div>
              </div>
              <div className="flex gap-4 py-5">
                <Step n={5} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><PlayCircle size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Start the moto before each heat</p></div>
                  <p className="text-sm text-muted-foreground">On the event's <span className="font-semibold text-foreground">Motos</span> tab, set the moto to <span className="font-semibold text-foreground">In Progress</span> before the gate drops. Crossings are only accepted while in progress — crossings sent outside that window are rejected with <code className="font-mono bg-muted px-1 rounded text-xs">409</code>.</p>
                </div>
              </div>
              <div className="flex gap-4 py-5 last:pb-0">
                <Step n={6} />
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2"><FlaskConical size={15} className="text-primary shrink-0" /><p className="font-semibold text-sm">Test the connection</p></div>
                  <p className="text-sm text-muted-foreground">Use the <span className="font-semibold text-foreground">Test Connection</span> tool below. Enter a known tag number and click <span className="font-semibold text-foreground">Send Test Crossing</span>. A green "Accepted" response confirms everything is wired up correctly (a moto must be In Progress to accept the crossing).</p>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* AMBrc Config Generator — MyLaps only */}
      {isMylaps && (
        <Card>
          <CardHeader className="pb-3 border-b">
            <div className="flex items-center gap-2">
              <FileDown size={18} className="text-primary shrink-0" />
              <CardTitle className="font-heading uppercase tracking-wider text-base">AMBrc Output Configuration</CardTitle>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Set AMBrc once — the facility endpoint auto-routes to whichever moto is In Progress for your club. No event ID or moto ID needed.
            </p>
          </CardHeader>
          <CardContent className="pt-5 space-y-5">
            <div className="space-y-1.5 max-w-xs">
              <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Loop / Reader ID (optional)</label>
              <Input value={ambrcReaderId} onChange={e => setAmbrcReaderId(e.target.value)} placeholder="e.g. finish-line-1" className="font-mono h-11" />
            </div>

            {/* Facility endpoint */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Endpoint URL</p>
                <Badge className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 border-green-300 dark:border-green-700 text-[10px] font-bold uppercase tracking-wider">Set Once</Badge>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 font-mono text-xs bg-muted px-3 py-2.5 rounded border overflow-x-auto">
                  {facilityEndpoint}
                </code>
                <Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText(facilityEndpoint); toast({ title: "Copied!" }); }} className="shrink-0 gap-1.5"><Copy size={13} /> Copy</Button>
              </div>
              <div className="bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800/40 rounded-md px-3 py-2 text-xs text-green-800 dark:text-green-300 flex gap-2">
                <Zap size={12} className="shrink-0 mt-0.5 text-green-600 dark:text-green-400" />
                <span>Set this URL in AMBrc once — it works for every event and heat. The server finds whichever moto is In Progress for your club automatically.</span>
              </div>
            </div>

            {/* Body template */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">JSON Body Template</p>
                <Button variant="outline" size="sm" onClick={copyAmbrcBody} className="gap-1.5">{copiedAmbrcBody ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}</Button>
              </div>
              <pre className="bg-muted font-mono text-xs p-4 rounded border whitespace-pre overflow-x-auto leading-relaxed">{ambrcBodyTemplate}</pre>
              <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700/40 rounded-md px-3 py-2 text-xs text-blue-800 dark:text-blue-300 flex gap-2">
                <Info size={13} className="shrink-0 mt-0.5" />
                <span><span className="font-bold">%TRANSPONDER%</span> and <span className="font-bold">%PASSTIME_ISO%</span> are AMBrc built-in template variables. No <code className="font-mono">motoId</code> or <code className="font-mono">eventId</code> needed — the facility endpoint handles routing automatically.</span>
              </div>
            </div>

            {/* Download */}
            <div className="flex items-center gap-3 pt-1">
              <Button onClick={downloadAmbrcConfig} className="font-heading uppercase tracking-wider h-11 px-6 gap-2"><FileDown size={16} /> Download Config Reference</Button>
              <p className="text-xs text-muted-foreground">Saves a JSON reference file — open it on your scoring computer while configuring AMBrc.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Local Bridge — RFID only */}
      {!isMylaps && (
        <Card className="border-amber-200 dark:border-amber-800/60 bg-amber-50/50 dark:bg-amber-950/20">
          <CardHeader className="pb-3 border-b border-amber-200 dark:border-amber-800/40">
            <div className="flex items-center gap-2">
              <WifiOff size={18} className="text-amber-600 dark:text-amber-400 shrink-0" />
              <CardTitle className="font-heading uppercase tracking-wider text-base">Poor Track Internet? Use the Local Bridge</CardTitle>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Cell signal at outdoor venues is unreliable. The <strong>Local RFID Bridge</strong> is a free Python script you run on your scoring laptop. It caches every lap locally and automatically replays them — with original hardware timestamps — the moment connectivity is restored.
            </p>
          </CardHeader>
          <CardContent className="pt-5 space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div className="flex flex-col gap-1.5 bg-background rounded-lg border p-3">
                <div className="flex items-center gap-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground"><ShieldCheck size={13} className="text-green-500" /> When online</div>
                <p className="text-muted-foreground text-xs">Tag reads forwarded to the cloud instantly. Zero latency change vs. direct reader → cloud.</p>
              </div>
              <div className="flex flex-col gap-1.5 bg-background rounded-lg border p-3">
                <div className="flex items-center gap-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground"><WifiOff size={13} className="text-amber-500" /> When offline</div>
                <p className="text-muted-foreground text-xs">Crossings queued in a local SQLite file. Reader gets instant 200 OK so it keeps firing.</p>
              </div>
              <div className="flex flex-col gap-1.5 bg-background rounded-lg border p-3">
                <div className="flex items-center gap-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground"><Wifi size={13} className="text-blue-500" /> On reconnect</div>
                <p className="text-muted-foreground text-xs">Bridge replays the cache in chronological order using the reader's original timestamps.</p>
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Setup (3 steps)</p>
              <div className="space-y-2 text-sm">
                <div className="flex gap-3 items-start">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold mt-0.5">1</span>
                  <div>
                    <p className="font-medium">Install Python 3.8+ and download the bridge script</p>
                    <p className="text-muted-foreground text-xs mt-0.5">Python is free at <code className="font-mono bg-muted px-1 rounded">python.org</code>. No extra packages needed — standard library only.</p>
                    <a href="/rfid_bridge.py" download="rfid_bridge.py" className="inline-flex items-center gap-1.5 mt-2 bg-primary text-primary-foreground hover:bg-primary/90 text-xs font-heading uppercase tracking-wider px-3 py-1.5 rounded-md transition-colors">
                      <Download size={13} /> Download rfid_bridge.py
                    </a>
                  </div>
                </div>

                <div className="flex gap-3 items-start">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold mt-0.5">2</span>
                  <div>
                    <p className="font-medium">Run the bridge on your scoring laptop</p>
                    <p className="text-muted-foreground text-xs mt-0.5">Open a terminal in the folder where you saved the script and run:</p>
                    {rfidReader === "impinj-r700" && (
                      <pre className="mt-1.5 bg-gray-900 text-green-400 font-mono text-xs px-3 py-2 rounded border border-gray-700 overflow-x-auto">
{`python rfid_bridge.py --api-url ${BASE_URL} --reader impinj-r700 --club-id ${user?.clubId ?? "YOUR_CLUB_ID"}`}
                      </pre>
                    )}
                    {rfidReader === "zebra-fx7500" && (
                      <pre className="mt-1.5 bg-gray-900 text-green-400 font-mono text-xs px-3 py-2 rounded border border-gray-700 overflow-x-auto">
{`python rfid_bridge.py --api-url ${BASE_URL} --reader zebra-fx7500 --club-id ${user?.clubId ?? "YOUR_CLUB_ID"}`}
                      </pre>
                    )}
                    {rfidReader === "generic" && (
                      <pre className="mt-1.5 bg-gray-900 text-green-400 font-mono text-xs px-3 py-2 rounded border border-gray-700 overflow-x-auto">
{`python rfid_bridge.py --api-url ${BASE_URL} --club-id ${user?.clubId ?? "YOUR_CLUB_ID"}`}
                      </pre>
                    )}
                    <p className="text-muted-foreground text-xs mt-1.5">Status page appears at <code className="font-mono bg-muted px-1 rounded">http://localhost:5555</code> showing live sync counts.</p>
                  </div>
                </div>

                <div className="flex gap-3 items-start">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold mt-0.5">3</span>
                  <div>
                    <p className="font-medium">Point your reader at the bridge instead of the cloud</p>
                    <p className="text-muted-foreground text-xs mt-0.5">In your reader's HTTP output config, use this local address instead:</p>
                    <pre className="mt-1 bg-gray-900 text-green-400 font-mono text-xs px-3 py-2 rounded border border-gray-700 overflow-x-auto">{`http://localhost:5555/timing/active/crossing?clubId=${user?.clubId ?? "YOUR_CLUB_ID"}`}</pre>
                    <p className="text-muted-foreground text-xs mt-1.5">That's it. The bridge accepts the same format your reader already sends and forwards it to the cloud.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-background rounded-lg border p-3 space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">
                <Terminal size={12} /> Optional flags
              </div>
              <div className="font-mono text-xs space-y-1 text-muted-foreground">
                <p><span className="text-foreground">--port 5555</span>   &nbsp;Local port (default 5555)</p>
                <p><span className="text-foreground">--retry 10</span>  &nbsp;Seconds between retry attempts when offline (default 10)</p>
                <p><span className="text-foreground">--db path</span>   &nbsp;SQLite cache file location</p>
                <p><span className="text-foreground">--club-id N</span>&nbsp;Your club ID — required so the bridge forwards to the correct facility endpoint</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* API Endpoint */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <CardTitle className="font-heading uppercase tracking-wider text-base">
            {isNativeReader ? `Endpoint — ${readerLabel}` : "API Endpoint"}
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isNativeReader
              ? `The facility endpoint accepts the ${readerLabel}'s native payload format directly — paste it into your reader's HTTP output config and never change it.`
              : "Point your reader at this URL. The platform automatically routes crossings to whichever moto is currently In Progress for your club."}
          </p>
        </CardHeader>
        <CardContent className="pt-5 space-y-5">

          {/* Endpoint URL row */}
          <div className="flex items-center gap-3">
            <Badge className="font-mono font-bold px-3 py-1 bg-primary text-primary-foreground text-sm shrink-0">POST</Badge>
            <code className="flex-1 font-mono text-sm bg-muted px-3 py-2 rounded border overflow-x-auto">
              {facilityEndpoint}
            </code>
            <Button variant="outline" size="sm" onClick={copyUrl} className="shrink-0 gap-2">
              {copiedUrl ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
            </Button>
          </div>

          {/* Payload examples */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                  {isNativeReader ? "Native payload format (sent by reader)" : "Request body"}
                </p>
                <Button variant="ghost" size="sm" onClick={copyPayloadExample} className="gap-1.5 h-7 text-xs">
                  {copiedPayload ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy</>}
                </Button>
              </div>
              <pre className="bg-muted font-mono text-xs p-4 rounded border whitespace-pre overflow-x-auto leading-relaxed">
                {rfidReader === "impinj-r700" ? IMPINJ_PAYLOAD : rfidReader === "zebra-fx7500" ? ZEBRA_PAYLOAD : GENERIC_PAYLOAD}
              </pre>
              {isNativeReader && (
                <p className="text-xs text-muted-foreground">
                  This is the exact format the {readerLabel} sends. You don't need to configure a custom body template — the platform parses it natively.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Success response</p>
              <pre className="bg-muted font-mono text-xs p-4 rounded border whitespace-pre overflow-x-auto leading-relaxed">
                {isNativeReader
                  ? `{\n  "ok": true,\n  "processed": 1,\n  "motoId": 12,\n  "results": [\n    {\n      "rfidNumber": "300833B2DDD9014000000003",\n      "crossingId": 4501,\n      "lapNumber": 3,\n      "lapTimeMs": 112340\n    }\n  ]\n}`
                  : `{\n  "ok": true,\n  "motoId": 12,\n  "crossingId": 4501,\n  "lapNumber": 3,\n  "lapTime": "1:52.34",\n  "lapTimeMs": 112340\n}`}
              </pre>
            </div>
          </div>

          <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-700/40 rounded-md px-4 py-3 text-xs text-blue-800 dark:text-blue-300 flex gap-2">
            <Info size={13} className="shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold">Moto auto-discovery:</span>{" "}
              The <code className="font-mono">?clubId=N</code> in the URL tells the platform which club's timing to score. It automatically finds whichever moto has status <code className="font-mono">in_progress</code> — so you configure the URL once and never touch it again between events or heats. A <code className="font-mono">409</code> response means no moto is currently in progress.
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Test Connection */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <div className="flex items-center gap-2">
            <FlaskConical size={18} className="text-primary shrink-0" />
            <CardTitle className="font-heading uppercase tracking-wider text-base">Test Connection</CardTitle>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isMylaps
              ? "Fire a simulated transponder crossing in native AMBrc format to verify the endpoint is live."
              : isNativeReader
                ? `Fire a simulated ${readerLabel} crossing to verify the endpoint is reachable and your moto is in progress.`
                : "Fire a simulated crossing to verify your endpoint is reachable and the moto is accepting crossings."}
          </p>
        </CardHeader>
        <CardContent className="pt-5 space-y-5">

          {isMylaps ? (
            /* MyLaps native test tool */
            <>
              <div className="space-y-1.5 max-w-xs">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Transponder Number</label>
                <Input
                  value={mylapsTestTransponder}
                  onChange={e => setMylapsTestTransponder(e.target.value)}
                  placeholder="e.g. 12345"
                  className="font-mono h-11"
                />
                <p className="text-xs text-muted-foreground">The numeric ID on the rider's MyLaps transponder. A moto must be In Progress to accept the crossing.</p>
              </div>

              <Button
                onClick={sendMylapsNativeTest}
                disabled={mylapsTestLoading || !mylapsTestTransponder}
                className="font-heading uppercase tracking-wider h-11 px-6 gap-2"
              >
                {mylapsTestLoading ? <><RefreshCw size={16} className="animate-spin" /> Sending…</> : <><Send size={16} /> Send Test Crossing</>}
              </Button>

              {mylapsTestResult && (
                <div className={`rounded-lg border p-4 space-y-2 ${mylapsTestResult.ok ? "bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800" : "bg-destructive/5 border-destructive/30"}`}>
                  <div className="flex items-center gap-2">
                    <Circle size={10} className={mylapsTestResult.ok ? "fill-green-500 text-green-500" : "fill-destructive text-destructive"} />
                    <span className={`text-sm font-semibold ${mylapsTestResult.ok ? "text-green-700 dark:text-green-400" : "text-destructive"}`}>
                      {mylapsTestResult.ok ? "Accepted" : "Rejected"}
                    </span>
                  </div>
                  <pre className="font-mono text-xs bg-background/60 p-3 rounded border overflow-x-auto whitespace-pre leading-relaxed">{mylapsTestResult.body}</pre>
                </div>
              )}
            </>
          ) : isNativeReader ? (
            /* Native RFID reader test tool (Impinj / Zebra) */
            <>
              <div className="space-y-1.5 max-w-xs">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                  Tag EPC ({rfidReader === "impinj-r700" ? "epcHex" : "idHex"})
                </label>
                <Input
                  value={nativeTestEpc}
                  onChange={e => setNativeTestEpc(e.target.value.toUpperCase())}
                  placeholder={rfidReader === "impinj-r700" ? "300833B2DDD9014000000003" : "E2003411B802011820000D4E"}
                  className="font-mono h-11 uppercase"
                />
                <p className="text-xs text-muted-foreground">Enter the EPC of a tag assigned to a rider. A moto must be In Progress to accept the crossing.</p>
              </div>

              <Button
                onClick={sendNativeTest}
                disabled={nativeTestLoading || !nativeTestEpc}
                className="font-heading uppercase tracking-wider h-11 px-6 gap-2"
              >
                {nativeTestLoading ? <><RefreshCw size={16} className="animate-spin" /> Sending…</> : <><Send size={16} /> Send Test Crossing</>}
              </Button>

              {nativeTestResult && (
                <div className={`rounded-lg border p-4 space-y-2 ${nativeTestResult.ok ? "bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800" : "bg-destructive/5 border-destructive/30"}`}>
                  <div className="flex items-center gap-2">
                    <Circle size={10} className={nativeTestResult.ok ? "fill-green-500 text-green-500" : "fill-destructive text-destructive"} />
                    <span className={`text-sm font-semibold ${nativeTestResult.ok ? "text-green-700 dark:text-green-400" : "text-destructive"}`}>
                      {nativeTestResult.ok ? "Accepted" : "Rejected"}
                    </span>
                  </div>
                  <pre className="font-mono text-xs bg-background/60 p-3 rounded border overflow-x-auto whitespace-pre leading-relaxed">{nativeTestResult.body}</pre>
                </div>
              )}
            </>
          ) : (
            /* Generic reader test tool */
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-xl">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">RFID Tag Number</label>
                  <Input value={testRfid} onChange={e => setTestRfid(e.target.value)} placeholder="e.g. 1A2B3C4D" className="font-mono h-11" />
                  <p className="text-xs text-muted-foreground">A moto must be In Progress to accept the crossing.</p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Reader ID (optional)</label>
                  <Input value={testReaderId} onChange={e => setTestReaderId(e.target.value)} placeholder="finish-line-1" className="font-mono h-11" />
                </div>
              </div>

              <Button onClick={sendTest} disabled={testLoading || !testRfid} className="font-heading uppercase tracking-wider h-11 px-6 gap-2">
                {testLoading ? <><RefreshCw size={16} className="animate-spin" /> Sending…</> : <><Send size={16} /> Send Test Crossing</>}
              </Button>

              {testResult && (
                <div className={`rounded-lg border p-4 space-y-2 ${testResult.ok ? "bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800" : "bg-destructive/5 border-destructive/30"}`}>
                  <div className="flex items-center gap-2">
                    <Circle size={10} className={testResult.ok ? "fill-green-500 text-green-500" : "fill-destructive text-destructive"} />
                    <span className={`text-sm font-semibold ${testResult.ok ? "text-green-700 dark:text-green-400" : "text-destructive"}`}>
                      {testResult.ok ? "Accepted" : "Rejected"}
                    </span>
                  </div>
                  <pre className="font-mono text-xs bg-background/60 p-3 rounded border overflow-x-auto whitespace-pre leading-relaxed">{testResult.body}</pre>
                </div>
              )}
            </>
          )}

        </CardContent>
      </Card>

      {/* ── RMonitor Live Output — scoreboard / announcer TCP feed ─────────── */}
      {(() => {
        const clubId = user?.clubId;
        const bridgeCmd = [
          "python rfid_bridge.py",
          `  --api-url ${BASE_URL}`,
          clubId ? `  --club-id ${clubId}` : "  --club-id YOUR_CLUB_ID",
          "  --rmonitor 50000",
        ].join(" \\\n");
        const copyRmon = () => {
          navigator.clipboard.writeText(bridgeCmd);
          setCopiedRmonitor(true);
          setTimeout(() => setCopiedRmonitor(false), 2000);
        };
        return (
          <Card>
            <CardHeader className="pb-3 border-b">
              <div className="flex items-center gap-2">
                <Radio size={18} className="text-primary shrink-0" />
                <CardTitle className="font-heading uppercase tracking-wider text-base">
                  RMonitor Live Output
                </CardTitle>
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 ml-1">TCP :50000</Badge>
              </div>
              <p className="text-sm text-muted-foreground mt-0.5">
                Push live lap data to trackside scoreboards, announcer laptops, and the Race Monitor app — all in real time.
              </p>
            </CardHeader>
            <CardContent className="pt-5 space-y-5">

              {/* How it works */}
              <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-1.5">
                <p className="font-semibold text-foreground">How it works</p>
                <p className="text-muted-foreground">
                  Add <code className="bg-background border rounded px-1 py-0.5 text-xs font-mono">--rmonitor 50000</code> to
                  your bridge command. The bridge subscribes to the cloud and exposes a local TCP server on port 50000.
                  Scoreboard software connects once at the start of race day and receives every lap automatically.
                </p>
              </div>

              {/* Bridge command */}
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                  Bridge Command
                </label>
                <div className="flex items-stretch gap-2">
                  <pre className="flex-1 font-mono text-xs bg-background border rounded-md p-3 overflow-x-auto leading-relaxed text-foreground whitespace-pre">{bridgeCmd}</pre>
                  <Button variant="outline" size="sm" onClick={copyRmon} className="shrink-0 self-start mt-0 gap-1.5 h-auto px-3 py-2">
                    {copiedRmonitor ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
                  </Button>
                </div>
              </div>

              {/* Scoreboard connection address */}
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                  Scoreboard / Race Monitor Connection
                </label>
                <div className="rounded-lg border p-3 font-mono text-sm bg-background">
                  <span className="text-muted-foreground">tcp://</span>
                  <span className="text-primary font-semibold">YOUR-LAPTOP-IP</span>
                  <span className="text-muted-foreground">:50000</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Enter this address in your scoreboard or Race Monitor software. Use your laptop's LAN IP address (e.g. 192.168.1.50) — not localhost.
                </p>
              </div>

              {/* Compatible software */}
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                  Compatible Software
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {[
                    "Race Monitor (iOS/Android)",
                    "AMBrc / Orbits",
                    "MyLaps Speedhive",
                    "Westhold Scoreboards",
                    "Custom TCP clients",
                    "Announcer laptop apps",
                  ].map(name => (
                    <div key={name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Circle size={5} className="fill-primary text-primary shrink-0" />
                      {name}
                    </div>
                  ))}
                </div>
              </div>

            </CardContent>
          </Card>
        );
      })()}

    </div>
  );
}
