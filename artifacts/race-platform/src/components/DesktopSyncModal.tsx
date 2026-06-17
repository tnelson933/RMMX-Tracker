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

// Baked in at build time via VITE_CLOUD_URL repo variable.
// If set, we hide the URL field so users only need Club ID + credentials.
const BUILT_IN_CLOUD_URL: string = (import.meta.env.VITE_CLOUD_URL as string) || "";

export function DesktopSyncModal() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(BUILT_IN_CLOUD_URL);
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
        // If the user previously saved a custom URL use that; otherwise keep the built-in one
        setUrl(creds?.cloudUrl || BUILT_IN_CLOUD_URL);
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
        setMsg({ text: "Connected! Your account has been synced.", kind: "success" });
        setTimeout(() => setOpen(false), 1400);
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
      <DialogContent className="w-[min(440px,calc(100vw-32px))] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Cloud Sync Settings</DialogTitle>
          <DialogDescription>
            Enter your organizer credentials to sync your account to this device.
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
          <div className="grid grid-cols-2 gap-2">
            <div className="min-w-0">
              <Label htmlFor="sync-clubid" className="text-xs font-semibold uppercase tracking-wide">
                Club ID
              </Label>
              <Input
                id="sync-clubid"
                placeholder="e.g. 1"
                value={clubId}
                onChange={(e) => setClubId(e.target.value)}
                className="mt-1 h-9 text-sm"
              />
              <p className="mt-1 text-[11px] text-muted-foreground leading-tight">
                Find yours on your Organizer Dashboard
              </p>
            </div>
            <div className="min-w-0">
              <Label htmlFor="sync-email" className="text-xs font-semibold uppercase tracking-wide">Email</Label>
              <Input
                id="sync-email"
                type="email"
                placeholder="you@club.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className="mt-1 h-9 text-sm"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="sync-password" className="text-xs font-semibold uppercase tracking-wide">Password</Label>
            <Input
              id="sync-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="mt-1 h-9 text-sm"
            />
          </div>

        </div>

        <div className="pt-2 flex flex-col gap-2">
          <div className="flex gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={busy}>
              {busy ? "Connecting…" : "Save & Connect"}
            </Button>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="self-start text-destructive hover:text-destructive hover:bg-destructive/10 text-xs px-2"
            onClick={handleDisconnect}
            disabled={busy}
          >
            Disconnect cloud sync
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
