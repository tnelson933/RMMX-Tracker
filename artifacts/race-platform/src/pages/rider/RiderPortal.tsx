import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { FollowingFeed } from "@/pages/rider/RiderFollowing";
import type { ReactNode } from "react";
import { User, ChevronRight, Plus, UserPlus, BarChart3, TrendingUp, Wrench } from "lucide-react";
import { cardSummary, nextMaintenance, recentFinishes } from "@workspace/rider-insights/profileCard";
import { NumberPlate } from "@/components/rider/ProfileSettings";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RiderLayout } from "@/components/layout/RiderLayout";
import { useRiderAuth } from "@/contexts/RiderAuthContext";
import { riderApi, type RiderProfile } from "@/lib/rider-api";

/** Finishing positions as a tiny line, P1 at the top (same as the app's rider card). */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <TrendingUp size={22} className="text-[#8C8C8C]" />;
  const w = 96, h = 30, pad = 3;
  const max = Math.max(...values), min = Math.min(...values), span = Math.max(1, max - min);
  const pts = values.map((v, i) => [pad + (i / (values.length - 1)) * (w - pad * 2), pad + ((v - min) / span) * (h - pad * 2)]);
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" className="max-w-[96px]" aria-hidden="true">
      <polyline points={pts.map(p => p.join(",")).join(" ")} fill="none" stroke="#242424" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={3} fill="#B30000" />
    </svg>
  );
}

const STATUS_DOT: Record<string, string> = { overdue: "#C62828", due_soon: "#D97706", ok: "#16A34A", unknown: "#8C8C8C" };

function Tile({ href, icon, title, children, label }: { href: string; icon: ReactNode; title: string; children: ReactNode; label: string }) {
  return (
    <Link href={href} aria-label={label}
      className="flex min-h-[116px] min-w-0 flex-col gap-2 rounded-xl border-2 border-[#ECECEC] bg-[#F7F7F7] p-2 sm:p-3 transition-colors hover:border-[#8C8C8C] hover:bg-white">
      <span className="flex items-start gap-1 font-heading font-bold uppercase tracking-0 text-[10px] leading-[12px] sm:tracking-[0.5px] sm:text-[13px] sm:leading-4 text-[#707070]">
        <span className="mt-px hidden sm:inline">{icon}</span> <span className="min-w-0">{title}</span>
      </span>
      <span className="flex flex-1 flex-col justify-between gap-2">{children}</span>
    </Link>
  );
}

function ProfileCard({ profile }: { profile: RiderProfile }) {
  const { data } = useQuery({ queryKey: ["rider-card", profile.id], queryFn: () => riderApi.card(profile.id) });
  const name = `${profile.firstName} ${profile.lastName}`.trim();
  const finishes = data ? recentFinishes(data.recent) : [];
  const next = data ? nextMaintenance(data.maintenance, Date.now()) : null;
  const hasBike = (profile.bikes?.length ?? 0) > 0;
  const followers = data?.followerCount ?? 0;
  return (
    <Card className="border-2 border-[#ECECEC]">
      <CardContent className="space-y-4 p-4 sm:p-6">
        <Link href={`/rider/portal/${profile.id}`} className="group flex items-center gap-3">
          {profile.bibNumber
            ? <NumberPlate number={profile.bibNumber} color={data?.plateColor} size={36} />
            : <span className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-[#242424]"><User size={20} className="text-white" /></span>}
          <span className="min-w-0 flex-1">
            <span className="block truncate font-heading font-extrabold text-[22px] uppercase leading-tight text-[#242424] group-hover:text-[#B30000]">{name}</span>
            {data?.className && <span className="block text-[13px] sm:text-[14px] font-semibold leading-tight text-[#B30000]">{data.className}</span>}
            <span className="block text-[14px] text-[#555]">{cardSummary(profile)}</span>
          </span>
          <ChevronRight size={22} className="flex-shrink-0 text-[#555] group-hover:text-[#242424]" />
        </Link>

        <div className="grid grid-cols-3 gap-1.5 sm:gap-3">
          <Tile href={`/rider/racer/${profile.id}`} icon={<User size={14} />} title="Racer Profile"
            label={`Racer profile, ${followers} ${followers === 1 ? "follower" : "followers"}`}>
            {profile.bibNumber ? <NumberPlate number={profile.bibNumber} color={data?.plateColor} size={26} /> : <User size={22} className="text-[#242424]" />}
            <span className="text-[13px] sm:text-[14px] font-semibold leading-tight text-[#242424]">{followers} {followers === 1 ? "follower" : "followers"}</span>
          </Tile>
          <Tile href={`/rider/portal/${profile.id}?tab=stats`} icon={<BarChart3 size={14} />} title="Career Stats"
            label={`Career stats${data?.avgFinish != null ? `, average finish P${data.avgFinish.toFixed(1)}` : ""}`}>
            <Sparkline values={finishes} />
            <span className="text-[13px] sm:text-[14px] font-semibold leading-tight text-[#242424]">{data?.avgFinish != null ? `Avg P${data.avgFinish.toFixed(1)}` : "No races yet"}</span>
          </Tile>
          <Tile href={`/rider/portal/${profile.id}?tab=profile`} icon={<Wrench size={14} />} title="Maintenance"
            label={`Maintenance, ${next ? next.label : hasBike ? "set up reminders in the app" : "add your bike"}`}>
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: next ? STATUS_DOT[next.status] : "#D4D4D4" }} />
            <span className={`text-[13px] sm:text-[14px] font-semibold leading-tight ${next?.status === "overdue" ? "text-[#C62828]" : "text-[#242424]"}`}>
              {next ? next.label : hasBike ? "Set up reminders in the app" : "Add your bike"}
            </span>
          </Tile>
        </div>
      </CardContent>
    </Card>
  );
}

export default function RiderPortal() {
  const { account } = useRiderAuth();
  const [, navigate] = useLocation();

  const { data: profiles, isLoading } = useQuery<RiderProfile[]>({
    queryKey: ["rider-profiles", account?.id],
    queryFn: () => riderApi.profiles(),
    enabled: !!account,
  } as any);

  return (
    <RiderLayout
      title="My Profiles"
      subtitle={<>All rider profiles linked to <span className="font-medium text-white">{account?.email}</span></>}
      titleAside={
        <Button
          onClick={() => navigate("/rider/new-profile")}
          className="w-full md:w-auto min-h-[52px] px-6 bg-white text-[#242424] border-white hover:bg-[#F2F2F2]"
        >
          <UserPlus size={16} /> Add Profile
        </Button>
      }
    >
      <div className="space-y-6">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <Card key={i} className="animate-pulse">
                <CardContent className="p-5 h-32" />
              </Card>
            ))}
          </div>
        ) : profiles && profiles.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2">
            {profiles.map((p) => (
              <ProfileCard key={p.id} profile={p} />
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="p-10 text-center space-y-4">
              <User size={40} className="mx-auto text-muted-foreground/30" />
              <div className="space-y-1.5">
                <h3 className="font-heading font-bold text-lg uppercase">No Rider Profiles Found</h3>
                <p className="text-muted-foreground text-sm max-w-sm mx-auto">
                  No rider profiles are linked to your email yet. Register for an event with this email and your history will appear here — or add a profile manually.
                </p>
              </div>
              <Button
                onClick={() => navigate("/rider/new-profile")}
                className="min-h-[44px] px-6 bg-[#242424] border-[#242424] text-white hover:bg-black"
              >
                <UserPlus size={16} /> Add Profile
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Riders you follow (same as the app's Home feed) */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-heading font-extrabold uppercase tracking-[0.5px] text-[18px] text-[#242424]">Riders you follow</h2>
            <Link href="/rider/following" className="text-[15px] font-semibold text-[#B30000] hover:underline">Find riders</Link>
          </div>
          <FollowingFeed limit={5} />
        </section>

        <Card className="bg-[#FAFAFA] border-2 border-[#ECECEC] shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="font-heading font-extrabold text-base uppercase tracking-[0.5px] text-[#242424] flex items-center gap-2">
              <Plus size={16} /> How profiles are linked
            </CardTitle>
          </CardHeader>
          <CardContent className="text-[15px] leading-[1.7] text-[#333] space-y-1.5">
            <p>Rider profiles are automatically linked to your account by email address.</p>
            <p>If you register a family member (e.g. a minor) using this email, their profile will also appear here as a separate entry.</p>
            <p>Contact the event organizer if you need to update the email on an existing registration.</p>
          </CardContent>
        </Card>
      </div>
    </RiderLayout>
  );
}
