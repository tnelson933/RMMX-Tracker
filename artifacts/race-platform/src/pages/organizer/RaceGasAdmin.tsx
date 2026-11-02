import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Download, Fuel, Loader2, Send, AlertCircle, CheckCircle2 } from "lucide-react";

// RM Roost admin: Race Gas — a Rocky Mountain ATV website credit for every
// rider who races an event. Credits are gathered as races finish and sent to
// the CRM set here, or downloaded in the Race Gas template's format.

interface Settings { enabled: boolean; endpointUrl: string | null; hasApiKey: boolean; amount: number; updatedAt: string }
interface EventRow { eventId: number; eventName: string; eventDate: string; clubName: string | null; total: number; ready: number; missing: number; sent: number; failed: number; unconfirmed: number; fileName: string }
interface Credit {
  id: number; creditId: string; riderId: number; amount: number; status: string; missingFields: string[] | null; lastError: string | null; sentAt: string | null;
  firstName: string | null; lastName: string | null; streetAddress: string | null; city: string | null; state: string | null; zip: string | null; email: string | null;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "Something went wrong. Try again.");
  return body as T;
}

/** The Race Gas template: its two note lines, then the seven required columns. */
function downloadRaceGasFile(fileName: string, credits: Credit[]) {
  const rows: Array<Array<string | number>> = [
    ["All fields are required for Attendee to receive Race Gas Credit"],
    ["Please name and save your file out in this format: Organization - Event - Month-Day-Year  //  Example: Ridersclub-Hareandhound-04-10-2018"],
    [],
    ["First Name \n(*as listed on RM account)", "Last Name", "Mailing address", "City", "State", "Zipcode", "Email address"],
    ...credits.filter(c => c.status !== "missing_info").map(c => [c.firstName ?? "", c.lastName ?? "", c.streetAddress ?? "", c.city ?? "", c.state ?? "", c.zip ?? "", c.email ?? ""]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 22 }, { wch: 16 }, { wch: 28 }, { wch: 16 }, { wch: 7 }, { wch: 10 }, { wch: 30 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Event");
  XLSX.writeFile(wb, `${fileName}.xlsx`);
}

const STATUS: Record<string, { label: string; tone: string }> = {
  ready: { label: "Ready", tone: "bg-blue-50 text-blue-700 border-blue-200" },
  missing_info: { label: "Missing info", tone: "bg-amber-50 text-amber-800 border-amber-200" },
  sent: { label: "Sent", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  failed: { label: "Failed, will retry", tone: "bg-red-50 text-red-700 border-red-200" },
  sending: { label: "Sending", tone: "bg-blue-50 text-blue-700 border-blue-200" },
  unconfirmed: { label: "Unconfirmed", tone: "bg-orange-50 text-orange-800 border-orange-300" },
};

export default function RaceGasAdmin() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isAdmin = user?.role === "super_admin";

  const { data: settings } = useQuery<Settings>({ queryKey: ["race-gas-settings"], queryFn: () => getJson("/api/admin/race-gas/settings"), enabled: isAdmin });
  const { data: events, isLoading: eventsLoading } = useQuery<EventRow[]>({ queryKey: ["race-gas-events"], queryFn: () => getJson("/api/admin/race-gas/events"), enabled: isAdmin });

  const [enabled, setEnabled] = useState(false);
  const [endpointUrl, setEndpointUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [amount, setAmount] = useState("15");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; status: number; response: string } | null>(null);
  const [openEvent, setOpenEvent] = useState<number | null>(null);
  const [busyEvent, setBusyEvent] = useState<number | null>(null);

  useEffect(() => {
    if (!settings) return;
    setEnabled(settings.enabled);
    setEndpointUrl(settings.endpointUrl ?? "");
    setAmount(String(settings.amount));
  }, [settings]);

  const { data: detail } = useQuery<{ fileName: string; credits: Credit[] }>({
    queryKey: ["race-gas-event", openEvent],
    queryFn: () => getJson(`/api/admin/race-gas/events/${openEvent}`),
    enabled: isAdmin && openEvent != null,
  });

  if (!isAdmin) return <div className="p-8 text-muted-foreground">Only RM Roost admins can open Race Gas.</div>;

  const save = async () => {
    setSaving(true);
    try {
      await getJson("/api/admin/race-gas/settings", { method: "PUT", body: JSON.stringify({ enabled, endpointUrl, amount: Number(amount), ...(apiKey.trim() ? { apiKey } : {}) }) });
      setApiKey("");
      qc.invalidateQueries({ queryKey: ["race-gas-settings"] });
      toast({ title: "Race Gas settings saved" });
    } catch (e: any) { toast({ title: "Couldn't save", description: e.message, variant: "destructive" }); }
    finally { setSaving(false); }
  };

  const test = async () => {
    setTesting(true); setTestResult(null);
    try { setTestResult(await getJson("/api/admin/race-gas/test", { method: "POST" })); }
    catch (e: any) { setTestResult({ ok: false, status: 0, response: e.message }); }
    finally { setTesting(false); }
  };

  const download = async (row: EventRow) => {
    setBusyEvent(row.eventId);
    try {
      const d = await getJson<{ fileName: string; credits: Credit[] }>(`/api/admin/race-gas/events/${row.eventId}`);
      downloadRaceGasFile(d.fileName, d.credits);
    } catch (e: any) { toast({ title: "Couldn't download", description: e.message, variant: "destructive" }); }
    finally { setBusyEvent(null); }
  };

  const resolve = async (row: EventRow, action: "sent" | "resend") => {
    setBusyEvent(row.eventId);
    try {
      const r = await getJson<{ count: number }>(`/api/admin/race-gas/events/${row.eventId}/unconfirmed`, { method: "POST", body: JSON.stringify({ action }) });
      toast({ title: action === "sent" ? `${r.count} marked as sent` : `${r.count} sent again` });
      qc.invalidateQueries({ queryKey: ["race-gas-events"] });
      qc.invalidateQueries({ queryKey: ["race-gas-event", row.eventId] });
    } catch (e: any) { toast({ title: "Couldn't update", description: e.message, variant: "destructive" }); }
    finally { setBusyEvent(null); }
  };

  const sendNow = async (row: EventRow) => {
    setBusyEvent(row.eventId);
    try {
      const r = await getJson<{ sent: number; failed: number; skipped?: string }>(`/api/admin/race-gas/events/${row.eventId}/send`, { method: "POST" });
      toast({ title: r.skipped ? "Gathered; sending is off" : `${r.sent} sent${r.failed ? `, ${r.failed} failed` : ""}` });
      qc.invalidateQueries({ queryKey: ["race-gas-events"] });
      qc.invalidateQueries({ queryKey: ["race-gas-event", row.eventId] });
    } catch (e: any) { toast({ title: "Couldn't send", description: e.message, variant: "destructive" }); }
    finally { setBusyEvent(null); }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-heading font-bold uppercase tracking-tight flex items-center gap-2"><Fuel className="text-primary" /> Race Gas</h1>
        <p className="text-muted-foreground mt-1">Every rider who races an event earns one Rocky Mountain ATV website credit for that event, however many races they run. Riders are added as their races finish (not practice, not "did not start") and each is sent to your CRM once.</p>
      </div>

      <Card>
        <CardHeader className="border-b pb-4"><CardTitle className="font-heading uppercase text-xl">Send credits to the CRM</CardTitle></CardHeader>
        <CardContent className="p-6 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label className="text-base">Send automatically</Label>
              <p className="text-sm text-muted-foreground">When on, each rider's credit is sent as soon as their race finishes. Off: credits wait as Ready; download the Excel file below instead.</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Send credits automatically" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="rg-url">CRM address (endpoint URL)</Label>
              <Input id="rg-url" placeholder="https://…" value={endpointUrl} onChange={e => setEndpointUrl(e.target.value)} />
              <p className="text-xs text-muted-foreground">Where RM Roost POSTs each event's credits (your CRM's webhook, or a connector such as Zapier or Make that adds them to the CRM).</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rg-key">API key</Label>
              <Input id="rg-key" type="password" autoComplete="off" placeholder={settings?.hasApiKey ? "Saved. Leave blank to keep it" : "Optional"} value={apiKey} onChange={e => setApiKey(e.target.value)} />
              <p className="text-xs text-muted-foreground">Sent as <code>Authorization: Bearer …</code> and used to sign each request. Never shown again after saving.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rg-amount">Credit per rider ($)</Label>
              <Input id="rg-amount" type="number" min={1} step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={saving} className="font-heading uppercase">{saving && <Loader2 size={14} className="mr-1.5 animate-spin" />}Save</Button>
            <Button variant="outline" onClick={test} disabled={testing || !settings?.endpointUrl} className="font-heading uppercase gap-1.5">
              {testing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send a test
            </Button>
          </div>
          {testResult && (
            <div className={`rounded-md border px-3 py-2 text-sm ${testResult.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"}`}>
              {testResult.ok ? <CheckCircle2 size={14} className="inline mr-1.5" /> : <AlertCircle size={14} className="inline mr-1.5" />}
              {testResult.ok ? `The CRM accepted the test (${testResult.status}).` : `The test didn't go through${testResult.status ? ` (${testResult.status})` : ""}.`}
              {testResult.response && <span className="block mt-1 font-mono text-xs opacity-80 break-all">{testResult.response}</span>}
            </div>
          )}
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">What RM Roost sends</summary>
            <pre className="mt-2 rounded-md bg-muted p-3 text-xs overflow-x-auto">{`POST <CRM address>
Authorization: Bearer <API key>
X-RM-Roost-Signature: sha256=<HMAC-SHA256 of the body with the API key>

{
  "source": "rm-roost",
  "event": { "id": 57, "name": "…", "date": "2026-11-13", "club": "…", "fileName": "Club-Event-11-13-2026" },
  "credits": [
    { "creditId": "rmroost-race-gas-57-183", "amount": 15, "firstName": "…", "lastName": "…",
      "mailingAddress": "…", "city": "…", "state": "UT", "zipcode": "…", "email": "…", "riderId": 183 }
  ]
}

Answer 2xx to accept. To reject some, answer { "results": [{ "creditId": "…", "ok": false, "error": "…" }] }.
creditId never changes for a rider and event: use it so a credit is never given twice.`}</pre>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b pb-4"><CardTitle className="font-heading uppercase text-xl">Events</CardTitle></CardHeader>
        <CardContent className="p-0">
          {eventsLoading ? (
            <div className="p-6 flex justify-center"><Loader2 className="animate-spin text-muted-foreground" /></div>
          ) : !events?.length ? (
            <p className="p-6 text-sm text-muted-foreground">No credits yet. They appear here as riders finish their races.</p>
          ) : (
            <div className="divide-y">
              {events.map(row => (
                <div key={row.eventId} className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <button className="text-left" onClick={() => setOpenEvent(openEvent === row.eventId ? null : row.eventId)}>
                      <p className="font-semibold">{row.eventName}</p>
                      <p className="text-xs text-muted-foreground">{row.eventDate} · {row.clubName ?? "—"} · {row.total} riders</p>
                    </button>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      {row.sent > 0 && <span className={`rounded border px-2 py-0.5 ${STATUS.sent.tone}`}>{row.sent} sent</span>}
                      {row.ready > 0 && <span className={`rounded border px-2 py-0.5 ${STATUS.ready.tone}`}>{row.ready} ready</span>}
                      {row.missing > 0 && <span className={`rounded border px-2 py-0.5 ${STATUS.missing_info.tone}`}>{row.missing} missing info</span>}
                      {row.failed > 0 && <span className={`rounded border px-2 py-0.5 ${STATUS.failed.tone}`}>{row.failed} failed</span>}
                      {row.unconfirmed > 0 && <span className={`rounded border px-2 py-0.5 ${STATUS.unconfirmed.tone}`}>{row.unconfirmed} unconfirmed</span>}
                      <Button size="sm" variant="outline" className="h-7 gap-1" disabled={busyEvent === row.eventId} onClick={() => download(row)}><Download size={12} /> Excel</Button>
                      <Button size="sm" variant="outline" className="h-7 gap-1" disabled={busyEvent === row.eventId} onClick={() => sendNow(row)}>
                        {busyEvent === row.eventId ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Send now
                      </Button>
                    </div>
                  </div>
                  {row.unconfirmed > 0 && (
                    <div className="mt-3 rounded-md border border-orange-300 bg-orange-50 px-3 py-2 text-sm text-orange-900 dark:bg-orange-950/30 dark:text-orange-200">
                      <p><strong>{row.unconfirmed} credit{row.unconfirmed === 1 ? "" : "s"} unconfirmed.</strong> The CRM may have received {row.unconfirmed === 1 ? "it" : "them"}, but its answer never came, so RM Roost won't send again on its own (that could credit riders twice). Check the CRM for this event, then:</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" className="h-7" disabled={busyEvent === row.eventId} onClick={() => resolve(row, "sent")}>The CRM has them: mark as sent</Button>
                        <Button size="sm" variant="outline" className="h-7" disabled={busyEvent === row.eventId} onClick={() => resolve(row, "resend")}>The CRM doesn't: send again</Button>
                      </div>
                    </div>
                  )}
                  {openEvent === row.eventId && detail && (
                    <div className="mt-3 overflow-x-auto rounded-md border">
                      <table className="w-full text-xs">
                        <thead className="bg-muted/50 text-muted-foreground"><tr>
                          <th className="px-2 py-1.5 text-left">Rider</th><th className="px-2 py-1.5 text-left">Email</th><th className="px-2 py-1.5 text-left">Address</th><th className="px-2 py-1.5 text-left">Status</th>
                        </tr></thead>
                        <tbody className="divide-y">
                          {detail.credits.map(c => (
                            <tr key={c.id}>
                              <td className="px-2 py-1.5">{[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}</td>
                              <td className="px-2 py-1.5">{c.email ?? "—"}</td>
                              <td className="px-2 py-1.5">{[c.streetAddress, c.city, c.state, c.zip].filter(Boolean).join(", ") || "—"}</td>
                              <td className="px-2 py-1.5">
                                <span className={`rounded border px-1.5 py-0.5 ${STATUS[c.status]?.tone ?? ""}`}>{STATUS[c.status]?.label ?? c.status}</span>
                                {c.status === "missing_info" && c.missingFields?.length ? <span className="ml-1.5 text-amber-800">needs {c.missingFields.join(", ")}</span> : null}
                                {(c.status === "failed" || c.status === "unconfirmed") && c.lastError ? <span className="ml-1.5 text-red-700">{c.lastError}</span> : null}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="px-3 py-2 text-[11px] text-muted-foreground">Missing info: the rider's profile lacks a field the credit needs. Once it's added (rider app or the rider's page), click Send now. The Excel file includes complete riders only.</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
