import { BadgeCheck, Clock } from "lucide-react";

/**
 * Shown wherever results appear: "Unofficial results" until the organizer
 * finalizes the race on Race Day Management, then "Official results".
 */
export function OfficialResultsBadge({ official, className = "", compact = false }: { official: boolean; className?: string; compact?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-bold uppercase tracking-wider ${compact ? "px-1.5 py-0 text-[9px]" : "px-2 py-0.5 text-[10px]"} ${
        official
          ? "bg-green-500/10 text-green-700 border-green-600/30 dark:text-green-300"
          : "bg-amber-500/10 text-amber-700 border-amber-500/40 dark:text-amber-300"
      } ${className}`}
      title={official ? "The organizer has finalized these results." : "These results may still change until the organizer finalizes them."}
    >
      {official ? <BadgeCheck size={compact ? 9 : 11} /> : <Clock size={compact ? 9 : 11} />}
      {official ? "Official results" : "Unofficial results"}
    </span>
  );
}
