import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { ShieldOff, Flag, LayoutDashboard, CalendarDays, Users, Trophy, ListOrdered, CreditCard, Tag, Wifi, WifiOff, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";

const PAGE_ICONS: Record<string, React.ElementType> = {
  dashboard: LayoutDashboard,
  events: CalendarDays,
  practice: Timer,
  riders: Users,
  series: Trophy,
  points_tables: ListOrdered,
  payments: CreditCard,
  discount_codes: Tag,
  reader_setup: Wifi,
  offline_mode: WifiOff,
};

const PAGE_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  events: "Events",
  practice: "Practice",
  riders: "Riders",
  series: "Series",
  points_tables: "Points Scoring Tables",
  payments: "Payments",
  discount_codes: "Discount Codes",
  reader_setup: "Reader Setup",
  offline_mode: "Offline Mode",
};

const PAGE_HREFS: Record<string, string> = {
  dashboard: "/dashboard",
  events: "/events",
  practice: "/practice",
  riders: "/riders",
  series: "/series",
  points_tables: "/points-tables",
  payments: "/payments",
  discount_codes: "/discount-codes",
  reader_setup: "/rfid/setup",
  offline_mode: "/offline-mode",
};

export default function NoAccessPage() {
  const { user, permissions } = useAuth();

  const portalPerms = permissions.filter((p) => p !== "gate_schedule");
  const hasGate = permissions.includes("gate_schedule");

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="max-w-md w-full text-center">
        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
          <ShieldOff size={28} className="text-muted-foreground" />
        </div>

        <h1 className="font-heading font-bold text-2xl uppercase tracking-wider mb-2">Limited Access</h1>
        <p className="text-muted-foreground mb-6">
          Hi {user?.name?.split(" ")[0]}, your account has restricted portal access. Contact your club organizer to update your permissions.
        </p>

        {portalPerms.length > 0 && (
          <div className="bg-white rounded-xl border p-4 mb-4 text-left">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Your accessible pages</p>
            <div className="space-y-2">
              {portalPerms.map((p) => {
                const Icon = PAGE_ICONS[p] ?? LayoutDashboard;
                const label = PAGE_LABELS[p] ?? p;
                const href = PAGE_HREFS[p] ?? "/dashboard";
                return (
                  <Link key={p} href={href}>
                    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted transition-colors cursor-pointer">
                      <Icon size={16} className="text-primary" />
                      <span className="font-medium text-sm">{label}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {hasGate && (
          <Link href="/gate">
            <Button className="w-full mb-3" variant="outline">
              <Flag size={16} className="mr-2" />
              Open Gate Schedule
            </Button>
          </Link>
        )}

        {portalPerms.length === 0 && !hasGate && (
          <p className="text-sm text-muted-foreground italic mb-4">
            No pages have been assigned yet. Please contact your organizer.
          </p>
        )}
      </div>
    </div>
  );
}
