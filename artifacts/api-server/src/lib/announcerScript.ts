/**
 * Race calls in the style of a supercross / motocross TV announcer: short,
 * punchy lines about the story of the race (who leads, who's closing, passes
 * for the podium, the white flag, the checkered flag), riders called by number
 * and last name, numbers said the racing way, gaps in round seconds. No lap
 * times or stat lists: a call has to fit in the seconds before the next one.
 *
 * Each call also carries a mood so the voice can build from steady early laps
 * to the finish.
 */

export interface AnnouncerEntry {
  position: number;
  riderName: string;
  bibNumber?: string | null;
  laps: number;
  lastLap: string | null;
  gap: string;
  dnf?: boolean;
  dns?: boolean;
}

export interface AnnouncerPositionChange {
  riderName: string;
  from: number;
  to: number;
  /** Who held that position before (for "gets by X"). */
  passedName?: string | null;
}

export type AnnouncementMood = "steady" | "rising" | "excited" | "peak";

export type AnnouncementScriptOptions = {
  lapCompleted: number;
  top5: AnnouncerEntry[];
  positionChanges: AnnouncerPositionChange[];
  kind: "lap" | "extra_lap" | "time_expired" | "finish";
  timeRemainingMs?: number | null;
  lapsRemaining?: number | null;
  extraLapsRemaining?: number;
  /** e.g. "250 B" and "main event", for the finish call. */
  raceClass?: string | null;
  typeLabel?: string | null;
};

export type Announcement = { text: string; mood: AnnouncementMood };

const ORDINALS = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const SMALL = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function pick<T>(values: T[]): T {
  return values[Math.floor(Math.random() * values.length)];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function twoDigits(n: number): string {
  if (n < 20) return SMALL[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? `-${SMALL[n % 10]}` : "");
}

export function numberWord(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 99) return String(n);
  return twoDigits(n);
}

/**
 * A race number the way announcers say it: 7 → "seven", 07 → "oh-seven",
 * 23 → "twenty-three", 123 → "one twenty-three", 105 → "one oh-five",
 * 100 → "one hundred". Anything else is left for the voice to read.
 */
export function bibSpeech(bib: string | null | undefined): string | null {
  const raw = (bib ?? "").trim();
  if (!raw) return null;
  if (!/^\d{1,3}$/.test(raw)) return raw;
  if (raw.length === 2 && raw[0] === "0") return `oh-${SMALL[Number(raw[1])]}`;
  const n = Number(raw);
  if (n < 100) return twoDigits(n);
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (rest === 0) return `${SMALL[hundreds]} hundred`;
  if (rest < 10) return `${SMALL[hundreds]} oh-${SMALL[rest]}`;
  return `${SMALL[hundreds]} ${twoDigits(rest)}`;
}

const SUFFIXES = /^(jr|sr|ii|iii|iv)\.?$/i;

export function lastName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length > 1 && SUFFIXES.test(parts[parts.length - 1])) return parts[parts.length - 2];
  return parts[parts.length - 1] ?? fullName;
}

/** Gap text like "+0:02.96" or "+1:05.30" → milliseconds, or null (leader, laps down). */
export function gapMs(gap: string): number | null {
  const m = gap?.match(/^\+(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  const frac = m[3] ? Number(m[3].padEnd(3, "0")) : 0;
  return Number(m[1]) * 60_000 + Number(m[2]) * 1000 + frac;
}

/** Gaps the way they're called: "a few tenths", "a second", "four seconds". */
export function gapSpeech(ms: number): string {
  if (ms < 500) return "just a few tenths";
  if (ms < 1000) return "less than a second";
  if (ms < 1500) return "a second";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${numberWord(seconds)} seconds`;
  const mins = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${mins === 1 ? "a minute" : `${numberWord(mins)} minutes`}${rest ? ` and ${numberWord(rest)}` : ""}`;
}

function minutesLeftSpeech(ms: number): string | null {
  const mins = Math.floor(ms / 60_000);
  if (ms < 60_000) return "Under a minute to go!";
  if (mins <= 2) return `Under ${numberWord(mins + 1)} minutes to go.`;
  if (mins <= 20) return `About ${numberWord(mins)} minutes left.`;
  return null;
}

/** Last names, or full names when two riders in the call share one. */
function namer(entries: AnnouncerEntry[], changes: AnnouncerPositionChange[]) {
  const names = [...entries.map(e => e.riderName), ...changes.map(c => c.riderName), ...changes.map(c => c.passedName ?? "")]
    .filter(Boolean);
  const counts = new Map<string, number>();
  for (const n of new Set(names)) counts.set(lastName(n), (counts.get(lastName(n)) ?? 0) + 1);
  const short = (full: string) => ((counts.get(lastName(full)) ?? 0) > 1 ? full : lastName(full));
  const withNumber = (entry: AnnouncerEntry | undefined, full: string) => {
    const bib = bibSpeech(entry?.bibNumber);
    return bib ? `${short(full)}, the ${bib},` : short(full);
  };
  return { short, withNumber };
}

export function buildAnnouncement(options: AnnouncementScriptOptions): Announcement {
  const {
    lapCompleted,
    top5,
    positionChanges,
    kind,
    timeRemainingMs = null,
    lapsRemaining = null,
    extraLapsRemaining = 0,
  } = options;
  const active = top5.filter(e => !e.dnf && !e.dns);
  const leader = active[0];
  const second = active[1];
  const third = active[2];
  const { short, withNumber } = namer(active, positionChanges);
  const entryFor = (name: string) => active.find(e => e.riderName === name);
  const leadGapMs = second && second.laps >= (leader?.laps ?? 0) ? gapMs(second.gap) : null;

  if (kind === "time_expired") {
    if (extraLapsRemaining <= 0) return { text: pick(["Time's up!", "The clock has run out!"]), mood: "rising" };
    if (extraLapsRemaining === 1) {
      return { text: pick(["Time's up, and that's the white flag! One lap to go!", "The clock hits zero! White flag, last lap!"]), mood: "excited" };
    }
    return { text: `Time's up! ${capitalize(numberWord(extraLapsRemaining))} more laps!`, mood: "rising" };
  }

  if (kind === "finish") {
    if (!leader) return { text: "", mood: "peak" };
    const race = [options.raceClass, options.typeLabel].filter(Boolean).join(" ");
    const bib = bibSpeech(leader.bibNumber);
    const winner = bib ? `Number ${bib}, ${leader.riderName}` : leader.riderName;
    const parts = [pick([
      `Checkered flag! ${winner} wins${race ? ` the ${race}` : ""}!`,
      `${winner} takes the checkers${race ? ` in the ${race}` : ""}!`,
      `There's the checkered flag, and it's ${winner} for the win!`,
    ])];
    if (leadGapMs != null && leadGapMs < 1000) parts.push(`By ${gapSpeech(leadGapMs)} over ${short(second!.riderName)}!`);
    else if (second) parts.push(`${short(second.riderName)} second${third ? `, ${short(third.riderName)} rounds out the podium` : ""}.`);
    if (leadGapMs != null && leadGapMs < 1000 && third) parts.push(`${short(third.riderName)} third.`);
    return { text: parts.join(" "), mood: "peak" };
  }

  // Lap and extra-lap calls tell one story, most important first.
  const lastLap = kind === "extra_lap" ? extraLapsRemaining === 1 : lapsRemaining === 1;
  if (kind === "extra_lap" && extraLapsRemaining <= 0) return { text: "", mood: "steady" };
  if (!leader) return { text: "", mood: "steady" };

  const forward = positionChanges.filter(c => c.to < c.from && c.to <= 3).sort((a, b) => a.to - b.to);
  const leadChange = forward.find(c => c.to === 1);
  const parts: string[] = [];
  let mood: AnnouncementMood = "steady";

  if (lastLap) {
    parts.push(pick(["White flag! Last lap!", "There's the white flag! One to go!", "Last lap!"]));
    mood = "excited";
  }

  if (leadChange) {
    const newLeader = withNumber(entryFor(leadChange.riderName), leadChange.riderName);
    const old = leadChange.passedName ? short(leadChange.passedName) : null;
    parts.push(pick([
      `${capitalize(newLeader)} takes the lead!`,
      `New leader! ${capitalize(newLeader)} is out front!`,
      old ? `${capitalize(newLeader)} gets by ${old} for the lead!` : `${capitalize(newLeader)} into the lead!`,
    ]));
    mood = "excited";
  } else if (forward.length > 0) {
    for (const change of forward.slice(0, 2)) {
      const who = short(change.riderName);
      const place = ORDINALS[change.to];
      parts.push(change.passedName
        ? pick([`${who} gets by ${short(change.passedName)} for ${place}!`, `${who} makes the pass on ${short(change.passedName)}, up to ${place}!`])
        : `${who} moves up to ${place}!`);
    }
    if (mood === "steady") mood = "rising";
  }

  if (!leadChange) {
    if (leadGapMs != null && leadGapMs < 1500) {
      parts.push(pick([
        `${capitalize(short(leader.riderName))} leads, but ${short(second!.riderName)} is right there, ${gapSpeech(leadGapMs)} back!`,
        `${capitalize(short(second!.riderName))} is all over ${short(leader.riderName)} for the lead!`,
        `What a battle up front: ${short(leader.riderName)} and ${short(second!.riderName)}, ${gapSpeech(leadGapMs)} apart!`,
      ]));
      if (mood === "steady") mood = "rising";
    } else if (lastLap || parts.length === 0) {
      // Routine laps: a quick check on the leader, not every lap.
      const routine = parts.length === 0 && !lastLap;
      const countdownDue = lapsRemaining === 2 || (timeRemainingMs != null && timeRemainingMs < 3 * 60_000);
      if (routine && !countdownDue && lapCompleted > 1 && lapCompleted % 2 === 0) {
        return { text: "", mood };
      }
      const lead = lapCompleted === 1 ? withNumber(leader, leader.riderName) : short(leader.riderName);
      parts.push(leadGapMs != null
        ? pick([
          `${capitalize(lead)} leads by ${gapSpeech(leadGapMs)}.`,
          `${capitalize(lead)} out front, ${gapSpeech(leadGapMs)} clear of ${short(second!.riderName)}.`,
          `${capitalize(lead)} with ${gapSpeech(leadGapMs)} in hand.`,
        ])
        : `${capitalize(lead)} leads.`);
      if (lapCompleted === 1 && second) parts.push(`${short(second.riderName)} second${third ? `, ${short(third.riderName)} third` : ""}.`);
    }
  }

  if (!lastLap && kind === "lap") {
    if (lapsRemaining === 2) {
      parts.push("Two laps to go!");
      if (mood === "steady") mood = "rising";
    } else if (timeRemainingMs != null) {
      const line = minutesLeftSpeech(timeRemainingMs);
      if (line) {
        parts.push(line);
        if (timeRemainingMs < 3 * 60_000 && mood === "steady") mood = "rising";
      }
    }
  }

  return { text: parts.join(" "), mood };
}

/** Text only (older callers and tests). */
export function buildAnnouncementScript(options: AnnouncementScriptOptions): string {
  return buildAnnouncement(options).text;
}
