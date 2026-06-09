import { Link, useLocation } from "wouter";
import { Mountain, LogOut, ChevronLeft, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRiderAuth } from "@/contexts/RiderAuthContext";
import { riderApi } from "@/lib/rider-api";
import { useQueryClient } from "@tanstack/react-query";

interface RiderLayoutProps {
  children: React.ReactNode;
  showBack?: boolean;
  backTo?: string;
  backLabel?: string;
}

export function RiderLayout({ children, showBack, backTo = "/rider/portal", backLabel = "My Profiles" }: RiderLayoutProps) {
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
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b bg-card sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {showBack ? (
              <Link href={backTo} className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground text-sm transition-colors">
                <ChevronLeft size={16} />
                {backLabel}
              </Link>
            ) : (
              <Link href="/" className="flex items-center gap-2">
                <Mountain size={20} className="text-primary" />
                <span className="flex flex-col leading-none">
                  <span className="font-heading font-bold uppercase tracking-wider text-sm">RMMX</span>
                  <span className="font-heading font-semibold uppercase tracking-widest text-[10px] text-muted-foreground">Tracker</span>
                </span>
              </Link>
            )}
          </div>

          <div className="flex items-center gap-3">
            {isAuthenticated && account && (
              <>
                <span className="text-sm text-muted-foreground hidden sm:block flex items-center gap-1.5">
                  <User size={13} className="inline" /> {account.email}
                </span>
                <Button size="sm" variant="ghost" onClick={handleLogout} className="text-muted-foreground hover:text-foreground gap-1.5">
                  <LogOut size={14} />
                  <span className="hidden sm:inline">Sign out</span>
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-4 py-4 sm:py-8">
        {children}
      </main>

      <footer className="border-t py-3 text-center text-xs text-muted-foreground">
        RMMX Tracker
      </footer>
    </div>
  );
}
