import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertTriangle } from "lucide-react";

/**
 * Clubs still on the older Stripe connection must move to their own Stripe
 * account (Payments → Switch account). Shown to the club organizer on every
 * page once RM Roost admins set a deadline; after it, card payments can't be
 * turned on for an event until the club switches.
 */
interface SwitchInfo { mustSwitch: boolean; deadline: string | null; overdue: boolean }

function dateWords(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function StripeSwitchBanner() {
  const { data } = useQuery({
    queryKey: ["registration-fee"],
    queryFn: async () => {
      const res = await fetch("/api/stripe/registration-fee", { credentials: "include" });
      return res.ok ? (res.json() as Promise<SwitchInfo & { cents: number | null }>) : null;
    },
    staleTime: 5 * 60_000,
  });
  if (!data?.mustSwitch || !data.deadline) return null;
  const when = dateWords(data.deadline);
  return (
    <div role="status" className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm border-b ${data.overdue ? "bg-red-500/10 border-red-500/30" : "bg-amber-500/10 border-amber-500/30"}`}>
      <AlertTriangle size={16} className={data.overdue ? "text-red-600" : "text-amber-600"} />
      <span className="flex-1 min-w-[14rem]">
        {data.overdue
          ? `Your club needed to switch to its own Stripe account by ${when}. Until you do, card payments can't be turned on for new events.`
          : `Switch your club to its own Stripe account by ${when}. It takes a few minutes, and your payouts then come straight from Stripe.`}
      </span>
      <Link href="/payments" className="font-semibold underline underline-offset-2">Open Payments</Link>
    </div>
  );
}
