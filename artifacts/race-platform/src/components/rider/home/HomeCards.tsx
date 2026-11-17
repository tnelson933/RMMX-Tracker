/**
 * Rider Home cards, ported from rider-app/components/HomeCards.tsx and
 * RaceCards.tsx in the app's dark theme: the next race as a photo hero with a
 * countdown, recent form as finish badges, one trend with a takeaway, race and
 * result cards, and a one-row way into Rocky.
 */
import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { Award, Calendar, ChevronRight, Flag, MapPin, Wrench, type LucideIcon } from "lucide-react";
import { countdownLabel } from "@workspace/rider-insights/home";
import { finishTakeaway, paceTakeaway, recentRounds } from "@workspace/rider-insights/season";

import type { EventHistory } from "@/lib/rider-api";
import { ChartCard, DARK, LineChart } from "./charts";
import { displayDate, longDate, placeLabel, shortDate } from "./format";

export const STOCK_PHOTO = "/brand/stock/rider-sand.jpg";

// ─── Badges and chips ─────────────────────────────────────────────────────────

/** Gold, silver and bronze for P1–P3; null off the podium. */
export function podiumColor(position: number | null | undefined): string | null {
  if (position === 1) return "#F5B700";
  if (position === 2) return "#C9D1DB";
  if (position === 3) return "#D08A4A";
  return null;
}

/** Finish as a race badge: metallic on the podium (trophy on P1), brand red elsewhere, muted for DNF/DNS. */
export function PositionBadge({ position, dnf, dns, size = "md" }: {
  position: number | null | undefined; dnf?: boolean; dns?: boolean; size?: "sm" | "md" | "lg";
}) {
  const dims = { sm: "h-6 px-[9px] min-w-6 text-[12px]", md: "h-[30px] px-[11px] min-w-[30px] text-[15px]", lg: "h-[52px] px-[14px] min-w-[52px] text-[26px]" }[size];
  if (dnf || dns) {
    return (
      <span className={`inline-flex items-center justify-center rounded-lg border border-[#3A3A3A] bg-[#2E2E2E] font-bold tracking-[0.5px] text-[#A8A8A8] ${dims}`}>
        <span className="text-[0.85em]">{dnf ? "DNF" : "DNS"}</span>
      </span>
    );
  }
  if (position == null) return null;
  const metal = podiumColor(position);
  const bg = metal ?? DARK.red;
  return (
    <span
      className={`inline-flex items-center justify-center gap-1 rounded-lg -skew-x-[8deg] font-heading font-extrabold italic tracking-[0.3px] ${dims}`}
      style={{ background: bg, color: metal ? "#14110A" : "#fff", boxShadow: `0 2px 8px ${bg}${metal ? "73" : "4D"}` }}
    >
      {position === 1 && size !== "sm" && <Award size={size === "lg" ? 22 : 13} color="#1A1300" aria-hidden />}
      P{position}
    </span>
  );
}

/** Red calendar block: month over day, like a race poster. */
export function DateBlock({ iso }: { iso: string | null | undefined }) {
  const d = iso ? displayDate(iso) : null;
  return (
    <div className="flex h-14 w-[52px] shrink-0 flex-col items-center justify-center rounded-xl bg-[#B30000] text-white font-bold leading-none">
      <span className="text-[10.5px] tracking-[1.2px]">{d ? d.toLocaleDateString("en-US", { month: "short" }).toUpperCase() : "TBD"}</span>
      <span className="mt-0.5 text-[23px]">{d ? d.getDate() : "–"}</span>
    </div>
  );
}

/** Small icon + text chip for date, class and place on race cards. */
export function MetaChip({ icon: Icon, label, accent }: { icon: LucideIcon; label: string; accent?: boolean }) {
  return (
    <span className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-[3px] text-[11.5px] font-semibold text-white ${accent ? "border-[#B30000]/55 bg-[rgba(179,0,0,0.22)]" : "border-[#3A3A3A] bg-[#2E2E2E]"}`}>
      <Icon size={11} className={accent ? "text-white" : "text-[#A8A8A8]"} aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}

export function SectionHeader({ icon: Icon, title, right }: { icon: LucideIcon; title: string; right?: ReactNode }) {
  return (
    <div className="mb-2.5 mt-1 flex items-center gap-1.5">
      <Icon size={13} className="text-white" aria-hidden />
      <h2 className="flex-1 font-heading font-bold uppercase tracking-[1px] text-[14px] text-white">{title}</h2>
      {right}
    </div>
  );
}

// ─── Next race hero ───────────────────────────────────────────────────────────

export interface NextRace {
  eventId: number;
  eventName: string;
  eventDate: string | null;
  eventEndDate?: string | null;
  eventState: string | null;
  eventLocation: string | null;
  eventImageUrl?: string | null;
  status: string;
  classes: string[];
}

/** Next race as a photo card; with no race booked, a prompt to find one. */
export function NextRaceHero({ race, todayYmd, href, findHref }: {
  race: NextRace | null; todayYmd: string; href: string; findHref: string;
}) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const label = race ? countdownLabel(race, todayYmd) : null;
  const live = label === "Racing today";
  const date = race?.eventDate
    ? displayDate(race.eventDate).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
    : null;
  const place = race ? placeLabel(race.eventLocation, race.eventState) : null;
  const src = race?.eventImageUrl && !photoFailed ? race.eventImageUrl : STOCK_PHOTO;
  return (
    <Link
      href={race ? href : findHref}
      aria-label={race ? `Next race: ${race.eventName}, ${label}. Open details.` : "No race booked. Find a race."}
      className="group relative block min-h-[230px] md:min-h-[300px] overflow-hidden rounded-[20px] bg-[#161616] hover:opacity-[0.96] transition-opacity"
    >
      <img
        src={src}
        alt=""
        aria-hidden
        onError={() => setPhotoFailed(true)}
        className="absolute inset-0 h-full w-full object-cover object-[50%_25%]"
      />
      <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-black/[0.15] via-black/45 to-black/[0.92]" />
      <div className="relative flex min-h-[230px] md:min-h-[300px] flex-col justify-end gap-1 p-4 md:p-6 text-white">
        <div className="flex items-center gap-1.5 font-heading font-bold uppercase tracking-[1.2px] text-[13px] text-[#E6E6E6]">
          {live && <span className="inline-block h-2 w-2 rounded-full bg-[#22c55e]" />}
          <span className="whitespace-pre">{race ? `Next gate drop  ·  ${label}` : "No race booked"}</span>
        </div>
        <div className="line-clamp-2 font-heading font-extrabold italic uppercase text-[30px] md:text-[40px] leading-[1.05]">
          {race ? race.eventName : "Find your next race"}
        </div>
        <div className="truncate whitespace-pre text-[14px] md:text-[15px] font-medium text-[#E6E6E6]">
          {race ? [date, place].filter(Boolean).join("  ·  ") : "Open races near you are one click away."}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex flex-1 flex-wrap gap-1.5">
            {(race?.classes ?? []).slice(0, 3).map(c => (
              <span key={c} className="rounded-full border border-white/50 px-2.5 py-[3px] font-heading font-bold uppercase tracking-[0.8px] text-[12px]">{c}</span>
            ))}
          </div>
          <span className="shrink-0 rounded-full bg-[#B30000] px-4 py-2 font-heading font-bold uppercase tracking-[1px] text-[14px] group-hover:bg-[#990000] transition-colors">
            {race ? (live ? "Race day" : "Details") : "Find a race"}
          </span>
        </div>
      </div>
    </Link>
  );
}

// ─── Recent form and trend ────────────────────────────────────────────────────

export type HomeResult = EventHistory & { riderId: number; riderName?: string };

/** The last few finishes as podium-coloured badges, oldest on the left. */
export function FormStrip({ history, hrefFor }: { history: HomeResult[]; hrefFor: (ev: HomeResult) => string }) {
  const recent = [...history].sort((a, b) => a.eventDate.localeCompare(b.eventDate)).slice(-5);
  if (recent.length === 0) return null;
  return (
    <section className="flex flex-col gap-2.5 rounded-2xl border border-[#3A3A3A] bg-[#242424] p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-heading font-bold uppercase tracking-[1.2px] text-[13px] text-[#A8A8A8]">Recent form</h2>
        <span className="text-[12px] font-medium text-[#A8A8A8]">Latest on the right</span>
      </div>
      <div className="flex gap-2">
        {recent.map(ev => {
          const finished = ev.motos.some(m => !m.dnf && !m.dns);
          return (
            <Link
              key={`${ev.riderId}-${ev.eventId}-${ev.raceClass}`}
              href={hrefFor(ev)}
              title={ev.riderName ? `${ev.riderName}: ${ev.eventName}` : ev.eventName}
              aria-label={`${ev.eventName}: ${ev.bestPosition != null ? `best finish P${ev.bestPosition}` : "no finish"}. Open the Race Report.`}
              className="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg py-1.5 hover:bg-[#2E2E2E] transition-colors"
            >
              {ev.bestPosition != null
                ? <PositionBadge position={ev.bestPosition} size="sm" />
                : <PositionBadge position={null} dnf={!finished} dns={false} size="sm" />}
              <span className="truncate text-[11px] font-medium text-[#A8A8A8]">{shortDate(ev.eventDate)}</span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/** One trend from the last five races: % off the winner's pace, or finishes if pace isn't available. */
export function FormTrendCard({ history }: { history: EventHistory[] }) {
  const rounds = recentRounds(history, 5);
  const xs = rounds.map(r => shortDate(r.eventDate));
  const pace = rounds.map(r => (r.pacePct == null ? null : Math.max(0, r.pacePct)));
  const paceVals = pace.filter((v): v is number => v != null);
  const scope = `in your last ${rounds.length} races`;

  if (paceVals.length >= 2) {
    const last = paceVals[paceVals.length - 1];
    const max = Math.max(1, ...paceVals) * 1.2;
    return (
      <ChartCard
        title="Pace vs the winner"
        right={<span className="font-heading font-extrabold italic text-[24px] leading-none text-white">{last.toFixed(1)}%</span>}
        takeaway={paceTakeaway(rounds, scope)}
      >
        <LineChart
          xLabels={xs} padLeft={14} height={96}
          series={[{ data: pace, color: DARK.you, area: DARK.area, dots: true }]}
          yMin={0} yMax={max}
          marks={[{ index: pace.lastIndexOf(last), value: last, color: DARK.best }]}
          ariaLabel={`Percent off the winner's pace in your last races: ${paceVals.map(v => `${v.toFixed(1)}%`).join(", ")}.`}
        />
      </ChartCard>
    );
  }

  const fin = rounds.map(r => r.avgFinish);
  const finVals = fin.filter((v): v is number => v != null);
  if (finVals.length < 2) return null;
  const worst = Math.max(...finVals);
  return (
    <ChartCard title="Average moto finish" takeaway={finishTakeaway(rounds)}>
      <LineChart
        xLabels={xs} padLeft={14} height={96}
        series={[{ data: fin, color: DARK.you, dots: true }]}
        yMin={0.5} yMax={Math.max(worst + 0.5, 3.5)} invert band={[0.5, 3.5]}
        ariaLabel={`Average moto finish in your last races: ${finVals.map(v => `P${Math.round(v)}`).join(", ")}.`}
      />
    </ChartCard>
  );
}

// ─── Race and result cards ────────────────────────────────────────────────────

/** An upcoming race: date block, status, name, place and class chips. */
export function EventCard({ title, dateIso, place, classes, status, registered, href }: {
  title: string;
  dateIso?: string | null;
  place?: string | null;
  classes?: string[];
  status?: "live" | "open" | null;
  registered?: boolean;
  href: string;
}) {
  const live = status === "live";
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 rounded-2xl bg-[#242424] p-3 hover:bg-[#2A2A2A] transition-colors ${live ? "border-[1.5px] border-[#ef4444]" : registered ? "border-[1.5px] border-[#B30000]" : "border border-[#3A3A3A]"}`}
    >
      <DateBlock iso={dateIso} />
      <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
        <div className="flex flex-wrap gap-[5px]">
          {live && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#ef4444] px-[7px] py-0.5 text-[9.5px] font-bold tracking-[0.8px] text-white">
              <span className="h-[5px] w-[5px] rounded-full bg-white" />LIVE NOW
            </span>
          )}
          {status === "open" && (
            <span className="rounded-full bg-[rgba(34,197,94,0.15)] px-[7px] py-0.5 text-[9.5px] font-bold tracking-[0.8px] text-[#22c55e]">REGISTRATION OPEN</span>
          )}
          {registered && (
            <span className="rounded-full bg-[#B30000] px-[7px] py-0.5 text-[9.5px] font-bold tracking-[0.8px] text-white">✓ REGISTERED</span>
          )}
        </div>
        <div className="line-clamp-2 font-heading font-extrabold italic uppercase tracking-[0.3px] text-[16px] leading-tight text-white">{title}</div>
        <div className="flex flex-wrap gap-[5px]">
          {place ? <MetaChip icon={MapPin} label={place} /> : null}
          {(classes ?? []).map(c => <MetaChip key={c} icon={Flag} label={c} accent />)}
        </div>
      </div>
      <ChevronRight size={18} className="shrink-0 text-[#A8A8A8]" />
    </Link>
  );
}

/** A finished race: podium-coloured edge stripe, position badge, event name, chips, moto finishes and points. */
export function ResultCard({
  position, dnf, kicker, kickerAvatarUrl, title, dateIso, raceClass, place, points, motos, official, href, footer,
}: {
  position: number | null | undefined;
  dnf?: boolean;
  kicker?: string | null;
  kickerAvatarUrl?: string | null;
  title: string;
  dateIso?: string | null;
  raceClass?: string | null;
  place?: string | null;
  points?: number | null;
  motos?: { position: number | null | undefined; dnf?: boolean; dns?: boolean }[];
  official?: boolean;
  href: string;
  footer?: ReactNode;
}) {
  const edge = podiumColor(position) ?? (position != null ? DARK.red : DARK.border);
  return (
    <div className="relative overflow-hidden rounded-2xl border border-[#3A3A3A] bg-[#242424]">
      <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ background: edge }} />
      <Link href={href} className="flex items-center gap-3 p-3.5 pl-4 hover:bg-[#2A2A2A] transition-colors">
        <div className="flex min-w-14 justify-center">
          {position != null || dnf
            ? <PositionBadge position={position} dnf={dnf} size="md" />
            : <span className="text-[16px] font-bold text-[#A8A8A8]">—</span>}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="min-w-0">
            {kicker ? (
              <div className="flex items-center gap-1.5">
                {kickerAvatarUrl ? <img src={kickerAvatarUrl} alt="" className="h-[18px] w-[18px] rounded-full object-cover" /> : null}
                <span className="truncate font-heading font-bold uppercase tracking-[1px] text-[12px] text-white">{kicker}</span>
              </div>
            ) : null}
            <div className="truncate font-heading font-extrabold italic uppercase tracking-[0.3px] text-[16px] text-white">{title}</div>
          </div>
          <div className="flex flex-wrap gap-[5px]">
            {dateIso ? <MetaChip icon={Calendar} label={longDate(dateIso)} /> : null}
            {raceClass ? <MetaChip icon={Flag} label={raceClass} accent /> : null}
            {place ? <MetaChip icon={MapPin} label={place} /> : null}
          </div>
          {official != null ? (
            <span className={`font-heading font-bold uppercase tracking-[0.6px] text-[12px] ${official ? "text-[#22c55e]" : "text-[#f59e0b]"}`}>
              {official ? "✓ Official results" : "Unofficial results"}
            </span>
          ) : null}
          {motos && motos.length > 1 && (
            <div className="flex flex-wrap items-center gap-[5px]">
              {motos.map((m, i) => (
                <span key={i} className="inline-flex items-center gap-[3px]">
                  <span className="text-[10.5px] font-bold text-[#A8A8A8]">M{i + 1}</span>
                  <PositionBadge position={m.position} dnf={m.dnf} dns={m.dns} size="sm" />
                </span>
              ))}
            </div>
          )}
        </div>
        {points != null && points > 0 ? (
          <div className="flex min-w-10 flex-col items-center">
            <span className="font-heading font-extrabold italic text-[22px] leading-none text-white">{points}</span>
            <span className="mt-0.5 text-[9.5px] font-bold tracking-[1px] text-[#A8A8A8]">PTS</span>
          </div>
        ) : (
          <ChevronRight size={18} className="shrink-0 text-[#A8A8A8]" />
        )}
      </Link>
      {footer}
    </div>
  );
}

/** Rocky in one row (he also floats on every screen). */
export function RockyRow() {
  return (
    <Link
      href="/rider/mechanic"
      aria-label="Ask Rocky, your AI mechanic and riding coach"
      className="flex items-center gap-3 rounded-2xl border border-[#3A3A3A] bg-[#242424] p-3 hover:bg-[#2A2A2A] transition-colors"
    >
      <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-[#B30000] text-white">
        <Wrench size={17} aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-heading font-extrabold italic uppercase text-[16px] leading-tight text-white">Ask Rocky</span>
        <span className="text-[12.5px] text-[#A8A8A8]">Setup, maintenance and riding tips</span>
      </span>
      <ChevronRight size={18} className="shrink-0 text-[#A8A8A8]" />
    </Link>
  );
}

/** Compact empty state: icon, title, message and one red pill button. */
export function EmptyCard({ icon: Icon, title, message, action }: {
  icon: LucideIcon; title: string; message: string; action?: { label: string; href: string };
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-[#3A3A3A] bg-[#242424] px-5 py-6 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[#2E2E2E]">
        <Icon size={20} className="text-[#A8A8A8]" aria-hidden />
      </span>
      <div className="font-heading font-extrabold uppercase tracking-[0.5px] text-[17px] text-white">{title}</div>
      <p className="max-w-sm text-[14px] text-[#A8A8A8]">{message}</p>
      {action && (
        <Link href={action.href} className="mt-1 rounded-full bg-[#B30000] px-5 py-2 font-heading font-bold uppercase tracking-[1px] text-[14px] text-white hover:bg-[#990000] transition-colors">
          {action.label}
        </Link>
      )}
    </div>
  );
}
