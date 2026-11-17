import { Zap, Clock, Inbox, ExternalLink } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { RiderLayout } from "@/components/layout/RiderLayout";

// The rider app's RM Cash screen (rider-app/app/rm-cash.tsx): the balance in a
// card with the RM Cash green border, transaction history, and a red
// "Use your cash" button.
export default function RmCash() {
  const { data } = useQuery<{ balance: number; currency: string }>({
    queryKey: ["rm-cash-balance"],
    queryFn: () =>
      fetch("/api/rider/rm-cash-balance", { credentials: "include" })
        .then(r => r.ok ? r.json() : { balance: 0, currency: "USD" })
        .catch(() => ({ balance: 0, currency: "USD" })),
    staleTime: 60_000,
  });

  const balance = data?.balance ?? 0;

  return (
    <RiderLayout
      showBack
      backTo="/rider/portal"
      backLabel="My Profiles"
      title="RM Cash"
      subtitle="Your Rocky Mountain ATV/MC balance."
    >
      <div className="max-w-md mx-auto flex flex-col gap-6">
        <div className="rounded-2xl border border-[#22c55e] bg-[#242424] px-4 py-8 text-center">
          <span aria-hidden className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-[rgba(34,197,94,0.15)]">
            <Zap size={26} className="text-[#22c55e]" />
          </span>
          <p className="text-[12px] font-bold uppercase tracking-[1.5px] text-[#A8A8A8] mb-1">Available Balance</p>
          <p className="text-5xl font-heading font-extrabold text-[#22c55e]">${balance.toFixed(2)}</p>
        </div>

        <div>
          <div className="flex items-center gap-1.5 mb-2.5">
            <Clock size={14} className="text-[#A8A8A8]" />
            <h2 className="m-0 font-heading font-bold text-[14px] uppercase tracking-[1px] text-[#A8A8A8]">Transaction History</h2>
          </div>
          <div className="rounded-xl border border-[#3A3A3A] bg-[#242424] px-6 py-10 text-center">
            <Inbox size={32} className="text-[#A8A8A8] mx-auto mb-3 opacity-40" />
            <p className="text-[15px] text-[#A8A8A8]">Your RM Cash history will appear here once you've earned credits</p>
          </div>
        </div>

        <a
          href="https://www.rockymountainatvmc.com"
          target="_blank"
          rel="noopener noreferrer"
          className="w-full mt-2 min-h-[56px] rounded-full bg-[#B30000] text-white font-heading font-extrabold uppercase tracking-[1px] text-[17px] flex items-center justify-center gap-2 hover:bg-[#990000] transition-colors"
        >
          Use your cash
          <ExternalLink size={17} />
        </a>
      </div>
    </RiderLayout>
  );
}
