import { useEffect, useState } from "react";
import { Building2, Bell, UserCog, Eye, LogOut, Loader2, Search, ShieldCheck, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// Mirror: a super admin works in RM Roost as one organizer to help them.
// Starting or quitting reloads the app so every page and cached query belongs
// to the right account.

export interface MirrorInfo {
  adminId: number;
  adminName: string;
  adminEmail?: string | null;
  clubName?: string | null;
  startedAt?: string | null;
}

async function post(path: string, body?: unknown) {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export async function quitMirror(goTo = "/admin/clubs") {
  await post("/api/admin/mirror/stop");
  window.location.href = goTo;
}

/** Super admin: pick an organizer by email and open their RM Roost. */
export function MirrorDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [email, setEmail] = useState("");
  const [matches, setMatches] = useState<Array<{ email: string; name: string; role: string; clubName: string | null }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const q = email.trim();
    const timer = setTimeout(() => {
      fetch(`/api/admin/mirror/organizers?q=${encodeURIComponent(q)}`, { credentials: "include" })
        .then(r => (r.ok ? r.json() : []))
        .then(setMatches)
        .catch(() => setMatches([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [email, open]);

  const start = async (target = email) => {
    if (!target.trim()) { setError("Enter the organizer's email address"); return; }
    setBusy(true);
    setError(null);
    try {
      await post("/api/admin/mirror", { email: target.trim() });
      window.location.href = "/dashboard";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start mirroring");
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Eye size={18} className="text-primary" /> Mirror an organizer</DialogTitle>
          <DialogDescription>
            See RM Roost exactly as that organizer does and work in their account to help them. Changes you make are real. Click <strong>Quit</strong> to come back.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={e => { e.preventDefault(); void start(); }} className="space-y-3">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              type="text"
              inputMode="email"
              autoComplete="off"
              value={email}
              onChange={e => { setEmail(e.target.value); setError(null); }}
              placeholder="Organizer email, name or club"
              className="pl-8"
            />
          </div>
          {matches.length > 0 && (
            <div className="max-h-56 overflow-y-auto rounded-md border divide-y">
              {matches.map(m => (
                <button
                  key={m.email}
                  type="button"
                  onClick={() => void start(m.email)}
                  disabled={busy}
                  className="w-full text-left px-3 py-2 hover:bg-muted transition-colors"
                >
                  <div className="text-sm font-medium">{m.clubName ?? "No club"} <span className="text-xs text-muted-foreground font-normal">· {m.role.replace("_", " ")}</span></div>
                  <div className="text-xs text-muted-foreground">{m.name} · {m.email}</div>
                </button>
              ))}
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy} className="w-full gap-2">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
            Mirror
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Left rail shown while mirroring: the super admin's menu stays available. */
export function SuperAdminRail({ mirror, organizerName, organizerEmail }: { mirror: MirrorInfo; organizerName?: string; organizerEmail?: string }) {
  const [busy, setBusy] = useState(false);
  const leaveTo = async (href: string) => {
    setBusy(true);
    try { await quitMirror(href); } catch { setBusy(false); }
  };
  const item = (href: string, label: string, Icon: typeof UserCog) => (
    <button
      key={href}
      onClick={() => void leaveTo(href)}
      disabled={busy}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-white/70 hover:bg-white/10 hover:text-white transition-colors"
      title={`Quit mirroring and open ${label}`}
    >
      <Icon size={17} /> {label}
    </button>
  );
  return (
    <aside className="hidden md:flex w-56 shrink-0 flex-col bg-gray-950 text-white border-r border-white/10 h-[100dvh] sticky top-0 overflow-y-auto">
      <div className="h-16 px-4 flex items-center gap-2 border-b border-white/10">
        <ShieldCheck size={16} className="text-green-400" />
        <div className="min-w-0">
          <p className="text-[10px] font-heading font-bold uppercase tracking-widest text-green-400">Super admin</p>
          <p className="text-sm font-semibold truncate">{mirror.adminName}</p>
        </div>
      </div>
      <div className="m-3 rounded-lg border border-amber-400/40 bg-amber-400/10 p-3 space-y-1">
        <p className="text-[10px] font-heading font-bold uppercase tracking-widest text-amber-300 flex items-center gap-1.5"><Eye size={12} /> Mirroring</p>
        <p className="text-sm font-semibold leading-snug">{mirror.clubName ?? "Organizer"}</p>
        <p className="text-xs text-white/60 break-all">{organizerName ? `${organizerName} · ` : ""}{organizerEmail}</p>
      </div>
      <nav className="flex-1 px-3 py-2 space-y-1">
        <div className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium bg-white/10 text-white">
          <Eye size={17} /> Mirror
        </div>
        {item("/admin/users", "Users", UserCog)}
        {item("/admin/clubs", "Clubs", Building2)}
        {item("/admin/notifications", "Notifications", Bell)}
        {item("/admin/clubs?mirror=1", "Mirror someone else", Repeat)}
      </nav>
      <div className="p-3 border-t border-white/10">
        <Button onClick={() => void leaveTo("/admin/clubs")} disabled={busy} className="w-full gap-2">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <LogOut size={15} />}
          Quit
        </Button>
      </div>
    </aside>
  );
}

/** Thin bar over the organizer's pages while mirroring (the only Quit on phones). */
export function MirrorBanner({ mirror, organizerEmail }: { mirror: MirrorInfo; organizerEmail?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-amber-400 text-amber-950 text-sm shrink-0">
      <Eye size={16} className="shrink-0" />
      <p className="flex-1 min-w-0 truncate">
        <strong>Mirroring {mirror.clubName ?? "an organizer"}</strong>
        <span className="hidden sm:inline"> as {organizerEmail}. Changes you make are saved to their account.</span>
      </p>
      <Button
        size="sm"
        variant="outline"
        className="h-7 bg-amber-50 border-amber-900/30 text-amber-950 hover:bg-white"
        disabled={busy}
        onClick={() => { setBusy(true); quitMirror().catch(() => setBusy(false)); }}
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : "Quit"}
      </Button>
    </div>
  );
}
