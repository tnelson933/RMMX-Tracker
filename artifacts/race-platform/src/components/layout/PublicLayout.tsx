import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useRiderAuth } from "@/contexts/RiderAuthContext";
import { Button } from "@/components/ui/button";
import { Menu, X, Timer, Flag, Trophy } from "lucide-react";
import rmLogo from "@assets/rm-logo.png";

const isDesktop = typeof (window as any).electronAPI !== "undefined";
const BASE = import.meta.env.BASE_URL;

const NAV = [
  { href: "/", label: "Home" },
  { href: "/results", label: "Results" },
  { href: "/leaderboard", label: "Leaderboard" },
];

// Header/footer follow the Rocky Mountain ATV/MC Design System (Header, Footer):
// charcoal #242424 utility bar with a red wedge, #F2F2F2 nav row, #2F2F2F footer
// columns under a #FAFAFA trust bar with a 3px red rule.
function Lockup({ onClick }: { onClick?: () => void }) {
  return (
    <Link href="/" className="flex items-center gap-3 shrink-0" onClick={onClick}>
      <img src={rmLogo} alt="" className="h-10 w-10" />
      <span className="flex flex-col leading-none">
        <span className="font-heading font-extrabold text-white text-2xl uppercase tracking-wide">RM Tracker</span>
        <span className="text-[13px] text-[#8C8C8C] mt-1">Race timing &amp; results</span>
      </span>
    </Link>
  );
}

export function PublicLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const { isAuthenticated: riderSignedIn } = useRiderAuth();
  const riderHref = riderSignedIn ? "/rider/portal" : "/rider/login";
  const riderLabel = riderSignedIn ? "Rider Portal" : "Rider Login";
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const close = () => setMobileOpen(false);
  const isActive = (href: string) => (href === "/" ? location === "/" : location.startsWith(href));

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="relative z-40">
        {/* Utility bar */}
        <div className="relative bg-[#242424] overflow-hidden">
          <div className="container mx-auto px-4 h-[72px] md:h-[84px] flex items-center justify-between">
            <Lockup onClick={close} />

            {/* Desktop auth: on the red wedge */}
            <div className="hidden md:flex relative h-full items-center gap-3 pl-14 pr-0">
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 -right-[50vw] bg-primary"
                style={{ clipPath: "polygon(32px 0, 100% 0, 100% 100%, 0 100%)" }}
              />
              {!isDesktop && (
                <Link href={riderHref} className="relative">
                  <Button variant="outline" className="border-2 border-white/80 text-white bg-transparent hover:bg-white/10">
                    {riderLabel}
                  </Button>
                </Link>
              )}
              <Link href={isAuthenticated ? "/dashboard" : "/login"} className="relative">
                <Button className="bg-white text-[#242424] border-white hover:bg-[#F2F2F2]">
                  {isAuthenticated ? "Dashboard" : "Organizer Login"}
                </Button>
              </Link>
            </div>

            {!isDesktop && (
              <button
                className="md:hidden p-2 text-white rounded-full hover:bg-white/10 transition-colors"
                onClick={() => setMobileOpen(o => !o)}
                aria-label="Toggle menu"
                aria-expanded={mobileOpen}
              >
                {mobileOpen ? <X size={24} /> : <Menu size={24} />}
              </button>
            )}
          </div>
        </div>

        {/* Nav row — hidden in the Electron desktop app (organizer-only) */}
        {!isDesktop && (
          <nav aria-label="Main" className="hidden md:block bg-[#F2F2F2] border-b-2 border-[#ECECEC]">
            <div className="container mx-auto px-4 h-14 flex items-center gap-8">
              {NAV.map(n => (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`h-full flex items-center font-heading font-bold text-[15px] uppercase tracking-[2px] border-b-[3px] transition-colors ${
                    isActive(n.href)
                      ? "border-primary text-[#242424]"
                      : "border-transparent text-[#555] hover:text-[#242424]"
                  }`}
                >
                  {n.label}
                </Link>
              ))}
            </div>
          </nav>
        )}

        {/* Mobile drawer */}
        {!isDesktop && mobileOpen && (
          <div className="md:hidden absolute top-full left-0 right-0 bg-[#F2F2F2] border-b-2 border-[#ECECEC] shadow-lg">
            <nav className="container mx-auto px-4 py-2 flex flex-col">
              {NAV.map(n => (
                <Link
                  key={n.href}
                  href={n.href}
                  onClick={close}
                  className={`py-4 font-heading font-bold text-base uppercase tracking-[2px] border-b-2 border-[#E0E0E0] ${
                    isActive(n.href) ? "text-primary" : "text-[#242424]"
                  }`}
                >
                  {n.label}
                </Link>
              ))}
              <div className="pt-4 pb-3 flex flex-col gap-3">
                <Link href={riderHref} onClick={close}>
                  <Button variant="outline" className="w-full border-2 border-[#8C8C8C] bg-white">{riderLabel}</Button>
                </Link>
                <Link href={isAuthenticated ? "/dashboard" : "/login"} onClick={close}>
                  <Button className="w-full">{isAuthenticated ? "Dashboard" : "Organizer Login"}</Button>
                </Link>
              </div>
            </nav>
          </div>
        )}
      </header>

      <main className="flex-1">
        {children}
      </main>

      <PublicFooter />
    </div>
  );
}

const TRUST = [
  { icon: Timer, text: "Live RFID & transponder timing" },
  { icon: Flag, text: "Official results, posted fast" },
  { icon: Trophy, text: "Series points, always current" },
];

const COLUMNS: Array<[string, Array<[string, string]>]> = [
  ["Race Info", [["Upcoming races", "/"], ["Results", "/results"], ["Series leaderboard", "/leaderboard"]]],
  ["Riders", [["Rider login", "/rider/login"], ["Rider app", "/rider-app"]]],
  ["Clubs", [["Organizer login", "/login"]]],
  ["Policies", [["Privacy policy", "/privacy"], ["Delete my account", "/delete-account"]]],
];

function PublicFooter() {
  return (
    <footer className="mt-auto">
      <div className="bg-[#FAFAFA] border-t-[3px] border-primary">
        <div className="container mx-auto px-4 py-5 flex flex-col md:flex-row md:items-center md:justify-center gap-4 md:gap-[clamp(24px,6vw,110px)]">
          {TRUST.map(({ icon: Icon, text }) => (
            <div key={text} className="flex items-center gap-3 text-[15px] text-[#333]">
              <Icon className="h-7 w-7 text-primary shrink-0" strokeWidth={2.2} />
              <span>{text}</span>
            </div>
          ))}
        </div>
      </div>

      {!isDesktop && (
        <div className="bg-[#2F2F2F]">
          <div className="container mx-auto px-4 py-10 md:py-12 grid grid-cols-2 md:grid-cols-5 gap-8">
            {COLUMNS.map(([heading, links]) => (
              <div key={heading}>
                <div className="font-heading font-bold text-white text-base uppercase tracking-[2px] mb-4">{heading}</div>
                <ul className="space-y-3">
                  {links.map(([label, href]) => (
                    <li key={href}>
                      <Link href={href} className="text-[15px] text-[#8C8C8C] hover:text-white hover:underline underline-offset-2">
                        {label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <div className="col-span-2 md:col-span-1 flex md:justify-end items-start">
              <div className="flex flex-col gap-2">
                <span className="text-[13px] text-[#8C8C8C] uppercase tracking-[2px]">Powered by</span>
                <img src={`${BASE}brand/rmatv-wordmark.svg`} alt="Rocky Mountain ATV/MC" className="h-12 w-auto" />
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white border-t-2 border-[#ECECEC]">
        <div className="container mx-auto px-4 py-5 text-center text-sm text-[#333]">
          &copy; {new Date().getFullYear()}&nbsp;&nbsp;|&nbsp;&nbsp;RM Tracker by Rocky Mountain ATV/MC. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
