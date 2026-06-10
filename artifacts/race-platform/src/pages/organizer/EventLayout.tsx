import { Switch, Route, Redirect, useRoute } from "wouter";
import { Link } from "wouter";
import { useGetEvent } from "@workspace/api-client-react";
import { ChevronLeft, Users, CheckCircle, Flag, FileText, Settings, Activity, Timer, CalendarDays } from "lucide-react";

import EventDetail from "./EventDetail";
import Registrations from "./Registrations";
import Checkin from "./Checkin";
import EventSchedule from "./EventSchedule";
import EventPractice from "./EventPractice";
import Motos from "./Motos";
import EnterResults from "./EnterResults";
import Report from "./Report";

export default function EventLayout() {
  const [match, params] = useRoute("/events/:eventId/*?");
  const eventId = parseInt(params?.eventId || "0");
  
  const { data: event, isLoading } = useGetEvent(eventId, { query: { enabled: !!eventId } as any });

  if (isLoading) return <div className="p-8">Loading event...</div>;
  if (!event) return <div className="p-8">Event not found</div>;

  const basePath = `/events/${eventId}`;

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="bg-sidebar border-b border-sidebar-border px-6 py-4">
        <Link href="/events" className="inline-flex items-center text-sm text-sidebar-foreground/60 hover:text-white mb-2 font-medium uppercase tracking-wider">
          <ChevronLeft size={16} className="mr-1" /> All Events
        </Link>
        <div className="flex justify-between items-end">
          <h1 className="text-2xl md:text-3xl font-heading font-bold uppercase tracking-tight text-white">
            {event.name}
          </h1>
          <span className="bg-primary/20 text-primary border border-primary/30 px-3 py-1 rounded text-xs font-bold uppercase tracking-wider">
            {event.status.replace('_', ' ')}
          </span>
        </div>
        
        {/* Horizontal Sub-nav */}
        <div className="flex gap-1 overflow-x-auto mt-6">
          <NavLink href={`${basePath}`} exact icon={<Settings size={16} />}>Overview</NavLink>
          <NavLink href={`${basePath}/registrations`} icon={<Users size={16} />}>Registrations</NavLink>
          <NavLink href={`${basePath}/checkin`} icon={<CheckCircle size={16} />}>Check-In</NavLink>
          <NavLink href={`${basePath}/schedule`} icon={<CalendarDays size={16} />}>Schedule</NavLink>
          <NavLink href={`${basePath}/practice`} icon={<Timer size={16} />}>Practice</NavLink>
          <NavLink href={`${basePath}/motos`} icon={<Flag size={16} />}>Motos & Lineups</NavLink>
          <NavLink href={`${basePath}/results`} icon={<Activity size={16} />}>Enter Results</NavLink>
          <NavLink href={`${basePath}/report`} icon={<FileText size={16} />}>Report</NavLink>
        </div>
      </div>
      
      <div className="flex-1 overflow-auto">
        <Switch>
          <Route path="/events/:eventId" component={EventDetail} />
          <Route path="/events/:eventId/registrations" component={Registrations} />
          <Route path="/events/:eventId/checkin" component={Checkin} />
          <Route path="/events/:eventId/schedule" component={EventSchedule} />
          <Route path="/events/:eventId/practice" component={EventPractice} />
          <Route path="/events/:eventId/motos" component={Motos} />
          <Route path="/events/:eventId/results" component={EnterResults} />
          <Route path="/events/:eventId/report" component={Report} />
        </Switch>
      </div>
    </div>
  );
}

function NavLink({ href, children, icon, exact = false }: { href: string, children: React.ReactNode, icon: React.ReactNode, exact?: boolean }) {
  const [match] = useRoute(exact ? href : `${href}/*`);
  
  return (
    <Link 
      href={href} 
      className={`flex items-center gap-2 px-4 py-3 rounded-t-md font-heading uppercase text-sm font-bold tracking-wider transition-colors whitespace-nowrap ${
        match 
          ? "bg-background text-foreground" 
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-white"
      }`}
    >
      {icon} {children}
    </Link>
  );
}
