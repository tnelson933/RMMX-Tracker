import { DatabaseZap } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface CacheStatusBadgeProps {
  cachedAt: number;
}

export function CacheStatusBadge({ cachedAt }: CacheStatusBadgeProps) {
  const age = formatDistanceToNow(new Date(cachedAt), { addSuffix: true });

  return (
    <div className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1 font-medium">
      <DatabaseZap size={13} className="shrink-0" />
      <span>Showing cached data from {age}</span>
    </div>
  );
}
