import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useListEvents, useUpdateEvent } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { format, parseISO, isBefore, startOfDay } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { CheckCircle2, Calendar, Loader2, CalendarClock } from "lucide-react";
import type { Event } from "@workspace/api-client-react";

const SESSION_KEY = "rmmx.pastEventCheckDismissed";

interface EventRowProps {
  event: Event;
  onResolved: (id: number) => void;
}

function EventRow({ event, onResolved }: EventRowProps) {
  const [mode, setMode] = useState<"idle" | "date">("idle");
  const [newDate, setNewDate] = useState(event.date.substring(0, 10));
  const update = useUpdateEvent();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const invalidate = () => queryClient.invalidateQueries();

  const markCompleted = () => {
    update.mutate(
      { eventId: event.id, data: { status: "completed" } },
      {
        onSuccess: () => {
          invalidate();
          onResolved(event.id);
        },
        onError: (err) => {
          toast({ title: "Update failed", description: err.message, variant: "destructive" });
        },
      }
    );
  };

  const saveDate = () => {
    if (!newDate) return;
    update.mutate(
      { eventId: event.id, data: { date: new Date(newDate + "T12:00:00").toISOString() } },
      {
        onSuccess: () => {
          invalidate();
          onResolved(event.id);
        },
        onError: (err) => {
          toast({ title: "Date update failed", description: err.message, variant: "destructive" });
        },
      }
    );
  };

  const statusLabel = event.status.replace(/_/g, " ");

  return (
    <div className="border rounded-lg p-4 space-y-3 bg-white">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="font-heading font-bold uppercase tracking-wide truncate">
            {event.name}
          </p>
          <p className="text-sm text-muted-foreground mt-0.5">
            {event.trackName || event.location}
            {event.state ? ` · ${event.state}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <Badge
            variant="outline"
            className="text-xs uppercase border-amber-400 text-amber-700 bg-amber-50"
          >
            {statusLabel}
          </Badge>
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            {format(parseISO(event.date.substring(0, 10)), "MMM d, yyyy")}
          </span>
        </div>
      </div>

      {mode === "idle" ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            onClick={markCompleted}
            disabled={update.isPending}
          >
            {update.isPending ? (
              <Loader2 size={14} className="mr-2 animate-spin" />
            ) : (
              <CheckCircle2 size={14} className="mr-2" />
            )}
            Mark Completed
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={() => setMode("date")}
            disabled={update.isPending}
          >
            <Calendar size={14} className="mr-2" />
            Update Race Date
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            type="date"
            value={newDate}
            min={new Date().toISOString().substring(0, 10)}
            onChange={(e) => setNewDate(e.target.value)}
            className="flex-1"
          />
          <Button
            size="sm"
            onClick={saveDate}
            disabled={update.isPending || !newDate}
          >
            {update.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              "Save"
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setMode("idle")}
            disabled={update.isPending}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

interface PastEventCheckDialogProps {
  clubId: number;
}

export function PastEventCheckDialog({ clubId }: PastEventCheckDialogProps) {
  const [open, setOpen] = useState(false);
  const [resolvedIds, setResolvedIds] = useState<Set<number>>(new Set());

  const { data: events } = useListEvents(
    { clubId },
    { query: { enabled: !!clubId } as any }
  );

  const today = startOfDay(new Date());

  const overdueEvents = (events ?? []).filter(
    (e) =>
      e.status !== "completed" &&
      isBefore(startOfDay(parseISO(e.date.substring(0, 10))), startOfDay(today)) &&
      !resolvedIds.has(e.id)
  );

  useEffect(() => {
    if (!events) return;
    if (sessionStorage.getItem(SESSION_KEY)) return;
    const hasOverdue = events.some(
      (e) =>
        e.status !== "completed" &&
        isBefore(startOfDay(parseISO(e.date.substring(0, 10))), startOfDay(new Date()))
    );
    if (hasOverdue) setOpen(true);
  }, [events]);

  const handleResolved = (id: number) => {
    setResolvedIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  useEffect(() => {
    if (open && overdueEvents.length === 0 && resolvedIds.size > 0) {
      setOpen(false);
    }
  }, [overdueEvents.length, open, resolvedIds.size]);

  const handleDismiss = () => {
    sessionStorage.setItem(SESSION_KEY, "true");
    setOpen(false);
  };

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleDismiss(); }}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0">
          <div className="flex items-center gap-3 mb-1">
            <div className="h-10 w-10 rounded-full bg-amber-100 flex items-center justify-center">
              <CalendarClock size={20} className="text-amber-600" />
            </div>
            <DialogTitle className="font-heading text-xl uppercase tracking-tight">
              Past Events Need Attention
            </DialogTitle>
          </div>
          <DialogDescription className="text-sm text-muted-foreground">
            {overdueEvents.length === 1
              ? "1 event is past its race date but hasn't been marked completed."
              : `${overdueEvents.length} events are past their race date but haven't been marked completed.`}
            {" "}Mark them completed or update the race date if it was rescheduled.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-2 space-y-3">
          {overdueEvents.map((event) => (
            <EventRow key={event.id} event={event} onResolved={handleResolved} />
          ))}
        </div>

        <div className="px-6 py-4 border-t shrink-0 flex justify-end">
          <Button variant="ghost" size="sm" onClick={handleDismiss}>
            Remind Me Later
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
