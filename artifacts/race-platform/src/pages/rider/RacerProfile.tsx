/**
 * Racer profile on the rider website (matches the app's racer page): a résumé
 * the system builds from published results, the number plate, and Follow.
 * Bio and home state only show on public profiles; riders under 18 start private.
 */
import { Link, useRoute } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bike, Check, ChevronRight, Lock, Share2, Trophy } from "lucide-react";
import { useEffect, useState } from "react";
import { fmtLapShort } from "@workspace/rider-insights/raceReport";

import { RiderLayout } from "@/components/layout/RiderLayout";
import { CHART, ChartCard, PhotoHero, PosBadge, TrendChart } from "@/components/rider/insights";
import { RiderAvatar } from "@/components/rider/RacerPhotos";
import { NumberPlate } from "@/components/rider/ProfileSettings";
import { riderApi, type FeedItem, type HistoryFilter, type RacerProfile as Racer } from "@/lib/rider-api";
import { Button } from "@/components/ui/button";

/** Secondary button on the dark theme (the shared outline variant has no dark border colour). */
const OUTLINE_BTN = "border-[#3A3A3A] bg-[#242424] text-white hover:bg-[#2E2E2E]";

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

export default function RacerProfile() {
  const [, params] = useRoute("/rider/racer/:riderId");
  const riderId = parseInt(params?.riderId ?? "0", 10);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["racer", riderId], queryFn: () => riderApi.racer(riderId), enabled: !!riderId });

  const toggle = useMutation({
    mutationFn: (follow: boolean) => (follow ? riderApi.follow(riderId) : riderApi.unfollow(riderId)),
    onMutate: (follow: boolean) => {
      qc.setQueryData(["racer", riderId], (d: Racer | undefined) => d && ({ ...d, following: follow, followerCount: Math.max(0, d.followerCount + (follow ? 1 : -1)) }));
    },
    onError: () => qc.invalidateQueries({ queryKey: ["racer", riderId] }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["rider-follows"] }),
  });

  return (
    <RiderLayout showBack
      backTo={data?.isManager ? `/rider/portal/${riderId}` : "/rider/following"}
      backLabel={data?.isManager ? "Rider page" : "Following"}
      eyebrow="Racer profile" title={data?.name}>
      {isLoading ? (
        <div className="h-64 animate-pulse rounded-2xl bg-muted" />
      ) : error || !data ? (
        <div className="rounded-xl border border-[#3A3A3A] bg-[#242424] p-12 text-center">
          <AlertTriangle size={36} className="mx-auto mb-3 text-[#A8A8A8]" />
          <p className="text-[#A8A8A8]">{error ? (error as Error).message : "This rider has no results yet."}</p>
        </div>
      ) : (
        <RacerBody data={data} riderId={riderId} onToggle={() => toggle.mutate(!data.following)} pending={toggle.isPending} />
      )}
    </RiderLayout>
  );
}

const H3 = "font-heading font-bold uppercase tracking-[1.4px] text-[14px] text-[#A8A8A8]";
const CARD = "rounded-xl border border-[#3A3A3A] bg-[#242424]";
const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Share the public profile link: the phone's share sheet, or copy the link. */
function ShareButton({ path, name }: { path: string; name: string }) {
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const url = `${window.location.origin}${path}`;
    try {
      if (navigator.share) { await navigator.share({ title: `${name} on RM Roost`, url }); return; }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { /* closed the share sheet, or the browser blocked the clipboard */ }
  };
  return (
    <Button variant="ghost" className={OUTLINE_BTN} onClick={share} aria-label="Share this profile">
      {copied ? <><Check size={16} className="mr-2" />Link copied</> : <><Share2 size={16} className="mr-2" />Share</>}
    </Button>
  );
}

function ResultRows({ items }: { items: FeedItem[] }) {
  return (
    <div className={`divide-y divide-[#3A3A3A] ${CARD}`}>
      {items.map(r => (
        <Link key={`${r.eventId}-${r.raceClass}`} href={`/results/${r.eventId}`} className="flex items-center gap-3 px-4 py-3 hover:bg-[#2E2E2E]">
          <PosBadge position={r.bestPosition} size="sm" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] text-white">{r.eventName}</span>
            <span className="block truncate text-[12px] text-[#A8A8A8]">{[shortDate(r.eventDate), r.raceClass, r.track].filter(Boolean).join(" · ")}</span>
          </span>
          <ChevronRight size={16} className="text-[#A8A8A8]" />
        </Link>
      ))}
    </div>
  );
}

/** Every result, with Year / Class / Track filters. Opens from "Full history". */
function FullHistory({ riderId, publicPage }: { riderId: number; publicPage: boolean }) {
  const [filter, setFilter] = useState<HistoryFilter>({});
  const { data, isLoading, error } = useQuery({
    queryKey: ["racer-history", riderId, publicPage, filter],
    queryFn: () => riderApi.racerHistory(riderId, filter, publicPage),
    placeholderData: prev => prev,
  });
  const pick = (label: string, key: keyof HistoryFilter, options: string[]) => options.length < 2 ? null : (
    <label className="flex flex-col gap-1 text-[12px] text-[#A8A8A8]">
      {label}
      <select value={filter[key] ?? ""} onChange={e => setFilter(f => ({ ...f, [key]: e.target.value || null }))}
        className="h-10 rounded-lg border border-[#3A3A3A] bg-[#242424] px-3 text-[14px] text-white">
        <option value="">All</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
  if (error) return <p className="text-sm text-[#A8A8A8]">{(error as Error).message}</p>;
  if (isLoading || !data) return <div className="h-32 animate-pulse rounded-xl bg-[#242424]" />;
  const filtered = !!(filter.year || filter.raceClass || filter.track);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        {pick("Year", "year", data.filters.years)}
        {pick("Class", "raceClass", data.filters.classes)}
        {pick("Track", "track", data.filters.tracks)}
        {filtered && <Button variant="ghost" className={OUTLINE_BTN} onClick={() => setFilter({})}>Clear filters</Button>}
      </div>
      <p className="text-[13px] text-[#A8A8A8]" aria-live="polite">
        {filtered ? `${data.items.length} of ${data.total} results` : `${data.total} ${data.total === 1 ? "result" : "results"}`}
      </p>
      {data.items.length === 0
        ? <p className={`${CARD} p-6 text-center text-sm text-[#A8A8A8]`}>No results match those filters.</p>
        : <ResultRows items={data.items} />}
    </div>
  );
}

/**
 * The profile itself. `publicPage` is the no-sign-in share page: no Follow
 * button (it asks the visitor to sign in), and history reads the public copy.
 */
export function RacerBody({ data, riderId, onToggle, pending, publicPage = false }: { data: Racer; riderId: number; onToggle?: () => void; pending?: boolean; publicPage?: boolean }) {
  const [showHistory, setShowHistory] = useState(false);
  const [allTracks, setAllTracks] = useState(false);
  const extras = data.extras;
  const series = data.series ?? [];
  const sponsors = data.profile?.sponsors ?? [];
  const st = data.stats;
  const resume = data.resume;
  const profile = data.profile;
  const sub = [resume?.classes[0], profile?.state ? STATE_NAMES[profile.state] ?? profile.state : null, resume?.firstYear ? `since ${resume.firstYear}` : null].filter(Boolean).join("  ·  ");
  const seasons = (resume?.seasons ?? []).filter(x => x.avgFinish != null);
  const worst = seasons.length ? Math.max(...seasons.map(x => x.avgFinish!)) : 3;

  return (
    <div className="space-y-5">
      <PhotoHero src={profile?.coverUrl} className="min-h-[240px]">
        <div className="flex min-h-[240px] items-end gap-4 p-5 text-white">
          <RiderAvatar url={profile?.avatarUrl} name={data.name} size={80} className="border-[3px] border-white" />
          <div className="min-w-0">
            <div className="font-heading font-extrabold italic uppercase text-[34px] leading-none">{data.name}</div>
            {sub ? <div className="mt-1 text-[15px] text-white/85">{sub}</div> : null}
          </div>
        </div>
      </PhotoHero>

      <div className="flex flex-wrap items-center gap-4">
        {profile?.number ? <NumberPlate number={profile.number} color={profile.plateColor} /> : null}
        <span className="flex-1 text-[15px] text-[#A8A8A8]">{data.followerCount} {data.followerCount === 1 ? "follower" : "followers"}</span>
        {data.sharePath ? <ShareButton path={data.sharePath} name={data.name} /> : null}
        {publicPage ? (
          <Link href={`/rider/racer/${riderId}`}><Button>Follow</Button></Link>
        ) : data.isManager ? (
          <Link href={`/rider/portal/${riderId}?tab=profile`}><Button variant="ghost" className={OUTLINE_BTN}>Edit profile</Button></Link>
        ) : data.visibility === "private" ? (
          // Private profiles can't be followed; an older follow can still be removed.
          data.following ? (
            <Button onClick={onToggle} disabled={pending} variant="ghost" className={OUTLINE_BTN}>Unfollow</Button>
          ) : null
        ) : (
          <Button onClick={onToggle} disabled={pending} variant={data.following ? "ghost" : "default"} className={data.following ? OUTLINE_BTN : undefined} aria-pressed={data.following}>
            {data.following ? "Following" : "Follow"}
          </Button>
        )}
      </div>

      {publicPage ? null : <RiderLiveLink riderId={riderId} />}

      {!publicPage && !data.isManager && data.visibility === "private" && (
        <p className="flex items-center gap-2 rounded-lg bg-[#2E2E2E] px-4 py-3 text-[14px] text-[#A8A8A8]">
          <Lock size={15} /> This rider's profile is private. Ask their parent or guardian to make it public.
        </p>
      )}
      {data.isManager && data.visibility === "private" && (
        <p className="flex items-center gap-2 rounded-lg bg-[#2E2E2E] px-4 py-3 text-[14px] text-[#A8A8A8]">
          <Lock size={15} /> Private profile. Other riders see published results only, not the bio or home state.
        </p>
      )}
      {profile?.bio ? <p className="text-[16px] text-white">{profile.bio}</p> : null}

      {(profile?.bike || sponsors.length > 0) && (
        <div className={`space-y-3 p-4 ${CARD}`}>
          {profile?.bike ? (
            <div className="flex items-center gap-2 text-[15px] text-white"><Bike size={17} className="text-[#A8A8A8]" aria-hidden /><span className="sr-only">Bike: </span>{profile.bike}</div>
          ) : null}
          {sponsors.length > 0 && (
            <div>
              <div className="mb-2 font-heading font-bold uppercase tracking-[1px] text-[12px] text-[#A8A8A8]">Sponsors</div>
              <div className="flex flex-wrap gap-2">
                {sponsors.map(sp => <span key={sp} className="rounded-full border border-[#3A3A3A] bg-[#2E2E2E] px-3 py-1 text-[13px] text-white">{sp}</span>)}
              </div>
            </div>
          )}
        </div>
      )}

      {resume?.headline ? (
        <p className="flex items-start gap-2 rounded-xl border border-[#3A3A3A] bg-[#242424] p-4 text-[17px] font-medium text-white">
          <span aria-hidden className="mt-1 inline-block h-5 w-1 shrink-0 -skew-x-[18deg] bg-[#B30000]" />{resume.headline}
        </p>
      ) : null}

      <div className="grid grid-cols-3 gap-3">
        {[{ v: st.starts, l: st.starts === 1 ? "Moto" : "Motos" }, { v: st.wins, l: st.wins === 1 ? "Win" : "Wins" }, { v: st.podiums, l: st.podiums === 1 ? "Podium" : "Podiums" }].map(t => (
          <div key={t.l} className="rounded-xl border border-[#3A3A3A] bg-[#242424] py-3 text-center">
            <div className="font-heading font-extrabold italic text-3xl text-white">{t.v}</div>
            <div className="font-heading font-bold uppercase tracking-[1px] text-[12px] text-[#A8A8A8]">{t.l}</div>
          </div>
        ))}
      </div>

      {st.starts > 0 && (
        <div className="space-y-2">
          <h2 className={H3}>Career</h2>
          <dl className={`grid grid-cols-2 gap-x-4 gap-y-3 p-4 sm:grid-cols-3 ${CARD}`}>
            {[
              extras ? { l: "Events", v: String(extras.events) } : null,
              extras ? { l: "Top 10s", v: String(extras.top10s) } : null,
              { l: "Top 5s", v: String(st.top5s) },
              st.avgFinish != null ? { l: "Average finish", v: `P${st.avgFinish}` } : null,
              st.totalLaps > 0 ? { l: "Laps led", v: `${st.lapsLed}${st.pctLapsLed != null ? ` (${st.pctLapsLed}%)` : ""}` } : null,
              st.totalLaps > 0 && st.avgLap1Position != null ? { l: "Average lap 1 position", v: `P${st.avgLap1Position}` } : null,
            ].filter((x): x is { l: string; v: string } => !!x).map(x => (
              <div key={x.l}>
                <dt className="font-heading font-bold uppercase tracking-[1px] text-[12px] text-[#A8A8A8]">{x.l}</dt>
                <dd className="font-heading font-extrabold italic text-2xl text-white">{x.v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {(extras?.bigWins.length ?? 0) > 0 && (
        <div className="space-y-2">
          <h2 className={H3}>Big wins</h2>
          <div className={`divide-y divide-[#3A3A3A] ${CARD}`}>
            {extras!.bigWins.slice(0, 6).map(w => (
              <Link key={`${w.eventId}-${w.raceClass}-${w.motoName}`} href={`/results/${w.eventId}`} className="flex items-center gap-3 px-4 py-3 hover:bg-[#2E2E2E]">
                <Trophy size={18} style={{ color: "#F5B700" }} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] text-white">{w.eventName}</span>
                  <span className="block truncate text-[12px] text-[#A8A8A8]">{w.raceClass} · {w.motoName} · won against {w.fieldSize - 1} riders · {shortDate(w.eventDate)}</span>
                </span>
                <ChevronRight size={16} className="text-[#A8A8A8]" />
              </Link>
            ))}
          </div>
        </div>
      )}

      {series.length > 0 && (
        <div className="space-y-2">
          <h2 className={H3}>Series standings</h2>
          <div className={`divide-y divide-[#3A3A3A] ${CARD}`}>
            {series.map(sr => (
              <div key={`${sr.seriesId}-${sr.raceClass}`} className="flex items-center gap-3 px-4 py-3">
                <PosBadge position={sr.position} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] text-white">{sr.seriesName}</span>
                  <span className="block truncate text-[12px] text-[#A8A8A8]">{sr.raceClass} · {sr.position} of {sr.riders} · {sr.points} pts</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(resume?.highlights.bestFinish || st.bestLap || resume?.highlights.bestComeback) && (
        <div className="space-y-2">
          <h2 className={H3}>Highlights</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {resume?.highlights.bestFinish && (
              <div className="rounded-xl border border-[#3A3A3A] bg-[#242424] p-4">
                <PosBadge position={resume.highlights.bestFinish.position} />
                <div className="mt-2 font-heading font-bold uppercase tracking-[1px] text-[12px] text-[#A8A8A8]">Best finish</div>
                <div className="text-[14px] text-white">{resume.highlights.bestFinish.eventName}</div>
              </div>
            )}
            {st.bestLap && (
              <div className="rounded-xl border border-[#3A3A3A] bg-[#242424] p-4">
                <div className="font-heading font-extrabold italic text-2xl text-white">{fmtLapShort(st.bestLap.ms)}</div>
                <div className="mt-1 font-heading font-bold uppercase tracking-[1px] text-[12px] text-[#A8A8A8]">Fastest lap</div>
                <div className="text-[14px] text-white">{st.bestLap.eventName}</div>
              </div>
            )}
            {resume?.highlights.bestComeback && (
              <div className="rounded-xl border border-[#3A3A3A] bg-[#242424] p-4">
                <div className="font-heading font-extrabold italic text-2xl text-white">+{resume.highlights.bestComeback.gained}</div>
                <div className="mt-1 font-heading font-bold uppercase tracking-[1px] text-[12px] text-[#A8A8A8]">Best comeback</div>
                <div className="text-[14px] text-white">{resume.highlights.bestComeback.eventName}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {seasons.length >= 2 && (
        <ChartCard title="Average finish by season" takeaway={(() => {
          const f = Math.round(seasons[0].avgFinish!), l = Math.round(seasons[seasons.length - 1].avgFinish!);
          return f - l >= 1 ? `Up from P${f} to P${l} since ${seasons[0].year}.` : l - f >= 1 ? `P${f} in ${seasons[0].year}, P${l} in ${seasons[seasons.length - 1].year}.` : `About P${l} every season.`;
        })()}>
          <TrendChart data={seasons.map(x => ({ x: x.year, you: x.avgFinish }))} series={[{ key: "you", name: "Avg finish", color: CHART.you, dots: true }]}
            yMin={0.5} yMax={Math.max(worst + 0.5, 3.5)} invert band={[0.5, 3.5]} yFormat={v => `P${Math.round(v)}`}
            ariaLabel={`Average finish by season: ${seasons.map(x => `${x.year} P${Math.round(x.avgFinish!)}`).join(", ")}.`} />
        </ChartCard>
      )}

      {(resume?.badges.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-2">
          {resume!.badges.map(b => (
            <span key={b.key} className="inline-flex items-center gap-2 rounded-full border border-[#3A3A3A] bg-[#242424] px-3 py-1.5 text-[13px] text-white">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: CHART.best }} />{b.label}
            </span>
          ))}
        </div>
      )}

      {(resume?.classes.length ?? 0) > 0 && (
        <div className={`p-4 text-[14px] text-[#A8A8A8] ${CARD}`}><b className="text-white">Classes</b>  {resume!.classes.slice(0, 6).join(", ")}</div>
      )}

      {extras && (extras.tracks.length > 0 || extras.states.length > 0) ? (
        <div className="space-y-2">
          <h2 className={H3}>Where {data.name.split(" ")[0]} has raced</h2>
          <div className={`space-y-3 p-4 ${CARD}`}>
            {extras.states.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {extras.states.map(x => (
                  <span key={x.code} className="rounded-full border border-[#3A3A3A] bg-[#2E2E2E] px-3 py-1 text-[13px] text-white">
                    {STATE_NAMES[x.code] ?? x.code} <span className="text-[#A8A8A8]">· {x.events} {x.events === 1 ? "event" : "events"}</span>
                  </span>
                ))}
              </div>
            )}
            {extras.tracks.length > 0 && (
              <ul className="grid gap-x-6 gap-y-1 text-[14px] sm:grid-cols-2">
                {(allTracks ? extras.tracks : extras.tracks.slice(0, 6)).map(t => (
                  <li key={t.name} className="flex justify-between gap-3"><span className="truncate text-white">{t.name}</span><span className="shrink-0 text-[#A8A8A8]">{t.events} {t.events === 1 ? "event" : "events"}</span></li>
                ))}
              </ul>
            )}
            {extras.tracks.length > 6 && (
              <button type="button" onClick={() => setAllTracks(v => !v)} className="text-[13px] font-semibold text-white underline">
                {allTracks ? "Show fewer tracks" : `Show all ${extras.tracks.length} tracks`}
              </button>
            )}
          </div>
        </div>
      ) : (resume?.tracks.length ?? 0) > 0 ? (
        <div className={`p-4 text-[14px] text-[#A8A8A8] ${CARD}`}><b className="text-white">Tracks</b>  {resume!.tracks.slice(0, 4).join(", ")}</div>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className={H3}>{showHistory ? "Full history" : "Recent results"}</h2>
          {data.recent.length > 0 && (
            <button type="button" onClick={() => setShowHistory(v => !v)} className="text-[13px] font-semibold text-white underline" aria-expanded={showHistory}>
              {showHistory ? "Show recent only" : "Full history and filters"}
            </button>
          )}
        </div>
        {data.recent.length === 0 ? <p className="text-sm text-[#A8A8A8]">No published results yet.</p>
          : showHistory ? <FullHistory riderId={riderId} publicPage={publicPage} />
          : <ResultRows items={data.recent} />}
      </div>
    </div>
  );
}

/** "Live now" while this rider is streaming from their phone (and this account may watch); checked every 20 s. */
function RiderLiveLink({ riderId }: { riderId: number }) {
  const [live, setLive] = useState<{ live: boolean; canWatch: boolean; viewers: number } | null>(null);
  useEffect(() => {
    let stopped = false;
    const load = () => fetch(`/api/rider/live/${riderId}`, { credentials: "include" })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (!stopped && j) setLive(j); })
      .catch(() => {});
    load();
    const t = setInterval(load, 20_000);
    return () => { stopped = true; clearInterval(t); };
  }, [riderId]);
  if (!live?.live || !live.canWatch) return null;
  return (
    <a href={`/rider-live/${riderId}`} target="_blank" rel="noopener"
      className="flex items-center justify-center gap-2 rounded-full bg-[#B30000] px-5 py-3 font-heading text-[15px] font-extrabold uppercase text-white hover:bg-[#990000]">
      <span className="h-2 w-2 rounded-full bg-white" /> Live now · Watch{live.viewers > 0 ? ` (${live.viewers})` : ""}
    </a>
  );
}
