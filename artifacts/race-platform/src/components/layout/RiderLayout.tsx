import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { LogOut, ChevronLeft, User, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PublicLayout } from "@/components/layout/PublicLayout";
import { TitleBand } from "@/components/TitleBand";
import { useRiderAuth } from "@/contexts/RiderAuthContext";
import { riderApi } from "@/lib/rider-api";
import { useQueryClient, useQuery } from "@tanstack/react-query";

// RM Cash uses the design system's RM Cash green (#015F2D). Shown on the rider
// login page too; the balance query only runs once a rider is signed in.
export function RmCashWidget({ isAuthenticated }: { isAuthenticated: boolean }) {
  const { data } = useQuery<{ balance: number }>({
    queryKey: ["rm-cash-balance"],
    queryFn: () =>
      fetch("/api/rider/rm-cash-balance", { credentials: "include" })
        .then(r => r.ok ? r.json() : { balance: 0 })
        .catch(() => ({ balance: 0 })),
    enabled: isAuthenticated,
    staleTime: 60_000,
  });
  const display = `$${(data?.balance ?? 0).toFixed(2)}`;
  return (
    <Link
      href="/rider/rm-cash"
      className="flex items-center gap-2 rounded-full border-2 border-[#ECECEC] bg-white pl-3 pr-4 min-h-[44px] select-none hover:bg-[#F2F2F2] hover:border-[#333] transition-colors"
    >
      <Zap size={16} className="text-[#015F2D] fill-[#015F2D] shrink-0" />
      <span className="flex flex-col leading-none">
        <span className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#707070]">RM Cash</span>
        <span className="text-[15px] font-bold text-[#015F2D] mt-0.5">{display}</span>
      </span>
    </Link>
  );
}

interface RiderLayoutProps {
  children: ReactNode;
  showBack?: boolean;
  backTo?: string;
  backLabel?: string;
  /** Page title shown in the brand TitleBand. Omit to skip the band (e.g. while loading). */
  title?: ReactNode;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  /** Right side of the TitleBand (actions, stats). */
  titleAside?: ReactNode;
}

export function RiderLayout({
  children,
  showBack,
  backTo = "/rider/portal",
  backLabel = "My Profiles",
  title,
  eyebrow = "Rider portal",
  subtitle,
  titleAside,
}: RiderLayoutProps) {
  const { account, isAuthenticated } = useRiderAuth();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  const handleLogout = async () => {
    await riderApi.logout().catch(() => {});
    // Immediately zero out the auth cache so RiderLogin's useEffect
    // sees isAuthenticated=false before any refetch completes.
    queryClient.setQueryData(["rider-auth-me"], null);
    queryClient.removeQueries({ queryKey: ["rider-auth-me"] });
    queryClient.removeQueries({ queryKey: ["rider-profiles"] });
    navigate("/");
  };

  return (
    <PublicLayout>
      {/* Rider account bar */}
      <div className="bg-white border-b-2 border-[#ECECEC]">
        <div className="container mx-auto max-w-5xl px-4 py-2 min-h-[60px] flex items-center justify-between gap-3">
          {showBack ? (
            <Link href={backTo} className="flex items-center gap-1.5 text-[15px] font-medium text-[#333] hover:underline underline-offset-2 min-h-[44px]">
              <ChevronLeft size={18} />
              {backLabel}
            </Link>
          ) : (
            <span className="font-heading font-bold uppercase tracking-[2px] text-[15px] text-[#242424]">Rider Portal</span>
          )}

          <div className="flex items-center gap-2 sm:gap-3">
            <RmCashWidget isAuthenticated={isAuthenticated} />
            {isAuthenticated && account && (
              <>
                <span className="text-[15px] text-[#555] hidden md:flex items-center gap-1.5">
                  <User size={15} /> {account.email}
                </span>
                <Button
                  variant="outline"
                  onClick={handleLogout}
                  aria-label="Sign out"
                  className="min-h-[44px] border-2 border-[#8C8C8C] bg-white text-[#333] hover:bg-[#F2F2F2] hover:border-[#333] px-3 sm:px-4"
                >
                  <LogOut size={16} />
                  <span className="hidden sm:inline">Sign out</span>
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {title && (
        <TitleBand containerClassName="max-w-5xl" eyebrow={eyebrow} title={title} subtitle={subtitle}>
          {titleAside}
        </TitleBand>
      )}

      <div className="brand-form container mx-auto max-w-5xl w-full px-4 py-6 sm:py-10">
        {children}
      </div>
    </PublicLayout>
  );
}
