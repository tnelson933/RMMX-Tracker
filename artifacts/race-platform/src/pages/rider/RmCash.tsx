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
    <RiderLayout showBack backTo="/rider/portal" backLabel="My Profiles">
      <div className="max-w-md mx-auto flex flex-col gap-6">
        <div className="text-center pt-4">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-green-100 dark:bg-green-900/30 mb-4">
            <Zap size={28} className="text-green-600 fill-green-600" />
          </div>
          <h1 className="font-heading font-bold text-2xl uppercase tracking-wider">RM Cash</h1>
          <p className="text-muted-foreground text-sm mt-1">Your Rocky Mountain ATV/MC balance</p>
        </div>

        <Card className="border-green-200 dark:border-green-800">
          <CardContent className="pt-6 pb-6 text-center">
            <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground mb-1">Available Balance</p>
            <p className="text-5xl font-extrabold text-green-600 tracking-tight">${balance.toFixed(2)}</p>
          </CardContent>
        </Card>

        <div>
          <div className="flex items-center gap-2 mb-3">
            <Clock size={14} className="text-muted-foreground" />
            <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Transaction History</h2>
          </div>
          <Card>
            <CardContent className="py-10 text-center">
              <Clock size={32} className="text-muted-foreground mx-auto mb-3 opacity-40" />
              <p className="text-sm font-medium text-muted-foreground">Your RM Cash history will appear here once you've earned credits</p>
            </CardContent>
          </Card>
        </div>

        <Button
          asChild
          className="w-full mt-2 bg-green-600 hover:bg-green-700 text-white font-bold uppercase tracking-wider"
          size="lg"
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
