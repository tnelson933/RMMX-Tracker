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

export function LocalSyncBadge() {
  const [lastSuccessAt, setLastSuccessAt] = useState<string | number | null | undefined>(undefined);

  useEffect(() => {
    if (!isLocalServer()) return;

    let cancelled = false;

    const fetchStatus = () => {
      fetch("/api/status")
        .then((r) => r.json())
        .then((data: StatusResponse) => {
          if (!cancelled) {
            setLastSuccessAt(data?.autoSync?.lastSuccessAt ?? null);
          }
        })
        .catch(() => {
          if (!cancelled) setLastSuccessAt(null);
        });
    };

    fetchStatus();
    const id = setInterval(fetchStatus, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!isLocalServer()) return null;
  if (lastSuccessAt === undefined) return null;

  const lastSuccessMs =
    lastSuccessAt === null
      ? null
      : typeof lastSuccessAt === "number"
      ? lastSuccessAt
      : new Date(lastSuccessAt).getTime();

  const synced = lastSuccessMs !== null && !isNaN(lastSuccessMs) && Date.now() - lastSuccessMs < 60_000;

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
