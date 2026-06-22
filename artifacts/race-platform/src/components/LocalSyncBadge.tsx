import { useEffect, useState } from "react";

function isLocalServer(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h.startsWith("192.168.");
}

interface StatusResponse {
  autoSync?: {
    lastSuccessAt: string | number | null;
  };
}

type SyncInfo = { lastSyncedAt: string | null; status: string };

export function LocalSyncBadge() {
  // null = not yet loaded, string = ISO timestamp of last sync, false = never synced / error
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null | false>(null);

  useEffect(() => {
    const electronAPI = (window as any).electronAPI;

    // ── Electron desktop app: read sync state directly from IPC ──────────────
    // The desktop sync-engine writes to its own SQLite DB (not the local
    // server's DB), so the HTTP /api/status endpoint never reflects the
    // desktop sync.  IPC is the only reliable source of truth here.
    if (electronAPI?.sync?.getState) {
      const update = (info: SyncInfo) => {
        setLastSyncedAt(info.lastSyncedAt ?? false);
      };

      electronAPI.sync.getState()
        .then(update)
        .catch(() => setLastSyncedAt(false));

      const unsub = electronAPI.sync.onChange?.((state: SyncInfo) => {
        // Only update on completed cycles (idle or error) — ignore the
        // transient "syncing" state so the badge doesn't flicker.
        if (state.status === "idle" || state.status === "error") {
          update(state);
        }
      });

      return () => { if (typeof unsub === "function") unsub(); };
    }

    // ── Browser / local HTTP server: poll /api/status ─────────────────────
    if (!isLocalServer()) return;

    let cancelled = false;

    const fetchStatus = () => {
      fetch("/api/status")
        .then((r) => r.json())
        .then((data: StatusResponse) => {
          if (!cancelled) {
            const ts = data?.autoSync?.lastSuccessAt;
            setLastSyncedAt(ts != null ? String(ts) : false);
          }
        })
        .catch(() => {
          if (!cancelled) setLastSyncedAt(false);
        });
    };

    fetchStatus();
    const id = setInterval(fetchStatus, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Still loading initial state — render an invisible placeholder so the
  // layout doesn't shift when the badge mounts with its real content.
  if (lastSyncedAt === null) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium invisible" aria-hidden="true">
        <span className="h-1.5 w-1.5 rounded-full shrink-0" />
        Synced
      </span>
    );
  }

  // Not running against local server or desktop app
  if (!isLocalServer() && !(window as any).electronAPI) return null;

  const lastMs =
    lastSyncedAt === false
      ? null
      : new Date(lastSyncedAt).getTime();

  // "Synced" if last successful sync was within the last 3 minutes.
  // The Electron sync-engine polls every 2 s (well within this window).
  // The local-server HTTP auto-sync runs every 2 minutes, so we need at least
  // 2 min + margin before declaring "not synced" — 3 min covers both cases.
  const synced = lastMs !== null && !isNaN(lastMs) && Date.now() - lastMs < 3 * 60 * 1000;

  if (synced) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/15 text-green-600 border border-green-500/25">
        <span className="h-1.5 w-1.5 rounded-full bg-green-500 shrink-0" />
        Synced
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/10 text-gray-400 border border-gray-500/20">
      <span className="h-1.5 w-1.5 rounded-full bg-gray-400 shrink-0" />
      Not Synced
    </span>
  );
}
