/**
 * Link previews (Open Graph / Twitter cards) for shared website links.
 *
 * Chat apps and social sites read a page's <head> without running its
 * JavaScript, so the server puts each event's or rider's own title,
 * description and share-card image into index.html (routes/shareMeta.ts).
 * Everything here is pure: building the text, escaping it, and swapping the
 * tags in the HTML.
 *
 * Privacy: callers only pass a rider here when the profile is public
 * (lib/riderResume.ts effectiveVisibility). A private profile gets the
 * site's generic preview, never the rider's name or photo.
 */

export const SITE_NAME = "RM Roost";
export const GENERIC_DESCRIPTION = "RM Roost — live RM TrackR & RFID race timing, series points, and public results.";
export const GENERIC_IMAGE_PATH = "/brand/og-image.png";

export type ShareMeta = {
  title: string;
  description: string;
  /** Absolute URL of the 1200×630 card. */
  image: string;
  imageAlt: string;
  /** Absolute URL of the page. */
  url: string;
  type: "website" | "profile";
};

/** What an event is doing right now, as a share card says it. */
export type EventPhase = "live" | "register" | "upcoming" | "closed" | "results";

export const PHASE_LABEL: Record<EventPhase, string> = {
  live: "Live now",
  register: "Register now",
  upcoming: "Coming up",
  closed: "Registration closed",
  results: "Results",
};

const day = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : null);

/**
 * The event's phase from its settled status (eventStatus.settleStatus) and the
 * track's local date. Null for drafts, which have no public page.
 */
export function eventPhase(
  e: { status: string; date: string; endDate?: string | null; registrationClose?: string | null },
  localToday: string,
  now = new Date(),
): EventPhase | null {
  if (e.status === "draft") return null;
  if (e.status === "completed" || e.status === "results_published") return "results";
  const start = day(e.date);
  const last = day(e.endDate) ?? start;
  if (e.status === "race_day" || (start && last && start <= localToday && localToday <= last)) return "live";
  if (last && last < localToday) return "results";
  if (e.status === "registration_open") {
    return e.registrationClose && now >= new Date(e.registrationClose) ? "closed" : "register";
  }
  if (e.status === "registration_closed") return "closed";
  return "upcoming";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parts(ymd: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, mo, d, wd: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
}

/** "Sat, Jun 14, 2026", "Jun 14–15, 2026", "Jun 30 – Jul 1, 2026". Empty for a bad date. */
export function formatEventDates(date: string | null | undefined, endDate?: string | null): string {
  const a = date ? parts(date) : null;
  if (!a) return "";
  const b = endDate ? parts(endDate) : null;
  if (!b || (b.y === a.y && b.mo === a.mo && b.d === a.d)) {
    return `${WEEKDAYS[a.wd]}, ${MONTHS[a.mo - 1]} ${a.d}, ${a.y}`;
  }
  if (a.y !== b.y) return `${MONTHS[a.mo - 1]} ${a.d}, ${a.y} – ${MONTHS[b.mo - 1]} ${b.d}, ${b.y}`;
  if (a.mo !== b.mo) return `${MONTHS[a.mo - 1]} ${a.d} – ${MONTHS[b.mo - 1]} ${b.d}, ${a.y}`;
  return `${MONTHS[a.mo - 1]} ${a.d}–${b.d}, ${a.y}`;
}

/** One line of plain text: no control characters, collapsed spaces, at most `max` characters. */
export function cleanText(value: unknown, max = 200): string {
  if (typeof value !== "string") return "";
  const flat = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** "Track Name, City, ST" without repeats or blanks. */
export function placeLine(e: { trackName?: string | null; location?: string | null; state?: string | null }): string {
  const bits: string[] = [];
  for (const raw of [e.trackName, e.location, e.state]) {
    const v = cleanText(raw, 80);
    if (!v) continue;
    // Skip a part already said ("Boise, ID" then state "ID"), comparing whole comma-separated parts.
    const have = new Set(bits.join(",").toLowerCase().split(",").map(p => p.trim()));
    if (!v.toLowerCase().split(",").every(p => have.has(p.trim()))) bits.push(v);
  }
  return bits.join(", ");
}

export type ShareEvent = {
  id: number;
  name: string;
  date: string;
  endDate?: string | null;
  trackName?: string | null;
  location?: string | null;
  state?: string | null;
  clubName?: string | null;
};

/** Which page of an event is being shared. */
export type EventPage = "results" | "register" | "watch" | "live";

export function eventMeta(
  e: ShareEvent,
  phase: EventPhase,
  page: EventPage,
  origin: string,
  pagePath: string,
  moto?: { name: string; raceClass?: string | null; status?: string | null } | null,
): ShareMeta {
  const name = cleanText(e.name, 120) || "Race";
  const when = formatEventDates(e.date, e.endDate);
  const where = placeLine(e);
  const club = cleanText(e.clubName, 80);
  const whenWhere = [when, where].filter(Boolean).join(" · ");
  const hosted = club ? ` Hosted by ${club}.` : "";

  let title: string;
  let lead: string;
  if (page === "live" && moto) {
    const motoName = cleanText(moto.name, 80) || "Race";
    const done = moto.status === "completed";
    title = `${done ? "Results" : "Live timing"}: ${motoName} · ${name}`;
    lead = done
      ? `Finishing order and lap times for ${motoName} at ${name}.`
      : `Live positions and lap times for ${motoName} at ${name}.`;
  } else if (page === "watch") {
    title = phase === "live" ? `Watch live: ${name}` : `Watch: ${name}`;
    lead = phase === "live" ? `Watch ${name} live, with live timing.` : `Live video and timing for ${name}.`;
  } else if (page === "register") {
    title = phase === "register" ? `Register: ${name}` : name;
    lead = phase === "register"
      ? `Registration is open for ${name}.`
      : phase === "results" ? `Results from ${name}.` : `${PHASE_LABEL[phase]}: ${name}.`;
  } else {
    title = phase === "results" ? `${name} Results` : name;
    lead = phase === "results" ? `Results from ${name}.`
      : phase === "live" ? `${name} is racing today. Follow live timing and results.`
      : phase === "register" ? `Registration is open for ${name}.`
      : `${PHASE_LABEL[phase]}: ${name}.`;
  }
  const description = cleanText(`${lead}${whenWhere ? ` ${whenWhere}.` : ""}${hosted}`, 300);
  return {
    title: cleanText(title, 140),
    description,
    image: `${origin}/api/public/og/event/${e.id}.png?v=${phase}`,
    imageAlt: cleanText(`${name}${when ? `, ${when}` : ""}${where ? `, ${where}` : ""} — ${PHASE_LABEL[phase]} on RM Roost`, 300),
    url: `${origin}${pagePath}`,
    type: "website",
  };
}

export type ShareRacer = {
  riderId: number;
  name: string;
  number: string | null;
  mainClass: string | null;
  starts: number;
  wins: number;
  podiums: number;
};

/** "14 starts · 3 wins · 6 podiums" (only what's not zero, starts always). */
export function racerStatLine(r: Pick<ShareRacer, "starts" | "wins" | "podiums">): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const bits = [plural(r.starts, "start", "starts")];
  if (r.wins > 0) bits.push(plural(r.wins, "win", "wins"));
  if (r.podiums > 0) bits.push(plural(r.podiums, "podium", "podiums"));
  return bits.join(" · ");
}

/** Only call for a public profile (see the privacy note at the top). */
export function racerMeta(r: ShareRacer, origin: string): ShareMeta {
  const name = cleanText(r.name, 80) || "Racer";
  const number = cleanText(r.number, 6);
  const cls = cleanText(r.mainClass, 40);
  const title = number ? `${name} #${number}` : name;
  const description = cleanText(
    `${[cls, racerStatLine(r)].filter(Boolean).join(" · ")}. Race results, lap times and series standings on RM Roost.`,
    300,
  );
  return {
    title,
    description,
    image: `${origin}/api/public/og/racer/${r.riderId}.png?v=${r.starts}`,
    imageAlt: cleanText(`${title}${cls ? `, ${cls}` : ""} — racer profile on RM Roost`, 300),
    url: `${origin}/racer/${r.riderId}`,
    type: "profile",
  };
}

export function genericMeta(origin: string, path = "/"): ShareMeta {
  return {
    title: SITE_NAME,
    description: GENERIC_DESCRIPTION,
    image: `${origin}${GENERIC_IMAGE_PATH}`,
    imageAlt: "RM Roost",
    url: `${origin}${path}`,
    type: "website",
  };
}

/** Escapes text for an HTML attribute value or text node. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SHARE_TAG = /\s*<meta\s+(?:name|property)="(?:description|og:[^"]*|twitter:[^"]*)"[^>]*>/gi;
const TITLE_TAG = /\s*<title>[\s\S]*?<\/title>/i;

/**
 * index.html with its title, description, Open Graph and Twitter tags replaced
 * by `meta`'s (the page's other head tags are kept as they are).
 */
export function injectShareMeta(html: string, meta: ShareMeta): string {
  const title = meta.title === SITE_NAME ? SITE_NAME : `${meta.title} · ${SITE_NAME}`;
  const tags = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:type" content="${meta.type}" />`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(meta.url)}" />`,
    `<meta property="og:image" content="${escapeHtml(meta.image)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${escapeHtml(meta.imageAlt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(meta.image)}" />`,
    `<meta name="twitter:image:alt" content="${escapeHtml(meta.imageAlt)}" />`,
  ].map(t => `\n    ${t}`).join("");
  const stripped = html.replace(TITLE_TAG, "").replace(SHARE_TAG, "");
  const at = stripped.search(/<\/head>/i);
  if (at < 0) return stripped;
  return `${stripped.slice(0, at).trimEnd()}${tags}\n  ${stripped.slice(at)}`;
}

/** The site's own address for absolute links: APP_URL, never the request's Host header. */
export function siteOrigin(appUrl: string | undefined): string {
  if (appUrl) {
    try {
      const u = new URL(appUrl.includes("://") ? appUrl : `https://${appUrl}`);
      if (u.protocol === "https:" || u.protocol === "http:") return u.origin;
    } catch { /* fall through */ }
  }
  return "https://www.rmroost.com";
}
