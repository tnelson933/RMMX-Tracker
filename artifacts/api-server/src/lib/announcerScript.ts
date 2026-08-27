export interface AnnouncerEntry {
  position: number;
  riderName: string;
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
}

export type AnnouncementScriptOptions = {
  lapCompleted: number;
  top5: AnnouncerEntry[];
  positionChanges: AnnouncerPositionChange[];
  kind: "lap" | "extra_lap" | "time_expired" | "finish";
  timeRemainingMs?: number | null;
  lapsRemaining?: number | null;
  extraLapsRemaining?: number;
};

const ORDINALS = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const CARDINALS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

function pick<T>(values: T[]): T {
  return values[Math.floor(Math.random() * values.length)];
}

function positionWord(position: number): string {
  return position <= 5 ? ORDINALS[position] : `${position}th`;
}

function numberWord(value: number): string {
  return value >= 0 && value < CARDINALS.length ? CARDINALS[value] : String(value);
}

function gapToSpeech(gap: string): string | null {
  if (!gap || gap === "Leader" || gap === "—" || /^\+\d+\s+laps?/.test(gap)) return null;
  const match = gap.match(/^\+(\d+):(\d+)\.(\d+)/);
  if (!match) return null;
  const mins = Number(match[1]);
  const secs = Number(match[2]);
  const tenths = Math.round(Number(match[3]) / 10);
  if (mins === 0) {
    return tenths > 0 ? `${secs} point ${tenths} seconds back` : `${secs} seconds back`;
  }
  const seconds = tenths > 0 ? `${secs} point ${tenths} seconds` : `${secs} seconds`;
  return `${mins} minute${mins === 1 ? "" : "s"} and ${seconds} back`;
}

function lapToSpeech(lapTime: string | null): string | null {
  if (!lapTime) return null;
  const match = lapTime.match(/^(\d+):(\d+)\.(\d+)/);
  if (!match) return null;
  const mins = Number(match[1]);
  const secs = Number(match[2]);
  const tenths = Math.round(Number(match[3]) / 10);
  const seconds = tenths > 0 ? `${secs} point ${tenths}` : String(secs);
  return mins === 0
    ? `${seconds} seconds`
    : `${mins} minute${mins === 1 ? "" : "s"} and ${seconds} seconds`;
}

function remainingLapsSpeech(value: number): string {
  if (value <= 0) return "No laps remain";
  return `${numberWord(value)} lap${value === 1 ? "" : "s"} remaining`;
}

function remainingExtraLapsSpeech(value: number): string {
  if (value <= 0) return "No extra laps remain";
  return `${numberWord(value)} extra lap${value === 1 ? "" : "s"} remaining`;
}

function remainingTimeSpeech(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1_000));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (mins > 0) {
    return `${mins} minute${mins === 1 ? "" : "s"}${secs ? ` and ${secs} second${secs === 1 ? "" : "s"}` : ""} remaining`;
  }
  return `${secs} second${secs === 1 ? "" : "s"} remaining`;
}

export function buildAnnouncementScript(options: AnnouncementScriptOptions): string {
  const {
    lapCompleted,
    top5,
    positionChanges,
    kind,
    timeRemainingMs = null,
    lapsRemaining = null,
    extraLapsRemaining = 0,
  } = options;
  const parts: string[] = [];

  if (kind === "time_expired") {
    parts.push(pick([
      "Time is up!",
      "The race clock has expired!",
      "The time limit is up!",
    ]));
    parts.push(`${remainingExtraLapsSpeech(Math.max(0, extraLapsRemaining))}.`);
    return parts.join(" ");
  }

  if (kind === "extra_lap") {
    parts.push(pick([
      "An extra lap is complete.",
      "That's another extra lap in the books.",
      "They have completed another extra lap.",
    ]));
    parts.push(`${remainingExtraLapsSpeech(Math.max(0, extraLapsRemaining))}.`);
  }

  if (kind === "finish") {
    parts.push(pick([
      "Checkered flag!",
      "That's the checkered flag!",
      "And there it is — checkered flag!",
      "We have a winner!",
    ]));
    const winner = top5[0];
    if (winner) {
      const lap = lapToSpeech(winner.lastLap);
      parts.push(pick([
        `${winner.riderName} takes the win${lap ? ` after a final lap of ${lap}` : ""}!`,
        `${winner.riderName} crosses the line first${lap ? ` with a ${lap} final lap` : ""}!`,
        `It's ${winner.riderName} for the win${lap ? ` after a ${lap} lap` : ""}!`,
      ]));
    }
    if (top5[1]) parts.push(pick([
      `${top5[1].riderName} crosses in second.`,
      `${top5[1].riderName} finishes second.`,
      `Second place goes to ${top5[1].riderName}.`,
    ]));
    if (top5[2]) parts.push(pick([
      `${top5[2].riderName} rounds out the podium.`,
      `${top5[2].riderName} takes third.`,
      `And ${top5[2].riderName} in third — completing the podium.`,
    ]));
    if (top5[3]) parts.push(`${top5[3].riderName} finishes fourth.`);
    return parts.join(" ");
  }

  for (const change of positionChanges) {
    if (change.to >= change.from) continue;
    parts.push(pick([
      `${change.riderName} makes a move — up to ${positionWord(change.to)}!`,
      `${change.riderName} is charging — moving up to ${positionWord(change.to)}!`,
      `What a pass — ${change.riderName} into ${positionWord(change.to)}!`,
      `${change.riderName} makes it happen — up to ${positionWord(change.to)} position!`,
    ]));
  }

  if (kind === "lap") {
    const lap = numberWord(lapCompleted);
    parts.push(pick([
      `Lap ${lap} is complete.`,
      `That's lap ${lap} in the books.`,
      `Through lap ${lap} now.`,
      `Lap ${lap} done.`,
    ]));
  }

  const leader = top5[0];
  if (leader) {
    const lap = lapToSpeech(leader.lastLap);
    parts.push(pick([
      `${leader.riderName} leads${lap ? ` with a ${lap} lap` : ""}.`,
      `${leader.riderName} out front${lap ? ` on a ${lap} lap` : ""}.`,
      `${leader.riderName} in the lead${lap ? ` after a ${lap} lap` : ""}.`,
    ]));
  }

  if (kind === "lap") {
    if (timeRemainingMs != null) {
      parts.push(`The clock shows ${remainingTimeSpeech(timeRemainingMs)}.`);
    } else if (lapsRemaining != null) {
      parts.push(`${remainingLapsSpeech(Math.max(0, lapsRemaining))}.`);
    }
  }

  const leaderLaps = leader?.laps ?? 0;
  for (let index = 1; index < Math.min(top5.length, 5); index++) {
    const rider = top5[index];
    if (rider.dnf || rider.dns || rider.laps < leaderLaps) continue;
    const gap = gapToSpeech(rider.gap);
    if (gap) {
      const position = positionWord(rider.position);
      parts.push(pick([
        `${rider.riderName} running ${position}, ${gap}.`,
        `${rider.riderName} in ${position}, ${gap}.`,
        `${position.charAt(0).toUpperCase() + position.slice(1)} place — ${rider.riderName}, ${gap}.`,
      ]));
    } else {
      parts.push(`${rider.riderName} in ${positionWord(rider.position)}.`);
    }
  }

  return parts.join(" ");
}