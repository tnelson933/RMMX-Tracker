import { useState } from "react";
import { useListEvents, useListMotos } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Wifi, Copy, Check, Send, RefreshCw, Circle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

const BASE_URL = window.location.origin;
const ENDPOINT = `${BASE_URL}/api/timing/crossing`;

const PAYLOAD_EXAMPLE = `{
  "rfidNumber": "1A2B3C4D",
  "motoId": 12,
  "crossingTime": "2026-05-27T14:32:01.000Z",
  "readerId": "finish-line-1"
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
              <div className="text-xs text-muted-foreground space-y-1">
                <p><span className="font-bold text-foreground">rfidNumber</span> — transponder tag ID (required)</p>
                <p><span className="font-bold text-foreground">motoId</span> — active moto ID (required)</p>
                <p><span className="font-bold text-foreground">crossingTime</span> — ISO 8601; omit to use server time</p>
                <p><span className="font-bold text-foreground">readerId</span> — reader name/ID for diagnostics</p>
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
              <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">RFID Tag Number</label>
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
                      <th className="pb-2 pr-4">RFID Tag</th>
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
