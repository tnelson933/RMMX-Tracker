/**
 * "Who is this rider?" card for live timing: tap a name to see their number,
 * class, home state, bike, career numbers and series standing, with a link to
 * the full profile. Render <RiderLookupHost /> once on the page; any
 * <RiderLookupName /> opens it.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RiderAvatar } from "@/components/rider/RacerPhotos";
import { riderApi } from "@/lib/rider-api";

const EVENT = "rm-rider-lookup";

export function openRiderLookup(riderId: number, name: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { riderId, name } }));
}

/** A rider name that opens the card. Looks like the text around it. */
export function RiderLookupName({ riderId, name, className = "" }: { riderId: number; name: string; className?: string }) {
  if (!(riderId > 0)) return <>{name}</>;
  return (
    <button type="button" onClick={e => { e.stopPropagation(); openRiderLookup(riderId, name); }}
      className={`text-left underline decoration-white/25 underline-offset-4 hover:decoration-white ${className}`}
      aria-label={`${name}: rider details`}>
      {name}
    </button>
  );
}

export function RiderLookupHost() {
  const [target, setTarget] = useState<{ riderId: number; name: string } | null>(null);
  useEffect(() => {
    const open = (e: Event) => setTarget((e as CustomEvent).detail);
    window.addEventListener(EVENT, open);
    return () => window.removeEventListener(EVENT, open);
  }, []);
  const { data, isLoading, error } = useQuery({
    queryKey: ["rider-lookup", target?.riderId], queryFn: () => riderApi.riderCard(target!.riderId), enabled: !!target, retry: false, staleTime: 60_000,
  });
  const sub = data ? [data.mainClass, data.state, data.firstYear ? `since ${data.firstYear}` : null].filter(Boolean).join(" · ") : "";

  return (
    <Dialog open={!!target} onOpenChange={open => { if (!open) setTarget(null); }}>
      <DialogContent className="max-w-sm border-[#3A3A3A] bg-[#242424] text-white">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <RiderAvatar url={data?.avatarUrl} name={target?.name ?? ""} size={56} />
            <div className="min-w-0 text-left">
              <DialogTitle className="break-words pr-6 font-heading text-2xl font-extrabold uppercase italic leading-tight text-white">
                {data?.number ? <span className="mr-2 text-[#A8A8A8]">#{data.number}</span> : null}{data?.name ?? target?.name}
              </DialogTitle>
              <DialogDescription className="text-[14px] text-[#A8A8A8]">{sub || (isLoading ? "Loading…" : "Rider details")}</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        {error ? (
          <p className="text-[14px] text-[#A8A8A8]">No results on record for this rider yet.</p>
        ) : data ? (
          <div className="space-y-4">
            {data.bike ? <p className="text-[15px] text-white"><span className="text-[#A8A8A8]">Bike </span>{data.bike}</p> : null}
            <dl className="grid grid-cols-4 gap-2 text-center">
              {[
                { l: data.starts === 1 ? "Moto" : "Motos", v: data.starts },
                { l: data.wins === 1 ? "Win" : "Wins", v: data.wins },
                { l: data.podiums === 1 ? "Podium" : "Podiums", v: data.podiums },
                { l: "Avg finish", v: data.avgFinish != null ? `P${data.avgFinish}` : "—" },
              ].map(x => (
                <div key={x.l} className="rounded-lg border border-[#3A3A3A] bg-[#2E2E2E] py-2">
                  <dd className="font-heading text-xl font-extrabold italic text-white">{x.v}</dd>
                  <dt className="font-heading text-[11px] font-bold uppercase tracking-[1px] text-[#A8A8A8]">{x.l}</dt>
                </div>
              ))}
            </dl>
            {data.series.map(sr => (
              <p key={`${sr.seriesId}-${sr.raceClass}`} className="text-[14px] text-white">
                <span className="text-[#A8A8A8]">{sr.seriesName} · {sr.raceClass} </span>P{sr.position} of {sr.riders} · {sr.points} pts
              </p>
            ))}
            {data.sharePath ? (
              <Link href={data.sharePath} onClick={() => setTarget(null)}
                className="block rounded-full bg-[#B30000] px-5 py-3 text-center font-heading text-[15px] font-extrabold uppercase text-white hover:bg-[#990000]">
                View profile
              </Link>
            ) : null}
          </div>
        ) : (
          <div className="h-24 animate-pulse rounded-lg bg-[#2E2E2E]" />
        )}
      </DialogContent>
    </Dialog>
  );
}
