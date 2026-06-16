import { useEffect, useState, useRef } from "react";
import { useListEvents } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Bell, Send, Smartphone, Info, Clock, AlertCircle } from "lucide-react";

const RATE_LIMIT_MS = 4 * 60 * 60 * 1000; // 4 hours in ms

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function getEventTimingStatus(eventDate: string): {
  allowed: boolean;
  message: string;
} {
  const [year, month, day] = eventDate.split("-").map(Number);
  const windowStart = new Date(year, month - 1, day, 0, 0, 0, 0);
  windowStart.setTime(windowStart.getTime() - 24 * 60 * 60 * 1000);
  const windowEnd = new Date(year, month - 1, day, 23, 59, 59, 999);
  const now = new Date();

  if (now < windowStart) {
    const dateStr = windowStart.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return {
      allowed: false,
      message: `Notifications open on ${dateStr} (24 hours before race day)`,
    };
  }
  if (now > windowEnd) {
    return {
      allowed: false,
      message: "This event has ended. Notifications are no longer allowed.",
    };
  }
  return { allowed: true, message: "" };
}

export function Notifications() {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [eventId, setEventId] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [pushCount, setPushCount] = useState<number | null>(null);
  const [lastSentAt, setLastSentAt] = useState<Date | null>(null);
  const [countdown, setCountdown] = useState<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { toast } = useToast();
  const { user } = useAuth();

  const { data: events } = useListEvents(
    { params: { query: { clubId: user?.clubId } } } as any,
  );

  // Load push stats and any persisted lastPushSentAt from localStorage
  useEffect(() => {
    fetch("/api/admin/notifications/push-stats")
      .then((r) => r.json())
      .then((d) => setPushCount(d.total))
      .catch(() => {});

    const stored = localStorage.getItem("lastPushSentAt");
    if (stored) {
      const d = new Date(stored);
      const elapsed = Date.now() - d.getTime();
      if (elapsed < RATE_LIMIT_MS) {
        setLastSentAt(d);
        setCountdown(RATE_LIMIT_MS - elapsed);
      } else {
        localStorage.removeItem("lastPushSentAt");
      }
    }
  }, []);

  // Countdown ticker
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (countdown > 0) {
      timerRef.current = setInterval(() => {
        setCountdown((prev) => {
          const next = prev - 1000;
          if (next <= 0) {
            clearInterval(timerRef.current!);
            localStorage.removeItem("lastPushSentAt");
            return 0;
          }
          return next;
        });
      }, 1000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [countdown > 0]);

  const selectedEvent = events?.find((e) => String(e.id) === eventId);
  const timingStatus = selectedEvent
    ? getEventTimingStatus(selectedEvent.date)
    : null;

  const isRateLimited = countdown > 0;
  const canSend =
    !isRateLimited &&
    !!eventId &&
    !!title.trim() &&
    !!body.trim() &&
    !sending &&
    (timingStatus?.allowed ?? false);

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    try {
      const res = await fetch("/api/admin/notifications/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          eventId: parseInt(eventId),
        }),
      });
      const data = await res.json();
      if (res.status === 429) {
        const retryMs = (data.retryAfterSeconds ?? 14400) * 1000;
        setCountdown(retryMs);
        const sentAt = data.lastSentAt ? new Date(data.lastSentAt) : new Date(Date.now() - (RATE_LIMIT_MS - retryMs));
        setLastSentAt(sentAt);
        localStorage.setItem("lastPushSentAt", sentAt.toISOString());
        throw new Error(`Rate limit active. Try again in ${formatCountdown(retryMs)}.`);
      }
      if (!res.ok) throw new Error(data.error || "Failed to send");

      // Persist rate limit from server response
      if (data.lastPushSentAt) {
        const sentAt = new Date(data.lastPushSentAt);
        setLastSentAt(sentAt);
        const remaining = RATE_LIMIT_MS - (Date.now() - sentAt.getTime());
        setCountdown(Math.max(0, remaining));
        localStorage.setItem("lastPushSentAt", sentAt.toISOString());
      }

      toast({
        title: "Notifications sent",
        description: `${data.sent} rider${data.sent !== 1 ? "s" : ""} notified`,
      });
      setTitle("");
      setBody("");
    } catch (e: any) {
      toast({
        title: "Failed to send",
        description: e.message,
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-2">
        <Bell className="text-primary" size={22} />
        <h1 className="font-heading text-2xl font-bold uppercase tracking-wider">
          Push Notifications
        </h1>
      </div>

      {pushCount !== null && (
        <div className="flex items-center gap-2 mb-6 text-sm text-muted-foreground">
          <Smartphone size={14} />
          <span>
            {pushCount} rider{pushCount !== 1 ? "s" : ""} have the app
            installed with notifications enabled
          </span>
        </div>
      )}

      {/* Policy callout */}
      <div className="mb-6 p-4 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg flex gap-3">
        <Info size={18} className="text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
        <div className="space-y-1.5 text-sm">
          <p className="font-semibold text-blue-900 dark:text-blue-200">
            Notification Policy
          </p>
          <ul className="space-y-1 text-blue-800 dark:text-blue-300 list-disc list-inside">
            <li>You must select a specific event — you cannot blast all riders.</li>
            <li>
              Notifications can only be sent within 24 hours before the event
              through end of race day.
            </li>
            <li>
              You may send at most 1 manual notification every 4 hours.
            </li>
          </ul>
        </div>
      </div>

      {/* Rate limit countdown */}
      {isRateLimited && (
        <div className="mb-5 p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg flex items-center gap-3 text-sm">
          <Clock size={16} className="text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="text-amber-800 dark:text-amber-300">
            Next notification available in{" "}
            <span className="font-mono font-bold">{formatCountdown(countdown)}</span>
          </span>
        </div>
      )}

      <div className="bg-card border rounded-lg p-6 space-y-5">
        <div className="space-y-2">
          <Label>Send to</Label>
          <Select value={eventId} onValueChange={setEventId}>
            <SelectTrigger>
              <SelectValue placeholder="Select an event…" />
            </SelectTrigger>
            <SelectContent>
              {events?.map((event) => (
                <SelectItem key={event.id} value={String(event.id)}>
                  {event.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!eventId && (
            <p className="text-xs text-muted-foreground">
              Select an event to notify its registered riders.
            </p>
          )}
          {eventId && timingStatus && !timingStatus.allowed && (
            <div className="flex items-start gap-2 text-xs text-destructive mt-1">
              <AlertCircle size={13} className="shrink-0 mt-0.5" />
              <span>{timingStatus.message}</span>
            </div>
          )}
          {eventId && timingStatus?.allowed && (
            <p className="text-xs text-muted-foreground">
              Only riders registered for this event will receive this.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="notif-title">Title</Label>
          <Input
            id="notif-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Race day announcement…"
            maxLength={100}
            disabled={!eventId || !timingStatus?.allowed || isRateLimited}
          />
          <p className="text-xs text-muted-foreground text-right">
            {title.length}/100
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="notif-body">Message</Label>
          <Textarea
            id="notif-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Gates open at 8am, first moto at 9am…"
            rows={3}
            maxLength={500}
            disabled={!eventId || !timingStatus?.allowed || isRateLimited}
          />
          <p className="text-xs text-muted-foreground text-right">
            {body.length}/500
          </p>
        </div>

        <Button
          onClick={handleSend}
          disabled={!canSend}
          className="w-full"
        >
          <Send size={15} className="mr-2" />
          {sending ? "Sending…" : "Send Push Notification"}
        </Button>
      </div>

      <div className="mt-6 p-4 bg-muted/40 rounded-lg border text-sm text-muted-foreground space-y-2">
        <p className="font-medium text-foreground">Automatic race-day notifications</p>
        <p>
          Riders are automatically notified when they are <strong>next up</strong> or{" "}
          <strong>3 races away</strong> as motos complete throughout the day.
        </p>
      </div>
    </div>
  );
}
