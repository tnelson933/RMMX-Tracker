import { useEffect, useState, useRef } from "react";
import { useListEvents } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Bell, Send, Smartphone, Info, Clock } from "lucide-react";

const RATE_LIMIT_MS = 1 * 60 * 60 * 1000;

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function isEventInWindow(eventDate: string, eventEndDate?: string | null): boolean {
  const [year, month, day] = eventDate.slice(0, 10).split("-").map(Number);
  const windowStart = new Date(year, month - 1, day, 0, 0, 0, 0);
  windowStart.setTime(windowStart.getTime() - 24 * 60 * 60 * 1000);
  // For multi-day events, extend window end to 48h after the last day
  const endStr = (eventEndDate || eventDate).slice(0, 10);
  const [ey, em, ed] = endStr.split("-").map(Number);
  const windowEnd = new Date(ey, em - 1, ed, 0, 0, 0, 0);
  windowEnd.setTime(windowEnd.getTime() + 48 * 60 * 60 * 1000);
  const now = new Date();
  return now >= windowStart && now <= windowEnd;
}

function formatContinuationDate(dateStr: string): string {
  if (!dateStr) return "";
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function formatTime12h(timeStr: string): string {
  if (!timeStr) return "";
  const [hStr, mStr] = timeStr.split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

type NotifType = "" | "schedule_delay" | "weather_alert";
type DelayReason = "" | "Weather" | "Track Maintenance" | "Timing Delay";

function generateMessage(
  type: NotifType,
  eventName: string,
  delayReason: DelayReason,
  resumptionTime: string,
  cancelForDay: boolean,
  continuationDate: string,
  weatherConditions: string
): { title: string; body: string } {
  if (type === "schedule_delay") {
    const reasonLabel = delayReason || "Unexpected";
    if (cancelForDay) {
      const contLabel = continuationDate
        ? ` We plan to continue on ${formatContinuationDate(continuationDate)}.`
        : "";
      return {
        title: `⚠️ ${eventName} — Canceled for Today`,
        body: `Racing has been canceled for today due to ${reasonLabel.toLowerCase()} conditions.${contLabel}`,
      };
    }
    const resumeLabel = resumptionTime
      ? ` Racing is expected to resume at ${formatTime12h(resumptionTime)}.`
      : "";
    return {
      title: `⚠️ Schedule Change — ${eventName}`,
      body: `${reasonLabel} delay in effect.${resumeLabel} Stay tuned for updates.`,
    };
  }
  if (type === "weather_alert") {
    return {
      title: `⛈ Weather Advisory — ${eventName}`,
      body: weatherConditions.trim() || "Severe weather conditions approaching. Stay alert.",
    };
  }
  return { title: "", body: "" };
}

export function Notifications() {
  const [eventId, setEventId] = useState<string>("");
  const [notifType, setNotifType] = useState<NotifType>("");
  const [delayReason, setDelayReason] = useState<DelayReason>("");
  const [resumptionTime, setResumptionTime] = useState("");
  const [cancelForDay, setCancelForDay] = useState(false);
  const [continuationDate, setContinuationDate] = useState("");
  const [weatherConditions, setWeatherConditions] = useState("");
  const [sending, setSending] = useState(false);
  const [pushCount, setPushCount] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { toast } = useToast();
  const { user } = useAuth();

  const { data: events } = useListEvents(
    { params: { query: { clubId: user?.clubId } } } as any,
  );

  const eligibleEvents = events?.filter((e) => isEventInWindow(e.date, (e as any).endDate)) ?? [];

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
        setCountdown(RATE_LIMIT_MS - elapsed);
      } else {
        localStorage.removeItem("lastPushSentAt");
      }
    }
  }, []);

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

  const selectedEvent = eligibleEvents.find((e) => String(e.id) === eventId);

  const { title: generatedTitle, body: generatedBody } = generateMessage(
    notifType,
    selectedEvent?.name ?? "",
    delayReason,
    resumptionTime,
    cancelForDay,
    continuationDate,
    weatherConditions
  );

  const isMessageReady = (() => {
    if (!selectedEvent || !notifType) return false;
    if (notifType === "schedule_delay") {
      if (!delayReason) return false;
      if (cancelForDay) return true;
      return !!resumptionTime;
    }
    if (notifType === "weather_alert") {
      return weatherConditions.trim().length > 0;
    }
    return false;
  })();

  const isRateLimited = countdown > 0;
  const canSend = !isRateLimited && isMessageReady && !sending;

  function resetTypeFields() {
    setDelayReason("");
    setResumptionTime("");
    setCancelForDay(false);
    setContinuationDate("");
    setWeatherConditions("");
  }

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    try {
      const res = await fetch("/api/admin/notifications/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: generatedTitle,
          body: generatedBody,
          eventId: parseInt(eventId),
        }),
      });
      const data = await res.json();
      if (res.status === 429) {
        const retryMs = (data.retryAfterSeconds ?? 14400) * 1000;
        setCountdown(retryMs);
        const sentAt = data.lastSentAt
          ? new Date(data.lastSentAt)
          : new Date(Date.now() - (RATE_LIMIT_MS - retryMs));
        localStorage.setItem("lastPushSentAt", sentAt.toISOString());
        throw new Error(`Rate limit active. Try again in ${formatCountdown(retryMs)}.`);
      }
      if (!res.ok) throw new Error(data.error || "Failed to send");

      if (data.lastPushSentAt) {
        const sentAt = new Date(data.lastPushSentAt);
        const remaining = RATE_LIMIT_MS - (Date.now() - sentAt.getTime());
        setCountdown(Math.max(0, remaining));
        localStorage.setItem("lastPushSentAt", sentAt.toISOString());
      }

      toast({
        title: "Notifications sent",
        description: `${data.sent} rider${data.sent !== 1 ? "s" : ""} notified`,
      });
      setNotifType("");
      resetTypeFields();
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
              through 24 hours after race day ends.
            </li>
            <li>You may send at most 1 manual notification every 4 hours.</li>
            <li>
              Supported types: <strong>Schedule Change / Delay</strong> and{" "}
              <strong>Weather Alert</strong>.
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
        {/* Event selector — only shows eligible events */}
        <div className="space-y-2">
          <Label>Send to</Label>
          <Select
            value={eventId}
            onValueChange={(v) => {
              setEventId(v);
              setNotifType("");
              resetTypeFields();
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select an event…" />
            </SelectTrigger>
            <SelectContent>
              {eligibleEvents.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  No events in the notification window right now.
                </div>
              ) : (
                eligibleEvents.map((event) => (
                  <SelectItem key={event.id} value={String(event.id)}>
                    {event.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          {!eventId && (
            <p className="text-xs text-muted-foreground">
              Only events within the 24h-before through 24h-after window are shown.
            </p>
          )}
          {eventId && (
            <p className="text-xs text-muted-foreground">
              Only riders registered for this event will receive this notification.
            </p>
          )}
        </div>

        {/* Notification type selector */}
        {eventId && (
          <div className="space-y-2">
            <Label>Notification type</Label>
            <Select
              value={notifType}
              onValueChange={(v) => {
                setNotifType(v as NotifType);
                resetTypeFields();
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose a type…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="schedule_delay">⚠️ Schedule Change / Delay</SelectItem>
                <SelectItem value="weather_alert">⛈ Weather Alert</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Schedule Change / Delay fields */}
        {notifType === "schedule_delay" && (
          <div className="space-y-4 pt-1">
            <div className="space-y-2">
              <Label>Delay reason</Label>
              <Select
                value={delayReason}
                onValueChange={(v) => setDelayReason(v as DelayReason)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a reason…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Weather">Weather</SelectItem>
                  <SelectItem value="Track Maintenance">Track Maintenance</SelectItem>
                  <SelectItem value="Timing Delay">Timing Delay</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {!cancelForDay && (
              <div className="space-y-2">
                <Label htmlFor="resumption-time">Expected resumption time</Label>
                <Input
                  id="resumption-time"
                  type="time"
                  value={resumptionTime}
                  onChange={(e) => setResumptionTime(e.target.value)}
                />
              </div>
            )}

            <div className="flex items-center gap-2">
              <Checkbox
                id="cancel-for-day"
                checked={cancelForDay}
                onCheckedChange={(checked) => {
                  setCancelForDay(!!checked);
                  if (!checked) setContinuationDate("");
                }}
              />
              <Label htmlFor="cancel-for-day" className="cursor-pointer font-normal">
                Cancel racing for the day
              </Label>
            </div>

            {cancelForDay && (
              <div className="space-y-2">
                <Label htmlFor="continuation-date">Continuation date (optional)</Label>
                <Input
                  id="continuation-date"
                  type="date"
                  value={continuationDate}
                  onChange={(e) => setContinuationDate(e.target.value)}
                />
              </div>
            )}
          </div>
        )}

        {/* Weather Alert fields */}
        {notifType === "weather_alert" && (
          <div className="space-y-2">
            <Label htmlFor="weather-conditions">Describe the incoming conditions</Label>
            <Textarea
              id="weather-conditions"
              value={weatherConditions}
              onChange={(e) => setWeatherConditions(e.target.value)}
              placeholder="e.g. Thunderstorms moving in from the west. Lightning in the area — racing suspended until further notice."
              rows={3}
              maxLength={400}
            />
            <p className="text-xs text-muted-foreground text-right">
              {weatherConditions.length}/400
            </p>
          </div>
        )}

        {/* Message preview */}
        {isMessageReady && (
          <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Preview — what riders will receive
            </p>
            <p className="font-semibold text-sm">{generatedTitle}</p>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{generatedBody}</p>
          </div>
        )}

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
