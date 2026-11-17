/**
 * Rider Home on the website, ported from the rider app's Home tab
 * (rider-app/app/(tabs)/index.tsx): greeting, the next gate drop as a photo
 * hero with a countdown, recent form and one trend, other booked races, the
 * last race, Rocky, and riders you follow. The checked riders drive it, as in
 * the app: history from all of them, the schedule from the first.
 */
import { useQuery, useQueries } from "@tanstack/react-query";
import { Award, Calendar, Loader2, UserPlus, WifiOff } from "lucide-react";
import { pickNextRace } from "@workspace/rider-insights/home";

import { RiderLayout } from "@/components/layout/RiderLayout";
import { riderApi, type ScheduleEvent } from "@/lib/rider-api";
import { useActiveRiders } from "@/lib/rider-active";
import {
  EmptyCard, EventCard, FormStrip, FormTrendCard, NextRaceHero, ResultCard, RockyRow, SectionHeader, type HomeResult,
} from "@/components/rider/home/HomeCards";
import { FollowingFeed } from "@/components/rider/home/FollowingFeed";
import { fmtToday, greeting, localDateString, placeLabel } from "@/components/rider/home/format";

const UPCOMING = new Set(["registration_open", "registration_closed", "race_day"]);
const classesOf = (e: ScheduleEvent) =>
  [...new Set((e.registrations ?? []).map(r => r.raceClass).filter((c): c is string => !!c))];

export default function RiderHome() {
  const { activeProfiles, isLoading: profilesLoading, isError: profilesError } = useActiveRiders();
  const primary = activeProfiles[0] ?? null;
  const isMulti = activeProfiles.length > 1;

  const scheduleQuery = useQuery({
    queryKey: ["rider-schedule", primary?.id],
    queryFn: () => riderApi.schedule(primary!.id),
    enabled: !!primary,
    staleTime: 30_000,
    // Poll every 15 s while a race is running today, like the app.
    refetchInterval: q => (q.state.data?.events ?? []).some(e => e.status === "race_day") ? 15_000 : false,
  });

  const historyQueries = useQueries({
    queries: activeProfiles.map(p => ({
      queryKey: ["rider-history", p.id],
      queryFn: () => riderApi.history(p.id),
      staleTime: 60_000,
    })),
  });

  const upcoming = (scheduleQuery.data?.events ?? []).filter(e => UPCOMING.has(e.status));
  const allHistory: HomeResult[] = historyQueries
    .flatMap((q, i) => {
      const p = activeProfiles[i];
      if (!q.data || !p) return [];
      const riderName = isMulti ? `${p.firstName} ${p.lastName}` : undefined;
      return q.data.history.map(ev => ({ ...ev, riderId: p.id, riderName }));
    })
    .sort((a, b) => new Date(b.eventDate).getTime() - new Date(a.eventDate).getTime());
  const last = allHistory[0] ?? null;

  const loading = (scheduleQuery.isLoading && !!primary) || historyQueries.some(q => q.isLoading);
  const loadFailed = scheduleQuery.isError || historyQueries.some(q => q.isError);
  const retry = () => { void scheduleQuery.refetch(); historyQueries.forEach(q => void q.refetch()); };

  const hasProfile = activeProfiles.length > 0;
  const hasStats = activeProfiles.some(p => p.eventsRaced > 0 || p.totalPoints > 0 || p.bestPosition != null);
  const todayYmd = localDateString();
  const next = pickNextRace(upcoming, todayYmd);
  const laterRaces = upcoming.filter(e => e.eventId !== next?.eventId);

  // Website pages for what the app opens in place.
  const upcomingHref = primary ? `/rider/portal/${primary.id}?tab=upcoming` : "/rider/races";
  const findHref = primary ? `/rider/portal/${primary.id}?tab=nearby` : "/rider/races";
  const raceHref = (ev: HomeResult) => `/rider/portal/${ev.riderId}?tab=races`;

  return (
    <RiderLayout>
      {/* ── Greeting ── */}
      <div className="pt-5 pb-4">
        <h1 className="truncate font-heading font-extrabold uppercase tracking-[0.8px] text-[26px] md:text-[34px] leading-[1.1] text-white">
          {primary ? greeting(primary.firstName) : "Welcome back!"}
        </h1>
        <p className="mt-0.5 text-[14px] text-[#A8A8A8]">
          {fmtToday()}{primary && hasStats ? " · Let's ride" : ""}
        </p>
      </div>

      {profilesLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-white" aria-label="Loading" /></div>
      ) : !hasProfile ? (
        profilesError ? (
          <ErrorBanner onRetry={() => window.location.reload()} />
        ) : (
          <div className="space-y-4">
            <EmptyCard
              icon={UserPlus}
              title="No rider profile linked"
              message="Add a rider profile to see your next race, results and trends here. Profiles also link when you register for a race with this email."
              action={{ label: "Add a rider", href: "/rider/new-profile" }}
            />
            <RockyRow />
          </div>
        )
      ) : (
        <div className="flex flex-col gap-5">
          {loadFailed && !loading && <ErrorBanner onRetry={retry} />}

          {/* ── Next race: photo hero with a countdown ── */}
          {loading && upcoming.length === 0 && allHistory.length === 0 ? (
            <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-white" aria-label="Loading your races" /></div>
          ) : (
            <NextRaceHero
              race={next ? { ...next, classes: classesOf(next) } : null}
              todayYmd={todayYmd}
              href={upcomingHref}
              findHref={findHref}
            />
          )}

          <div className="grid items-start gap-5 md:grid-cols-2">
            {/* Left: recent form and one trend */}
            <div className="flex flex-col gap-3">
              {allHistory.length > 0 && (
                <>
                  <FormStrip history={allHistory} hrefFor={raceHref} />
                  <FormTrendCard history={allHistory} />
                </>
              )}
              {!loading && !loadFailed && allHistory.length === 0 && (
                <EmptyCard
                  icon={Award}
                  title="No results yet"
                  message="Finishes, points and laps land here after your first race."
                  action={{ label: "Find a race", href: findHref }}
                />
              )}
            </div>

            {/* Right: last race, other booked races, Rocky */}
            <div className="flex flex-col gap-5">
              {last && (
                <section>
                  <SectionHeader icon={Award} title="Last race" />
                  <ResultCard
                    position={last.bestPosition}
                    kicker={last.riderName}
                    title={last.eventName}
                    dateIso={last.eventDate}
                    raceClass={last.raceClass}
                    points={last.totalPoints}
                    motos={last.motos}
                    official={last.motos.some(m => m.official != null) ? last.motos.every(m => m.official) : undefined}
                    href={raceHref(last)}
                  />
                </section>
              )}
              {laterRaces.length > 0 && (
                <section>
                  <SectionHeader icon={Calendar} title="Also coming up" />
                  <div className="flex flex-col gap-2.5">
                    {laterRaces.map(e => (
                      <EventCard
                        key={e.eventId}
                        title={e.eventName}
                        dateIso={e.eventDate}
                        place={placeLabel(e.eventLocation, e.eventState) || null}
                        classes={classesOf(e).slice(0, 2)}
                        status={e.status === "race_day" ? "live" : e.status === "registration_open" ? "open" : null}
                        registered
                        href={upcomingHref}
                      />
                    ))}
                  </div>
                </section>
              )}
              <RockyRow />
            </div>
          </div>

          {/* ── Riders you follow ── */}
          <FollowingFeed />
        </div>
      )}
    </RiderLayout>
  );
}

function ErrorBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-2.5 rounded-xl border border-[#3A3A3A] bg-[#242424] p-3">
      <WifiOff size={16} className="shrink-0 text-[#A8A8A8]" />
      <p className="flex-1 text-[14px] leading-snug text-white">Couldn't load your races. Check your connection, then try again.</p>
      <button type="button" onClick={onRetry} className="shrink-0 rounded-full border border-[#3A3A3A] bg-[#2E2E2E] px-3.5 py-1.5 font-heading font-bold uppercase tracking-[0.8px] text-[13px] text-white hover:bg-[#3A3A3A]">
        Retry
      </button>
    </div>
  );
}
