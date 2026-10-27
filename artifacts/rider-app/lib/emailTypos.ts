/**
 * Catch common email-domain typos ("gmial.com", "gmail.con") before sign-in or
 * sign-up. A mistyped email at sign-up creates a second, empty account that
 * isn't linked to the rider's race history.
 */

const COMMON_DOMAINS = [
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "aol.com",
  "live.com", "msn.com", "me.com", "comcast.net", "protonmail.com", "ymail.com",
];

// Real providers that sit close to a common one ("mail.com" vs "gmail.com"); never "correct" these.
const KNOWN_VALID = new Set([
  ...COMMON_DOMAINS, "mail.com", "gmx.com", "gmx.net", "att.net", "sbcglobal.net", "verizon.net", "cox.net",
  "charter.net", "q.com", "frontier.com", "juno.com", "earthlink.net", "zoho.com", "fastmail.com", "pm.me",
  "proton.me", "hey.com", "mac.com", "rocketmail.com", "live.ca", "yahoo.ca", "hotmail.ca",
]);

const TLD_FIXES: Record<string, string> = { con: "com", cmo: "com", ocm: "com", cm: "com", om: "com", comm: "com", vom: "com", xom: "com", nte: "net", ner: "net" };

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      // Adjacent swap ("gmial") counts as one edit
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
    }
  }
  return dp[a.length][b.length];
}

/** A corrected email when the domain looks like a typo of a common provider, else null. */
export function suggestEmailFix(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  const local = email.slice(0, at);
  let domain = email.slice(at + 1).replace(/\.+$/, "");
  if (KNOWN_VALID.has(domain)) return null;

  const dot = domain.lastIndexOf(".");
  if (dot > 0 && TLD_FIXES[domain.slice(dot + 1)]) domain = `${domain.slice(0, dot)}.${TLD_FIXES[domain.slice(dot + 1)]}`;
  if (COMMON_DOMAINS.includes(domain)) return `${local}@${domain}`;

  let best: string | null = null;
  let bestDistance = Infinity;
  for (const d of COMMON_DOMAINS) {
    const dist = editDistance(domain, d);
    if (dist < bestDistance) { best = d; bestDistance = dist; }
  }
  // Short domains need a closer match, so "me.com"-sized names aren't over-corrected
  const maxDistance = domain.length >= 8 ? 2 : 1;
  return best && bestDistance <= maxDistance ? `${local}@${best}` : null;
}
