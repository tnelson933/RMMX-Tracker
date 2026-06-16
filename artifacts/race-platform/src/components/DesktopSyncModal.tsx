import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ElectronAPI = typeof window extends { electronAPI: infer T } ? T : unknown;

function eAPI(): ElectronAPI | null {
  return (window as { electronAPI?: ElectronAPI }).electronAPI ?? null;
}

export function DesktopSyncModal() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [clubId, setClubId] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ text: string; kind: "error" | "success" } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const api = eAPI() as any;
    if (!api) return;

    const handler = () => {
      setMsg(null);
      setPassword("");
      api.auth.getCredentials().then((creds: any) => {
        setUrl(creds?.cloudUrl ?? "");
        setClubId(String(creds?.clubId ?? ""));
        setEmail(creds?.email ?? "");
      }).catch(() => {});
      setOpen(true);
    };

    window.addEventListener("rm-open-sync-settings", handler);
    return () => window.removeEventListener("rm-open-sync-settings", handler);
  }, []);

  if (!eAPI()) return null;

  const api = eAPI() as any;

  const handleSave = async () => {
    if (!url || !clubId || !email || !password) {
      setMsg({ text: "All fields are required.", kind: "error" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api.auth.setCredentials(email, password, url, clubId);
      await api.sync.flush();
      const state = await api.sync.getState();
      if (state.status === "error") {
        setMsg({ text: `Could not connect: ${state.lastError ?? "unknown error"}`, kind: "error" });
      } else {
        setMsg({ text: "Connected! Sync is running.", kind: "success" });
        setTimeout(() => setOpen(false), 1400);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setMsg({ text: `Error: ${msg}`, kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    if (!url || !clubId || !email || !password) {
      setMsg({ text: "All fields are required.", kind: "error" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api.auth.setCredentials(email, password, url, clubId);
      await api.sync.flush();
      const state = await api.sync.getState();
      if (state.status === "error") {
        setMsg({ text: `Connection failed: ${state.lastError ?? "unknown error"}`, kind: "error" });
      } else {
        setMsg({ text: "Connection successful! Click Save & Connect to finish.", kind: "success" });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setMsg({ text: `Error: ${msg}`, kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await api.auth.clearCredentials();
      setMsg({ text: "Cloud sync disconnected.", kind: "success" });
      setTimeout(() => setOpen(false), 1200);
    } catch {
      setMsg({ text: "Failed to disconnect.", kind: "error" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cloud Sync Settings</DialogTitle>
          <DialogDescription>
            Connect this desktop app to your Rocky Mountain Race Platform cloud account to sync registrations, check-ins, and timing data in real time.
          </DialogDescription>
        </DialogHeader>

        {msg && (
          <div
            className={`rounded px-3 py-2 text-sm ${
              msg.kind === "error"
                ? "bg-destructive/10 text-destructive"
                : "bg-green-500/10 text-green-600 dark:text-green-400"
            }`}
          >
            {msg.text}
          </div>
        )}

        <div className="space-y-3">
          <div>
            <Label htmlFor="sync-url">Cloud URL</Label>
            <Input
              id="sync-url"
              type="url"
              placeholder="https://your-app.replit.app"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoComplete="off"
              className="mt-1"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="sync-clubid">Club ID</Label>
              <Input
                id="sync-clubid"
                placeholder="1"
                value={clubId}
                onChange={(e) => setClubId(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="sync-email">Email</Label>
              <Input
                id="sync-email"
                type="email"
                placeholder="you@club.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className="mt-1"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="sync-password">Password</Label>
            <Input
              id="sync-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="mt-1"
            />
          </div>
        </div>

        <div className="flex items-center justify-between pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={handleDisconnect}
            disabled={busy}
          >
            Disconnect cloud sync
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="outline" onClick={handleTest} disabled={busy}>
              Test Connection
            </Button>
            <Button onClick={handleSave} disabled={busy}>
              {busy ? "Connecting…" : "Save & Connect"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
