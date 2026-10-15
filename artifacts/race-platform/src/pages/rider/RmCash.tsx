import { Zap, Clock, ExternalLink } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { RiderLayout } from "@/components/layout/RiderLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

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
        <Card className="border-2 border-[#015F2D]">
          <CardContent className="py-8 text-center">
            <p className="flex items-center justify-center gap-1.5 text-[13px] font-bold uppercase tracking-[2px] text-[#707070] mb-2"><Zap size={14} className="text-[#015F2D] fill-[#015F2D]" /> Available Balance</p>
            <p className="text-5xl font-heading font-extrabold text-[#015F2D]">${balance.toFixed(2)}</p>
          </CardContent>
        </Card>

        <div>
          <div className="flex items-center gap-2 mb-3">
            <span aria-hidden className="w-[4px] h-5 bg-primary -skew-x-[18deg] shrink-0" />
            <h2 className="m-0 font-heading font-extrabold text-lg uppercase tracking-[0.5px] text-[#242424]">Transaction History</h2>
          </div>
          <Card>
            <CardContent className="py-10 text-center">
              <Clock size={32} className="text-muted-foreground mx-auto mb-3 opacity-40" />
              <p className="text-[15px] text-[#555]">Your RM Cash history will appear here once you've earned credits</p>
            </CardContent>
          </Card>
        </div>

        <Button
          asChild
          className="w-full mt-2 min-h-[52px] text-base bg-[#015F2D] border-[#015F2D] text-white hover:bg-[#017A3A]"
        >
          <a href="https://www.rockymountainatvmc.com" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2">
            Use your cash
            <ExternalLink size={16} />
          </a>
        </Button>
      </div>
    </RiderLayout>
  );
}
