/**
 * The 1200×630 share-card pictures shown in link previews, drawn as SVG here
 * and turned into PNG by routes/shareMeta.ts (resvg, with the Barlow fonts in
 * api-server/assets/fonts). Brand: charcoal #242424, red #B30000, Barlow.
 * Pure: no database, no files. Text is escaped and sized to fit.
 */
import { PHASE_LABEL, type EventPhase, cleanText } from "./shareMeta";

export const CARD_W = 1200;
export const CARD_H = 630;

const CHARCOAL = "#242424";
const RED = "#B30000";
const LIGHT = "#E6E6E6";
const MUTED = "#BDBDBD";

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Rough width of a line in Barlow at `size` px. Barlow has no width tables
 * here, so this errs wide: uppercase ExtraBold ~0.62em, mixed SemiBold ~0.52em.
 */
export function textWidth(text: string, size: number, upper: boolean): number {
  let units = 0;
  for (const ch of text) {
    if (ch === " ") units += 0.26;
    else if (/[il1.,:;'!|]/i.test(ch) && !upper) units += 0.28;
    else if (/[IJ1.,:;'!|]/.test(ch)) units += 0.3;
    else if (/[MW]/.test(ch)) units += upper ? 0.86 : 0.8;
    else if (/[mw]/.test(ch)) units += 0.78;
    else if (/[A-Z0-9#&]/.test(ch)) units += upper ? 0.62 : 0.6;
    else units += 0.52;
  }
  return units * size;
}

/** Greedy word wrap into at most `maxLines`; the last line ends with "…" when text is left over. */
export function wrapLines(text: string, size: number, maxWidth: number, maxLines: number, upper: boolean): string[] {
  const words = text.split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  let i = 0;
  for (; i < words.length; i++) {
    const next = current ? `${current} ${words[i]}` : words[i];
    if (textWidth(next, size, upper) <= maxWidth || !current) {
      current = next;
      continue;
    }
    lines.push(current);
    current = words[i];
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && current) { lines.push(current); i = words.length; }
  if (i < words.length || lines.some(l => textWidth(l, size, upper) > maxWidth)) {
    // Trim the last line until it fits with an ellipsis.
    let last = lines[lines.length - 1] ?? "";
    while (last.length > 1 && textWidth(`${last}…`, size, upper) > maxWidth) last = last.slice(0, -1).trimEnd();
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

/** The biggest size (from `sizes`) at which the text fits in `maxLines` without cutting. */
export function fitText(text: string, sizes: number[], maxWidth: number, maxLines: number, upper: boolean) {
  for (const size of sizes) {
    const lines = wrapLines(text, size, maxWidth, maxLines, upper);
    if (!lines.some(l => l.endsWith("…"))) return { size, lines };
  }
  const size = sizes[sizes.length - 1];
  return { size, lines: wrapLines(text, size, maxWidth, maxLines, upper) };
}

/** Shared frame: charcoal, a slanted red stripe, red bottom rule and the logo. */
function frame(inner: string, logoDataUri: string | null): string {
  const logo = logoDataUri
    ? `<image href="${logoDataUri}" x="64" y="44" width="288" height="90" preserveAspectRatio="xMinYMid meet"/>`
    : `<text x="64" y="104" font-family="Barlow" font-weight="800" font-size="44" fill="#FFFFFF" letter-spacing="2">RM ROOST</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
  <rect width="${CARD_W}" height="${CARD_H}" fill="${CHARCOAL}"/>
  <path d="M1010 0 H1200 V630 H880 Z" fill="#1C1C1C"/>
  <path d="M1080 0 H1120 L990 630 H950 Z" fill="${RED}" opacity="0.9"/>
  <path d="M1150 0 H1162 L1032 630 H1020 Z" fill="${RED}" opacity="0.55"/>
  <rect x="0" y="${CARD_H - 14}" width="${CARD_W}" height="14" fill="${RED}"/>
  ${logo}
  ${inner}
</svg>`;
}

function pill(label: string, x: number, y: number, live: boolean): string {
  const text = label.toUpperCase();
  const size = 26;
  const w = Math.round(textWidth(text, size, true) + 1.5 * text.length + 48 + (live ? 26 : 0));
  const dot = live ? `<circle cx="${x + 28}" cy="${y + 26}" r="8" fill="#FFFFFF"/>` : "";
  return `<rect x="${x}" y="${y}" width="${w}" height="52" rx="26" fill="${RED}"/>${dot}
  <text x="${x + 24 + (live ? 26 : 0)}" y="${y + 35}" font-family="Barlow" font-weight="700" font-size="${size}" letter-spacing="1.5" fill="#FFFFFF">${escapeXml(text)}</text>`;
}

function lines(texts: string[], x: number, y: number, size: number, lineHeight: number, weight: number, fill: string, spacing = 0): string {
  return texts.map((t, i) =>
    `<text x="${x}" y="${y + i * lineHeight}" font-family="Barlow" font-weight="${weight}" font-size="${size}" fill="${fill}"${spacing ? ` letter-spacing="${spacing}"` : ""}>${escapeXml(t)}</text>`,
  ).join("\n  ");
}

export type EventCardInput = {
  name: string;
  phase: EventPhase;
  dates: string;
  place: string;
  club: string | null;
};

const TEXT_MAX_W = 860;

export function eventCardSvg(input: EventCardInput, logoDataUri: string | null): string {
  const name = cleanText(input.name, 120).toUpperCase() || "RACE";
  const title = fitText(name, [88, 78, 68, 60, 52], TEXT_MAX_W, 2, true);
  const lh = Math.round(title.size * 1.02);
  const titleTop = 276 + (title.lines.length === 1 ? 24 : 0);
  const afterTitle = titleTop + (title.lines.length - 1) * lh;
  const details = [input.dates, input.place].map(s => cleanText(s, 90)).filter(Boolean);
  const detailLines = details.map(d => wrapLines(d, 34, TEXT_MAX_W, 1, false)[0]);
  const club = input.club ? wrapLines(cleanText(input.club, 80), 28, TEXT_MAX_W, 1, false)[0] : null;
  const inner = [
    pill(PHASE_LABEL[input.phase], 64, 160 - 4, input.phase === "live"),
    lines(title.lines, 64, titleTop + title.size * 0.35, title.size, lh, 800, "#FFFFFF"),
    lines(detailLines, 64, afterTitle + title.size * 0.35 + 68, 34, 46, 600, LIGHT),
    club ? lines([club], 64, afterTitle + title.size * 0.35 + 68 + detailLines.length * 46 + 6, 28, 36, 600, MUTED) : "",
  ].join("\n  ");
  return frame(inner, logoDataUri);
}

/** Plate colours (riderResume PLATE_COLORS): background and number colour. */
const PLATES: Record<string, [string, string]> = {
  white: ["#FFFFFF", "#111111"],
  black: ["#111111", "#FFFFFF"],
  red: [RED, "#FFFFFF"],
  yellow: ["#FFD400", "#111111"],
  blue: ["#1446A0", "#FFFFFF"],
  green: ["#13823A", "#FFFFFF"],
  orange: ["#F26B00", "#111111"],
};

/** The number plate on the left of the racer and result cards. */
function plateSvg(number: string, plateBg: string, plateFg: string): string {
  const size = number.length >= 3 ? 150 : 190;
  return `<rect x="64" y="186" width="296" height="296" rx="28" fill="${plateBg}" stroke="#FFFFFF" stroke-opacity="${plateBg === "#111111" ? 0.35 : 0}" stroke-width="4"/>
  <text x="212" y="${334 + size * 0.36}" text-anchor="middle" font-family="Barlow" font-weight="800" font-size="${size}" fill="${plateFg}">${escapeXml(number)}</text>`;
}

export type RacerCardInput = {
  name: string;
  number: string | null;
  plateColor: string | null;
  mainClass: string | null;
  starts: number;
  wins: number;
  podiums: number;
};

export function racerCardSvg(input: RacerCardInput, logoDataUri: string | null): string {
  const [plateBg, plateFg] = PLATES[(input.plateColor ?? "").toLowerCase()] ?? PLATES.white;
  const number = cleanText(input.number, 4);
  const hasPlate = !!number;
  const textX = hasPlate ? 400 : 64;
  const maxW = hasPlate ? 560 : TEXT_MAX_W;
  const name = fitText(cleanText(input.name, 80).toUpperCase() || "RACER", [84, 74, 64, 56, 48], maxW, 2, true);
  const lh = Math.round(name.size * 1.02);
  const nameTop = 230 + (name.lines.length === 1 ? 24 : 0) + name.size * 0.35;
  const afterName = nameTop + (name.lines.length - 1) * lh;
  const cls = input.mainClass ? wrapLines(cleanText(input.mainClass, 40), 34, maxW, 1, false)[0] : null;

  const plate = hasPlate ? plateSvg(number, plateBg, plateFg) : "";

  const stats: Array<[number, string]> = [
    [input.starts, input.starts === 1 ? "Start" : "Starts"],
    [input.wins, input.wins === 1 ? "Win" : "Wins"],
    [input.podiums, input.podiums === 1 ? "Podium" : "Podiums"],
  ];
  const statsY = Math.max(afterName + (cls ? 60 : 0) + 110, 470);
  const statBlocks = stats.map(([n, label], i) => {
    const x = textX + i * 180;
    return `<text x="${x}" y="${statsY}" font-family="Barlow" font-weight="800" font-size="64" fill="#FFFFFF">${n}</text>
  <text x="${x}" y="${statsY + 36}" font-family="Barlow" font-weight="700" font-size="22" letter-spacing="2" fill="${MUTED}">${label.toUpperCase()}</text>`;
  }).join("\n  ");

  const inner = [
    pill("Racer profile", textX, 112, false),
    plate,
    lines(name.lines, textX, nameTop, name.size, lh, 800, "#FFFFFF"),
    cls ? lines([cls], textX, afterName + 56, 34, 40, 600, LIGHT) : "",
    statBlocks,
  ].join("\n  ");
  return frame(inner, logoDataUri);
}


export type ResultCardInput = {
  name: string;
  number: string | null;
  plateColor: string | null;
  /** "P1", "DNF" (shareMeta resultLabel). */
  label: string;
  raceClass: string | null;
  eventName: string;
  dates: string;
  place: string;
  official: boolean;
};

/** One rider's result at an event: plate, position + class, name, event, date and track. */
export function resultCardSvg(input: ResultCardInput, logoDataUri: string | null): string {
  const [plateBg, plateFg] = PLATES[(input.plateColor ?? "").toLowerCase()] ?? PLATES.white;
  const number = cleanText(input.number, 4);
  const hasPlate = !!number;
  const textX = hasPlate ? 400 : 64;
  const maxW = hasPlate ? 560 : TEXT_MAX_W;

  const label = cleanText(input.label, 6).toUpperCase() || "DNF";
  const posSize = 132;
  const posW = textWidth(label, posSize, true) + 1.5 * label.length;
  const cls = input.raceClass ? fitText(cleanText(input.raceClass, 40), [44, 38, 32, 28], Math.max(maxW - posW - 28, 160), 1, false) : null;
  // A long name takes two lines at a smaller size rather than being cut.
  const name = fitText(cleanText(input.name, 80).toUpperCase() || "RACER", [60, 54, 48, 42], maxW, 2, true);
  const below = (name.lines.length - 1) * name.size;
  const eventLine = wrapLines(cleanText(input.eventName, 120) || "Race", 34, maxW, 1, false)[0];
  const details = [input.dates, input.place].map(v => cleanText(v, 90)).filter(Boolean).join(" · ");
  const detailLine = details ? wrapLines(details, 26, maxW, 1, false)[0] : null;

  const status = input.official
    ? pill("Race result", textX, 112, false)
    : `${pill("Race result", textX, 112, false)}
  <rect x="${textX + 258}" y="112" width="196" height="52" rx="26" fill="none" stroke="#FFD27A" stroke-width="3"/>
  <text x="${textX + 356}" y="147" text-anchor="middle" font-family="Barlow" font-weight="700" font-size="24" letter-spacing="1.5" fill="#FFD27A">UNOFFICIAL</text>`;

  const inner = [
    status,
    hasPlate ? plateSvg(number, plateBg, plateFg) : "",
    `<text x="${textX}" y="312" font-family="Barlow" font-weight="800" font-size="${posSize}" fill="#FFFFFF" letter-spacing="1.5">${escapeXml(label)}</text>`,
    cls ? lines(cls.lines, Math.round(textX + posW + 28), 306, cls.size, cls.size, 700, LIGHT) : "",
    lines(name.lines, textX, 392, name.size, name.size, 800, "#FFFFFF"),
    lines([eventLine], textX, 448 + below, 34, 40, 600, LIGHT),
    detailLine ? lines([detailLine], textX, 494 + below, 26, 32, 600, MUTED) : "",
  ].join("\n  ");
  return frame(inner, logoDataUri);
}
