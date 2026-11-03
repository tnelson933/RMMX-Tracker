/**
 * Links the rider app's AI (mechanic and coach) may send: Rocky Mountain ATV/MC
 * only. That's the store (rockymountainatvmc.com; rockymountainatv.com
 * redirects there) and the YouTube channel "Rocky Mountain ATV MC" (@rmatvmc).
 * Everything else is removed before a reply reaches a rider, so a competitor's
 * site never appears, and neither does a product or video address the AI made
 * up: it links to a store search or a channel search, which always work.
 */

export const STORE_SEARCH = "https://www.rockymountainatvmc.com/search/go?w=";
export const CHANNEL_SEARCH = "https://www.youtube.com/@rmatvmc/search?query=";

/** For the prompts: the only link formats the AI may use. */
export const APPROVED_LINKS_RULES = `LINKS (strict):
- Only link to Rocky Mountain ATV/MC. Products: a store search, ${STORE_SEARCH}<words, spaces as %20> (e.g. ${STORE_SEARCH}Maxima%2010W-40). How-to videos: a search of our YouTube channel, Rocky Mountain ATV MC, ${CHANNEL_SEARCH}<words, spaces as %20> (e.g. ${CHANNEL_SEARCH}oil%20change).
- Never write any other web address: no other store, brand, forum, video or social site, and never a product page or video address you'd have to guess. Don't name or recommend other retailers or their sites.
- If there's nothing to link, give the advice without a link.`;

const STORE_HOSTS = ["rockymountainatvmc.com", "rockymountainatv.com"];
const CHANNEL_PATHS = [/^\/@rmatvmc(\/|$)/i, /^\/rmatvmc(\/|$)/i, /^\/c\/rockymountainatvmc(\/|$)/i, /^\/user\/rockymountainatvmc(\/|$)/i, /^\/rockymountainatvmc(\/|$)/i, /^\/channel\/UCQSXoYEPBXNPSx1hWbO2WRQ(\/|$)/];

/** The approved form of a link, or null when it isn't ours. Old "/search#q=" store links are fixed. */
export function approvedLink(raw: string): string | null {
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (STORE_HOSTS.some(h => host === h || host.endsWith(`.${h}`))) {
    const oldSearch = /^\/search\/?$/i.test(url.pathname) && url.hash.startsWith("#q=");
    if (oldSearch) return `${STORE_SEARCH}${encodeURIComponent(decodeURIComponent(url.hash.slice(3).replace(/\+/g, " ")))}`;
    return `https://www.rockymountainatvmc.com${url.pathname}${url.search}${url.hash}`;
  }
  if ((host === "youtube.com" || host === "m.youtube.com") && CHANNEL_PATHS.some(re => re.test(url.pathname))) {
    return `https://www.youtube.com${url.pathname}${url.search}`;
  }
  return null;
}

// Full links, then bare web names ("somestore.com/page"); trailing punctuation isn't part of a link.
const URL_RE = /\bhttps?:\/\/[^\s<>()"'\]]+|\b(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|co|io|us|ca|shop|store|tv|app|info|biz|ly|gg|me)(?:\/[^\s<>()"'\]]*)?/gi;
const TRAILING = /[.,;:!?)\]]+$/;

/** A reply with every link that isn't Rocky Mountain ATV/MC removed (markdown links keep their words). */
export function enforceApprovedLinks(text: string): string {
  if (!text) return text;
  // [words](link): keep the words, and the link only if it's ours.
  let out = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, words: string, link: string) => {
    const ok = approvedLink(link);
    return ok ? `${words} — ${ok}` : words;
  });
  out = out.replace(URL_RE, (match: string) => {
    const tail = match.match(TRAILING)?.[0] ?? "";
    const link = tail ? match.slice(0, -tail.length) : match;
    const ok = approvedLink(link);
    return ok ? ok + tail : tail;
  });
  // Tidy what a removed link leaves behind ("Grab some here: ." / "— ," / doubled spaces).
  return out
    .replace(/[ \t]*[—–-][ \t]*(?=[.,;:!?]|\n|$)/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]+$/gm, "");
}

/** enforceApprovedLinks on every string inside a JSON value (e.g. a training plan). */
export function enforceApprovedLinksDeep<T>(value: T, skipKeys: string[] = []): T {
  if (typeof value === "string") return enforceApprovedLinks(value) as T;
  if (Array.isArray(value)) return value.map(v => enforceApprovedLinksDeep(v, skipKeys)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, skipKeys.includes(k) ? v : enforceApprovedLinksDeep(v, skipKeys)])) as T;
  }
  return value;
}
