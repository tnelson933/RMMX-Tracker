import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";

export function PublicLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b border-border bg-card">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-primary font-heading font-bold text-2xl uppercase tracking-wider">
              RMMC
            </span>
          </Link>
          <nav className="flex items-center gap-6">
            <Link href="/" className="text-sm font-medium hover:text-primary transition-colors">Home</Link>
            <Link href="/results" className="text-sm font-medium hover:text-primary transition-colors">Results</Link>
            <Link href="/leaderboard" className="text-sm font-medium hover:text-primary transition-colors">Leaderboard</Link>
          </nav>
          <div>
            {isAuthenticated ? (
              <Link href="/dashboard">
                <Button variant="outline" className="font-heading uppercase">Dashboard</Button>
              </Link>
            ) : (
              <Link href="/login">
                <Button className="font-heading uppercase">Organizer Login</Button>
              </Link>
            )}
          </div>
        </div>
      </header>
      <main className="flex-1">
        {children}
      </main>
      <footer className="border-t border-border bg-card py-8">
        <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
          &copy; {new Date().getFullYear()} Rocky Mountain ATV/MC Race Platform
        </div>
      </footer>
    </div>
  );
}
