import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { format, parseISO } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Upload, CalendarCheck2 } from "lucide-react";

const SESSION_KEY = "rmtracker.unpublishedResultsDismissed";

interface UnpublishedEvent {
  id: number;
  name: string;
  date: string;
  location: string | null;
  trackName: string | null;
  state: string | null;
}

interface UnpublishedResultsDialogProps {
  clubId: number;
}

export function UnpublishedResultsDialog({ clubId }: UnpublishedResultsDialogProps) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<UnpublishedEvent[]>([]);
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!clubId) return;
    if (sessionStorage.getItem(SESSION_KEY)) return;

    fetch(`/api/clubs/${clubId}/unpublished-completed-events`)
      .then(r => r.ok ? r.json() : [])
      .then((data: UnpublishedEvent[]) => {
        if (data.length > 0) {
          setEvents(data);
          setOpen(true);
        }
      })
      .catch(() => {});
  }, [clubId]);

  const handleDismiss = () => {
    sessionStorage.setItem(SESSION_KEY, "true");
    setOpen(false);
  };

  const handleGoToEvent = (eventId: number) => {
    handleDismiss();
    navigate(`/events/${eventId}/results`);
  };

  if (!open || events.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleDismiss(); }}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0">
          <div className="flex items-center gap-3 mb-1">
            <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
              <Upload size={20} className="text-blue-600" />
            </div>
            <DialogTitle className="font-heading text-xl uppercase tracking-tight">
              Results Not Published
            </DialogTitle>
          </div>
          <DialogDescription className="text-sm text-muted-foreground">
            {events.length === 1
              ? "1 completed event has results that haven't been published yet."
              : `${events.length} completed events have results that haven't been published yet.`}
            {" "}Riders and spectators won't see results until you publish them.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-2 space-y-3">
          {events.map((event) => (
            <div key={event.id} className="border rounded-lg p-4 space-y-3 bg-white">
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
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="outline" className="text-xs uppercase border-blue-300 text-blue-700 bg-blue-50">
                    Unpublished
                  </Badge>
                  <span className="text-sm text-muted-foreground whitespace-nowrap flex items-center gap-1">
                    <CalendarCheck2 size={13} />
                    {format(parseISO(event.date.substring(0, 10)), "MMM d, yyyy")}
                  </span>
                </div>
              </div>
              <Button
                size="sm"
                className="w-full"
                onClick={() => handleGoToEvent(event.id)}
              >
                <Upload size={14} className="mr-2" />
                Go to Enter Results &amp; Publish
              </Button>
            </div>
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
