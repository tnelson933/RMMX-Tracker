import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Bell, Send, Smartphone, ShieldCheck } from "lucide-react";

export default function AdminNotifications() {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [sending, setSending] = useState(false);
  const [pushCount, setPushCount] = useState<number | null>(null);
  const { toast } = useToast();
  const { user } = useAuth();

  useEffect(() => {
    fetch("/api/admin/notifications/push-stats")
      .then((r) => r.json())
      .then((d) => setPushCount(d.total))
      .catch(() => {});
  }, []);

  if (user?.role !== "super_admin") {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Access restricted to super admins.
      </div>
    );
  }

  const linkUrlValid =
    linkUrl.trim() === "" ||
    (() => {
      try {
        const u = new URL(linkUrl.trim());
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    })();

  async function handleSend() {
    if (!title.trim() || !body.trim() || !linkUrlValid) return;
    setSending(true);
    try {
      const res = await fetch("/api/admin/notifications/broadcast-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          ...(linkUrl.trim() ? { linkUrl: linkUrl.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to send");
      toast({
        title: "Broadcast sent",
        description: `${data.sent} rider${data.sent !== 1 ? "s" : ""} notified`,
      });
      setTitle("");
      setBody("");
      setLinkUrl("");
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

      <div className="flex items-center gap-2 mb-1 text-xs font-bold uppercase tracking-widest text-primary">
        <ShieldCheck size={13} />
        <span>Super Admin Broadcast</span>
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

      <div className="mb-5 p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg text-sm text-amber-800 dark:text-amber-300">
        <p className="font-semibold mb-1">No restrictions</p>
        <p>
          As a super admin you can broadcast to all riders at any time with no
          timing window or rate limits. Use this sparingly.
        </p>
      </div>

      <div className="bg-card border rounded-lg p-6 space-y-5">
        <div className="space-y-2">
          <Label htmlFor="admin-notif-title">Title</Label>
          <Input
            id="admin-notif-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Platform announcement…"
            maxLength={100}
          />
          <p className="text-xs text-muted-foreground text-right">
            {title.length}/100
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="admin-notif-body">Message</Label>
          <Textarea
            id="admin-notif-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Important update for all riders…"
            rows={3}
            maxLength={500}
          />
          <p className="text-xs text-muted-foreground text-right">
            {body.length}/500
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="admin-notif-link">
            Link URL <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <Input
            id="admin-notif-link"
            type="url"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://example.com/announcement"
            maxLength={500}
          />
          {!linkUrlValid && (
            <p className="text-xs text-destructive">
              Must be a valid link starting with http:// or https://
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            When riders tap the notification, this page will open on their phone.
          </p>
        </div>

        <p className="text-xs text-muted-foreground">
          This will be sent to <strong>all {pushCount ?? "…"} riders</strong> who
          have the app installed with notifications enabled.
        </p>

        <Button
          onClick={handleSend}
          disabled={!title.trim() || !body.trim() || !linkUrlValid || sending}
          className="w-full"
        >
          <Send size={15} className="mr-2" />
          {sending ? "Sending…" : "Broadcast to All Riders"}
        </Button>
      </div>
    </div>
  );
}
