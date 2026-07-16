import { useEffect, useState, useRef } from "react";
import { useListEvents, useGetNotificationHistory, getGetNotificationHistoryQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
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
import { Bell, Clock, Send, Smartphone, Users } from "lucide-react";

const TITLE_MAX = 100;
const BODY_MAX = 500;

type Audience = "all" | "event";

function audienceLabel(
  audienceType: string,
  eventId: number | null | undefined,
  eventMap: Map<number, string>,
): string {
  if (audienceType === "all_global") return "All riders (global)";
  if (audienceType === "event" && eventId) {
    return eventMap.get(eventId) ?? `Event #${eventId}`;
  }
  return "All my riders";
}

function formatSentAt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function Notifications() {
  const [audience, setAudience] = useState<Audience | "">("");
  const [eventId, setEventId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [pushCount, setPushCount] = useState<number | null>(null);
  const [audienceCount, setAudienceCount] = useState<number | null>(null);
  const [audienceCountLoading, setAudienceCountLoading] = useState(false);
  const audienceCountController = useRef<AbortController | null>(null);
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: events } = useListEvents(
    { params: { query: { clubId: user?.clubId } } } as any,
  );

  const { data: history, refetch: refetchHistory } = useGetNotificationHistory({ query: {} as any });

  const eventMap = new Map<number, string>(
    (events ?? []).map((e) => [e.id, e.name]),
  );

  const sortedEvents = [...(events ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );

  useEffect(() => {
    fetch("/api/admin/notifications/push-stats")
      .then((r) => r.json())
      .then((d) => setPushCount(d.clubCount ?? d.total))
      .catch(() => {});
  }, []);

  // Fetch audience count whenever audience or eventId changes
  useEffect(() => {
    const shouldFetch =
      audience === "all" || (audience === "event" && eventId !== "");

    if (!shouldFetch) {
      setAudienceCount(null);
      return;
    }

    // Cancel any in-flight request
    if (audienceCountController.current) {
      audienceCountController.current.abort();
    }
    const controller = new AbortController();
    audienceCountController.current = controller;

    setAudienceCountLoading(true);
    setAudienceCount(null);

    const params = new URLSearchParams({ audience });
    if (audience === "event" && eventId) params.set("eventId", eventId);

    fetch(`/api/admin/notifications/audience-count?${params}`, {
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((d) => {
        if (typeof d.count === "number") setAudienceCount(d.count);
      })
      .catch(() => {})
      .finally(() => setAudienceCountLoading(false));

    return () => controller.abort();
  }, [audience, eventId]);

  const audienceSelected =
    audience === "all" || (audience === "event" && eventId !== "");

  const canSend =
    !sending &&
    title.trim().length > 0 &&
    body.trim().length > 0 &&
    audienceSelected;

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    try {
      const payload: Record<string, unknown> = {
        title: title.trim(),
        body: body.trim(),
      };
      if (audience === "event" && eventId) {
        payload.eventId = parseInt(eventId, 10);
      }

      const res = await fetch("/api/admin/notifications/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to send");

      toast({
        title: "Notifications sent",
        description: `${data.sent} rider${data.sent !== 1 ? "s" : ""} notified`,
      });
      setTitle("");
      setBody("");
      setAudience("");
      setEventId("");
      setAudienceCount(null);
      queryClient.invalidateQueries({ queryKey: getGetNotificationHistoryQueryKey() });
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

      <div className="bg-card border rounded-lg p-6 space-y-5">
        {/* Audience picker */}
        <div className="space-y-2">
          <Label>Send to</Label>
          <Select
            value={audience}
            onValueChange={(v) => {
              setAudience(v as Audience);
              setEventId("");
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Choose audience…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All my riders</SelectItem>
              <SelectItem value="event">Specific event</SelectItem>
            </SelectContent>
          </Select>

          {/* Recipient count preview */}
          {(audience === "all" || (audience === "event" && eventId)) && (
            <>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Users size={12} />
                {audienceCountLoading ? (
                  <span>Counting recipients…</span>
                ) : audienceCount !== null ? (
                  <span>
                    <span className="font-medium text-foreground">
                      ~{audienceCount}
                    </span>{" "}
                    rider{audienceCount !== 1 ? "s" : ""} will receive this
                  </span>
                ) : null}
              </div>
              {!audienceCountLoading && audienceCount === 0 && (
                <p className="text-xs text-destructive">
                  No riders in this audience have the app installed — nobody will receive this.
                </p>
              )}
            </>
          )}

          {audience === "all" && !audienceCountLoading && (
            <p className="text-xs text-muted-foreground">
              Every rider registered for any of your club's events will receive this.
            </p>
          )}
        </div>

        {/* Event dropdown — shown when "Specific event" is chosen */}
        {audience === "event" && (
          <div className="space-y-2">
            <Label>Event</Label>
            <Select value={eventId} onValueChange={setEventId}>
              <SelectTrigger>
                <SelectValue placeholder="Select an event…" />
              </SelectTrigger>
              <SelectContent className="max-h-72 overflow-y-auto">
                {sortedEvents.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    No events found.
                  </div>
                ) : (
                  sortedEvents.map((event) => (
                    <SelectItem key={event.id} value={String(event.id)}>
                      {event.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            {eventId && !audienceCountLoading && (
              <p className="text-xs text-muted-foreground">
                Only riders registered for this event will receive this notification.
              </p>
            )}
          </div>
        )}

        {/* Title */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="notif-title">Title</Label>
            <span className={`text-xs tabular-nums ${title.length >= TITLE_MAX ? "text-destructive" : "text-muted-foreground"}`}>
              {title.length}/{TITLE_MAX}
            </span>
          </div>
          <Input
            id="notif-title"
            value={title}
            onChange={(e) => setTitle(e.target.value.slice(0, TITLE_MAX))}
            placeholder="e.g. Weather update for tomorrow's race"
            maxLength={TITLE_MAX}
          />
        </div>

        {/* Body */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="notif-body">Message</Label>
            <span className={`text-xs tabular-nums ${body.length >= BODY_MAX ? "text-destructive" : "text-muted-foreground"}`}>
              {body.length}/{BODY_MAX}
            </span>
          </div>
          <Textarea
            id="notif-body"
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, BODY_MAX))}
            placeholder="Write your message here…"
            rows={4}
            maxLength={BODY_MAX}
          />
        </div>

        <Button onClick={handleSend} disabled={!canSend} className="w-full">
          <Send size={15} className="mr-2" />
          {sending ? "Sending…" : "Send Push Notification"}
        </Button>
      </div>

      {/* Recent sends */}
      <div className="mt-6">
        <h2 className="font-semibold text-sm uppercase tracking-wider text-muted-foreground mb-3">
          Recent sends
        </h2>
        {!history || history.length === 0 ? (
          <div className="bg-card border rounded-lg p-6 text-sm text-muted-foreground text-center">
            No notifications sent yet.
          </div>
        ) : (
          <div className="bg-card border rounded-lg divide-y">
            {history.map((entry) => (
              <div key={entry.id} className="px-4 py-3 space-y-0.5">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-medium text-sm leading-snug flex-1">
                    {entry.title}
                  </p>
                  <span className="text-xs text-muted-foreground whitespace-nowrap flex items-center gap-1 mt-0.5">
                    <Users size={11} />
                    {entry.sentCount}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
                  {entry.body}
                </p>
                <div className="flex items-center gap-3 text-xs text-muted-foreground pt-0.5">
                  <span className="flex items-center gap-1">
                    <Clock size={11} />
                    {formatSentAt(entry.sentAt)}
                  </span>
                  <span className="text-muted-foreground/60">·</span>
                  <span>{audienceLabel(entry.audienceType, entry.eventId, eventMap)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
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
