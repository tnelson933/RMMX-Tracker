import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { errorText, responseErrorMessage } from "@/lib/friendlyErrors";
import { Bell, CheckCircle2, Loader2, Mail, MessageSquare, Phone, XCircle } from "lucide-react";

/**
 * Transponder rental return reminders, shared by the event's Transponder
 * Rentals page and Admin → Rentals: the renter panel (call, text, email, send
 * a push reminder), the "Remind all" button, and who was and wasn't reached.
 */

export type ReminderStatus = "sent" | "no_app" | "no_notifications" | "failed";

export interface RentalDetail {
  registrationId: number;
  riderId: number;
  eventId: number;
  eventName: string;
  eventDate: string;
  riderName: string;
  email: string | null;
  phone: string | null;
  emergencyContact: string | null;
  emergencyPhone: string | null;
  bibNumber: string | null;
  transponderNumber: string | null;
  transponderReturned: boolean;
  raceClass: string;
  hasPushToken: boolean;
  notifyBlockedReason: string | null;
  reminderStatus: ReminderStatus | null;
  reminderMessage: string | null;
  reminderAt: string | null;
  replacementCharge: number | null;
}

export interface ReminderResult {
  registrationId: number;
  riderId: number;
  eventId: number;
  riderName: string;
  status: ReminderStatus;
  message: string;
}

/** The text riders get (matches the server's). */
export function reminderPreview(charge: number | null): string {
  const amount = charge != null ? ` $${charge.toFixed(2)}` : " the cost of the transponder";
  return `Don't forget to return your rented transponder. Any transponders not returned within 24 hours will be charged${amount}.`;
}

/** Check mark (sent) or red X (not sent, with why) for a rental's last reminder. */
export function ReminderMark({ status, message, className = "" }: { status: ReminderStatus | null; message: string | null; className?: string }) {
  if (!status) return <span className={`text-muted-foreground text-xs ${className}`}>—</span>;
  const label = message ?? (status === "sent" ? "Push notification sent" : "Not sent");
  return (
    <span title={label} aria-label={label} role="img" className={`inline-flex ${className}`}>
      {status === "sent" ? <CheckCircle2 size={16} className="text-emerald-600" /> : <XCircle size={16} className="text-red-600" />}
    </span>
  );
}

/** A tel:/sms: friendly version of a phone number. */
const dialable = (phone: string) => phone.replace(/[^\d+]/g, "");

/** The renter panel: who has the transponder, how to reach them, and the push reminder. */
export function RenterDialog({ eventId, registrationId, onClose, onReminded }: {
  eventId: number | null;
  registrationId: number | null;
  onClose: () => void;
  onReminded?: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [sending, setSending] = useState(false);
  const open = eventId != null && registrationId != null;
  const key = ["rental-detail", eventId, registrationId];
  const { data: rental, isLoading, isError, refetch } = useQuery<RentalDetail>({
    queryKey: key,
    enabled: open,
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/transponder-rentals/registrations/${registrationId}`, { credentials: "include" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(responseErrorMessage(res.status, body));
      return body;
    },
  });

  async function remind() {
    if (!rental) return;
    setSending(true);
    try {
      const res = await fetch(`/api/events/${rental.eventId}/transponder-rentals/registrations/${rental.registrationId}/remind`, { method: "POST", credentials: "include" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(responseErrorMessage(res.status, body));
      toast({ title: "Reminder sent", description: `${rental.riderName} got a push notification to return the transponder.` });
    } catch (err) {
      toast({ title: "Reminder not sent", description: errorText(err), variant: "destructive" });
    } finally {
      setSending(false);
      await queryClient.invalidateQueries({ queryKey: key });
      onReminded?.();
    }
  }

  const canSend = !!rental && rental.hasPushToken && !rental.transponderReturned;
  const blockedReason = !rental ? null
    : rental.transponderReturned ? "This transponder is already marked returned."
    : rental.notifyBlockedReason;

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading uppercase tracking-wide">{rental?.riderName ?? "Renter"}</DialogTitle>
          <DialogDescription>
            {rental ? `${rental.eventName} (${rental.eventDate}) · ${rental.raceClass}${rental.bibNumber ? ` · #${rental.bibNumber}` : ""}` : "Rental transponder"}
          </DialogDescription>
        </DialogHeader>

        {isError ? (
          <p className="text-sm text-muted-foreground">Couldn't load this rental. <button className="underline" onClick={() => refetch()}>Try again</button></p>
        ) : isLoading || !rental ? (
          <div className="flex justify-center py-6"><Loader2 className="animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
              <span className="text-muted-foreground">Transponder</span>
              <span className="font-mono font-semibold uppercase">{rental.transponderNumber ?? "Not handed out yet"}</span>
              <span className={`text-xs font-semibold ${rental.transponderReturned ? "text-emerald-700" : "text-amber-700"}`}>
                {rental.transponderReturned ? "Returned" : "Still out"}
              </span>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Contact</p>
              {rental.phone ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{rental.phone}</span>
                  <Button asChild size="sm" variant="outline" className="h-7 gap-1 text-xs">
                    <a href={`tel:${dialable(rental.phone)}`}><Phone size={12} /> Call</a>
                  </Button>
                  <Button asChild size="sm" variant="outline" className="h-7 gap-1 text-xs">
                    <a href={`sms:${dialable(rental.phone)}?body=${encodeURIComponent(reminderPreview(rental.replacementCharge))}`}><MessageSquare size={12} /> Text</a>
                  </Button>
                </div>
              ) : (
                <p className="text-muted-foreground">No phone number on file.</p>
              )}
              {rental.email ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all">{rental.email}</span>
                  <Button asChild size="sm" variant="outline" className="h-7 gap-1 text-xs">
                    <a href={`mailto:${rental.email}?subject=${encodeURIComponent("Please return your rented transponder")}&body=${encodeURIComponent(reminderPreview(rental.replacementCharge))}`}><Mail size={12} /> Email</a>
                  </Button>
                </div>
              ) : (
                <p className="text-muted-foreground">No email on file.</p>
              )}
              {(rental.emergencyContact || rental.emergencyPhone) && (
                <p className="text-muted-foreground">
                  Emergency contact: {rental.emergencyContact ?? "—"}
                  {rental.emergencyPhone && <> · <a className="underline" href={`tel:${dialable(rental.emergencyPhone)}`}>{rental.emergencyPhone}</a></>}
                </p>
              )}
            </div>

            <div className="space-y-2 rounded-lg border p-3">
              <Button onClick={remind} disabled={!canSend || sending} className="w-full gap-1.5" title={blockedReason ?? undefined}>
                {sending ? <Loader2 size={14} className="animate-spin" /> : <Bell size={14} />}
                Send notification about rental return
              </Button>
              {blockedReason && <p className="text-xs text-muted-foreground">{blockedReason}</p>}
              <p className="text-xs text-muted-foreground">They'll get: "{reminderPreview(rental.replacementCharge)}"</p>
              {rental.reminderStatus && (
                <p className="flex items-center gap-1.5 text-xs">
                  <ReminderMark status={rental.reminderStatus} message={rental.reminderMessage} />
                  {rental.reminderMessage}
                  {rental.reminderAt && <span className="text-muted-foreground">· {new Date(rental.reminderAt).toLocaleString()}</span>}
                </p>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** "Remind all to return transponders" plus the results: a check mark or red X per rider. */
export function RemindAllPanel({ url, outCount, onDone, onOpenRenter }: {
  url: string;
  outCount: number;
  onDone?: () => void;
  onOpenRenter?: (r: ReminderResult) => void;
}) {
  const { toast } = useToast();
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<ReminderResult[] | null>(null);

  async function remindAll() {
    setSending(true);
    try {
      const res = await fetch(url, { method: "POST", credentials: "include" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(responseErrorMessage(res.status, body));
      const list: ReminderResult[] = body?.results ?? [];
      setResults(list);
      const sent = list.filter(r => r.status === "sent").length;
      toast({
        title: list.length === 0 ? "No transponders are out" : `Reminder sent to ${sent} of ${list.length} rider${list.length === 1 ? "" : "s"}`,
        description: list.length > sent ? "Riders with a red X didn't get it. Open their name to call or text them." : undefined,
      });
    } catch (err) {
      toast({ title: "Couldn't send reminders", description: errorText(err), variant: "destructive" });
    } finally {
      setSending(false);
      onDone?.();
    }
  }

  return (
    <div className="space-y-3">
      <Button onClick={remindAll} disabled={sending || outCount === 0} className="gap-1.5 bg-amber-500 hover:bg-amber-600 text-white"
        title={outCount === 0 ? "No transponders are out" : undefined}>
        {sending ? <Loader2 size={14} className="animate-spin" /> : <Bell size={14} />}
        Remind all to return transponders
      </Button>
      {results && results.length > 0 && (
        <div className="rounded-lg border bg-card">
          <div className="px-4 py-2 border-b text-xs font-semibold uppercase tracking-wider text-muted-foreground">Push notification sent</div>
          <ul className="divide-y">
            {results.map(r => (
              <li key={r.registrationId} className="flex items-center gap-2 px-4 py-2 text-sm">
                <ReminderMark status={r.status} message={r.message} />
                {onOpenRenter
                  ? <button className="font-medium underline-offset-2 hover:underline" onClick={() => onOpenRenter(r)}>{r.riderName}</button>
                  : <span className="font-medium">{r.riderName}</span>}
                {r.status !== "sent" && <span className="text-xs text-red-700">{r.message.replace(/^Not sent: /, "")}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
