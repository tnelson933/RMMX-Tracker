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
  const [ticket, setTicket] = useState<TicketPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"approved" | "declined" | null>(null);

  useEffect(() => {
    if (!ticketId || !token) { setError("This link is missing information. Open the ticket in RM Roost instead."); return; }
    fetch(`/api/support/tickets/${ticketId}/email-decision?token=${encodeURIComponent(token)}`)
      .then(async r => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error ?? "This link isn't valid.");
        setTicket(body);
      })
      .catch(err => setError(err.message));
  }, [ticketId, token]);

  async function decide(decision: "approve" | "decline") {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/support/tickets/${ticketId}/email-decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, decision }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? "Couldn't save that. Try again.");
      setDone(body.status);
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
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Rocky support request{ticket ? ` #${ticket.id}` : ""}</p>
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
          {done ? (
            <p className="flex items-center gap-2 text-sm font-semibold">
              {done === "approved" ? <CheckCircle2 className="text-green-600" size={18} /> : <XCircle className="text-muted-foreground" size={18} />}
              {done === "approved"
                ? "Approved. The organizer was told the team is looking into it. Open the ticket to see what Rocky found."
                : "Declined. The organizer was told."}
            </p>
          ) : ticket?.canDecide ? (
            <>
              <p className="text-sm">
                Approving marks this for investigation and tells the organizer the RM Roost team is on it. Nothing in RM Roost changes until you fix it.
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
