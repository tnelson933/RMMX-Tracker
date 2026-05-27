import { Link, useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useLogout } from "@workspace/api-client-react";
import { 
  LayoutDashboard, 
  CalendarDays, 
  Users, 
  Tag, 
  Trophy,
  Building2,
  LogOut,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export function OrganizerLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user } = useAuth();
  const logout = useLogout();

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        window.location.href = "/";
      }
    });
  };

  const isAdmin = user?.role === "super_admin";

  const navItems = [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/events", label: "Events", icon: CalendarDays },
    { href: "/riders", label: "Riders", icon: Users },
    { href: "/rfid", label: "RFID Management", icon: Tag },
    { href: "/series", label: "Series", icon: Trophy },
  ];

  return (
    <div className="min-h-[100dvh] flex bg-gray-50">
      <aside className="w-64 bg-sidebar text-sidebar-foreground flex flex-col border-r border-sidebar-border">
        <div className="h-16 flex items-center px-6 border-b border-sidebar-border/50">
          <span className="text-sidebar-primary font-heading font-bold text-2xl uppercase tracking-wider">
            RMMC Ops
          </span>
        </div>
        
        <div className="p-4 border-b border-sidebar-border/50">
          <div className="font-heading font-semibold text-lg">{user?.name}</div>
          <div className="text-xs text-sidebar-foreground/70 uppercase tracking-wider">
            {user?.role.replace('_', ' ')}
          </div>
        </div>

        <nav className="flex-1 py-4 flex flex-col gap-1 px-3">
          {navItems.map((item) => {
            const isActive = location.startsWith(item.href);
            const Icon = item.icon;
            
            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-md font-medium text-sm transition-colors ${
                  isActive 
                    ? "bg-sidebar-primary text-sidebar-primary-foreground" 
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                }`}
              >
                <Icon size={18} />
                {item.label}
              </Link>
            );
          })}

          {isAdmin && (
            <div className="mt-4 pt-4 border-t border-sidebar-border/40">
              <div className="flex items-center gap-2 px-3 mb-2">
                <ShieldCheck size={12} className="text-primary" />
                <span className="text-[10px] font-heading font-bold uppercase tracking-widest text-primary">
                  Admin
                </span>
              </div>
              <Link
                href="/admin/clubs"
                className={`flex items-center gap-3 px-3 py-2.5 rounded-md font-medium text-sm transition-colors ${
                  location.startsWith("/admin/clubs")
                    ? "bg-sidebar-primary text-sidebar-primary-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                }`}
              >
                <Building2 size={18} />
                Clubs
              </Link>
            </div>
          )}
        </nav>

        <div className="p-4 border-t border-sidebar-border/50">
          <Button 
            variant="ghost" 
            className="w-full justify-start gap-3 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground border-transparent bg-transparent"
            onClick={handleLogout}
            disabled={logout.isPending}
          >
            <LogOut size={18} />
            Logout
          </Button>
        </div>
      </aside>
      
      <main className="flex-1 flex flex-col h-[100dvh] overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
