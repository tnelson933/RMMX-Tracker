/**
 * Following on the rider website (matches the app's Follow screen and Home
 * feed): find riders by name, the riders you follow, and their latest results.
 */
import { useEffect, useState } from "react";
import { RiderAvatar } from "@/components/rider/RacerPhotos";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Search } from "lucide-react";

import { RiderLayout } from "@/components/layout/RiderLayout";
import { PosBadge } from "@/components/rider/insights";
import { riderApi } from "@/lib/rider-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Latest results from riders you follow (and your own riders), for here and the portal home. */
export function FollowingFeed({ limit }: { limit?: number }) {
  const { data } = useQuery({ queryKey: ["rider-feed"], queryFn: () => riderApi.feed() });
  const items = (data?.items ?? []).filter(i => !i.isMine).slice(0, limit ?? 30);
  if (items.length === 0) {
    return <p className="rounded-xl border border-[#E2E2E2] bg-white p-6 text-center text-sm text-[#707070]">Follow friends and rivals to see their results here.</p>;
  }
  return (
    <div className="divide-y divide-[#E2E2E2] rounded-xl border border-[#E2E2E2] bg-white">
      {items.map(i => (
        <Link key={`${i.riderId}-${i.eventId}-${i.raceClass}`} href={`/rider/racer/${i.riderId}`} className="flex items-center gap-3 px-4 py-3 hover:bg-[#F7F7F7]">
          <PosBadge position={i.bestPosition} size="sm" />
          <RiderAvatar url={i.riderAvatarUrl} name={i.riderName} size={32} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-semibold text-[#242424]">{i.riderName}</span>
            <span className="block truncate text-[13px] text-[#707070]">{i.eventName} · {i.raceClass} · {shortDate(i.eventDate)}</span>
          </span>
          <ChevronRight size={16} className="text-[#707070]" />
        </Link>
      ))}
    </div>
  );
}

export default function RiderFollowing() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const { data: follows } = useQuery({ queryKey: ["rider-follows"], queryFn: () => riderApi.follows() });
  const { data: found, isFetching } = useQuery({ queryKey: ["rider-search", term], queryFn: () => riderApi.searchRiders(term), enabled: term.length >= 2 });

  const toggle = useMutation({
    mutationFn: ({ id, follow }: { id: number; follow: boolean }) => (follow ? riderApi.follow(id) : riderApi.unfollow(id)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["rider-follows"] });
      qc.invalidateQueries({ queryKey: ["rider-search"] });
      qc.invalidateQueries({ queryKey: ["rider-feed"] });
    },
  });

  return (
    <RiderLayout showBack eyebrow="Rider portal" title="Following">
      <div className="space-y-8">
        <section className="space-y-3">
          <label htmlFor="rider-search" className="font-heading font-bold uppercase tracking-[1.2px] text-[14px] text-[#707070]">Find riders</label>
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#707070]" />
            <Input id="rider-search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search by name" className="pl-9" />
          </div>
          {term.length >= 2 && (
            <div className="divide-y divide-[#E2E2E2] rounded-xl border border-[#E2E2E2] bg-white">
              {(found?.riders ?? []).length === 0 ? (
                <p className="p-4 text-sm text-[#707070]">{isFetching ? "Searching…" : "No riders with results match that name."}</p>
              ) : found!.riders.map(r => (
                <div key={r.id} className="flex items-center gap-3 px-4 py-3">
                  <RiderAvatar url={r.avatarUrl} name={r.name} size={36} />
                  <Link href={`/rider/racer/${r.id}`} className="min-w-0 flex-1 hover:underline">
                    <span className="block truncate text-[15px] font-semibold text-[#242424]">{r.name}</span>
                    <span className="block truncate text-[13px] text-[#707070]">{[r.clubName, r.lastRaced ? `last raced ${shortDate(r.lastRaced)}` : null].filter(Boolean).join(" · ")}</span>
                  </Link>
                  <Button size="sm" variant={r.following ? "outline" : "default"} disabled={toggle.isPending}
                    onClick={() => toggle.mutate({ id: r.id, follow: !r.following })} aria-pressed={r.following}>
                    {r.following ? "Following" : "Follow"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="font-heading font-bold uppercase tracking-[1.2px] text-[14px] text-[#707070]">Riders you follow</h2>
          {(follows?.following ?? []).length === 0 ? (
            <p className="text-sm text-[#707070]">You're not following anyone yet. Search above, or open a rider from results.</p>
          ) : (
            <div className="divide-y divide-[#E2E2E2] rounded-xl border border-[#E2E2E2] bg-white">
              {follows!.following.map(f => (
                <div key={f.riderId} className="flex items-center gap-3 px-4 py-3">
                  <RiderAvatar url={f.avatarUrl} name={f.name} size={36} />
                  <Link href={`/rider/racer/${f.riderId}`} className="flex-1 text-[15px] font-semibold text-[#242424] hover:underline">{f.name}</Link>
                  <Button size="sm" variant="outline" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: f.riderId, follow: false })}>Unfollow</Button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="font-heading font-bold uppercase tracking-[1.2px] text-[14px] text-[#707070]">Latest results</h2>
          <FollowingFeed />
        </section>
      </div>
    </RiderLayout>
  );
}
