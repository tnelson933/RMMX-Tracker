import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, Check, Copy, LifeBuoy, Loader2, X } from "lucide-react";

interface Ticket {
  id: number;
  summary: string;
  details: string;
  urgency: "normal" | "urgent";
  status: "open" | "approved" | "declined" | "resolved";
  diagnostics: Array<{ tool: string; input: unknown; result: string }> | null;
  resolution: string | null;
  clubId: number | null;
  clubName: string | null;
  eventId: number | null;
  eventName: string | null;
  eventDate: string | null;
  reporterName: string | null;
  reporterEmail: string | null;
  createdAt: string;
  decidedAt: string | null;
  resolvedAt: string | null;
  investigationStatus: "running" | "done" | "failed" | null;
  investigationStartedAt: string | null;
  investigationFinishedAt: string | null;
  investigationReport: string | null;
  investigationError: string | null;
  investigationUsage: { inputTokens?: number; outputTokens?: number; rounds?: number } | null;
  proposedFix: {
    kind: "data" | "code" | "config" | "none";
    rootCause: string;
    summary: string;
    organizerMessage: string;
    sql?: string;
    expectedRows?: number;
    files?: Array<{ path: string; content: string }>;
    steps?: string;
  } | null;
  fixStatus: string | null;
  fixResult: string | null;
  fixPrUrl: string | null;
}

const FIX_STATUS_LABEL: Record<string, string> = {
  awaiting_approval: "Waiting for your approval",
  applying: "Applying…",
  applied: "Applied",
  rolled_back: "Rolled back (row count didn't match)",
  pr_opened: "Pull request opened",
  declined: "Declined",
  failed: "Failed",
};

const STATUS_STYLE: Record<Ticket["status"], string> = {
  open: "bg-amber-500/10 text-amber-800 border-amber-500/40",
  approved: "bg-blue-500/10 text-blue-800 border-blue-500/40",
  declined: "bg-muted text-muted-foreground border-border",
  resolved: "bg-green-500/10 text-green-700 border-green-600/30",
};

/** A ready-to-paste brief for a Claude Code session to investigate the ticket. */
export function investigationBrief(t: Ticket): string {
  const lines = [
    `RM Roost support ticket #${t.id} (${t.urgency}, ${t.status}), opened ${new Date(t.createdAt).toLocaleString()}.`,
    `Club: ${t.clubName ?? "unknown"}${t.clubId ? ` (club id ${t.clubId})` : ""}.`,
    t.eventId ? `Event: ${t.eventName ?? ""} on ${t.eventDate ?? "?"} (event id ${t.eventId}).` : "No event was open.",
    `Reported through Rocky by ${t.reporterName ?? "an organizer"}.`,
    "",
    `Summary: ${t.summary}`,
    "",
    "What the organizer reported and Rocky's notes:",
    t.details,
    "",
    "What Rocky checked (read-only, the organizer's own club):",
    ...((t.diagnostics ?? []).length
      ? (t.diagnostics ?? []).map(d => `- ${d.tool} ${JSON.stringify(d.input)}: ${d.result.slice(0, 1500)}`)
      : ["- nothing"]),
    "",
    "Task: find the root cause in the RM-Tracker repo and production data (read-only first). Propose the fix: a code change as a commit, or a data fix as the exact SQL with the rows it affects. Don't change production or deploy until I approve. When it's fixed, resolve ticket #" + t.id + " in Admin → Support with a short note for the organizer (they see it in Rocky).",
  ];
  return lines.join("\n");
}

/** Admin → Support: requests Rocky escalated to the RM Roost team. */
export default function SupportTickets() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const initial = Number(new URLSearchParams(window.location.search).get("ticket")) || null;
  const [selectedId, setSelectedId] = useState<number | null>(initial);
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: tickets = [], isLoading, isError, refetch } = useQuery<Ticket[]>({
    queryKey: ["/api/support/tickets"],
    enabled: user?.role === "super_admin",
    // Watch a running investigation finish.
    refetchInterval: (q) => ((q.state.data as Ticket[] | undefined)?.some(t => t.investigationStatus === "running") ? 10_000 : false),
    queryFn: async () => {
      const r = await fetch("/api/support/tickets", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });

  if (user?.role !== "super_admin") {
    return <div className="p-8 text-center text-muted-foreground">Access restricted to super admins.</div>;
  }

  const selected = tickets.find(t => t.id === selectedId) ?? null;

  async function act(path: string, body: Record<string, unknown>, done: string) {
    if (!selected) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/support/tickets/${selected.id}/${path}`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
      toast({ title: done, description: typeof json.message === "string" ? json.message : undefined });
      setResolution("");
      await queryClient.invalidateQueries({ queryKey: ["/api/support/tickets"] });
    } catch (err: any) {
      toast({ title: "Couldn't update the ticket", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-heading font-bold uppercase tracking-tight flex items-center gap-2"><LifeBuoy className="text-primary" /> Support</h1>
        <p className="text-muted-foreground mt-1">Problems Rocky couldn't solve, sent to the RM Roost team. Approving tells the organizer you're on it and starts an investigation that proposes a fix for you to approve; resolving posts your note in their Rocky chat.</p>
      </div>

      {isError ? (
        <p className="text-sm text-muted-foreground">Couldn't load tickets. <button className="underline" onClick={() => refetch()}>Try again</button></p>
      ) : isLoading ? (
        <Loader2 className="animate-spin text-muted-foreground" />
      ) : tickets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No support requests yet.</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4">
          <div className="space-y-2">
            {tickets.map(t => (
              <button
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className={`w-full text-left rounded-lg border px-4 py-3 transition-colors ${selectedId === t.id ? "border-primary bg-primary/5" : "bg-card hover:bg-muted/40"}`}
              >
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-muted-foreground">#{t.id}</span>
                  <span className={`rounded-full border px-2 py-0.5 font-semibold capitalize ${STATUS_STYLE[t.status]}`}>{t.status}</span>
                  {t.urgency === "urgent" && <span className="inline-flex items-center gap-1 font-bold text-red-700"><AlertTriangle size={11} /> Urgent</span>}
                  <span className="ml-auto text-muted-foreground">{new Date(t.createdAt).toLocaleDateString()}</span>
                </div>
                <p className="font-semibold text-sm mt-1.5 line-clamp-2">{t.summary}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{[t.clubName, t.eventName].filter(Boolean).join(" · ")}</p>
              </button>
            ))}
          </div>

          {selected ? (
            <Card>
              <CardContent className="p-5 space-y-4">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono text-muted-foreground">#{selected.id}</span>
                  <span className={`rounded-full border px-2 py-0.5 font-semibold capitalize ${STATUS_STYLE[selected.status]}`}>{selected.status}</span>
                  {selected.urgency === "urgent" && <span className="inline-flex items-center gap-1 font-bold text-red-700"><AlertTriangle size={11} /> Urgent</span>}
                </div>
                <h2 className="font-heading font-bold text-xl leading-snug">{selected.summary}</h2>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Club</dt><dd>{selected.clubName ?? "—"}</dd>
                  <dt className="text-muted-foreground">Event</dt><dd>{selected.eventName ? `${selected.eventName} (${selected.eventDate})` : "—"}</dd>
                  <dt className="text-muted-foreground">Reported by</dt><dd>{[selected.reporterName, selected.reporterEmail].filter(Boolean).join(" · ") || "—"}</dd>
                  <dt className="text-muted-foreground">Opened</dt><dd>{new Date(selected.createdAt).toLocaleString()}</dd>
                </dl>
                <div className="rounded-md bg-muted/50 p-3 text-sm whitespace-pre-wrap">{selected.details}</div>

                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1.5">What Rocky checked</p>
                  {(selected.diagnostics ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">Nothing: Rocky escalated without running a check.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {(selected.diagnostics ?? []).map((d, i) => (
                        <details key={i} className="rounded-md border px-3 py-2 text-sm">
                          <summary className="cursor-pointer font-medium">{d.tool} <span className="font-mono text-xs text-muted-foreground">{JSON.stringify(d.input)}</span></summary>
                          <pre className="mt-2 text-xs whitespace-pre-wrap break-all max-h-80 overflow-auto">{(() => { try { return JSON.stringify(JSON.parse(d.result), null, 2); } catch { return d.result; } })()}</pre>
                        </details>
                      ))}
                    </div>
                  )}
                </div>

                {(selected.status !== "open" && selected.status !== "declined") && (
                  <div className="space-y-2 border-t pt-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Investigation</p>
                      {selected.investigationStatus === "running" && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Loader2 size={12} className="animate-spin" /> Running since {new Date(selected.investigationStartedAt!).toLocaleTimeString()}
                        </span>
                      )}
                      {selected.investigationStatus === "failed" && <span className="text-xs font-semibold text-destructive">Stopped</span>}
                      {selected.investigationStatus === "done" && selected.investigationUsage && (
                        <span className="text-xs text-muted-foreground">
                          {selected.investigationUsage.rounds} steps · {Math.round(((selected.investigationUsage.inputTokens ?? 0) + (selected.investigationUsage.outputTokens ?? 0)) / 1000)}k tokens
                        </span>
                      )}
                      {selected.status === "approved" && selected.investigationStatus !== "running" && (
                        <Button size="sm" variant="outline" className="h-7 ml-auto" disabled={busy} onClick={() => act("investigate", {}, "Investigation started")}>
                          {selected.investigationStatus ? "Run again" : "Run investigation"}
                        </Button>
                      )}
                    </div>
                    {selected.investigationError && <p className="text-sm text-destructive">{selected.investigationError}</p>}
                    {selected.investigationReport && (
                      <details className="rounded-md border px-3 py-2 text-sm" open={!selected.proposedFix}>
                        <summary className="cursor-pointer font-medium">Full report</summary>
                        <pre className="mt-2 text-xs whitespace-pre-wrap break-words max-h-[28rem] overflow-auto">{selected.investigationReport}</pre>
                      </details>
                    )}
                    {selected.proposedFix && (
                      <div className="rounded-md border border-primary/30 bg-primary/[0.03] p-3 space-y-2 text-sm">
                        <p className="text-xs font-bold uppercase tracking-wider text-primary">Proposed fix · {selected.proposedFix.kind}</p>
                        <p className="font-semibold">{selected.proposedFix.summary}</p>
                        <p className="whitespace-pre-wrap text-muted-foreground">{selected.proposedFix.rootCause}</p>
                        {selected.proposedFix.sql && (
                          <>
                            <p className="text-xs text-muted-foreground">
                              Runs in a transaction; commits only if it changes exactly {selected.proposedFix.expectedRows} row{selected.proposedFix.expectedRows === 1 ? "" : "s"}.
                            </p>
                            <pre className="rounded bg-muted p-2 text-xs whitespace-pre-wrap break-all">{selected.proposedFix.sql}</pre>
                          </>
                        )}
                        {(selected.proposedFix.files ?? []).map(f => (
                          <details key={f.path} className="rounded border bg-background px-2 py-1.5">
                            <summary className="cursor-pointer font-mono text-xs">{f.path}</summary>
                            <pre className="mt-1 text-[11px] whitespace-pre-wrap break-all max-h-80 overflow-auto">{f.content}</pre>
                          </details>
                        ))}
                        {selected.proposedFix.steps && <pre className="rounded bg-muted p-2 text-xs whitespace-pre-wrap">{selected.proposedFix.steps}</pre>}
                        <p className="text-xs"><span className="text-muted-foreground">The organizer will be told:</span> {selected.proposedFix.organizerMessage}</p>
                        {selected.fixStatus && (
                          <p className="text-xs font-semibold">{FIX_STATUS_LABEL[selected.fixStatus] ?? selected.fixStatus}{selected.fixResult ? `: ${selected.fixResult}` : ""}</p>
                        )}
                        {selected.fixPrUrl && <a href={selected.fixPrUrl} target="_blank" rel="noreferrer" className="text-xs underline">Open the pull request</a>}
                        {selected.fixStatus === "awaiting_approval" && (
                          <div className="flex flex-wrap gap-2 pt-1">
                            <Button size="sm" disabled={busy} onClick={() => act("fix-decision", { decision: "approve" }, selected.proposedFix?.kind === "data" ? "Fix run" : "Pull request opened")}>
                              {selected.proposedFix.kind === "data" ? "Approve and run the fix" : "Approve and open the pull request"}
                            </Button>
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => act("fix-decision", { decision: "decline" }, "Fix declined")}>Decline fix</Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {selected.resolution && (
                  <div className="rounded-md border border-green-600/30 bg-green-500/5 p-3 text-sm">
                    <p className="text-xs font-bold uppercase tracking-wider text-green-700 mb-1">Resolution</p>
                    <p className="whitespace-pre-wrap">{selected.resolution}</p>
                  </div>
                )}

                <div className="flex flex-wrap gap-2 pt-1">
                  <Button variant="outline" className="gap-1.5" onClick={async () => {
                    await navigator.clipboard.writeText(investigationBrief(selected));
                    toast({ title: "Investigation brief copied", description: "Paste it into a Claude Code session." });
                  }}>
                    <Copy size={14} /> Copy investigation brief
                  </Button>
                  {selected.status === "open" && (
                    <>
                      <Button className="gap-1.5" disabled={busy} onClick={() => act("decide", { decision: "approve" }, "Approved: the organizer was told you're on it")}>
                        <Check size={14} /> Approve investigation
                      </Button>
                      <Button variant="outline" className="gap-1.5" disabled={busy} onClick={() => act("decide", { decision: "decline" }, "Declined")}>
                        <X size={14} /> Decline
                      </Button>
                    </>
                  )}
                </div>

                {(selected.status === "open" || selected.status === "approved") && (
                  <div className="space-y-2 border-t pt-4">
                    <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Mark fixed</p>
                    <Textarea value={resolution} onChange={e => setResolution(e.target.value)} rows={3}
                      placeholder="What was wrong and what you fixed. The organizer sees this in their Rocky chat." />
                    <Button disabled={busy || !resolution.trim()} onClick={() => act("resolve", { resolution }, "Resolved: the organizer was told")}>
                      Resolve and tell the organizer
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ) : (
            <p className="text-sm text-muted-foreground">Pick a request to see what Rocky found.</p>
          )}
        </div>
      )}
    </div>
  );
}
