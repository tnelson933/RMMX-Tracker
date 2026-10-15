import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Trophy, Calendar, Star, User, ChevronRight, Plus, Clock, UserPlus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RiderLayout } from "@/components/layout/RiderLayout";
import { useRiderAuth } from "@/contexts/RiderAuthContext";
import { riderApi, type RiderProfile } from "@/lib/rider-api";

function ProfileCard({ profile }: { profile: RiderProfile }) {
  const [, navigate] = useLocation();
  return (
    <Card
      className="cursor-pointer border-2 border-[#ECECEC] hover:border-[#8C8C8C] hover:shadow-[0_12px_20px_-6px_rgba(0,0,0,0.22)] transition-all group"
      onClick={() => navigate(`/rider/portal/${profile.id}`)}
    >
      <CardContent className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-[#242424] flex items-center justify-center flex-shrink-0">
              <User size={20} className="text-white" />
            </div>
            <div>
              <h3 className="font-heading font-extrabold text-[22px] uppercase leading-tight text-[#242424]">
                {profile.firstName} {profile.lastName}
              </h3>
              {profile.bibNumber && (
                <span className="text-[15px] text-[#555] font-bold">#{profile.bibNumber}</span>
              )}
              {profile.dateOfBirth && (
                <span className="text-[13px] text-muted-foreground ml-2">DOB: {profile.dateOfBirth}</span>
              )}
            </div>
          </div>
          <ChevronRight size={22} className="text-[#555] group-hover:text-[#242424] transition-colors mt-2 flex-shrink-0" />
        </div>

        <div className="mt-4 grid grid-cols-3 gap-3">
          <div className="bg-[#F2F2F2] rounded-[10px] p-3 text-center">
            <div className="flex items-center justify-center gap-1 text-[#707070] text-[13px] font-bold uppercase tracking-[0.5px] mb-1">
              <Calendar size={13} className="hidden sm:block" /> Events
            </div>
            <div className="font-heading font-extrabold text-2xl text-[#242424]">{profile.eventsRaced}</div>
          </div>
          <div className="bg-[#F2F2F2] rounded-[10px] p-3 text-center">
            <div className="flex items-center justify-center gap-1 text-[#707070] text-[13px] font-bold uppercase tracking-[0.5px] mb-1">
              <Trophy size={13} className="hidden sm:block" /> Best Finish
            </div>
            <div className="font-heading font-extrabold text-2xl text-[#242424]">
              {profile.bestPosition ? `P${profile.bestPosition}` : "—"}
            </div>
          </div>
          <div className="bg-[#F2F2F2] rounded-[10px] p-3 text-center">
            <div className="flex items-center justify-center gap-1 text-[#707070] text-[13px] font-bold uppercase tracking-[0.5px] mb-1">
              <Star size={13} className="hidden sm:block" /> Points
            </div>
            <div className="font-heading font-extrabold text-2xl text-primary">{profile.totalPoints}</div>
          </div>
        </div>

        {profile.lastRaced && (
          <div className="mt-3 flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <Clock size={13} />
            Last raced: {new Date(profile.lastRaced).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
          </div>
        )}

        {profile.eventsRaced === 0 && (
          <Badge variant="outline" className="mt-3 rounded-full border-2 border-[#ECECEC] px-3 py-1 text-[13px] font-medium text-[#555]">No race results yet</Badge>
        )}
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
