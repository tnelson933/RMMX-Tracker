/**
 * Public racer profile: the page a shared profile link opens, no sign-in.
 * Only public profiles have one; private profiles (riders under 18 start
 * private) show a short "this profile is private" message instead.
 */
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { Link, useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";

import { RacerBody } from "@/pages/rider/RacerProfile";
import { riderApi } from "@/lib/rider-api";
import { Button } from "@/components/ui/button";

export default function PublicRacer() {
  const [, params] = useRoute("/racer/:riderId");
  const riderId = parseInt(params?.riderId ?? "0", 10);
  const { data, isLoading, error } = useQuery({
    queryKey: ["public-racer", riderId], queryFn: () => riderApi.publicRacer(riderId), enabled: riderId > 0, retry: false,
  });
  useDocumentTitle(data?.name ?? null);

  return (
    <div className="bg-[#161616]">
      <div className="container mx-auto max-w-3xl px-4 py-8">
        {isLoading ? (
          <div className="h-64 animate-pulse rounded-2xl bg-[#242424]" />
        ) : error || !data ? (
          <div className="rounded-xl border border-[#3A3A3A] bg-[#242424] p-10 text-center">
            <Lock size={32} className="mx-auto mb-3 text-[#A8A8A8]" aria-hidden />
            <h1 className="font-heading text-2xl font-extrabold uppercase italic text-white">Profile not available</h1>
            <p className="mx-auto mt-2 max-w-md text-[15px] text-[#A8A8A8]">
              {riderId > 0 && error ? (error as Error).message : "That link doesn't point to a rider."} Race results are still on the Results page.
            </p>
            <Link href="/results"><Button className="mt-5">See results</Button></Link>
          </div>
        ) : (
          <>
            <h1 className="sr-only">{data.name}: racer profile</h1>
            <RacerBody data={data} riderId={riderId} publicPage />
            <p className="mt-8 text-center text-[13px] text-[#A8A8A8]">
              Built from race results on RM Roost. <Link href="/rider/login" className="font-semibold text-white underline">Sign in</Link> to follow riders and get their results.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
