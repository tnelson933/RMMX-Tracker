import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Award, Calendar, ChevronDown, ChevronLeft, ChevronRight, Flag, Loader2, Radio, Search, XCircle } from "lucide-react";
import { defaultSide, nextScheduled, splitLivePast } from "@workspace/rider-insights/liveRaces";
import { RiderLayout } from "@/components/layout/RiderLayout";
import { localDateString } from "@/lib/eventDates";
import { EmptyState, RaceEventCard, SectionLabel, type EventCardEvent } from "@/components/rider/web/RaceEventCard";
import { Segmented } from "@/components/rider/web/Segmented";

// Web version of the rider app's Results tab (rider-app/app/(tabs)/results.tsx):
// Race Events / Series, a search box, Live / Past, and series standings.
// Events open the website's results page, which shows live timing on race day.

interface BrowseEvent extends EventCardEvent {
  status: string;
}

interface PublicSeries {
  id: number;
  name: string;
  season: number | string | null;
  clubName: string | null;
  state: string | null;
  classes: string[] | null;
}

interface SeriesStandingRow {
  position: number;
  riderId: number;
  riderName: string;
  raceClass: string;
  totalScore: number;
  eventsEntered: number;
  amaNumber: string | null;
  bikeBrand: string | null;
}

type MainTab = "races" | "series";
type Side = "live" | "past";

function toEvent(r: Record<string, unknown>): BrowseEvent {
  return {
    eventId: Number(r.eventId ?? r.id),
    name: String(r.name ?? ""),
    state: (r.state as string | null) ?? null,
    date: String(r.date ?? ""),
    endDate: (r.endDate as string | null) ?? null,
    location: (r.location as string | null) ?? null,
    trackName: (r.trackName as string | null) ?? null,
    clubName: (r.clubName as string | null) ?? null,
    status: String(r.status ?? ""),
  };
}

async function getJson<T>(url: string, what: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load ${what}. Check your connection and try again.`);
  return res.json() as Promise<T>;
}

/** Keeps the typed value and a copy that settles 350 ms after typing stops. */
function useDebounced(value: string, ms = 350) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value.trim()), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return [settled, setSettled] as const;
}

function Spinner() {
  return (
    <div className="flex justify-center py-20" role="status" aria-label="Loading">
      <Loader2 size={24} className="animate-spin text-[#A8A8A8]" />
    </div>
  );
}

// ─── Series ──────────────────────────────────────────────────────────────────

function SeriesCard({ series, onOpen }: { series: PublicSeries; onOpen: () => void }) {
  const classes = series.classes ?? [];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left flex items-start gap-3 rounded-xl border border-[#3A3A3A] bg-[#242424] p-3.5 hover:bg-[#2A2A2A] transition-colors"
    >
      <span className="shrink-0 w-11 h-11 rounded-[10px] bg-[#B30000]/20 flex items-center justify-center">
        <Award size={18} className="text-white" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[16px] font-bold text-[#FAFAFA] line-clamp-2">{series.name}</span>
        {series.season != null && series.season !== "" && <span className="block text-[13px] text-[#A8A8A8] mt-0.5">{series.season}</span>}
        <span className="block text-[13px] text-[#A8A8A8]">{series.clubName}{series.state ? ` · ${series.state}` : ""}</span>
        {classes.length > 0 && (
          <span className="flex flex-wrap gap-1 mt-1.5">
            {classes.slice(0, 5).map(c => (
              <span key={c} className="rounded-md bg-[#2E2E2E] px-2 py-0.5 text-[11px] font-medium text-[#A8A8A8]">{c}</span>
            ))}
            {classes.length > 5 && <span className="rounded-md bg-[#2E2E2E] px-2 py-0.5 text-[11px] font-medium text-[#A8A8A8]">+{classes.length - 5} more</span>}
          </span>
        )}
      </span>
      <ChevronRight size={18} className="shrink-0 mt-0.5 text-[#A8A8A8]" />
    </button>
  );
}

const PODIUM = ["#f59e0b", "#94a3b8", "#b45309"];

function SeriesStandings({ series, onBack }: { series: PublicSeries; onBack: () => void }) {
  const { data: rows = [], isLoading, isError, refetch } = useQuery({
    queryKey: ["public-series-standings", series.id],
    queryFn: () => getJson<SeriesStandingRow[]>(`/api/public/series/${series.id}/standings`, "the standings"),
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const byClass = useMemo(() => {
    const map = new Map<string, SeriesStandingRow[]>();
    for (const row of rows) {
      if (!map.has(row.raceClass)) map.set(row.raceClass, []);
      map.get(row.raceClass)!.push(row);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);

  const toggle = (cls: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(cls)) next.delete(cls); else next.add(cls);
    return next;
  });

  return (
    <div className="max-w-3xl">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 min-h-[44px] text-[15px] font-medium text-[#A8A8A8] hover:text-white">
        <ChevronLeft size={18} /> All series
      </button>
      <div className="mb-4">
        <h2 className="font-heading font-extrabold uppercase text-[24px] leading-tight text-[#FAFAFA]">{series.name}</h2>
        <p className="text-[14px] text-[#A8A8A8] mt-1">{[series.season, series.clubName, series.state].filter(Boolean).join(" · ")}</p>
      </div>

      {isLoading ? <Spinner /> : isError ? (
        <EmptyState icon={Award} title="Couldn't load the standings" message="Check your connection and try again.">
          <button type="button" onClick={() => void refetch()} className="mt-2 rounded-full bg-[#B30000] px-6 min-h-[44px] font-bold text-white hover:bg-[#990000]">Try again</button>
        </EmptyState>
      ) : byClass.length === 0 ? (
        <EmptyState icon={Award} title="No standings yet" message="Points show up here once the series' first race results are published." />
      ) : (
        <div className="space-y-4">
          {byClass.map(([cls, classRows]) => {
            const open = expanded.has(cls);
            const shown = open ? classRows : classRows.slice(0, 10);
            return (
              <section key={cls} className="rounded-2xl border border-[#3A3A3A] bg-[#242424] overflow-hidden">
                <header className="flex items-center justify-between gap-2 px-4 py-3 bg-[#2E2E2E]/60 border-b border-[#3A3A3A]">
                  <h3 className="font-heading font-bold uppercase tracking-[0.8px] text-[15px] text-[#FAFAFA]">{cls}</h3>
                  <span className="text-[12px] text-[#A8A8A8]">{classRows.length} rider{classRows.length === 1 ? "" : "s"}</span>
                </header>
                <ol>
                  {shown.map((r, i) => (
                    <li key={`${r.riderId}-${i}`} className="border-b border-[#3A3A3A] last:border-b-0">
                      <Link href={`/rider/racer/${r.riderId}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[#2A2A2A]">
                        <span
                          className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-[13px] font-bold"
                          style={r.position <= 3 ? { backgroundColor: PODIUM[r.position - 1], color: "#161616" } : { backgroundColor: "#2E2E2E", color: "#A8A8A8" }}
                        >
                          {r.position}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block truncate text-[15px] font-semibold text-[#FAFAFA]">{r.riderName}</span>
                          <span className="block truncate text-[12px] text-[#A8A8A8]">
                            {[r.amaNumber ? `#${r.amaNumber}` : null, r.bikeBrand, `${r.eventsEntered} event${r.eventsEntered === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                        <span className="text-right">
                          <span className="block font-heading font-extrabold italic text-[20px] leading-none text-[#FAFAFA]">{r.totalScore}</span>
                          <span className="block text-[10px] font-bold tracking-[1px] text-[#A8A8A8]">PTS</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ol>
                {classRows.length > 10 && (
                  <button type="button" onClick={() => toggle(cls)} className="w-full flex items-center justify-center gap-1 min-h-[44px] text-[14px] font-semibold text-[#A8A8A8] hover:text-white border-t border-[#3A3A3A]">
                    {open ? "Show top 10" : `Show all ${classRows.length}`}
                    <ChevronDown size={15} className={open ? "rotate-180" : ""} />
                  </button>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function RiderResults() {
  const [tab, setTab] = useState<MainTab>("races");
  const [racesQuery, setRacesQuery] = useState("");
  const [seriesQuery, setSeriesQuery] = useState("");
  const [racesQ, setRacesQ] = useDebounced(racesQuery);
  const [seriesQ, setSeriesQ] = useDebounced(seriesQuery);
  const [pickedSide, setPickedSide] = useState<Side | null>(null);
  const [selectedSeries, setSelectedSeries] = useState<PublicSeries | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const eventsQuery = useQuery({
    queryKey: ["rider-results-browse", racesQ],
    queryFn: async () => (await getJson<Array<Record<string, unknown>>>(`/api/public/events/browse?q=${encodeURIComponent(racesQ)}`, "races")).map(toEvent),
    refetchInterval: 30_000,
    placeholderData: prev => prev,
  });
  const { data: upcoming = [] } = useQuery({
    queryKey: ["rider-results-upcoming"],
    queryFn: async () => (await getJson<Array<Record<string, unknown>>>("/api/public/upcoming", "upcoming races")).map(toEvent),
  });
  const seriesListQuery = useQuery({
    queryKey: ["rider-results-series"],
    queryFn: () => getJson<PublicSeries[]>("/api/public/series", "series"),
    enabled: tab === "series",
  });

  const today = localDateString();
  const { live, past } = splitLivePast(eventsQuery.data ?? [], today);
  const side: Side = pickedSide ?? defaultSide(live.length);
  const shown = side === "live" ? live : past;
  const comingUp = nextScheduled(upcoming, today, 4);

  const filteredSeries = useMemo(() => {
    const list = seriesListQuery.data ?? [];
    if (!seriesQ) return list;
    const q = seriesQ.toLowerCase();
    const has = (v: unknown) => String(v ?? "").toLowerCase().includes(q);
    return list.filter(s => has(s.name) || has(s.clubName) || has(s.state) || has(s.season));
  }, [seriesListQuery.data, seriesQ]);

  const query = tab === "races" ? racesQuery : seriesQuery;
  const clearSearch = () => {
    if (tab === "races") { setRacesQuery(""); setRacesQ(""); }
    else { setSeriesQuery(""); setSeriesQ(""); }
    searchRef.current?.focus();
  };

  if (selectedSeries) {
    return (
      <RiderLayout>
        <div className="pt-2">
          <SeriesStandings series={selectedSeries} onBack={() => setSelectedSeries(null)} />
        </div>
      </RiderLayout>
    );
  }

  return (
    <RiderLayout title="Race Results">
      <div className="max-w-3xl">
        <div className="space-y-3">
          <Segmented<MainTab>
            label="Results type"
            value={tab}
            onChange={setTab}
            options={[{ key: "races", label: "Race Events", icon: Flag }, { key: "series", label: "Series", icon: Award }]}
          />

          <label className="flex items-center gap-2 rounded-xl border border-[#3A3A3A] bg-[#2E2E2E] px-3 focus-within:border-[#A8A8A8]">
            <Search size={16} className="shrink-0 text-[#A8A8A8]" />
            <span className="sr-only">{tab === "races" ? "Search races" : "Search series"}</span>
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={e => (tab === "races" ? setRacesQuery(e.target.value) : setSeriesQuery(e.target.value))}
              placeholder={tab === "races" ? "Search by state, city, race or track name…" : "Search by series name, club, state…"}
              autoComplete="off"
              className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[#FAFAFA] placeholder:text-[#A8A8A8] [&::-webkit-search-cancel-button]:hidden"
            />
            {query.length > 0 && (
              <button type="button" onClick={clearSearch} aria-label="Clear search" className="shrink-0 w-9 h-9 flex items-center justify-center text-[#A8A8A8] hover:text-white">
                <XCircle size={16} />
              </button>
            )}
          </label>

          {tab === "races" && (
            <div role="tablist" aria-label="Live or past races" className="flex gap-2">
              {(["live", "past"] as const).map(k => {
                const active = side === k;
                return (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-label={k === "live" ? `Live, ${live.length} running` : `Past, ${past.length} events`}
                    onClick={() => setPickedSide(k)}
                    className={`flex-1 flex items-center justify-center gap-1.5 min-h-[40px] rounded-full border-[1.5px] font-heading font-bold uppercase tracking-[1px] text-[14px] transition-colors ${active ? "bg-[#FAFAFA] border-[#FAFAFA] text-[#161616]" : "border-[#3A3A3A] text-[#FAFAFA] hover:border-[#A8A8A8]"}`}
                  >
                    {k === "live" && <span className={`w-[7px] h-[7px] rounded-full ${live.length > 0 ? "bg-[#ef4444]" : "bg-[#A8A8A8]"}`} />}
                    {k === "live" ? "Live" : "Past"}
                    {k === "live" && live.length > 0 && (
                      <span className="min-w-[20px] h-[20px] px-1.5 rounded-full bg-[#B30000] text-white text-[11px] font-sans font-bold flex items-center justify-center">{live.length}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {tab === "races" && (
          eventsQuery.isLoading ? <Spinner /> : eventsQuery.isError && !eventsQuery.data ? (
            <EmptyState icon={Flag} title="Couldn't load races" message="Check your connection and try again.">
              <button type="button" onClick={() => void eventsQuery.refetch()} className="mt-2 rounded-full bg-[#B30000] px-6 min-h-[44px] font-bold text-white hover:bg-[#990000]">Try again</button>
            </EmptyState>
          ) : shown.length > 0 ? (
            <>
              <SectionLabel
                icon={side === "live" ? <span className="w-[7px] h-[7px] rounded-full bg-[#ef4444]" /> : <Flag size={13} className="text-[#A8A8A8]" />}
                count={`${shown.length} ${shown.length === 1 ? "event" : "events"}`}
              >
                {side === "live" ? "Live Now" : "Past Races"}
              </SectionLabel>
              <div className="space-y-2.5">
                {shown.map(e => <RaceEventCard key={e.eventId} event={e} live={side === "live"} href={`/results/${e.eventId}`} />)}
              </div>
            </>
          ) : side === "live" ? (
            <>
              <EmptyState
                icon={Radio}
                title={racesQ ? "No matching races live" : "No races live right now"}
                message={racesQ ? "Nothing running today matches your search." : "Races show up here on race day while they're running."}
              />
              {!racesQ && comingUp.length > 0 && (
                <>
                  <SectionLabel icon={<Calendar size={13} className="text-[#A8A8A8]" />}>Coming up</SectionLabel>
                  <div className="space-y-2.5">
                    {comingUp.map(e => <RaceEventCard key={e.eventId} event={e} href={`/register/${e.eventId}`} />)}
                  </div>
                </>
              )}
            </>
          ) : (
            <EmptyState
              icon={racesQ ? Search : Flag}
              title={racesQ ? "No matching past races" : "No past races yet"}
              message={racesQ ? "Try a state (UT), a city, a track or an event name." : "Finished races show up here."}
            />
          )
        )}

        {tab === "series" && (
          seriesListQuery.isLoading ? <Spinner /> : seriesListQuery.isError ? (
            <EmptyState icon={Award} title="Couldn't load series" message="Check your connection and try again.">
              <button type="button" onClick={() => void seriesListQuery.refetch()} className="mt-2 rounded-full bg-[#B30000] px-6 min-h-[44px] font-bold text-white hover:bg-[#990000]">Try again</button>
            </EmptyState>
          ) : filteredSeries.length === 0 ? (
            <EmptyState
              icon={Award}
              title={seriesQ ? "No matching series" : "No series yet"}
              message={seriesQ ? "Try a different search — series name, club name, or state." : "Championship series will appear here once clubs create them."}
            />
          ) : (
            <>
              <SectionLabel icon={<Award size={13} className="text-[#A8A8A8]" />} count={`${filteredSeries.length} series`}>Championship Series</SectionLabel>
              <div className="space-y-2.5">
                {filteredSeries.map(s => <SeriesCard key={s.id} series={s} onOpen={() => { setSelectedSeries(s); window.scrollTo(0, 0); }} />)}
              </div>
            </>
          )
        )}
      </div>
    </RiderLayout>
  );
}
