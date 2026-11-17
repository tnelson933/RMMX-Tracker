import type { ReactNode } from "react";
import { Link } from "wouter";
import { Calendar, ChevronRight, MapPin, Users, type LucideIcon } from "lucide-react";

// Web versions of the rider app's race cards (rider-app/components/RaceCards.tsx):
// the red date block, small meta chips and the browsable event card.

/** Event dates are calendar days: read them at local noon so US time zones keep the day. */
export function eventDayDate(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T12:00:00`);
}

/** "Jun 4, 2026", or "Jun 4–6, 2026" for a multi-day event. */
export function fmtEventRange(date: string, endDate?: string | null): string {
  if (!date) return "";
  const start = eventDayDate(date);
  if (!endDate || endDate.slice(0, 10) === date.slice(0, 10)) {
    return start.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  const end = eventDayDate(endDate);
  const startStr = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
    return `${startStr}–${end.getDate()}, ${end.getFullYear()}`;
  }
  return `${startStr} – ${end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}

/** "City, ST" without repeating the state when the place already ends with it. */
export function placeLabel(place: string | null | undefined, state: string | null | undefined): string {
  const p = (place ?? "").trim();
  const st = (state ?? "").trim();
  if (!st) return p;
  if (!p) return st;
  const before = p.charAt(p.length - st.length - 1);
  const endsWithState = p.toLowerCase().endsWith(st.toLowerCase()) && (p.length === st.length || before === "," || before === " ");
  return endsWithState ? p : `${p}, ${st}`;
}

/** Red calendar block: month over day, like a race poster. */
export function DateBlock({ iso, size = 52 }: { iso: string | null | undefined; size?: number }) {
  const d = iso ? eventDayDate(iso) : null;
  return (
    <div
      className="shrink-0 rounded-xl bg-[#B30000] text-white flex flex-col items-center justify-center leading-none"
      style={{ width: size, height: size + 4 }}
      aria-hidden="true"
    >
      <span className="font-bold tracking-[1.2px]" style={{ fontSize: size * 0.2 }}>
        {d ? d.toLocaleDateString("en-US", { month: "short" }).toUpperCase() : "TBD"}
      </span>
      <span className="font-bold mt-0.5" style={{ fontSize: size * 0.44 }}>
        {d ? d.getDate() : "–"}
      </span>
    </div>
  );
}

/** Small icon + text chip for date, place, club and class. */
export function MetaChip({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 max-w-full rounded-full border border-[#3A3A3A] bg-[#2E2E2E] px-2 py-[3px] text-[12px] font-semibold text-[#FAFAFA]">
      <Icon size={11} className="shrink-0 text-[#A8A8A8]" />
      <span className="truncate">{label}</span>
    </span>
  );
}

export function LiveNowPill() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#B30000] px-2 py-[3px] text-[10px] font-bold tracking-[0.8px] text-white">
      <span className="w-[5px] h-[5px] rounded-full bg-white animate-pulse" />
      LIVE NOW
    </span>
  );
}

export interface EventCardEvent {
  eventId: number;
  name: string;
  state: string | null;
  date: string;
  endDate: string | null;
  location: string | null;
  trackName: string | null;
  clubName: string | null;
}

/** An event in a list: date block, LIVE NOW pill, name and place/club chips. */
export function RaceEventCard({ event, href, live, extra }: { event: EventCardEvent; href: string; live?: boolean; extra?: ReactNode }) {
  const multiDay = !!event.endDate && event.endDate.slice(0, 10) !== event.date.slice(0, 10);
  const place = placeLabel(event.location || event.trackName, event.state);
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 rounded-2xl bg-[#242424] p-3 transition-colors hover:bg-[#2A2A2A] focus-visible:outline focus-visible:outline-2 focus-visible:outline-white ${live ? "border-[1.5px] border-[#ef4444]" : "border border-[#3A3A3A]"}`}
    >
      <DateBlock iso={event.date} />
      <div className="flex-1 min-w-0 space-y-1.5">
        {live && <div><LiveNowPill /></div>}
        <div className="font-heading font-extrabold italic uppercase text-[16px] leading-tight tracking-[0.3px] text-[#FAFAFA] line-clamp-2">
          {event.name}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {multiDay && <MetaChip icon={Calendar} label={fmtEventRange(event.date, event.endDate)} />}
          {place && <MetaChip icon={MapPin} label={place} />}
          {event.clubName && <MetaChip icon={Users} label={event.clubName} />}
        </div>
        {extra}
      </div>
      <ChevronRight size={18} className="shrink-0 text-[#A8A8A8]" />
    </Link>
  );
}

/** Section label above a list ("Live Now · 3 events"). */
export function SectionLabel({ icon, children, count }: { icon: ReactNode; children: ReactNode; count?: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 pt-5 pb-2.5">
      {icon}
      <span className="font-heading font-bold uppercase tracking-[1px] text-[14px] text-[#FAFAFA]">{children}</span>
      {count != null && <span className="ml-auto text-[13px] text-[#A8A8A8]">{count}</span>}
    </div>
  );
}

/** The app's empty state: icon, title, message. */
export function EmptyState({ icon: Icon, title, message, children }: { icon: LucideIcon; title: string; message?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center gap-2 py-14 px-6">
      <Icon size={36} className="text-[#A8A8A8]/60" />
      <div className="text-[17px] font-bold text-[#FAFAFA]">{title}</div>
      {message && <p className="text-[15px] text-[#A8A8A8] max-w-sm leading-snug">{message}</p>}
      {children}
    </div>
  );
}
