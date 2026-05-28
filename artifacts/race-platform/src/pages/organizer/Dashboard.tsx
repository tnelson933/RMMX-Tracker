import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useGetClubDashboard } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Calendar, Users, CheckCircle, Plus, Tag, Activity } from "lucide-react";
import { Link } from "wouter";
import { format, parseISO } from "date-fns";

export default function Dashboard() {
  const { user } = useAuth();
  const clubId = user?.clubId;
  
  const { data: dashboard, isLoading } = useGetClubDashboard(clubId || 0, {
    query: { enabled: !!clubId } as any
  });

  if (isLoading) return <div className="p-8">Loading dashboard...</div>;
  if (!clubId) return <div className="p-8">No club associated with your account.</div>;

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-4xl font-heading font-bold uppercase tracking-tight">Ops Dashboard</h1>
          <p className="text-muted-foreground mt-1">Live club overview and recent activity.</p>
        </div>
        <div className="flex gap-3">
          <Link href="/events">
            <Button className="font-heading uppercase tracking-wider"><Plus size={16} className="mr-2" /> New Event</Button>
          </Link>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card className="border-sidebar-border bg-sidebar text-sidebar-foreground">
          <CardContent className="p-6 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-sidebar-foreground/70 uppercase tracking-widest mb-1">Upcoming Events</p>
              <h2 className="text-4xl font-heading font-bold">{dashboard?.upcomingEvents || 0}</h2>
            </div>
            <div className="h-12 w-12 rounded-full bg-primary/20 flex items-center justify-center text-primary">
              <Calendar size={24} />
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="p-6 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Total Riders</p>
              <h2 className="text-4xl font-heading font-bold">{dashboard?.totalRiders || 0}</h2>
            </div>
            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
              <Users size={24} />
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="p-6 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Registrations</p>
              <h2 className="text-4xl font-heading font-bold">{dashboard?.totalRegistrations || 0}</h2>
            </div>
            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
              <Tag size={24} />
            </div>
          </CardContent>
        </Card>
        
        <Card className="border-secondary bg-secondary/5">
          <CardContent className="p-6 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-secondary uppercase tracking-widest mb-1">Total Checked In</p>
              <h2 className="text-4xl font-heading font-bold text-secondary">{dashboard?.checkedInToday || 0}</h2>
            </div>
            <div className="h-12 w-12 rounded-full bg-secondary/20 flex items-center justify-center text-secondary">
              <CheckCircle size={24} />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
        <div className="xl:col-span-2 space-y-6">
          <h2 className="text-2xl font-heading font-bold uppercase tracking-tight flex items-center gap-2">
            <Calendar className="text-primary" /> Upcoming Events
          </h2>
          
          <div className="space-y-4">
            {dashboard?.upcomingEventList?.length ? (
              dashboard.upcomingEventList.map(event => (
                <Link key={event.id} href={`/events/${event.id}`}>
                  <Card className="hover:border-primary transition-colors cursor-pointer hover-elevate">
                    <CardContent className="p-4 flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="bg-muted px-4 py-2 rounded text-center min-w-16">
                          <div className="text-xs font-bold text-muted-foreground uppercase">{format(parseISO(event.date.substring(0, 10)), 'MMM')}</div>
                          <div className="text-xl font-heading font-bold">{format(parseISO(event.date.substring(0, 10)), 'dd')}</div>
                        </div>
                        <div>
                          <h3 className="font-heading font-bold text-xl uppercase">{event.name}</h3>
                          <p className="text-sm text-muted-foreground">{event.trackName || event.location}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <span className="inline-block bg-primary/10 text-primary px-2 py-1 rounded text-xs font-bold uppercase tracking-wider">
                          {event.status.replace('_', ' ')}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))
            ) : (
              <Card>
                <CardContent className="p-8 text-center text-muted-foreground">
                  No upcoming events.
                </CardContent>
              </Card>
            )}
          </div>
        </div>
        
        <div className="space-y-6">
          <h2 className="text-2xl font-heading font-bold uppercase tracking-tight flex items-center gap-2">
            <Activity className="text-primary" /> Recent Activity
          </h2>
          
          <Card>
            <CardContent className="p-0">
              {dashboard?.recentActivity?.length ? (
                <div className="divide-y">
                  {dashboard.recentActivity.map((activity, i) => (
                    <div key={i} className="p-4 flex items-start gap-4">
                      <div className="mt-1">
                        {activity.type === 'registration' && <Tag size={16} className="text-primary" />}
                        {activity.type === 'checkin' && <CheckCircle size={16} className="text-secondary" />}
                        {activity.type === 'result' && <Activity size={16} className="text-sidebar-primary" />}
                      </div>
                      <div>
                        <p className="text-sm font-medium">{activity.description}</p>
                        <p className="text-xs text-muted-foreground mt-1">{new Date(activity.timestamp).toLocaleString()}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-8 text-center text-muted-foreground text-sm">
                  No recent activity to display.
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
