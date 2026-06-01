import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useLogout } from "@workspace/api-client-react";
import { PastEventCheckDialog } from "@/components/organizer/PastEventCheckDialog";
import { useBroadcast } from "@/contexts/BroadcastContext";
import {
  LayoutDashboard,
  CalendarDays,
  Users,
  Tag,
  Trophy,
  Building2,
  UserCog,
  LogOut,
  ShieldCheck,
  Wifi,
  CreditCard,
  Menu,
  X,
  Mic,
  MicOff,
  Video,
  VideoOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import rmLogo from "@assets/rm-logo.png";

export function OrganizerLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user } = useAuth();
  const logout = useLogout();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { broadcastState, micEnabled, camEnabled, duration, activeEventId, toggleMic, toggleCam, stopBroadcast } = useBroadcast();
  const isLive = broadcastState === "live";

  const formatDuration = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        window.location.href = "/";
      },
    });
  };

  const isAdmin = user?.role === "super_admin";
  const clubId = user?.clubId;
  const close = () => setSidebarOpen(false);

  const navItems = [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, exact: false },
    { href: "/events", label: "Events", icon: CalendarDays, exact: false },
    { href: "/riders", label: "Riders", icon: Users, exact: false },
    { href: "/series", label: "Series", icon: Trophy, exact: false },
    { href: "/rfid", label: "RFID Tags", icon: Tag, exact: true },
    { href: "/rfid/setup", label: "Reader Setup", icon: Wifi, exact: false },
    { href: "/payments", label: "Payments", icon: CreditCard, exact: false },
  ];

  const SidebarContent = () => (
    <>
      <div className="h-16 flex items-center px-4 gap-3 border-b border-sidebar-border/50 shrink-0">
        <img src={rmLogo} alt="RMMX Tracker" className="h-9 w-9 shrink-0" />
        <span className="flex flex-col leading-none">
          <span className="text-sidebar-primary font-heading font-bold text-xl uppercase tracking-wider">RMMX</span>
          <span className="text-sidebar-primary/60 font-heading font-semibold text-xs uppercase tracking-widest">Tracker</span>
        </span>
        {/* Close button — mobile only */}
        <button
          className="ml-auto md:hidden p-1 rounded hover:bg-sidebar-accent text-sidebar-foreground/70"
          onClick={close}
          aria-label="Close menu"
        >
          <X size={20} />
        </button>
      </div>

      <div className="p-4 border-b border-sidebar-border/50 shrink-0">
        <div className="font-heading font-semibold text-lg">{user?.name}</div>
        <div className="text-xs text-sidebar-foreground/70 uppercase tracking-wider">
          {user?.role.replace("_", " ")}
        </div>
      </div>

      <nav className="flex-1 py-4 flex flex-col gap-1 px-3 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = item.exact ? location === item.href : location.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={close}
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
              href="/admin/users"
              onClick={close}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-md font-medium text-sm transition-colors ${
                location.startsWith("/admin/users")
                  ? "bg-sidebar-primary text-sidebar-primary-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              }`}
            >
              <UserCog size={18} />
              Users
            </Link>
            <Link
              href="/admin/clubs"
              onClick={close}
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

      <div className="p-4 border-t border-sidebar-border/50 shrink-0">
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
    </>
  );

  return (
    <div className="min-h-[100dvh] flex bg-gray-50">

      {/* Desktop sidebar — always visible */}
      <aside className="hidden md:flex w-64 bg-sidebar text-sidebar-foreground flex-col border-r border-sidebar-border shrink-0">
        <SidebarContent />
      </aside>

      {/* Mobile sidebar — slide-in drawer */}
      {sidebarOpen && (
        <>
          {/* Backdrop */}
          <div
            className="md:hidden fixed inset-0 z-40 bg-black/50"
            onClick={close}
          />
          {/* Drawer */}
          <aside className="md:hidden fixed inset-y-0 left-0 z-50 w-72 bg-sidebar text-sidebar-foreground flex flex-col border-r border-sidebar-border shadow-2xl">
            <SidebarContent />
          </aside>
        </>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 h-[100dvh] overflow-hidden">

        {/* Mobile top bar */}
        <div className="md:hidden flex items-center gap-3 px-4 h-14 bg-sidebar text-sidebar-foreground border-b border-sidebar-border shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1.5 rounded hover:bg-sidebar-accent transition-colors"
            aria-label="Open menu"
          >
            <Menu size={22} />
          </button>
          <img src={rmLogo} alt="RMMX Tracker" className="h-7 w-7" />
          <span className="flex flex-col leading-none">
            <span className="font-heading font-bold text-base uppercase tracking-wider text-sidebar-primary">RMMX</span>
            <span className="font-heading font-semibold text-[10px] uppercase tracking-widest text-sidebar-primary/60">Tracker</span>
          </span>
        </div>

        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>

      {clubId && <PastEventCheckDialog clubId={clubId} />}

      {/* Floating live broadcast bar — visible on every organizer page while streaming */}
      {isLive && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-gray-900/95 backdrop-blur border border-red-600/50 rounded-full px-4 py-2 shadow-2xl shadow-red-900/30">
          {/* Live indicator */}
          <span className="flex items-center gap-1.5 text-white text-xs font-bold font-heading uppercase tracking-wider">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
            </span>
            LIVE · {formatDuration(duration)}
          </span>

          <span className="w-px h-4 bg-white/20" />

          {/* Mic toggle */}
          <button
            onClick={toggleMic}
            title={micEnabled ? "Mute mic" : "Unmute mic"}
            className={`p-1.5 rounded-full transition-colors ${micEnabled ? "text-white hover:bg-white/10" : "text-red-400 hover:bg-red-400/10"}`}
          >
            {micEnabled ? <Mic size={14} /> : <MicOff size={14} />}
          </button>

          {/* Cam toggle */}
          <button
            onClick={toggleCam}
            title={camEnabled ? "Hide camera" : "Show camera"}
            className={`p-1.5 rounded-full transition-colors ${camEnabled ? "text-white hover:bg-white/10" : "text-red-400 hover:bg-red-400/10"}`}
          >
            {camEnabled ? <Video size={14} /> : <VideoOff size={14} />}
          </button>

          <span className="w-px h-4 bg-white/20" />

          {/* Back to broadcast link */}
          {activeEventId && (
            <Link
              href={`/events/${activeEventId}/broadcast`}
              className="text-xs text-white/70 hover:text-white transition-colors font-heading uppercase tracking-wider"
            >
              Back to stream
            </Link>
          )}

          {/* End stream */}
          <Button
            size="sm"
            variant="ghost"
            onClick={stopBroadcast}
            className="h-7 text-xs font-heading uppercase tracking-wider text-red-400 hover:bg-red-500/20 hover:text-red-300 px-3"
          >
            End Stream
          </Button>
        </div>
      )}
    </div>
  );
}
