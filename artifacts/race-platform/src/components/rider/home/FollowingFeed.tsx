/**
 * Home "Following" section (rider-app/components/FollowingFeed.tsx): results of
 * riders you follow, unofficial until the organizer finalizes them.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Users } from "lucide-react";

import { riderApi } from "@/lib/rider-api";
import { dedupeFeedItems } from "@/lib/feed";
import { EmptyCard, ResultCard, SectionHeader } from "./HomeCards";

export function FollowingFeed() {
  const { data } = useQuery({
    queryKey: ["rider-feed"],
    queryFn: () => riderApi.feed(),
    staleTime: 60_000,
  });
  // De-duplicate before dropping your own riders, so a followed copy of your own rider stays out too.
  const items = data ? dedupeFeedItems(data.items).filter(i => !i.isMine).slice(0, 8) : null;

  return (
    <section>
      <SectionHeader
        icon={Users}
        title="Following"
        right={<Link href="/rider/following" className="text-[13px] font-semibold text-white underline-offset-2 hover:underline">Find riders</Link>}
      />
      {items && items.length === 0 ? (
        <EmptyCard
          icon={Users}
          title="Ride with your crew"
          message="Follow friends and rivals to see their results here."
          action={{ label: "Follow", href: "/rider/following" }}
        />
      ) : (
        <div className="grid gap-2.5 md:grid-cols-2">
          {(items ?? []).map(i => (
            <ResultCard
              key={`${i.riderId}-${i.eventId}-${i.raceClass}`}
              position={i.bestPosition}
              kicker={i.riderName}
              kickerAvatarUrl={i.riderAvatarUrl}
              title={i.eventName}
              dateIso={i.eventDate}
              raceClass={i.raceClass}
              motos={i.motos}
              official={i.official}
              href={`/rider/racer/${i.riderId}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
