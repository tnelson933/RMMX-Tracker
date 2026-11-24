/**
 * The public event page before any results exist: what, when, where, which
 * classes and what they cost, who runs it, and Register while entries are open.
 * Fees and details come from the same public register-info the registration
 * page uses, so the two never disagree.
 */
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Calendar, Clock, ExternalLink, MapPin, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EventClubContact, type ClubContactInfo } from "@/components/EventClubContact";
import { formatEventDatesFull } from "@/lib/eventDates";
import { displayTime, firstRaceTime, mapLink, money, placeLine, registrationIsOpen } from "@/lib/eventInfo";

export interface PublicEventInfo extends ClubContactInfo {
  id: number;
  name: string;
  date: string;
  endDate?: string | null;
  state: string;
  location: string | null;
  trackName: string | null;
  streetAddress?: string | null;
  zip?: string | null;
  trackLat?: number | null;
  trackLng?: number | null;
  raceClasses: string[];
  classDetails?: Record<string, string>;
  status: string;
  registrationOpen?: string | null;
  registrationClose?: string | null;
  paymentEnabled: boolean;
  entryFee: number | null;
  earlyBirdActive?: boolean;
  earlyBirdEndsAt?: string | null;
  currentEntryFee?: number | null;
  maxRiders?: number | null;
  /** Class entries so far, void excluded (newer servers only). */
  entryCount?: number;
}

/** The registration page's event info (public). Shared query key so both pages reuse one fetch. */
export function usePublicEventInfo(eventId: number) {
  return useQuery({
    queryKey: ["public-register-info", eventId],
    enabled: eventId > 0,
    queryFn: async (): Promise<PublicEventInfo> => {
      const r = await fetch(`/api/public/events/${eventId}/register-info`);
      if (!r.ok) throw new Error("Couldn't load this event's details.");
      return r.json();
    },
  });
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <CardHeader className="px-6 py-4 border-b-2 border-[#ECECEC] space-y-0">
      <h2 className="flex items-center gap-3 m-0 font-heading font-extrabold uppercase text-lg leading-none tracking-[0.5px] text-[#242424]">
        <span aria-hidden className="w-[4px] h-5 bg-primary -skew-x-[18deg] shrink-0" />
        {children}
      </h2>
    </CardHeader>
  );
}

interface Props {
  eventId: number;
  motos: Array<{ type?: string | null; scheduledTime?: string | null; motoNumber?: number | null }> | undefined;
  /** Enduro: each class's start time of day (from GET /events/:id). */
  classStartTimes?: Record<string, string | null>;
}

export function UpcomingEventView({ eventId, motos, classStartTimes }: Props) {
  const { data: info, isLoading, isError } = usePublicEventInfo(eventId);

  if (isLoading) {
    return (
      <div className="grid gap-6 md:grid-cols-3" aria-busy="true" aria-label="Loading event details">
        <div className="md:col-span-2 h-72 rounded-[14px] bg-card border animate-pulse" />
        <div className="h-72 rounded-[14px] bg-card border animate-pulse" />
      </div>
    );
  }
  if (isError || !info) {
    return (
      <Card>
        <CardContent className="p-10 text-center text-[#333]">
          This event's details didn't load. Refresh the page to try again.
        </CardContent>
      </Card>
    );
  }

  const open = registrationIsOpen(info);
  const fee = info.currentEntryFee ?? info.entryFee;
  const firstRace = firstRaceTime(motos ?? []);
  const enduroStarts = Object.entries(classStartTimes ?? {}).filter(([, t]) => !!t);
  const map = mapLink(info);
  const place = placeLine(info);
  const closes = info.registrationClose ? new Date(info.registrationClose) : null;
  const opens = info.registrationOpen ? new Date(info.registrationOpen) : null;
  const notYetOpen = !!opens && opens > new Date();

  return (
    <div className="grid gap-6 md:grid-cols-3">
      <div className="md:col-span-2 space-y-6 min-w-0">
        {/* Register call to action */}
        <Card className="overflow-hidden">
          <CardContent className="p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-5">
            <div className="min-w-0">
              <div className="font-heading font-extrabold uppercase text-2xl leading-tight text-[#242424]">
                {open ? "Registration is open" : notYetOpen ? "Registration opens soon" : info.status === "race_day" ? "Racing today" : "Registration closed"}
              </div>
              <p className="mt-1 text-[15px] text-[#333]">
                {open && closes && <>Sign up online until {format(closes, "EEEE, MMMM d 'at' h:mm a")}.</>}
                {open && !closes && <>Sign up online now and skip the line at the gate.</>}
                {!open && notYetOpen && opens && <>Opens {format(opens, "EEEE, MMMM d 'at' h:mm a")}.</>}
                {!open && !notYetOpen && <>Online sign-up has ended. Results will appear here after the races.</>}
              </p>
            </div>
            {open && (
              <Button asChild size="lg" className="h-[52px] px-8 text-base shrink-0">
                <Link href={`/register/${eventId}`}>Register</Link>
              </Button>
            )}
          </CardContent>
        </Card>

        {/* Classes and fees */}
        <Card>
          <SectionTitle>Classes{info.raceClasses.length ? ` (${info.raceClasses.length})` : ""}</SectionTitle>
          <CardContent className="p-0">
            {fee != null && fee > 0 && (
              <div className="px-6 py-4 border-b border-[#ECECEC] flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[15px] text-[#333]">
                <span>
                  Entry fee <strong className="text-[#242424]">{money(fee)}</strong>{info.raceClasses.length > 1 ? " per class" : ""}
                </span>
                {info.earlyBirdActive && info.entryFee != null && info.earlyBirdEndsAt && (
                  <span className="text-[13px] text-[#555]">Early bird price, then {money(info.entryFee)} after {format(new Date(`${info.earlyBirdEndsAt}T12:00:00`), "MMMM d")}</span>
                )}
                {!info.paymentEnabled && <span className="text-[13px] text-[#555]">Paid at the gate</span>}
              </div>
            )}
            {info.raceClasses.length === 0 ? (
              <p className="px-6 py-6 text-[15px] text-[#555]">The organizer hasn't listed classes yet.</p>
            ) : (
              <ul className="divide-y divide-[#ECECEC]">
                {info.raceClasses.map(cls => {
                  const details = info.classDetails?.[cls];
                  return (
                    <li key={cls} className="px-6 py-3.5">
                      <div className="flex items-baseline justify-between gap-4">
                        <span className="font-heading font-bold uppercase text-[17px] tracking-[0.3px] text-[#242424] break-words">{cls}</span>
                        {fee != null && fee > 0 && <span className="shrink-0 tabular-nums text-[15px] text-[#333]">{money(fee)}</span>}
                      </div>
                      {details && <p className="mt-1 text-[14px] leading-relaxed text-[#555] line-clamp-3">{details}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6 min-w-0">
        <Card>
          <SectionTitle>When &amp; where</SectionTitle>
          <CardContent className="p-6 space-y-4 text-[15px] text-[#333]">
            <div className="flex gap-3">
              <Calendar size={18} aria-hidden className="mt-0.5 shrink-0 text-[#555]" />
              <span>{formatEventDatesFull(info.date, info.endDate)}</span>
            </div>
            {(firstRace || enduroStarts.length > 0) && (
              <div className="flex gap-3">
                <Clock size={18} aria-hidden className="mt-0.5 shrink-0 text-[#555]" />
                {firstRace ? (
                  <span>First race {firstRace}</span>
                ) : (
                  <ul className="space-y-0.5">
                    {enduroStarts.map(([cls, t]) => <li key={cls}>{cls}: starts {displayTime(t)}</li>)}
                  </ul>
                )}
              </div>
            )}
            {place && (
              <div className="flex gap-3">
                <MapPin size={18} aria-hidden className="mt-0.5 shrink-0 text-[#555]" />
                <div className="min-w-0">
                  <div className="break-words">{place}</div>
                  {info.streetAddress && <div className="text-[14px] text-[#555] break-words">{info.streetAddress}{info.zip ? ` ${info.zip}` : ""}</div>}
                  {map && (
                    <a href={map} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 font-semibold text-[#242424] underline underline-offset-2 hover:text-primary">
                      Open in Maps <ExternalLink size={13} aria-hidden />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  )}
                </div>
              </div>
            )}
            {typeof info.entryCount === "number" && (
              <div className="flex gap-3">
                <Users size={18} aria-hidden className="mt-0.5 shrink-0 text-[#555]" />
                <span>
                  {info.entryCount === 0 ? "No entries yet" : `${info.entryCount} ${info.entryCount === 1 ? "entry" : "entries"} so far`}
                  {info.maxRiders ? <span className="text-[#555]"> · {info.maxRiders} max</span> : null}
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <EventClubContact info={info} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
