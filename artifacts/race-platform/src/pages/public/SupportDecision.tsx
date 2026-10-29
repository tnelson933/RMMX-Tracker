import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";

interface TicketPreview {
  id: number;
  summary: string;
  urgency: "normal" | "urgent";
  status: string;
  clubName: string | null;
  eventName: string | null;
  canDecide: boolean;
  message: string | null;
  /** stage=fix: the fix the investigation proposed. */
  fix?: { kind: string; summary: string; rootCause: string; sql: string | null; expectedRows: number | null; files: string[] } | null;
  fixStatus?: string | null;
  fixResult?: string | null;
}

/**
 * Opened from the Approve / Decline link in a support-request email or text.
 * Opening the link decides nothing (mail scanners follow links); a tap here does.
 */
export default function SupportDecision() {
  const params = new URLSearchParams(window.location.search);
  const ticketId = Number(params.get("ticket"));
  const token = params.get("token") ?? "";
  const suggested = params.get("decision");
  // stage=fix: approving the fix the investigation proposed, not the request itself.
  const isFix = params.get("stage") === "fix";
  const [ticket, setTicket] = useState<TicketPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"approved" | "declined" | null>(null);
  const [fixOutcome, setFixOutcome] = useState<string | null>(null);

  useEffect(() => {
    if (!ticketId || !token) { setError("This link is missing information. Open the ticket in RM Roost instead."); return; }
    fetch(`/api/support/tickets/${ticketId}/email-decision?token=${encodeURIComponent(token)}${isFix ? "&stage=fix" : ""}`)
      .then(async r => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error ?? "This link isn't valid.");
        setTicket(body);
      })
      .catch(err => setError(err.message));
  }, [ticketId, token, isFix]);

  async function decide(decision: "approve" | "decline") {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/support/tickets/${ticketId}/email-decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, decision, ...(isFix ? { stage: "fix" } : {}) }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? "Couldn't save that. Try again.");
      if (isFix) setFixOutcome(body.message ?? "Done.");
      else setDone(body.status);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-12">
      <Card>
        <CardContent className="p-6 space-y-4">
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{isFix ? "Proposed fix for support request" : "Rocky support request"}{ticket ? ` #${ticket.id}` : ""}</p>
          {!ticket && !error && <Loader2 className="animate-spin text-muted-foreground" />}
          {ticket && (
            <>
              <h1 className="font-heading font-bold text-xl leading-snug">{ticket.summary}</h1>
              {ticket.urgency === "urgent" && (
                <p className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-red-700">
                  <AlertTriangle size={13} /> Urgent: racing or check-in is blocked
                </p>
              )}
              <p className="text-sm text-muted-foreground">{[ticket.clubName, ticket.eventName].filter(Boolean).join(" · ")}</p>
            </>
          )}
          {isFix && ticket?.fix && (
            <div className="space-y-2 text-sm">
              <p className="font-semibold">{ticket.fix.summary}</p>
              <p className="text-muted-foreground whitespace-pre-wrap">{ticket.fix.rootCause.slice(0, 1200)}</p>
              {ticket.fix.sql && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">Data fix · changes exactly {ticket.fix.expectedRows} row{ticket.fix.expectedRows === 1 ? "" : "s"}</p>
                  <pre className="rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-all">{ticket.fix.sql}</pre>
                </div>
              )}
              {ticket.fix.files.length > 0 && (
                <p className="text-xs text-muted-foreground">Code fix in {ticket.fix.files.join(", ")}. Approving opens a pull request; merging it deploys.</p>
              )}
            </div>
          )}
          {isFix ? (
            fixOutcome ? (
              <p className="flex items-center gap-2 text-sm font-semibold"><CheckCircle2 className="text-green-600" size={18} /> {fixOutcome}</p>
            ) : ticket?.canDecide ? (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => decide("approve")} disabled={busy} variant={suggested === "decline" ? "outline" : "default"}>
                  {busy ? <Loader2 size={14} className="animate-spin mr-1.5" /> : null} {ticket.fix?.kind === "data" ? "Approve and run the fix" : "Approve and open the pull request"}
                </Button>
                <Button onClick={() => decide("decline")} disabled={busy} variant={suggested === "decline" ? "default" : "outline"}>Decline</Button>
              </div>
            ) : ticket ? (
              <p className="text-sm text-muted-foreground">{ticket.message ?? ticket.fixResult}</p>
            ) : null
          ) : done ? (
            <p className="flex items-center gap-2 text-sm font-semibold">
              {done === "approved" ? <CheckCircle2 className="text-green-600" size={18} /> : <XCircle className="text-muted-foreground" size={18} />}
              {done === "approved"
                ? "Approved. The investigation has started and the organizer was told. You'll get an email and text when the proposed fix is ready."
                : "Declined. The organizer was told."}
            </p>
          ) : ticket?.canDecide ? (
            <>
              <p className="text-sm">
                Approving starts an investigation (code and read-only data) and tells the organizer the RM Roost team is on it. You'll get the proposed fix to approve; nothing in RM Roost changes until you do.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => decide("approve")} disabled={busy} variant={suggested === "decline" ? "outline" : "default"}>
                  {busy ? <Loader2 size={14} className="animate-spin mr-1.5" /> : null} Approve investigation
                </Button>
                <Button onClick={() => decide("decline")} disabled={busy} variant={suggested === "decline" ? "default" : "outline"}>
                  Decline
                </Button>
              </div>
            </>
          ) : ticket?.message ? (
            <p className="text-sm text-muted-foreground">{ticket.message}</p>
          ) : null}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {ticket && (
            <a href={`/admin/support?ticket=${ticket.id}`} className="block text-sm underline text-muted-foreground">Open the ticket in RM Roost</a>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
