import { useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Menu, X } from "lucide-react";
import rmLogo from "@assets/rm-logo.png";

export function PublicLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const close = () => setMobileOpen(false);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b border-border bg-card relative z-40">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5" onClick={close}>
            <img src={rmLogo} alt="RMMX Tracker" className="h-9 w-9" />
            <span className="flex flex-col leading-none">
              <span className="text-primary font-heading font-bold text-xl uppercase tracking-wider">RMMX</span>
              <span className="text-primary/70 font-heading font-semibold text-xs uppercase tracking-widest">Tracker</span>
            </span>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-6">
            <Link href="/" className="text-sm font-medium hover:text-primary transition-colors">Home</Link>
            <Link href="/results" className="text-sm font-medium hover:text-primary transition-colors">Results</Link>
            <Link href="/leaderboard" className="text-sm font-medium hover:text-primary transition-colors">Leaderboard</Link>
          </nav>

          {/* Desktop auth buttons */}
          <div className="hidden md:flex items-center gap-2">
            <Link href="/rider/login">
              <Button variant="outline" className="font-heading uppercase text-sm">Rider Login</Button>
            </Link>
            {isAuthenticated ? (
              <Link href="/dashboard">
                <Button variant="outline" className="font-heading uppercase text-sm">Dashboard</Button>
              </Link>
            ) : (
              <Link href="/login">
                <Button className="font-heading uppercase text-sm">Organizer Login</Button>
              </Link>
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            className="md:hidden p-2 rounded-md hover:bg-muted transition-colors"
            onClick={() => setMobileOpen(o => !o)}
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>

        {/* Mobile drawer */}
        {mobileOpen && (
          <div className="md:hidden absolute top-full left-0 right-0 bg-card border-b border-border shadow-lg">
            <nav className="container mx-auto px-4 py-3 flex flex-col">
              <Link href="/" onClick={close} className="py-3 px-1 text-sm font-medium border-b border-border/50 hover:text-primary transition-colors">Home</Link>
              <Link href="/results" onClick={close} className="py-3 px-1 text-sm font-medium border-b border-border/50 hover:text-primary transition-colors">Results</Link>
              <Link href="/leaderboard" onClick={close} className="py-3 px-1 text-sm font-medium border-b border-border/50 hover:text-primary transition-colors">Leaderboard</Link>
              <div className="pt-4 pb-2 flex flex-col gap-2">
                <Link href="/rider/login" onClick={close}>
                  <Button variant="outline" className="w-full font-heading uppercase text-sm">Rider Login</Button>
                </Link>
                {isAuthenticated ? (
                  <Link href="/dashboard" onClick={close}>
                    <Button className="w-full font-heading uppercase text-sm">Dashboard</Button>
                  </Link>
                ) : (
                  <Link href="/login" onClick={close}>
                    <Button className="w-full font-heading uppercase text-sm">Organizer Login</Button>
                  </Link>
                )}
              </div>
            </nav>
          </div>
        )}
      </header>

      <main className="flex-1">
        {children}
      </main>

      <footer className="border-t border-border bg-card py-8">
        <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
          &copy; {new Date().getFullYear()} RMMX Tracker
        </div>
      </footer>
    </div>
  );
}
