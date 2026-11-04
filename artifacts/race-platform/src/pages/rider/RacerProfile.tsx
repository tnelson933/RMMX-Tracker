/**
 * Racer profile on the rider website (matches the app's racer page): a résumé
 * the system builds from published results, the number plate, and Follow.
 * Bio and home state only show on public profiles; riders under 18 start private.
 */
import { Link, useRoute } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, Lock } from "lucide-react";
import { fmtLapShort } from "@workspace/rider-insights/raceReport";

import { RiderLayout } from "@/components/layout/RiderLayout";
import { CHART, ChartCard, PhotoHero, PosBadge, TrendChart } from "@/components/rider/insights";
import { NumberPlate } from "@/components/rider/ProfileSettings";
import { riderApi, type RacerProfile as Racer } from "@/lib/rider-api";
import { Button } from "@/components/ui/button";

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
        <div className="rounded-xl border border-[#E2E2E2] bg-white p-12 text-center">
          <AlertTriangle size={36} className="mx-auto mb-3 text-[#707070]" />
          <p className="text-[#707070]">{error ? (error as Error).message : "This rider has no results yet."}</p>
        </div>
      ) : (
        <RacerBody data={data} riderId={riderId} onToggle={() => toggle.mutate(!data.following)} pending={toggle.isPending} />
      )}
    </RiderLayout>
  );
}

function RacerBody({ data, riderId, onToggle, pending }: { data: Racer; riderId: number; onToggle: () => void; pending: boolean }) {
  const st = data.stats;
  const resume = data.resume;
  const profile = data.profile;
  const initials = data.name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  const sub = [resume?.classes[0], profile?.state ? STATE_NAMES[profile.state] ?? profile.state : null, resume?.firstYear ? `since ${resume.firstYear}` : null].filter(Boolean).join("  ·  ");
  const seasons = (resume?.seasons ?? []).filter(x => x.avgFinish != null);
  const worst = seasons.length ? Math.max(...seasons.map(x => x.avgFinish!)) : 3;

  return (
    <div className="space-y-5">
      <PhotoHero className="min-h-[240px]">
        <div className="flex min-h-[240px] items-end gap-4 p-5 text-white">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full border-[3px] border-white bg-[#3A3A3A] font-heading font-extrabold text-[28px]">{initials}</div>
          <div className="min-w-0">
            <div className="font-heading font-extrabold italic uppercase text-[34px] leading-none">{data.name}</div>
            {sub ? <div className="mt-1 text-[15px] text-white/85">{sub}</div> : null}
          </div>
        </div>
      </PhotoHero>

      <div className="flex flex-wrap items-center gap-4">
        {profile?.number ? <NumberPlate number={profile.number} color={profile.plateColor} /> : null}
        <span className="flex-1 text-[15px] text-[#707070]">{data.followerCount} {data.followerCount === 1 ? "follower" : "followers"}</span>
        {data.isManager ? (
          <Link href={`/rider/portal/${riderId}?tab=profile`}><Button variant="outline">Edit profile</Button></Link>
        ) : (
          <Button onClick={onToggle} disabled={pending} variant={data.following ? "outline" : "default"} aria-pressed={data.following}>
            {data.following ? "Following" : "Follow"}
          </Button>
        )}
      </div>

      {data.isManager && data.visibility === "private" && (
        <p className="flex items-center gap-2 rounded-lg bg-[#F2F2F2] px-4 py-3 text-[14px] text-[#555]">
          <Lock size={15} /> Private profile. Other riders see published results only, not the bio or home state.
        </p>
      )}
      {profile?.bio ? <p className="text-[16px] text-[#242424]">{profile.bio}</p> : null}

      {resume?.headline ? (
        <p className="flex items-start gap-2 rounded-xl border border-[#E2E2E2] bg-white p-4 text-[17px] font-medium text-[#242424]">
          <span aria-hidden className="mt-1 inline-block h-5 w-1 shrink-0 -skew-x-[18deg] bg-[#B30000]" />{resume.headline}
        </p>
      ) : null}

      <div className="grid grid-cols-3 gap-3">
        {[{ v: st.starts, l: st.starts === 1 ? "Moto" : "Motos" }, { v: st.wins, l: st.wins === 1 ? "Win" : "Wins" }, { v: st.podiums, l: st.podiums === 1 ? "Podium" : "Podiums" }].map(t => (
          <div key={t.l} className="rounded-xl border border-[#E2E2E2] bg-white py-3 text-center">
            <div className="font-heading font-extrabold italic text-3xl text-[#242424]">{t.v}</div>
            <div className="font-heading font-bold uppercase tracking-[1px] text-[12px] text-[#707070]">{t.l}</div>
          </div>
        ))}
      </div>

      {(resume?.highlights.bestFinish || st.bestLap || resume?.highlights.bestComeback) && (
        <div className="space-y-2">
          <h3 className="font-heading font-bold uppercase tracking-[1.4px] text-[14px] text-[#707070]">Highlights</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            {resume?.highlights.bestFinish && (
              <div className="rounded-xl border border-[#E2E2E2] bg-white p-4">
                <PosBadge position={resume.highlights.bestFinish.position} />
                <div className="mt-2 font-heading font-bold uppercase tracking-[1px] text-[12px] text-[#707070]">Best finish</div>
                <div className="text-[14px] text-[#242424]">{resume.highlights.bestFinish.eventName}</div>
              </div>
            )}
            {st.bestLap && (
              <div className="rounded-xl border border-[#E2E2E2] bg-white p-4">
                <div className="font-heading font-extrabold italic text-2xl text-[#242424]">{fmtLapShort(st.bestLap.ms)}</div>
                <div className="mt-1 font-heading font-bold uppercase tracking-[1px] text-[12px] text-[#707070]">Fastest lap</div>
                <div className="text-[14px] text-[#242424]">{st.bestLap.eventName}</div>
              </div>
            )}
            {resume?.highlights.bestComeback && (
              <div className="rounded-xl border border-[#E2E2E2] bg-white p-4">
                <div className="font-heading font-extrabold italic text-2xl text-[#242424]">+{resume.highlights.bestComeback.gained}</div>
                <div className="mt-1 font-heading font-bold uppercase tracking-[1px] text-[12px] text-[#707070]">Best comeback</div>
                <div className="text-[14px] text-[#242424]">{resume.highlights.bestComeback.eventName}</div>
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
            <span key={b.key} className="inline-flex items-center gap-2 rounded-full border border-[#E2E2E2] bg-white px-3 py-1.5 text-[13px] text-[#242424]">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: CHART.best }} />{b.label}
            </span>
          ))}
        </div>
      )}

      {((resume?.classes.length ?? 0) > 0 || (resume?.tracks.length ?? 0) > 0) && (
        <div className="space-y-1 rounded-xl border border-[#E2E2E2] bg-white p-4 text-[14px] text-[#555]">
          {(resume?.classes.length ?? 0) > 0 && <div><b className="text-[#242424]">Classes</b>  {resume!.classes.slice(0, 4).join(", ")}</div>}
          {(resume?.tracks.length ?? 0) > 0 && <div><b className="text-[#242424]">Tracks</b>  {resume!.tracks.slice(0, 4).join(", ")}</div>}
        </div>
      )}

      <div className="space-y-2">
        <h3 className="font-heading font-bold uppercase tracking-[1.4px] text-[14px] text-[#707070]">Recent results</h3>
        {data.recent.length === 0 ? <p className="text-sm text-[#707070]">No published results yet.</p> : (
          <div className="divide-y divide-[#E2E2E2] rounded-xl border border-[#E2E2E2] bg-white">
            {data.recent.map(r => (
              <Link key={`${r.eventId}-${r.raceClass}`} href={`/results/${r.eventId}`} className="flex items-center gap-3 px-4 py-3 hover:bg-[#F7F7F7]">
                <PosBadge position={r.bestPosition} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] text-[#242424]">{r.eventName}</span>
                  <span className="text-[12px] text-[#707070]">{new Date(r.eventDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} · {r.raceClass}</span>
                </span>
                <ChevronRight size={16} className="text-[#707070]" />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
