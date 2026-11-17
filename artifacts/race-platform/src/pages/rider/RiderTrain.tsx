import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Activity, AlertCircle, Bike, ChevronDown, ChevronUp, Clock, Cpu, Dumbbell, Flag, Info, List, Loader2,
  Moon, Salad, Trophy, Zap,
} from "lucide-react";
import { RiderLayout } from "@/components/layout/RiderLayout";
import { useRiderAuth } from "@/contexts/RiderAuthContext";
import { useActiveRiders } from "@/lib/rider-active";
import { riderApi, type EventPracticeLeaderboardEntry, type PracticeLap } from "@/lib/rider-api";
import { isNetworkError, NETWORK_ERROR_MESSAGE } from "@/lib/friendlyErrors";
import { SessionLapChart, TrackProgressChart } from "@/components/rider/PracticeCharts";
import { EmptyState } from "@/components/rider/web/RaceEventCard";
import { Segmented } from "@/components/rider/web/Segmented";

// Web version of the rider app's Train tab (rider-app/app/(tabs)/train.tsx):
// Track (practice and event-practice lap times by track, date and session, with
// charts, lap table and gate-pick leaderboard) and Train (the AI training-plan
// generator). Plans are kept per account in this browser, like the app keeps them
// on the phone.

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtLap(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return "—";
  const totalSec = ms / 1000;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return mins > 0 ? `${mins}:${secs.toFixed(3).padStart(6, "0")}` : `${secs.toFixed(3)}s`;
}

function displayDate(iso: string): Date {
  // Date-only values are calendar days; timestamps are real moments.
  return iso.length <= 10 ? new Date(`${iso}T12:00:00`) : new Date(iso);
}

function dateLabel(iso: string | null | undefined): string {
  if (!iso) return "Unknown Date";
  return displayDate(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function dateKey(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const d = displayDate(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Motocross lap 1 includes the start, so it doesn't count toward the best lap. */
function isLapEligible(lapNumber: number, raceStyle?: string | null): boolean {
  return raceStyle !== "motocross" || lapNumber > 1;
}

function bestOf(laps: PracticeLap[], raceStyle?: string | null): number | null {
  const v = laps.filter(l => isLapEligible(l.lapNumber, raceStyle) && (l.lapTimeMs ?? 0) > 0);
  return v.length ? Math.min(...v.map(l => l.lapTimeMs!)) : null;
}

// ─── Track data ──────────────────────────────────────────────────────────────

interface SessionItem {
  key: string;
  label: string;
  status: string;
  riderId: number;
  practiceSessionId?: number;
  myLaps: PracticeLap[];
  bestLapMs: number | null;
  leaderboard?: EventPracticeLeaderboardEntry[];
  startedAt?: string | null;
  raceStyle?: string | null;
}
interface DateGroup { key: string; label: string; sessions: SessionItem[] }
interface TrackItem { key: string; label: string; sublabel: string | null; sessions: SessionItem[]; dates: DateGroup[] }

const byLap = (a: PracticeLap, b: PracticeLap) => a.lapNumber - b.lapNumber;

async function loadTracks(profiles: { id: number; firstName: string; lastName: string }[]): Promise<TrackItem[]> {
  const results = await Promise.allSettled(profiles.flatMap(p => [riderApi.practice(p.id), riderApi.eventPractice(p.id)]));
  // Nothing came back at all (server trouble, signed out): that isn't "no laps yet".
  if (results.length > 0 && results.every(r => r.status === "rejected")) throw new Error("practice load failed");
  const multi = profiles.length > 1;
  const built: TrackItem[] = [];

  profiles.forEach((profile, i) => {
    const riderName = `${profile.firstName} ${profile.lastName}`.trim();
    const practice = results[i * 2];
    const eventPractice = results[i * 2 + 1];

    if (eventPractice.status === "fulfilled") {
      const events = (eventPractice.value as Awaited<ReturnType<typeof riderApi.eventPractice>>).events ?? [];
      for (const ev of events) {
        const sessions: SessionItem[] = (ev.sessions ?? []).map(s => {
          const myLaps = [...(s.myLaps ?? [])].sort(byLap);
          return {
            key: `event-moto-${s.motoId}-rider-${profile.id}`,
            label: s.sessionName,
            status: s.status,
            riderId: profile.id,
            myLaps,
            bestLapMs: bestOf(myLaps, ev.raceStyle),
            leaderboard: s.leaderboard ?? [],
            startedAt: ev.eventDate ?? null,
            raceStyle: ev.raceStyle ?? null,
          };
        });
        if (sessions.length === 0) continue;
        built.push({
          key: `event-${ev.eventId}-rider-${profile.id}`,
          label: ev.eventName,
          sublabel: [multi ? riderName : null, ev.eventDate ? dateLabel(ev.eventDate) : null, ev.eventState].filter(Boolean).join(" · "),
          sessions,
          dates: [{ key: ev.eventDate ? dateKey(ev.eventDate) : "event", label: ev.eventDate ? dateLabel(ev.eventDate) : "Event Date", sessions }],
        });
      }
    }

    if (practice.status === "fulfilled") {
      const standalone = (practice.value as Awaited<ReturnType<typeof riderApi.practice>>).sessions ?? [];
      const venueMap = new Map<string, typeof standalone>();
      for (const s of standalone) {
        const venue = s.venueName?.trim() || "Unknown Track";
        if (!venueMap.has(venue)) venueMap.set(venue, []);
        venueMap.get(venue)!.push(s);
      }
      for (const [venue, venueSessions] of venueMap) {
        const sessions: SessionItem[] = venueSessions
          .map(s => {
            const myLaps = [...(s.laps ?? [])].sort(byLap);
            return {
              key: `practice-${s.sessionId}-rider-${profile.id}`,
              label: s.sessionName,
              status: s.endedAt ? "completed" : "in_progress",
              riderId: profile.id,
              practiceSessionId: Number(s.sessionId),
              myLaps,
              bestLapMs: bestOf(myLaps),
              startedAt: s.startedAt ?? null,
            };
          })
          .sort((a, b) => (b.startedAt ? Date.parse(b.startedAt) : 0) - (a.startedAt ? Date.parse(a.startedAt) : 0));
        const dateMap = new Map<string, SessionItem[]>();
        for (const s of sessions) {
          const dk = dateKey(s.startedAt);
          if (!dateMap.has(dk)) dateMap.set(dk, []);
          dateMap.get(dk)!.push(s);
        }
        const dates = [...dateMap.entries()]
          .sort(([a], [b]) => b.localeCompare(a))
          .map(([key, ds]) => ({ key, label: dateLabel(ds[0].startedAt), sessions: ds }));
        built.push({
          key: `venue-${venue}-rider-${profile.id}`,
          label: venue,
          sublabel: [multi ? riderName : null, `${venueSessions.length} session${venueSessions.length !== 1 ? "s" : ""}`].filter(Boolean).join(" · "),
          sessions,
          dates,
        });
      }
    }
  });

  // The track with the latest activity first.
  const latest = (t: TrackItem) => t.sessions.reduce((max, s) => {
    const time = s.startedAt ? Date.parse(s.startedAt) : 0;
    return Number.isFinite(time) ? Math.max(max, time) : max;
  }, 0);
  return built.sort((a, b) => latest(b) - latest(a) || a.label.localeCompare(b.label));
}

/** A session nobody ended stays "in progress" forever: only one started in the last 12 hours is live. */
function isLiveSession(s: SessionItem | null): boolean {
  if (!s || s.status !== "in_progress" || s.practiceSessionId == null) return false;
  const started = s.startedAt ? Date.parse(s.startedAt) : NaN;
  return !Number.isFinite(started) || Date.now() - started < 12 * 3_600_000;
}

// ─── Track UI ────────────────────────────────────────────────────────────────

function ChipBar({ label, items, selected, onSelect }: {
  label: string;
  items: { key: string; label: string; sub?: string | null }[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="py-2.5 border-b border-[#2E2E2E]">
      <div className="text-[12px] font-heading font-bold uppercase tracking-[0.8px] text-[#A8A8A8] mb-1.5">{label}</div>
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1" role="radiogroup" aria-label={label}>
        {items.map(item => {
          const active = item.key === selected;
          return (
            <button
              key={item.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onSelect(item.key)}
              className={`shrink-0 text-left rounded-[20px] px-3.5 py-2 transition-colors ${active ? "bg-[#B30000] text-white" : "bg-[#2E2E2E] border border-[#3A3A3A] text-[#FAFAFA] hover:border-[#A8A8A8]"}`}
            >
              <span className="block text-[14px] font-bold whitespace-nowrap">{item.label}</span>
              {item.sub ? <span className={`block text-[11px] whitespace-nowrap ${active ? "text-white/90" : "text-[#A8A8A8]"}`}>{item.sub}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StatTile({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="flex-1 rounded-[10px] bg-[#2E2E2E] p-3 text-center">
      <div className="text-[20px] font-bold text-[#FAFAFA]">{value}</div>
      <div className="text-[11px] uppercase tracking-[0.5px] text-[#A8A8A8] mt-0.5">{label}</div>
    </div>
  );
}

function LapTable({ laps, raceStyle }: { laps: PracticeLap[]; raceStyle?: string | null }) {
  const valid = laps.filter(l => (l.lapTimeMs ?? 0) > 0);
  if (valid.length === 0) {
    return (
      <div className="rounded-xl border border-[#3A3A3A] bg-[#242424] p-6 flex flex-col items-center gap-1.5 text-center">
        <Clock size={28} className="text-[#A8A8A8]" />
        <p className="text-[14px] text-[#A8A8A8]">No lap times recorded yet.</p>
      </div>
    );
  }
  const best = bestOf(valid, raceStyle);
  return (
    <div className="rounded-xl border border-[#3A3A3A] bg-[#242424] overflow-hidden">
      <table className="w-full text-left">
        <thead className="bg-[#2E2E2E]/60 border-b border-[#3A3A3A]">
          <tr className="text-[12px] font-heading font-bold uppercase tracking-[0.5px] text-[#A8A8A8]">
            <th scope="col" className="w-12 px-3.5 py-2">Lap</th>
            <th scope="col" className="px-2 py-2">Time</th>
            <th scope="col" className="w-24 px-3.5 py-2 text-right">Gap</th>
          </tr>
        </thead>
        <tbody>
          {valid.map((lap, i) => {
            const eligible = isLapEligible(lap.lapNumber, raceStyle);
            const isBest = eligible && best != null && lap.lapTimeMs === best;
            const delta = eligible && best != null && !isBest && lap.lapTimeMs! > best ? `+${((lap.lapTimeMs! - best) / 1000).toFixed(3)}s` : "";
            return (
              <tr key={i} className={`border-b border-[#3A3A3A] last:border-b-0 ${isBest ? "bg-[#B30000]/15" : ""}`}>
                <td className="px-3.5 py-2.5 text-[14px] text-[#A8A8A8]">{lap.lapNumber}</td>
                <td className={`px-2 py-2.5 text-[15px] tabular-nums ${isBest ? "font-extrabold text-white" : "text-[#FAFAFA]"}`}>{fmtLap(lap.lapTimeMs)}</td>
                <td className="px-3.5 py-2.5 text-right">
                  {isBest
                    ? <span className="inline-flex items-center gap-1 rounded-full bg-[#B30000] px-2 py-0.5 text-[11px] font-bold text-white"><Zap size={11} />BEST</span>
                    : <span className="text-[13px] text-[#A8A8A8] tabular-nums">{delta}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GatePickBoard({ entries }: { entries: EventPracticeLeaderboardEntry[] }) {
  return (
    <div className="rounded-xl border border-[#3A3A3A] bg-[#242424] overflow-hidden">
      <div className="flex items-center gap-1.5 px-3.5 py-2.5 bg-[#2E2E2E]/60 border-b border-[#3A3A3A]">
        <List size={13} className="text-[#A8A8A8]" />
        <span className="flex-1 text-[12px] font-heading font-bold uppercase tracking-[0.8px] text-[#A8A8A8]">Gate Pick Order</span>
        <span className="text-[11px] text-[#A8A8A8]">Best Lap</span>
      </div>
      {entries.map((e, i) => (
        <div key={i} className={`flex items-center gap-2.5 px-3.5 py-2.5 border-b border-[#3A3A3A] last:border-b-0 ${e.isMe ? "bg-[#B30000]/10" : ""}`}>
          <span className={`w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-[12px] font-bold ${e.rank === 1 ? "bg-[#B30000] text-white" : e.isMe ? "bg-[#B30000]/40 text-white" : "bg-[#2E2E2E] text-[#A8A8A8]"}`}>{e.rank}</span>
          <span className="flex-1 min-w-0">
            <span className={`block truncate text-[14px] text-[#FAFAFA] ${e.isMe ? "font-bold" : ""}`}>{e.riderName}{e.isMe ? "  ★" : ""}</span>
            {e.bibNumber && <span className="block text-[12px] text-[#A8A8A8]">#{e.bibNumber}</span>}
          </span>
          <span className="text-right">
            <span className={`block text-[14px] tabular-nums text-[#FAFAFA] ${e.isMe ? "font-bold" : "font-semibold"}`}>{fmtLap(e.bestLapMs)}</span>
            <span className="block text-[11px] text-[#A8A8A8]">{e.lapCount} lap{e.lapCount !== 1 ? "s" : ""}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="font-heading font-bold uppercase tracking-[0.8px] text-[14px] text-[#A8A8A8] mb-2">{children}</h2>;
}

function TrackMode({ onWantPlan }: { onWantPlan: () => void }) {
  const { activeProfiles } = useActiveRiders();
  const profileKey = activeProfiles.map(p => p.id).join(",");
  const [selTrack, setSelTrack] = useState<string | null>(null);
  const [selDate, setSelDate] = useState<string | null>(null);
  const [selSession, setSelSession] = useState<string | null>(null);
  const [liveNow, setLiveNow] = useState(false);

  const tracksQuery = useQuery({
    queryKey: ["rider-train-tracks", profileKey],
    queryFn: () => loadTracks(activeProfiles),
    enabled: activeProfiles.length > 0,
    // While an open-practice session is running, check for new laps every few seconds.
    refetchInterval: liveNow ? 4000 : false,
    refetchIntervalInBackground: false,
  });
  const tracks = tracksQuery.data ?? [];

  const currentTrack = tracks.find(t => t.key === selTrack) ?? tracks[0] ?? null;
  const currentDate = currentTrack?.dates.find(d => d.key === selDate) ?? currentTrack?.dates[0] ?? null;
  const currentSession = currentDate?.sessions.find(s => s.key === selSession) ?? currentDate?.sessions[0] ?? null;

  const live = isLiveSession(currentSession);
  useEffect(() => { setLiveNow(live); }, [live]);

  // Personal-best flash: a new best lap on the live session beats the track's previous best.
  const [pbFlash, setPbFlash] = useState(false);
  const baseline = useRef<{ key: string | null; best: number | null }>({ key: null, best: null });
  const pbTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!currentSession || !currentTrack) return;
    const trackBest = (exclude: string | null) => {
      const v = currentTrack.sessions.filter(s => s.key !== exclude).map(s => s.bestLapMs).filter((n): n is number => n != null && n > 0);
      return v.length ? Math.min(...v) : null;
    };
    if (baseline.current.key !== currentSession.key) {
      // New selection: remember the best so far, no flash.
      const others = trackBest(currentSession.key);
      const mine = currentSession.bestLapMs;
      baseline.current = { key: currentSession.key, best: others == null ? mine : mine == null ? others : Math.min(others, mine) };
      setPbFlash(false);
      return;
    }
    const mine = currentSession.bestLapMs;
    if (live && mine != null && (baseline.current.best == null || mine < baseline.current.best)) {
      baseline.current.best = mine;
      setPbFlash(true);
      if (pbTimer.current) clearTimeout(pbTimer.current);
      pbTimer.current = setTimeout(() => setPbFlash(false), 3500);
    }
  }, [currentSession, currentTrack, live]);
  useEffect(() => () => { if (pbTimer.current) clearTimeout(pbTimer.current); }, []);

  const sessionsAtTrack = currentTrack?.sessions ?? [];
  const totalLaps = sessionsAtTrack.reduce((n, s) => n + s.myLaps.filter(l => (l.lapTimeMs ?? 0) > 0).length, 0);
  const bests = sessionsAtTrack.map(s => s.bestLapMs).filter((n): n is number => n != null && n > 0);
  const overallBest = bests.length ? Math.min(...bests) : null;

  const pickTrack = (key: string) => { setSelTrack(key); setSelDate(null); setSelSession(null); };
  const pickDate = (key: string) => { setSelDate(key); setSelSession(null); };

  if (activeProfiles.length === 0) {
    return (
      <EmptyState icon={Activity} title="Add your rider profile" message="Link a rider profile to see your practice sessions and lap times.">
        <Link href="/rider/portal" className="mt-2 rounded-full bg-[#B30000] px-6 min-h-[44px] inline-flex items-center font-bold text-white hover:bg-[#990000]">Go to Profile</Link>
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2.5">
        <StatTile value={sessionsAtTrack.length} label="Sessions" />
        <StatTile value={totalLaps} label="Total Laps" />
        <StatTile value={fmtLap(overallBest)} label="Best Ever" />
      </div>

      <div>
        {tracks.length > 0 && <ChipBar label="Track" items={tracks.map(t => ({ key: t.key, label: t.label, sub: t.sublabel }))} selected={currentTrack?.key ?? null} onSelect={pickTrack} />}
        {currentTrack && currentTrack.dates.length > 1 && <ChipBar label="Date" items={currentTrack.dates.map(d => ({ key: d.key, label: d.label }))} selected={currentDate?.key ?? null} onSelect={pickDate} />}
        {currentDate && currentDate.sessions.length > 1 && <ChipBar label="Session" items={currentDate.sessions.map(s => ({ key: s.key, label: s.label }))} selected={currentSession?.key ?? null} onSelect={setSelSession} />}
      </div>

      {tracksQuery.isLoading ? (
        <div className="flex justify-center py-16" role="status" aria-label="Loading"><Loader2 size={24} className="animate-spin text-[#A8A8A8]" /></div>
      ) : tracksQuery.isError ? (
        <EmptyState icon={AlertCircle} title="Couldn't load practice data" message="Check your connection and try again.">
          <button type="button" onClick={() => void tracksQuery.refetch()} className="mt-2 rounded-full bg-[#B30000] px-6 min-h-[44px] font-bold text-white hover:bg-[#990000]">Try again</button>
        </EmptyState>
      ) : tracks.length === 0 ? (
        <EmptyState icon={Activity} title="Get on the clock" message="Lap times from practice at events and timed practice days show up here, with your best laps highlighted.">
          <div className="flex flex-wrap justify-center gap-2 mt-2">
            <button type="button" onClick={onWantPlan} className="rounded-full bg-[#B30000] px-6 min-h-[44px] inline-flex items-center gap-2 font-bold text-white hover:bg-[#990000]"><Cpu size={16} />Get a training plan</button>
            <Link href="/rider/races" className="rounded-full border border-[#3A3A3A] bg-[#2E2E2E] px-6 min-h-[44px] inline-flex items-center font-bold text-[#FAFAFA] hover:border-[#A8A8A8]">Find a race</Link>
          </div>
        </EmptyState>
      ) : !currentSession ? (
        <p className="text-center text-[14px] text-[#A8A8A8] py-12">Select a session above</p>
      ) : (
        <>
          <div className={`rounded-xl bg-[#242424] p-4 transition-all ${pbFlash ? "border-2 border-[#eab308] shadow-[0_0_24px_rgba(234,179,8,0.35)]" : "border border-[#3A3A3A]"}`}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[17px] font-extrabold text-[#FAFAFA]">{currentSession.label}</div>
                {currentTrack && (
                  <div className="text-[13px] text-[#A8A8A8] mt-0.5">
                    {currentTrack.label}{currentDate && currentTrack.dates.length > 1 ? `  ·  ${currentDate.label}` : currentTrack.sublabel ? `  ·  ${currentTrack.sublabel}` : ""}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5" aria-live="polite">
                  {currentSession.status === "in_progress" && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#B30000] px-2 py-0.5 text-[10px] font-bold text-white">
                      <span className="w-[5px] h-[5px] rounded-full bg-white animate-pulse" />LIVE
                    </span>
                  )}
                  {pbFlash && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#eab308] px-2.5 py-1 text-[11px] font-extrabold text-[#713f12] animate-bounce">
                      <Zap size={11} />Personal Best!
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className={`text-[26px] font-extrabold tabular-nums ${pbFlash ? "text-[#facc15]" : "text-white"}`}>{fmtLap(bestOf(currentSession.myLaps, currentSession.raceStyle))}</div>
                <div className="text-[11px] uppercase tracking-[0.5px] text-[#A8A8A8]">Best Lap</div>
                <div className="text-[12px] text-[#A8A8A8]">{currentSession.myLaps.filter(l => (l.lapTimeMs ?? 0) > 0).length} laps</div>
              </div>
            </div>
          </div>

          <SessionLapChart laps={currentSession.myLaps} raceStyle={currentSession.raceStyle} />
          {currentTrack && <TrackProgressChart sessions={currentTrack.sessions} trackLabel={currentTrack.label} />}

          <section>
            <SectionTitle>Lap Times</SectionTitle>
            <LapTable laps={currentSession.myLaps} raceStyle={currentSession.raceStyle} />
          </section>
          {currentSession.leaderboard && currentSession.leaderboard.length > 0 && (
            <section>
              <SectionTitle>Class Leaderboard</SectionTitle>
              <GatePickBoard entries={currentSession.leaderboard} />
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ─── Coach: plan types ───────────────────────────────────────────────────────

interface WorkoutExercise {
  name: string;
  equipment: string;
  duration: string | null;
  sets: number | null;
  reps: string | null;
  restSeconds: number;
  intensity: string;
  muscleGroups: string[];
  mxBenefit: string;
  formTips: string[];
  exerciseNote?: string;
  equipmentSetup?: string;
  progressionTip?: string;
  imageUrl?: string;
}
interface DrillBlock { name: string; durationMinutes: number; reps: number; trackSection: string; mxFocus: string; cues: string[] }
interface WorkoutPhase { name: string; duration: number; phaseColor: string; exercises?: WorkoutExercise[]; drillBlocks?: DrillBlock[] }
interface WorkoutPlan {
  planTitle: string;
  totalMinutes: number;
  focus: string[];
  mxRelevance: string | string[];
  phases: WorkoutPhase[];
  proTip: string;
  nutritionTip: string;
  recoveryTip: string;
}
type WorkoutType = "gym" | "bike";

/** A plan the page can draw: the AI's reply isn't checked by the server. */
function usablePlan(p: unknown): p is WorkoutPlan {
  return !!p && typeof p === "object" && Array.isArray((p as WorkoutPlan).phases)
    && (p as WorkoutPlan).phases.every(ph => !!ph && typeof ph === "object");
}

/** AI-chosen phase colours, or a neutral grey when one is missing or odd. */
function safeColor(c: unknown): string {
  return typeof c === "string" && /^#[0-9a-f]{3,8}$/i.test(c.trim()) ? c.trim() : "#A8A8A8";
}

const PLAN_KEY = (accountId: number) => `workout_plan_v2_${accountId}`;
const LAST_TYPE_KEY = "last_workout_type_v1";

function readSavedPlan(accountId: number): { plan: WorkoutPlan; workoutType: WorkoutType } | null {
  try {
    const raw = localStorage.getItem(PLAN_KEY(accountId));
    if (!raw) return null;
    const saved = JSON.parse(raw);
    const plan = saved && typeof saved === "object" && "plan" in saved ? saved.plan : saved;
    if (!usablePlan(plan)) { localStorage.removeItem(PLAN_KEY(accountId)); return null; }
    return { plan, workoutType: saved?.workoutType === "bike" ? "bike" : "gym" };
  } catch {
    return null;
  }
}

function writeSavedPlan(accountId: number, value: { plan: WorkoutPlan; workoutType: WorkoutType } | null) {
  try {
    if (value) localStorage.setItem(PLAN_KEY(accountId), JSON.stringify(value));
    else localStorage.removeItem(PLAN_KEY(accountId));
  } catch { /* private mode: the plan just isn't kept */ }
}

const WORKOUT_TYPES: { key: WorkoutType; label: string; Icon: typeof Dumbbell }[] = [
  { key: "gym", label: "Gym Workout", Icon: Dumbbell },
  { key: "bike", label: "On the Bike", Icon: Bike },
];
const DURATION_OPTIONS = [30, 45, 60, 90, 120];
const SUGGESTIONS: Record<WorkoutType | "default", string[]> = {
  default: [
    "Reduce arm pump on long motos",
    "Improve explosive holeshot speed",
    "Better core stability in whoops",
    "Increase overall moto endurance",
    "Strengthen grip and wrist control",
  ],
  gym: [
    "Reduce arm pump with targeted forearm training",
    "Build explosive holeshot power with plyometrics",
    "Core stability for whoops and rhythm sections",
    "Grip strength and wrist endurance",
    "Increase moto cardio endurance",
  ],
  bike: [
    "Improve gate start reaction time",
    "Rut riding confidence and line choice",
    "Corner entry and exit speed",
    "Scrub technique over jumps",
    "Whoops section momentum and flow",
  ],
};
const LOADING_MESSAGES = [
  "Analyzing your training needs…",
  "Consulting MX performance data…",
  "Building your personalized workout…",
  "Fine-tuning sets and reps…",
  "Adding pro tips from the pits…",
  "Almost ready…",
];
const EXPECTED_SECONDS = 45;

// ─── Coach: input ────────────────────────────────────────────────────────────

function InputPanel({ onGenerate }: { onGenerate: (goal: string, duration: number, type: WorkoutType) => void }) {
  const [goal, setGoal] = useState("");
  const [duration, setDuration] = useState<number | null>(null);
  const [type, setType] = useState<WorkoutType | null>(() => {
    try {
      const v = localStorage.getItem(LAST_TYPE_KEY);
      return v === "gym" || v === "bike" ? v : v === "mix" ? "gym" : null;
    } catch { return null; }
  });
  const pickType = (t: WorkoutType) => {
    setType(t);
    try { localStorage.setItem(LAST_TYPE_KEY, t); } catch { /* ignore */ }
  };

  const trimmed = goal.trim();
  const canGenerate = trimmed.length > 10 && duration !== null && type !== null;
  const hint = trimmed.length === 0 ? "Describe what you want to improve"
    : trimmed.length <= 10 ? "Add a bit more detail"
    : !type ? "Select a session type above"
    : "Pick a duration above";

  return (
    <form
      className="space-y-6"
      onSubmit={e => { e.preventDefault(); if (canGenerate) onGenerate(trimmed, duration!, type!); }}
    >
      <div className="flex flex-col items-center text-center gap-2 pt-2">
        <span className="w-16 h-16 rounded-full bg-[#B30000]/20 flex items-center justify-center"><Bike size={34} className="text-white" /></span>
        <h2 className="font-heading font-extrabold uppercase text-[24px] text-[#FAFAFA]">MX Training Coach</h2>
        <p className="text-[15px] text-[#A8A8A8] leading-snug">AI-powered workouts built exclusively for<br />Supercross and Motocross racers</p>
      </div>

      <div className="space-y-2.5">
        <label htmlFor="train-goal" className="block text-[15px] font-bold text-[#FAFAFA]">What do you want to improve?</label>
        <textarea
          id="train-goal"
          value={goal}
          onChange={e => setGoal(e.target.value)}
          rows={4}
          maxLength={1000}
          placeholder="e.g. I get bad arm pump in the last 10 minutes of a moto and my grip strength falls apart in rutted corners…"
          className={`w-full rounded-xl bg-[#242424] p-3.5 text-[#FAFAFA] placeholder:text-[#A8A8A8]/70 leading-relaxed min-h-[110px] outline-none border-[1.5px] focus:border-[#FAFAFA] ${trimmed ? "border-[#B30000]" : "border-[#3A3A3A]"}`}
        />
        <div className="space-y-1.5">
          <div className="text-[13px] text-[#A8A8A8]">{type ? `Quick picks for ${WORKOUT_TYPES.find(w => w.key === type)!.label.toLowerCase()}:` : "Quick picks:"}</div>
          <div className="flex flex-wrap gap-1.5">
            {(type ? SUGGESTIONS[type] : SUGGESTIONS.default).map(s => (
              <button key={s} type="button" onClick={() => setGoal(s)} className="rounded-full bg-[#2E2E2E] border border-[#3A3A3A] px-3 py-1.5 text-[13px] text-[#A8A8A8] hover:text-white hover:border-[#A8A8A8]">{s}</button>
            ))}
          </div>
        </div>
      </div>

      <fieldset className="space-y-2.5">
        <legend className="text-[15px] font-bold text-[#FAFAFA] mb-2.5">What kind of session?</legend>
        <div className="flex gap-2">
          {WORKOUT_TYPES.map(({ key, label, Icon }) => {
            const active = type === key;
            return (
              <button key={key} type="button" aria-pressed={active} onClick={() => pickType(key)}
                className={`flex-1 flex flex-col items-center gap-1 rounded-xl py-3 px-2 transition-colors ${active ? "bg-[#B30000] text-white" : "bg-[#2E2E2E] border border-[#3A3A3A] text-[#FAFAFA] hover:border-[#A8A8A8]"}`}>
                <Icon size={20} />
                <span className="text-[13px] font-bold">{label}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-[15px] font-bold text-[#FAFAFA] mb-2.5">{type === "gym" ? "Total Time" : type === "bike" ? "Practice Time" : "How long do you have?"}</legend>
        <div className="grid grid-cols-5 gap-2">
          {DURATION_OPTIONS.map(d => {
            const active = duration === d;
            return (
              <button key={d} type="button" aria-pressed={active} onClick={() => setDuration(d)}
                className={`flex flex-col items-center rounded-[10px] py-3 transition-colors ${active ? "bg-[#B30000] text-white" : "bg-[#2E2E2E] border border-[#3A3A3A] text-[#FAFAFA] hover:border-[#A8A8A8]"}`}>
                <span className="text-[16px] font-extrabold">{d}</span>
                <span className={`text-[10px] uppercase tracking-[0.3px] ${active ? "text-white" : "text-[#A8A8A8]"}`}>min</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div>
        <button type="submit" disabled={!canGenerate}
          className={`w-full rounded-full py-4 flex flex-col items-center font-heading font-extrabold uppercase tracking-[1px] text-[17px] transition-colors ${canGenerate ? "bg-[#B30000] text-white hover:bg-[#990000]" : "bg-[#2E2E2E] text-[#A8A8A8] cursor-not-allowed"}`}>
          Generate My Plan
          {!canGenerate && <span className="font-sans normal-case tracking-normal font-normal text-[12px] mt-0.5">{hint}</span>}
        </button>
        <p className="text-center text-[12px] text-[#A8A8A8] mt-3">Powered by Claude AI · Trained on professional MX/SX conditioning programs</p>
      </div>

      <div className="flex items-start gap-2 rounded-[10px] bg-[#2E2E2E] border border-[#3A3A3A] p-3">
        <Info size={13} className="shrink-0 mt-0.5 text-[#A8A8A8]" />
        <p className="text-[12px] text-[#A8A8A8] leading-relaxed">
          <strong className="text-[#FAFAFA]">For informational purposes only.</strong>{" "}
          AI-generated training plans are suggestions and may not be suitable for your fitness level or health condition. Consult a certified personal trainer before starting any new gym program, and always ride within your ability level under the guidance of a qualified coach.
        </p>
      </div>
    </form>
  );
}

// ─── Coach: loading ──────────────────────────────────────────────────────────

function LoadingPanel({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const msg = LOADING_MESSAGES[Math.min(LOADING_MESSAGES.length - 1, Math.floor(elapsed / 8))];
  // Eases toward 95% so the bar never claims it's finished before the plan arrives.
  const pct = Math.min(95, Math.round((1 - Math.exp(-elapsed / (EXPECTED_SECONDS * 0.6))) * 100));
  const mm = Math.floor(elapsed / 60), ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="flex flex-col items-center text-center gap-5 py-12 px-4" role="status" aria-live="polite">
      <span className="w-20 h-20 rounded-full bg-[#B30000]/20 flex items-center justify-center">
        <Loader2 size={36} className="animate-spin text-white" />
      </span>
      <div className="space-y-1.5">
        <h2 className="font-heading font-extrabold uppercase text-[22px] text-[#FAFAFA]">Building Your Plan</h2>
        <p className="text-[15px] text-[#A8A8A8]">{msg}</p>
      </div>
      <div className="w-full max-w-sm space-y-1.5">
        <div className="h-2 rounded-full bg-[#2E2E2E] overflow-hidden" aria-hidden="true">
          <div className="h-full rounded-full bg-[#B30000] transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex justify-between text-[12px] text-[#A8A8A8] tabular-nums">
          <span>{mm}:{ss} elapsed</span>
          <span>usually 40–50 s</span>
        </div>
      </div>
      <p className="text-[13px] text-[#A8A8A8] max-w-sm leading-relaxed">
        {elapsed < 60
          ? "Your coach is writing a full session just for you, so this takes about a minute. Keep this tab open; your plan is saved as soon as it's ready."
          : "Taking a little longer than usual. Hang tight, it's still working."}
      </p>
    </div>
  );
}

// ─── Coach: plan ─────────────────────────────────────────────────────────────

function Pill({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold text-[#FAFAFA]"
      style={{ backgroundColor: color ? `${color}33` : "#2E2E2E" }}>
      {children}
    </span>
  );
}

function ExerciseCard({ ex, color }: { ex: WorkoutExercise; color: string }) {
  const [open, setOpen] = useState(false);
  const [imgError, setImgError] = useState(false);
  const metrics = [ex.sets ? `${ex.sets} sets` : null, ex.reps || null, ex.duration ?? null].filter(Boolean).join(" × ");
  const note = ex.exerciseNote ?? (ex.equipmentSetup && ex.progressionTip ? `${ex.equipmentSetup} Next: ${ex.progressionTip}` : ex.equipmentSetup ?? ex.progressionTip ?? null);
  const tips = Array.isArray(ex.formTips) ? ex.formTips : [];
  const muscles = Array.isArray(ex.muscleGroups) ? ex.muscleGroups : [];
  return (
    <div className="rounded-xl border border-[#3A3A3A] bg-[#242424] overflow-hidden" style={{ borderLeft: `3px solid ${color}` }}>
      {ex.imageUrl && !imgError && <img src={ex.imageUrl} alt="" className="w-full aspect-video object-cover" onError={() => setImgError(true)} />}
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} className="w-full flex items-center gap-3 p-3.5 pb-2.5 text-left">
        <span className="w-10 h-10 shrink-0 rounded-[10px] flex items-center justify-center" style={{ backgroundColor: `${color}33` }}><Dumbbell size={18} className="text-white" /></span>
        <span className="flex-1 min-w-0">
          <span className="block text-[16px] font-bold text-[#FAFAFA]">{ex.name}</span>
          <span className="block text-[12px] text-[#A8A8A8]">{ex.equipment}</span>
        </span>
        {open ? <ChevronUp size={16} className="text-[#A8A8A8]" /> : <ChevronDown size={16} className="text-[#A8A8A8]" />}
      </button>
      <div className="flex flex-wrap items-center gap-2 px-3.5 pb-3">
        {metrics && <Pill color={color}>{metrics}</Pill>}
        {ex.restSeconds > 0 && <Pill>{ex.restSeconds}s rest</Pill>}
        {ex.intensity && <Pill>{ex.intensity}</Pill>}
        {ex.mxBenefit && <Pill color="#B30000"><Bike size={11} />{ex.mxBenefit}</Pill>}
      </div>
      {open && (
        <div className="px-3.5 pb-3.5 space-y-2.5">
          {tips.length > 0 && (
            <div>
              <div className="text-[12px] font-heading font-bold uppercase tracking-[0.5px] text-[#A8A8A8] mb-1">Form Cues</div>
              <ul className="space-y-0.5">{tips.map((t, i) => <li key={i} className="flex gap-2 text-[14px] text-[#FAFAFA] leading-snug"><span style={{ color }}>•</span>{t}</li>)}</ul>
            </div>
          )}
          {muscles.length > 0 && (
            <div className="flex flex-wrap gap-1.5">{muscles.map((m, i) => <span key={i} className="rounded-md bg-[#2E2E2E] border border-[#3A3A3A] px-2 py-0.5 text-[12px] text-[#A8A8A8]">{m}</span>)}</div>
          )}
          {note && (
            <p className="flex gap-1.5 text-[13px] text-[#A8A8A8] leading-snug"><Info size={12} className="shrink-0 mt-0.5" /><span><strong className="text-[#FAFAFA]">Note: </strong>{note}</span></p>
          )}
        </div>
      )}
    </div>
  );
}

function DrillCard({ drill, color }: { drill: DrillBlock; color: string }) {
  const [open, setOpen] = useState(false);
  const cues = Array.isArray(drill.cues) ? drill.cues : [];
  return (
    <div className="rounded-xl border border-[#3A3A3A] bg-[#242424] overflow-hidden" style={{ borderLeft: `3px solid ${color}` }}>
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} className="w-full flex items-center gap-3 p-3.5 pb-2.5 text-left">
        <span className="w-10 h-10 shrink-0 rounded-[10px] flex items-center justify-center" style={{ backgroundColor: `${color}33` }}><Flag size={18} className="text-white" /></span>
        <span className="flex-1 min-w-0">
          <span className="block text-[16px] font-bold text-[#FAFAFA]">{drill.name}</span>
          <span className="block text-[12px] text-[#A8A8A8]">{drill.trackSection}</span>
        </span>
        {open ? <ChevronUp size={16} className="text-[#A8A8A8]" /> : <ChevronDown size={16} className="text-[#A8A8A8]" />}
      </button>
      <div className="flex flex-wrap items-center gap-2 px-3.5 pb-3">
        <Pill color={color}>{drill.durationMinutes} min</Pill>
        {drill.reps > 0 && <Pill>{drill.reps} reps/set</Pill>}
        {drill.mxFocus && <Pill color="#B30000"><Bike size={11} />{drill.mxFocus}</Pill>}
      </div>
      {open && cues.length > 0 && (
        <div className="px-3.5 pb-3.5">
          <div className="text-[12px] font-heading font-bold uppercase tracking-[0.5px] text-[#A8A8A8] mb-1">Technique Cues</div>
          <ul className="space-y-0.5">{cues.map((c, i) => <li key={i} className="flex gap-2 text-[14px] text-[#FAFAFA] leading-snug"><span style={{ color }}>•</span>{c}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function splitTipSentences(text: string): string[] {
  const parts = text.split(/[.!?]\s+/).reduce<string[]>((acc, seg, i, arr) => {
    if (i < arr.length - 1) acc.push(seg + ".");
    else if (seg.trim()) acc.push(seg.trim());
    return acc;
  }, []).filter(Boolean);
  return parts.length > 1 ? parts : [text];
}

function TipCard({ Icon, label, color, text }: { Icon: typeof Trophy; label: string; color: string; text: string }) {
  const bullets = splitTipSentences(text);
  return (
    <div className="rounded-xl border border-[#3A3A3A] bg-[#242424] p-3.5 flex gap-3">
      <span className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center" style={{ backgroundColor: `${color}33` }}><Icon size={17} className="text-white" /></span>
      <div className="flex-1">
        <div className="text-[14px] font-heading font-bold uppercase tracking-[0.5px] text-[#FAFAFA] mb-1">{label}</div>
        {bullets.length > 1
          ? <ul className="space-y-0.5">{bullets.map((b, i) => <li key={i} className="flex gap-2 text-[14px] text-[#FAFAFA] leading-snug"><span style={{ color }}>•</span>{b}</li>)}</ul>
          : <p className="text-[14px] text-[#FAFAFA] leading-snug">{text}</p>}
      </div>
    </div>
  );
}

function PlanPanel({ plan, workoutType, onReset }: { plan: WorkoutPlan; workoutType: WorkoutType; onReset: () => void }) {
  const meta = WORKOUT_TYPES.find(w => w.key === workoutType)!;
  const phases = plan.phases ?? [];
  return (
    <div className="space-y-5">
      <div className="rounded-2xl border-[1.5px] border-[#B30000]/60 overflow-hidden">
        <div className="p-4 bg-[#B30000]/15 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <h2 className="font-heading font-extrabold uppercase text-[22px] leading-tight text-[#FAFAFA]">{plan.planTitle}</h2>
            <span className="shrink-0 rounded-full bg-[#B30000] px-3 py-1 text-[13px] font-bold text-white">{plan.totalMinutes} min</span>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#B30000]/30 px-3 py-1 text-[12px] font-bold text-white"><meta.Icon size={13} />{meta.label}</span>
          {(plan.focus ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1.5">{plan.focus.map((f, i) => <span key={i} className="rounded-md bg-[#B30000]/35 px-2 py-0.5 text-[12px] font-bold text-white">{f}</span>)}</div>
          )}
          {Array.isArray(plan.mxRelevance)
            ? <ul className="space-y-0.5">{plan.mxRelevance.map((b, i) => <li key={i} className="flex gap-2 text-[14px] text-[#FAFAFA] leading-snug"><span>•</span>{b}</li>)}</ul>
            : plan.mxRelevance ? <p className="text-[14px] text-[#FAFAFA] leading-snug">{plan.mxRelevance}</p> : null}
        </div>
        {phases.length > 0 && (
          <div className="flex border-t border-[#3A3A3A]/80 bg-[#242424]">
            {phases.map((ph, i) => (
              <div key={i} className="flex-1 p-2 flex flex-col items-center text-center border-r border-[#3A3A3A]/60 last:border-r-0">
                <span className="w-2 h-2 rounded-full mb-1" style={{ backgroundColor: safeColor(ph.phaseColor) }} />
                <span className="text-[11px] font-heading font-bold uppercase text-[#A8A8A8]">{ph.name}</span>
                <span className="text-[11px] text-[#A8A8A8]">{ph.duration}m</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {phases.map((ph, pi) => {
        const color = safeColor(ph.phaseColor);
        return (
          <section key={pi} className="space-y-2.5">
            <div className="flex items-center gap-2.5">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
              <h3 className="flex-1 font-heading font-extrabold uppercase tracking-[1px] text-[16px] text-[#FAFAFA]">{ph.name}</h3>
              <Pill color={color}>{ph.duration} min</Pill>
            </div>
            {Array.isArray(ph.drillBlocks) && ph.drillBlocks.length > 0
              ? ph.drillBlocks.map((d, di) => <DrillCard key={di} drill={d} color={color} />)
              : (ph.exercises ?? []).map((ex, ei) => <ExerciseCard key={ei} ex={ex} color={color} />)}
          </section>
        );
      })}

      {plan.proTip && <TipCard Icon={Trophy} label="Pro Tip" color="#B30000" text={plan.proTip} />}
      {plan.nutritionTip && <TipCard Icon={Salad} label="Nutrition" color="#22c55e" text={plan.nutritionTip} />}
      {plan.recoveryTip && <TipCard Icon={Moon} label="Recovery" color="#8b5cf6" text={plan.recoveryTip} />}

      <button type="button" onClick={onReset} className="w-full rounded-full border-[1.5px] border-[#FAFAFA] py-3.5 font-heading font-extrabold uppercase tracking-[1px] text-[16px] text-[#FAFAFA] hover:bg-[#242424]">
        Generate New Plan
      </button>
    </div>
  );
}

// ─── Coach mode ──────────────────────────────────────────────────────────────

type CoachState = { kind: "input" } | { kind: "loading"; startedAt: number } | { kind: "plan"; plan: WorkoutPlan; workoutType: WorkoutType } | { kind: "error"; message: string };

function CoachMode() {
  const { account } = useRiderAuth();
  const accountId = account?.id ?? null;
  const [state, setState] = useState<CoachState>({ kind: "input" });
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // Show this account's saved plan; a different account never sees another's.
  useEffect(() => {
    if (accountId == null) { setState({ kind: "input" }); return; }
    const saved = readSavedPlan(accountId);
    setState(prev => prev.kind === "loading" ? prev : saved ? { kind: "plan", ...saved } : { kind: "input" });
  }, [accountId]);

  const generate = useCallback(async (goal: string, durationMinutes: number, workoutType: WorkoutType) => {
    setState({ kind: "loading", startedAt: Date.now() });
    window.scrollTo(0, 0);
    try {
      const res = await fetch("/api/rider/training-plan", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal, durationMinutes, workoutType }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? (res.status >= 500 ? "The coach didn't respond. Try again in a moment." : "Couldn't generate a plan. Please try again."));
      }
      const data: unknown = await res.json();
      if (!usablePlan(data)) throw new Error("The plan didn't come through properly. Try again.");
      // Saved even if the rider left the page while it was being written.
      if (accountId != null) writeSavedPlan(accountId, { plan: data, workoutType });
      if (mounted.current) {
        setState({ kind: "plan", plan: data, workoutType });
        window.scrollTo(0, 0);
      }
    } catch (e) {
      if (mounted.current) setState({ kind: "error", message: isNetworkError(e) ? NETWORK_ERROR_MESSAGE : (e as Error)?.message || "Something went wrong. Please try again." });
    }
  }, [accountId]);

  const reset = () => {
    if (accountId != null) writeSavedPlan(accountId, null);
    setState({ kind: "input" });
    window.scrollTo(0, 0);
  };

  switch (state.kind) {
    case "input": return <InputPanel onGenerate={generate} />;
    case "loading": return <LoadingPanel startedAt={state.startedAt} />;
    case "plan": return <PlanPanel plan={state.plan} workoutType={state.workoutType} onReset={reset} />;
    case "error": return (
      <div className="flex flex-col items-center text-center gap-4 py-14 px-4" role="alert">
        <AlertCircle size={40} className="text-[#f87171]" />
        <h2 className="font-heading font-extrabold uppercase text-[20px] text-[#FAFAFA]">Couldn't Generate Plan</h2>
        <p className="text-[15px] text-[#A8A8A8] max-w-sm">{state.message}</p>
        <button type="button" onClick={() => setState({ kind: "input" })} className="rounded-full bg-[#B30000] px-7 min-h-[44px] font-bold text-white hover:bg-[#990000]">Try Again</button>
      </div>
    );
  }
}

// ─── Page ────────────────────────────────────────────────────────────────────

type TabMode = "track" | "coach";

export default function RiderTrain() {
  const [mode, setMode] = useState<TabMode>(() => {
    try { return new URLSearchParams(window.location.search).get("tab") === "coach" ? "coach" : "track"; } catch { return "track"; }
  });
  // Both panels stay mounted so a plan being written keeps going while the rider checks lap times.
  const panels = useMemo(() => ({ track: <TrackMode onWantPlan={() => setMode("coach")} />, coach: <CoachMode /> }), []);

  return (
    <RiderLayout title="Train">
      <div className="max-w-3xl space-y-4">
        <Segmented<TabMode>
          label="Train section"
          value={mode}
          onChange={setMode}
          options={[{ key: "track", label: "Track", icon: Activity }, { key: "coach", label: "Train", icon: Cpu }]}
        />
        <div hidden={mode !== "track"}>{panels.track}</div>
        <div hidden={mode !== "coach"}>{panels.coach}</div>
      </div>
    </RiderLayout>
  );
}
