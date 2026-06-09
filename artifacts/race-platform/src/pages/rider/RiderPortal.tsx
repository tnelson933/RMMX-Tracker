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
      className="cursor-pointer hover:border-primary/50 hover:shadow-md transition-all group"
      onClick={() => navigate(`/rider/portal/${profile.id}`)}
    >
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
              <User size={18} className="text-primary" />
            </div>
            <div>
              <h3 className="font-heading font-bold text-lg leading-tight">
                {profile.firstName} {profile.lastName}
              </h3>
              {profile.bibNumber && (
                <span className="text-sm text-muted-foreground font-mono">#{profile.bibNumber}</span>
              )}
              {profile.dateOfBirth && (
                <span className="text-xs text-muted-foreground ml-2">DOB: {profile.dateOfBirth}</span>
              )}
            </div>
          </div>
          <ChevronRight size={18} className="text-muted-foreground group-hover:text-primary transition-colors mt-1 flex-shrink-0" />
        </div>

        <div className="mt-4 grid grid-cols-3 gap-3">
          <div className="bg-muted/50 rounded-lg p-3 text-center">
            <div className="flex items-center justify-center gap-1 text-muted-foreground text-xs mb-1">
              <Calendar size={11} /> Events
            </div>
            <div className="font-heading font-bold text-xl">{profile.eventsRaced}</div>
          </div>
          <div className="bg-muted/50 rounded-lg p-3 text-center">
            <div className="flex items-center justify-center gap-1 text-muted-foreground text-xs mb-1">
              <Trophy size={11} /> Best Finish
            </div>
            <div className="font-heading font-bold text-xl">
              {profile.bestPosition ? `P${profile.bestPosition}` : "—"}
            </div>
          </div>
          <div className="bg-muted/50 rounded-lg p-3 text-center">
            <div className="flex items-center justify-center gap-1 text-muted-foreground text-xs mb-1">
              <Star size={11} /> Points
            </div>
            <div className="font-heading font-bold text-xl text-primary">{profile.totalPoints}</div>
          </div>
        </div>

        {profile.lastRaced && (
          <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock size={11} />
            Last raced: {new Date(profile.lastRaced).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
          </div>
        )}

        {profile.eventsRaced === 0 && (
          <Badge variant="outline" className="mt-3 text-xs text-muted-foreground">No race results yet</Badge>
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
    <RiderLayout>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-heading font-bold text-3xl uppercase tracking-tight">My Profiles</h1>
            <p className="text-muted-foreground mt-1">
              All rider profiles linked to <span className="font-medium text-foreground">{account?.email}</span>
            </p>
          </div>
          <Button
            onClick={() => navigate("/rider/new-profile")}
            size="sm"
            className="font-heading uppercase tracking-wider shrink-0 mt-1"
          >
            <UserPlus size={14} className="mr-2" /> Add Profile
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <Card key={i} className="animate-pulse">
                <CardContent className="p-5 h-32" />
              </Card>
            ))}
          </div>
        ) : profiles && profiles.length > 0 ? (
          <div className="space-y-3">
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
                size="sm"
                className="font-heading uppercase tracking-wider"
              >
                <UserPlus size={14} className="mr-2" /> Add Profile
              </Button>
            </CardContent>
          </Card>
        )}

        <Card className="border-dashed">
          <CardHeader className="pb-2">
            <CardTitle className="font-heading text-sm uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Plus size={14} /> How profiles are linked
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-1.5">
            <p>Rider profiles are automatically linked to your account by email address.</p>
            <p>If you register a family member (e.g. a minor) using this email, their profile will also appear here as a separate entry.</p>
            <p>Contact the event organizer if you need to update the email on an existing registration.</p>
          </CardContent>
        </Card>
      </div>
    </RiderLayout>
  );
}
