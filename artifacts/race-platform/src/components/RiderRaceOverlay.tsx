import { useEffect, useState } from "react";

/**
 * Race overlay on a rider's live phone video (viewer page and the phone's own
 * screen): the class and race they're in, their place once live timing has
 * one, and in the bottom-left corner their best lap and last two laps.
 * Polls /api/rider/live/:riderId/race with the stream's ticket every 5 s.
 */

export interface RiderRace {
  eventName: string;
  className: string;
  raceName: string;
  status: "scheduled" | "in_progress" | "completed";
  finalized: boolean;
  position: number | null;
  riders: number;
  laps: number;
  gap: string | null;
  bestLap: string | null;
  lastLaps: string[];
  /** When the live video stops because the race is over (ISO), else null. */
  liveEndsAt: string | null;
}

export function useRiderRace(riderId: number, ticket: string | null): RiderRace | null {
  const [race, setRace] = useState<RiderRace | null>(null);
  useEffect(() => {
    if (!ticket || !Number.isInteger(riderId) || riderId <= 0) return;
    let stopped = false;
    const load = () => fetch(`/api/rider/live/${riderId}/race?${new URLSearchParams({ ticket })}`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (!stopped && j) setRace(j.race ?? null); })
      .catch(() => { /* keep the last one */ });
    load();
    const t = setInterval(load, 5_000);
    return () => { stopped = true; clearInterval(t); };
  }, [riderId, ticket]);
  return race;
}

const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

const STATUS: Record<RiderRace["status"], string> = { scheduled: "Up next", in_progress: "Racing", completed: "Finished" };

/** "Race over · live video ends in 4:32" while a finished race's stream winds down. */
export function RiderLiveEnding({ race }: { race: RiderRace | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!race?.liveEndsAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [race?.liveEndsAt]);
  if (!race?.liveEndsAt) return null;
  const left = Math.max(0, Math.round((new Date(race.liveEndsAt).getTime() - now) / 1000));
  return (
    <div role="status" className="relative z-10 mx-4 mt-2 rounded-xl bg-amber-500/90 px-3 py-2 text-center text-[13px] font-semibold text-black">
      {race.finalized ? "Race over, results are final." : "Race over."} Live video ends in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
    </div>
  );
}

/** Class, race and place: sits under the stream's name pills at the top. */
export function RiderRaceHeader({ race }: { race: RiderRace | null }) {
  if (!race) return null;
  return (
    <div className="relative z-10 flex items-start justify-between gap-3 px-4">
      <div className="min-w-0 rounded-xl bg-black/60 px-3 py-2">
        <div className="truncate font-heading text-[15px] font-extrabold uppercase leading-tight">
          {race.className}{race.raceName ? <span className="font-semibold text-white/80"> · {race.raceName}</span> : null}
        </div>
        <div className="text-[11px] uppercase tracking-wider text-white/70">
          {race.status === "completed" && race.finalized ? "Final" : STATUS[race.status]}{race.status !== "scheduled" && race.laps > 0 ? ` · Lap ${race.laps}` : ""}{race.gap && race.gap !== "Leader" && race.position !== 1 ? ` · ${race.gap}` : ""}
        </div>
      </div>
      {race.position != null && (
        <div className="shrink-0 rounded-xl bg-[#B30000] px-3 py-1.5 text-center leading-none shadow-lg" aria-label={`In ${ordinal(race.position)} place`}>
          <div className="font-heading text-[30px] font-extrabold italic">P{race.position}</div>
          {race.riders > 0 && <div className="mt-0.5 text-[10px] uppercase tracking-wider text-white/85">of {race.riders}</div>}
        </div>
      )}
    </div>
  );
}

/** Best lap and the last two laps, for the bottom-left corner. */
export function RiderLapTimes({ race, className = "" }: { race: RiderRace | null; className?: string }) {
  if (!race || (!race.bestLap && race.lastLaps.length === 0)) return null;
  return (
    <div className={`z-10 min-w-[9.5rem] rounded-xl bg-black/65 px-3 py-2 font-mono text-[13px] leading-snug ${className}`}>
      {race.bestLap && (
        <div className="flex justify-between gap-3">
          <span className="font-sans text-[11px] font-bold uppercase tracking-wider text-[#4ADE80]">Best</span>
          <span className="font-semibold text-[#4ADE80]">{race.bestLap}</span>
        </div>
      )}
      {race.lastLaps.map((lap, i) => (
        <div key={i} className="flex justify-between gap-3">
          <span className="font-sans text-[11px] font-bold uppercase tracking-wider text-white/60">{i === 0 ? "Last" : "Prev"}</span>
          <span>{lap}</span>
        </div>
      ))}
    </div>
  );
}
