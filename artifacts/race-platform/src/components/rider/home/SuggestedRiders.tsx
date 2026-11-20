/**
 * Rider home "Riders to follow" (rider-app/components/SuggestedRiders.tsx):
 * riders yours race against, riders from your state and recent winners, with
 * one-click Follow. Hidden when there's nobody to suggest.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";
import { UserPlus } from "lucide-react";

import { RiderAvatar } from "@/components/rider/RacerPhotos";
import { riderApi } from "@/lib/rider-api";
import { SectionHeader } from "./HomeCards";

export function SuggestedRiders() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["rider-suggested"], queryFn: () => riderApi.suggestedRiders(), staleTime: 60_000 });
  const [followed, setFollowed] = useState<Set<number>>(new Set());
  const follow = useMutation({
    mutationFn: (id: number) => riderApi.follow(id),
    onMutate: (id: number) => setFollowed(prev => new Set(prev).add(id)),
    onError: (_e, id) => setFollowed(prev => { const n = new Set(prev); n.delete(id); return n; }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rider-feed"] });
      qc.invalidateQueries({ queryKey: ["rider-follows"] });
    },
  });
  const riders = data ? [...data.competitors, ...data.nearby, ...data.top].slice(0, 12) : [];
  if (riders.length === 0) return null;

  return (
    <section>
      <SectionHeader
        icon={UserPlus}
        title="Riders to follow"
        right={<Link href="/rider/following" className="text-[13px] font-semibold text-white underline-offset-2 hover:underline">See all</Link>}
      />
      <div className="-mx-4 flex snap-x gap-2.5 overflow-x-auto px-4 pb-2 md:mx-0 md:px-0">
        {riders.map(r => {
          const isFollowing = followed.has(r.id);
          return (
            <div key={r.id} className="flex w-[160px] shrink-0 snap-start flex-col items-center gap-1.5 rounded-xl border border-[#3A3A3A] bg-[#242424] p-3 text-center">
              <Link href={`/rider/racer/${r.id}`} className="flex flex-col items-center gap-1.5 hover:underline">
                <RiderAvatar url={r.avatarUrl} name={r.name} size={56} />
                <span className="w-full truncate text-[14px] font-semibold text-white">{r.number ? `#${r.number} ` : ""}{r.name}</span>
              </Link>
              <span className="line-clamp-2 min-h-[32px] text-[12px] leading-4 text-[#A8A8A8]">{r.reason}</span>
              <button type="button" disabled={isFollowing} onClick={() => follow.mutate(r.id)} aria-pressed={isFollowing}
                className={`w-full rounded-full px-3 py-1.5 font-heading text-[13px] font-bold uppercase tracking-[1px] ${isFollowing ? "border border-[#3A3A3A] text-white" : "bg-[#B30000] text-white hover:bg-[#990000]"}`}>
                {isFollowing ? "Following" : "Follow"}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
