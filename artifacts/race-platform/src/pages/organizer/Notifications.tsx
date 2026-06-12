import { useEffect, useState } from "react";
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
import { Bell, Send, Smartphone } from "lucide-react";

export function Notifications() {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [eventId, setEventId] = useState<string>("all");
  const [sending, setSending] = useState(false);
  const [pushCount, setPushCount] = useState<number | null>(null);
  const { toast } = useToast();
  const { user } = useAuth();

  const { data: events } = useListEvents(
    { params: { query: { clubId: user?.clubId } } } as any,
  );

  useEffect(() => {
    fetch("/api/admin/notifications/push-stats")
      .then((r) => r.json())
      .then((d) => setPushCount(d.total))
      .catch(() => {});
  }, []);

  async function handleSend() {
    if (!title.trim() || !body.trim()) return;
    setSending(true);
    try {
      const res = await fetch("/api/admin/notifications/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          eventId: eventId !== "all" ? parseInt(eventId) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to send");
      toast({
        title: "Notifications sent",
        description: `${data.sent} rider${data.sent !== 1 ? "s" : ""} notified`,
      });
      setTitle("");
      setBody("");
      setEventId("all");
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
            {pushCount} rider{pushCount !== 1 ? "s" : ""} have the app installed
            with notifications enabled
          </span>
        </div>
      )}

      <div className="bg-card border rounded-lg p-6 space-y-5">
        <div className="space-y-2">
          <Label htmlFor="notif-title">Title</Label>
          <Input
            id="notif-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Race day announcement…"
            maxLength={100}
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
          />
          <p className="text-xs text-muted-foreground text-right">
            {body.length}/500
          </p>
        </div>

        <div className="space-y-2">
          <Label>Send to</Label>
          <Select value={eventId} onValueChange={setEventId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All riders (with push enabled)</SelectItem>
              {events?.map((event) => (
                <SelectItem key={event.id} value={String(event.id)}>
                  {event.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {eventId === "all"
              ? "All riders who have the app installed will receive this."
              : "Only riders registered for this event will receive this."}
          </p>
        </div>

        <Button
          onClick={handleSend}
          disabled={!title.trim() || !body.trim() || sending}
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
