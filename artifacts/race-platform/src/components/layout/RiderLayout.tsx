import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { LogOut, ChevronLeft, Zap, Home, Trophy, Flag, Activity, UserCircle, Wrench } from "lucide-react";
import { useRiderAuth } from "@/contexts/RiderAuthContext";
import { riderApi } from "@/lib/rider-api";
import { useActiveRiders, nameColor, initials } from "@/lib/rider-active";
import { useQueryClient, useQuery } from "@tanstack/react-query";

// The rider pages share the rider app's look (rider-app/app/(tabs)/_layout.tsx and
// components/BrandBar.tsx): the dark race theme, the RM Roost banner with the
// rider avatars and RM Cash on the right, the five tabs (bottom bar on phones, a
// top bar on wider screens, with the red race stripe on the active tab) and the
// floating Rocky button.

// RM Cash uses the design system's RM Cash green. Only queries once signed in.
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
  if (!isAuthenticated) return null;
  const display = `$${(data?.balance ?? 0).toFixed(2)}`;
  return (
    <Link
      href="/rider/rm-cash"
      className="flex items-center gap-2 rounded-lg border border-[#3A3A3A] bg-[#242424] pl-2.5 pr-3 min-h-[44px] select-none hover:bg-[#2E2E2E] transition-colors"
    >
      <Zap size={15} className="text-[#22c55e] shrink-0" />
      <span className="flex flex-col leading-none">
        <span className="text-[10px] font-bold uppercase tracking-[1.2px] text-[#A8A8A8]">RM Cash</span>
        <span className="text-[15px] font-bold text-[#22c55e] mt-0.5">{display}</span>
      </span>
    </Link>
  );
}

function ProfileAvatars() {
  const { activeProfiles } = useActiveRiders();
  if (activeProfiles.length === 0) return null;
  const MAX = 3;
  const shown = activeProfiles.slice(0, MAX);
  const overflow = activeProfiles.length - MAX;
  return (
    <Link href="/rider/portal" aria-label="Your rider profiles" className="flex items-center">
      {shown.map((p, idx) => (
        <span
          key={p.id}
          className="w-7 h-7 rounded-full border-2 border-[#161616] flex items-center justify-center overflow-hidden text-[10px] font-bold text-white"
          style={{ backgroundColor: nameColor(`${p.firstName}${p.lastName}`), marginLeft: idx === 0 ? 0 : -8, zIndex: MAX - idx }}
        >
          {p.avatarUrl
            ? <img src={p.avatarUrl} alt={`Photo of ${p.firstName}`} className="w-full h-full object-cover" />
            : initials(p.firstName, p.lastName)}
        </span>
      ))}
      {overflow > 0 && (
        <span className="w-7 h-7 rounded-full border-2 border-[#161616] bg-[#A8A8A8] flex items-center justify-center text-[10px] font-bold text-white" style={{ marginLeft: -8 }}>
          +{overflow}
        </span>
      )}
    </Link>
  );
}

const TABS = [
  { href: "/rider/home", label: "Home", Icon: Home, match: ["/rider/home"] },
  { href: "/rider/races", label: "My Races", Icon: Trophy, match: ["/rider/races", "/rider/portal/"] },
  { href: "/rider/results", label: "Results", Icon: Flag, match: ["/rider/results"] },
  { href: "/rider/train", label: "Train", Icon: Activity, match: ["/rider/train"] },
  { href: "/rider/portal", label: "Profile", Icon: UserCircle, match: ["/rider/portal", "/rider/racer", "/rider/following", "/rider/new-profile", "/rider/rm-cash"] },
] as const;

function activeTab(path: string) {
  // "/rider/portal/:id" (a rider's races) belongs to My Races, "/rider/portal" to Profile.
  if (/^\/rider\/portal\/\d+/.test(path)) return "/rider/races";
  for (const t of TABS) if (t.match.some(m => path === m || path.startsWith(m.endsWith("/") ? m : m + "/") || path === m)) return t.href;
  return null;
}

/** Desktop: tabs in the top bar. */
function TopTabs({ current }: { current: string | null }) {
  return (
    <nav aria-label="Rider sections" className="hidden md:flex items-stretch gap-1">
      {TABS.map(({ href, label, Icon }) => {
        const on = current === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={on ? "page" : undefined}
            className={`relative flex items-center gap-2 px-3.5 min-h-[44px] rounded-lg font-heading font-bold uppercase tracking-[0.8px] text-[14px] transition-colors ${on ? "text-white bg-[#242424]" : "text-[#A8A8A8] hover:text-white hover:bg-[#1f1f1f]"}`}
          >
            <span className={`absolute top-0 left-1/2 -translate-x-1/2 h-[3px] w-[22px] rounded-full ${on ? "bg-[#B30000]" : "bg-transparent"}`} />
            <Icon size={17} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Phones: the app's bottom tab bar. */
function BottomTabs({ current }: { current: string | null }) {
  return (
    <nav aria-label="Rider sections" className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-[#161616] border-t border-[#3A3A3A] pb-[env(safe-area-inset-bottom)]">
      <div className="grid grid-cols-5">
        {TABS.map(({ href, label, Icon }) => {
          const on = current === href;
          return (
            <Link
              key={href}
              href={href}
              aria-current={on ? "page" : undefined}
              className={`relative flex flex-col items-center justify-center gap-1 pt-3 pb-2 min-h-[64px] font-heading font-bold uppercase tracking-[0.8px] text-[11px] ${on ? "text-white" : "text-[#A8A8A8]"}`}
            >
              <span className={`absolute top-0 h-[3px] w-[22px] rounded-full ${on ? "bg-[#B30000]" : "bg-transparent"}`} />
              <Icon size={22} />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/** Rocky, minimized: the app's floating red button. */
function RockyButton() {
  return (
    <Link
      href="/rider/mechanic"
      aria-label="Ask Rocky, your AI mechanic and riding coach"
      className="fixed z-40 right-4 bottom-[84px] md:bottom-6 w-[60px] h-[60px] rounded-full bg-[#B30000] text-white flex items-center justify-center shadow-[0_0_0_6px_rgba(179,0,0,0.25),0_8px_24px_rgba(0,0,0,0.5)] hover:bg-[#990000] transition-colors"
    >
      <Wrench size={26} />
      <span className="absolute top-1 right-1 w-3 h-3 rounded-full bg-[#22c55e] border-2 border-[#161616]" />
    </Link>
  );
}

interface RiderLayoutProps {
  children: ReactNode;
  showBack?: boolean;
  backTo?: string;
  backLabel?: string;
  /** Page title, in the app's big uppercase heading. Omit to skip it (e.g. while loading). */
  title?: ReactNode;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  /** Right side of the title row (actions, stats). */
  titleAside?: ReactNode;
  /** Hide the floating Rocky button (screens with their own button there). */
  hideRocky?: boolean;
  /** Content runs edge to edge under the title (the page lays out its own width). */
  wide?: boolean;
}

export function RiderLayout({
  children,
  showBack,
  backTo = "/rider/portal",
  backLabel = "My Profiles",
  title,
  eyebrow,
  subtitle,
  titleAside,
  hideRocky,
  wide,
}: RiderLayoutProps) {
  const { isAuthenticated } = useRiderAuth();
  const queryClient = useQueryClient();
  const [location, navigate] = useLocation();
  const current = activeTab(location);

  const handleLogout = async () => {
    await riderApi.logout().catch(() => {});
    // Zero out the auth cache so RiderLogin sees isAuthenticated=false before any refetch.
    queryClient.setQueryData(["rider-auth-me"], null);
    queryClient.removeQueries({ queryKey: ["rider-auth-me"] });
    queryClient.removeQueries({ queryKey: ["rider-profiles"] });
    navigate("/rider/login");
  };

  return (
    <div className="rider-theme min-h-screen flex flex-col">
      <header className="sticky top-0 z-30 bg-[#161616]/95 backdrop-blur border-b border-[#2E2E2E]">
        <div className="mx-auto max-w-6xl px-4 h-[64px] flex items-center gap-4">
          <Link href="/rider/home" aria-label="RM Roost rider home" className="shrink-0">
            <img src="/brand/rm-roost-hero.png" alt="RM Roost" className="h-[42px] w-auto" />
          </Link>
          <div className="flex-1 flex justify-center">
            {isAuthenticated && <TopTabs current={current} />}
          </div>
          {isAuthenticated && (
            <div className="flex items-center gap-2.5">
              <ProfileAvatars />
              <RmCashWidget isAuthenticated={isAuthenticated} />
              <button
                type="button"
                onClick={handleLogout}
                aria-label="Sign out"
                title="Sign out"
                className="hidden md:flex items-center justify-center w-[44px] h-[44px] rounded-lg text-[#A8A8A8] hover:text-white hover:bg-[#242424]"
              >
                <LogOut size={18} />
              </button>
            </div>
          )}
        </div>
      </header>

      <main className={`flex-1 w-full pb-[110px] md:pb-16 ${wide ? "" : "mx-auto max-w-6xl px-4"}`}>
        {showBack && (
          <div className={wide ? "mx-auto max-w-6xl px-4" : ""}>
            <Link href={backTo} className="inline-flex items-center gap-1 mt-4 text-[15px] font-medium text-[#A8A8A8] hover:text-white min-h-[44px]">
              <ChevronLeft size={18} />
              {backLabel}
            </Link>
          </div>
        )}
        {title && (
          <div className={`${wide ? "mx-auto max-w-6xl px-4" : ""} pt-5 pb-4 flex flex-wrap items-end justify-between gap-4`}>
            <div className="min-w-0">
              {eyebrow && <div className="text-[12px] font-bold uppercase tracking-[1.5px] text-[#A8A8A8] mb-1">{eyebrow}</div>}
              <h1 className="font-heading font-extrabold uppercase text-[30px] md:text-[36px] leading-[1.05] tracking-[0.5px] text-white">{title}</h1>
              {subtitle && <div className="text-[15px] text-[#A8A8A8] mt-1.5">{subtitle}</div>}
            </div>
            {titleAside && <div className="flex items-center gap-2">{titleAside}</div>}
          </div>
        )}
        <div className="brand-form">{children}</div>
      </main>

      {isAuthenticated && <BottomTabs current={current} />}
      {isAuthenticated && !hideRocky && <RockyButton />}
    </div>
  );
}
