import { useState } from "react";
import { Link, Redirect } from "wouter";
import { Trophy, UserPlus, AlertTriangle } from "lucide-react";
import { RiderLayout } from "@/components/layout/RiderLayout";
import { useActiveRiders, nameColor, initials } from "@/lib/rider-active";
import type { RiderProfile } from "@/lib/rider-api";
import RiderHistory from "@/pages/rider/RiderHistory";

// The "My Races" tab (rider app: app/(tabs)/my-races.tsx). One active rider goes
// straight to their races; several get the app's rider switcher above the chosen
// rider's races; none get a prompt to add a rider profile.

function RiderSwitcher({ riders, selectedId, onSelect }: { riders: RiderProfile[]; selectedId: number; onSelect: (id: number) => void }) {
  return (
    <div role="tablist" aria-label="Choose a rider" className="flex gap-2 overflow-x-auto hide-scrollbar">
      {riders.map(r => {
        const on = r.id === selectedId;
        return (
          <button
            key={r.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onSelect(r.id)}
            className={`flex items-center gap-2 shrink-0 rounded-full border pl-1.5 pr-4 min-h-[44px] text-[14px] font-bold transition-colors ${
              on ? "bg-primary border-primary text-white" : "bg-card border-border text-muted-foreground hover:text-white hover:bg-muted"
            }`}
          >
            <span
              className="w-8 h-8 rounded-full overflow-hidden flex items-center justify-center text-[11px] font-bold text-white shrink-0"
              style={{ backgroundColor: nameColor(`${r.firstName}${r.lastName}`) }}
            >
              {r.avatarUrl
                ? <img src={r.avatarUrl} alt="" className="w-full h-full object-cover" />
                : initials(r.firstName, r.lastName)}
            </span>
            {r.firstName}
          </button>
        );
      })}
    </div>
  );
}

export default function RiderRaces() {
  const { activeProfiles, isLoading, error } = useActiveRiders();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  if (isLoading) {
    return (
      <RiderLayout title="My Races">
        <div className="space-y-4">
          <div className="h-11 w-64 bg-muted animate-pulse rounded-full" />
          <div className="h-40 bg-muted animate-pulse rounded-2xl" />
        </div>
      </RiderLayout>
    );
  }

  if (error) {
    return (
      <RiderLayout title="My Races">
        <div className="rounded-2xl border border-border bg-card p-10 text-center">
          <AlertTriangle size={36} className="mx-auto text-muted-foreground mb-3" />
          <h2 className="font-heading font-extrabold text-lg uppercase mb-1">Couldn't load your races</h2>
          <p className="text-sm text-muted-foreground">{(error as Error).message}</p>
        </div>
      </RiderLayout>
    );
  }

  if (activeProfiles.length === 0) {
    return (
      <RiderLayout title="My Races">
        <div className="rounded-2xl border border-border bg-card p-10 text-center">
          <Trophy size={40} className="mx-auto text-muted-foreground mb-3" />
          <h2 className="font-heading font-extrabold text-lg uppercase mb-1">Your story starts here</h2>
          <p className="text-sm text-muted-foreground mb-5">Add a rider profile to see races, results, points and lap times.</p>
          <Link
            href="/rider/new-profile"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 min-h-[44px] font-heading font-bold uppercase tracking-[0.8px] text-white hover:bg-[#990000] transition-colors"
          >
            <UserPlus size={16} /> Add a rider
          </Link>
        </div>
      </RiderLayout>
    );
  }

  if (activeProfiles.length === 1) {
    return <Redirect to={`/rider/portal/${activeProfiles[0].id}`} replace />;
  }

  const current = activeProfiles.find(p => p.id === selectedId) ?? activeProfiles[0];
  return (
    <RiderHistory
      key={current.id}
      riderId={current.id}
      riderSwitcher={<RiderSwitcher riders={activeProfiles} selectedId={current.id} onSelect={setSelectedId} />}
    />
  );
}
