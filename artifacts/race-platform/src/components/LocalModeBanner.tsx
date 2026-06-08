import { WifiOff } from "lucide-react";

function isLocalhost(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h.startsWith("192.168.");
}

export function LocalModeBanner() {
  if (!isLocalhost()) return null;

  return (
    <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
      <WifiOff className="w-4 h-4 shrink-0" />
      <span className="font-semibold">Local Mode</span>
      <span className="text-muted-foreground hidden sm:inline">
        · Running on this device — data stored locally
      </span>
    </div>
  );
}
