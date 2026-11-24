import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import type { Moto } from "@workspace/api-client-react";
import { CheckCircle2, Clock, Maximize2, Radio, Volume2, VolumeX } from "lucide-react";
import { LiveRaceViews, useLiveRaceStream } from "@/pages/public/LiveLeaderboard";
import { useSharedAnnouncer } from "@/hooks/useSharedAnnouncer";
import { sharedAnnouncerMotoId } from "@/lib/sharedAnnouncer";

// The video player (MediaSource relay) only downloads while the event is streaming.
const EventStreamPlayer = lazy(() => import("./EventStreamPlayer"));

const typeLabel = (t: string | null | undefined) =>
  t === "main" ? "Main" : t === "lcq" ? "LCQ" : t === "practice" ? "Practice" : t === "enduro_test" ? "Test" : "Heat";

/** "2:30 PM" from an ISO time; a plain label ("2:30 PM", "After lunch") as it is. */
function timeLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Run order: moto number, then id (as Watch Live orders its schedule). */
export function runOrder(motos: Moto[]): Moto[] {
  return [...motos].sort((a, b) => (a.motoNumber ?? a.id) - (b.motoNumber ?? b.id) || a.id - b.id);
}

function Pulse({ className = "h-2 w-2" }: { className?: string }) {
  return (
    <span aria-hidden className={`relative flex ${className}`}>
      <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75 animate-ping motion-reduce:animate-none" />
      <span className={`relative inline-flex rounded-full bg-red-500 ${className}`} />
    </span>
  );
}

function Schedule({ motos, runningId, nextId }: { motos: Moto[]; runningId: number | null; nextId: number | null }) {
  const listRef = useRef<HTMLOListElement>(null);
  // Keep the running (or next) race in view inside the list, without moving the page.
  const focusId = runningId ?? nextId;
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-moto-id="${focusId}"]`);
    if (list && row) list.scrollTop = Math.max(0, row.offsetTop - list.offsetTop - 8);
  }, [focusId]);

  if (motos.length === 0) {
    return <p className="px-4 py-6 text-sm text-white/65">The race order shows here once the organizer sets the lineups.</p>;
  }
  return (
    <ol ref={listRef} className="relative max-h-80 overflow-y-auto overscroll-contain lg:max-h-[34rem]" aria-label="Race order">
      {motos.map(m => {
        const running = m.id === runningId;
        const next = m.id === nextId;
        const done = m.status === "completed";
        const time = !done ? timeLabel(m.scheduledTime) : null;
        const cls = m.raceClasses?.length ? m.raceClasses.join(", ") : m.raceClass;
        const body = (
          <>
            <span className="flex w-4 shrink-0 justify-center" aria-hidden>
              {running ? <Pulse /> : done ? <CheckCircle2 size={14} className="text-white/45" /> : <span className="h-1.5 w-1.5 rounded-full bg-white/30" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block truncate font-heading text-sm uppercase tracking-wide ${done ? "text-white/60" : "text-white"}`}>{m.name}</span>
              <span className="block truncate text-xs text-white/60">{[typeLabel(m.type), cls].filter(Boolean).join(" · ")}</span>
            </span>
            {running ? (
              <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-white">Running</span>
            ) : next ? (
              <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-[#242424]">Up next</span>
            ) : time ? (
              <span className="shrink-0 font-mono text-xs text-white/60">{time}</span>
            ) : done ? (
              <span className="shrink-0 text-[11px] uppercase tracking-wider text-white/55">Results</span>
            ) : null}
          </>
        );
        const rowClass = `flex min-h-12 items-center gap-3 border-b border-white/10 px-4 py-2 ${running ? "bg-white/[0.08]" : next ? "bg-white/[0.04]" : ""}`;
        return (
          <li key={m.id} data-moto-id={m.id} aria-current={running ? "step" : undefined}>
            {running || done ? (
              <Link
                href={`/live/${m.id}`}
                className={`${rowClass} hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white`}
                aria-label={`${m.name}: ${running ? "live timing" : "results"}`}
              >
                {body}
              </Link>
            ) : (
              <div className={rowClass}>{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Race day on the event page: the running race's live timing (the same views
 * and stream as Watch Live and /live/:motoId), the video when the event is
 * streaming, the shared announcer and the race order. Loaded on demand, so an
 * event page that isn't racing never downloads it.
 */
export default function EventLiveSection({ eventId, motos, isStreaming }: {
  eventId: number;
  motos: Moto[];
  isStreaming: boolean;
}) {
  const ordered = runOrder(motos);
  const running = ordered.find(m => m.status === "in_progress") ?? null;
  const next = ordered.find(m => m.status === "scheduled" && m.id !== running?.id) ?? null;
  const lastDone = [...ordered].reverse().find(m => m.status === "completed") ?? null;
  // One timing stream for the running race (the page's results refresh on their own).
  const live = useLiveRaceStream(running?.id);

  const [announcerOn, setAnnouncerOn] = useState(false);
  const announcerMotoId = sharedAnnouncerMotoId(running ?? lastDone);
  const announcer = useSharedAnnouncer(announcerMotoId, announcerOn);

  return (
    <section
      aria-labelledby="event-live-heading"
      className="overflow-hidden rounded-[14px] border border-white/10 bg-sidebar text-sidebar-foreground shadow-[0_3px_6px_rgba(0,0,0,0.16)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {running ? <Pulse className="h-2.5 w-2.5" /> : <Clock size={16} aria-hidden className="text-white/70" />}
          <h2 id="event-live-heading" className="m-0 font-heading text-lg font-bold uppercase leading-none tracking-wide text-white">
            {running ? "Live now" : "Race day"}
          </h2>
          {running && (
            <span className="min-w-0 truncate text-sm text-white/70">
              {running.name}{running.raceClass ? ` · ${running.raceClass}` : ""}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {announcerMotoId && (
            <button
              type="button"
              onClick={() => setAnnouncerOn(v => !v)}
              aria-pressed={announcerOn}
              className={`flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-xs font-bold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${
                announcerOn ? "bg-primary text-white hover:bg-[#8F0000]" : "border border-white/20 bg-white/5 text-white/80 hover:bg-white/10"
              }`}
            >
              {announcerOn ? <Volume2 size={14} aria-hidden /> : <VolumeX size={14} aria-hidden />}
              Announcer {announcerOn ? "on" : "off"}
            </button>
          )}
          {running && (
            <Link
              href={`/live/${running.id}`}
              className="flex min-h-11 items-center gap-1.5 rounded-full border border-white/20 bg-white/5 px-3.5 text-xs font-bold uppercase tracking-wider text-white/85 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <Maximize2 size={14} aria-hidden /> Full timing
            </Link>
          )}
          <Link
            href={`/watch/${eventId}`}
            className="flex min-h-11 items-center gap-1.5 rounded-full border border-white/20 bg-white/5 px-3.5 text-xs font-bold uppercase tracking-wider text-white/85 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <Radio size={14} aria-hidden /> Watch
          </Link>
        </div>
      </div>
      {announcerOn && (announcer.label || announcer.error || (running && !announcer.connected)) && (
        <p role="status" className="m-0 flex items-center gap-1.5 border-b border-white/10 px-4 py-1.5 text-xs text-white/70">
          <Volume2 size={12} aria-hidden />
          {announcer.error ? "Announcer audio isn't available right now." : announcer.label ?? "Connecting the announcer…"}
        </p>
      )}

      <div className="grid lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 lg:border-r lg:border-white/10">
          {isStreaming && (
            <Suspense fallback={<div className="aspect-video w-full animate-pulse bg-black motion-reduce:animate-none" aria-label="Loading the live video" />}>
              <EventStreamPlayer eventId={eventId} />
            </Suspense>
          )}
          {running ? (
            <div className="flex h-[30rem] max-h-[75vh] min-h-80 flex-col">
              <LiveRaceViews {...live} showRaceStatus />
            </div>
          ) : (
            <div className="px-4 py-8 sm:px-6">
              <p className="m-0 font-heading text-sm font-bold uppercase tracking-[2px] text-white/60">Between races</p>
              {next ? (
                <p className="mt-2 mb-0 text-xl font-heading font-bold uppercase text-white">
                  Up next: {next.name}
                  {next.raceClass ? <span className="block text-base font-semibold normal-case text-white/70">{next.raceClass}{timeLabel(next.scheduledTime) ? ` · ${timeLabel(next.scheduledTime)}` : ""}</span> : null}
                </p>
              ) : (
                <p className="mt-2 mb-0 text-lg text-white/80">{lastDone ? "That's the last race on the schedule." : "Racing hasn't started yet."}</p>
              )}
              <p className="mt-3 mb-0 max-w-prose text-sm text-white/65">Live timing starts here by itself when the next race goes. Finished races are in the results below.</p>
            </div>
          )}
        </div>
        <div className="border-t border-white/10 lg:border-t-0">
          <h3 className="m-0 px-4 pt-3 pb-2 font-heading text-xs font-bold uppercase tracking-[2px] text-white/60">Race order</h3>
          <Schedule motos={ordered} runningId={running?.id ?? null} nextId={next?.id ?? null} />
        </div>
      </div>
    </section>
  );
}
