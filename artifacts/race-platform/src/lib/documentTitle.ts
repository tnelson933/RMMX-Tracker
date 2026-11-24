/**
 * Browser tab titles: "<page> · RM Roost". routeTitle() gives every route a
 * sensible default from its path; pages with a name worth showing (an event,
 * a live race, a rider) override it with useDocumentTitle().
 */

export const SITE_NAME = "RM Roost";

/** "<title> · RM Roost", or just "RM Roost" without a title. */
export function fullTitle(title: string | null | undefined): string {
  const t = (title ?? "").trim();
  return t ? `${t} · ${SITE_NAME}` : SITE_NAME;
}

const EXACT: Record<string, string> = {
  "/results": "Results",
  "/leaderboard": "Series Standings",
  "/login": "Organizer Login",
  "/setup-account": "Set Up Your Account",
  "/forgot-password": "Reset Password",
  "/support/decide": "Support Request",
  "/privacy": "Privacy Policy",
  "/terms": "Terms and Conditions",
  "/delete-account": "Delete Account",
  "/rider-app": "Rider App",
  "/scan": "Hand Scanner",
  "/pdf-view": "Document",
  "/rider/login": "Rider Login",
  "/rider/reset-password": "Reset Password",
  "/rider": "Rider Home",
  "/rider/home": "Rider Home",
  "/rider/races": "My Races",
  "/rider/results": "Rider Results",
  "/rider/train": "Train",
  "/rider/mechanic": "Mechanic",
  "/rider/new-profile": "New Rider Profile",
  "/rider/following": "Following",
  "/rider/portal": "Rider Profiles",
  "/rider/rm-cash": "RM Cash",
  "/gate": "Gate Schedule",
  "/gate-mobile": "Gate Schedule",
  "/no-access": "No Access",
  "/dashboard": "Dashboard",
  "/events": "Events",
  "/riders": "Riders",
  "/rfid/setup": "Reader Setup",
  "/rfid": "Timing Tags",
  "/offline-mode": "Offline Mode",
  "/offline/sync": "Offline Sync",
  "/series": "Series",
  "/points-tables": "Points Tables",
  "/payments": "Payments",
  "/discount-codes": "Discount Codes",
  "/practice": "Practice",
  "/notifications": "Notifications",
  "/race-day-display": "Race Day Display",
  "/team": "Team",
  "/staff": "Staff",
  "/admin/clubs": "Admin · Clubs",
  "/admin/users": "Admin · Users",
  "/admin/notifications": "Admin · Notifications",
  "/admin/support": "Admin · Support",
  "/admin/race-gas": "Admin · Race Gas",
};

/** Routes with an id, until the page knows the name. First match wins. */
const PREFIXES: Array<[RegExp, string]> = [
  [/^\/results\/\d+/, "Event"],
  [/^\/register\/\d+/, "Register"],
  [/^\/live\/\d+/, "Live Timing"],
  [/^\/watch\/\d+/, "Watch Live"],
  [/^\/(rider\/racer|racer)\/\d+/, "Racer Profile"],
  [/^\/rider\/portal\/\d+/, "Rider Profile"],
  [/^\/(phone-live|rider-live)\/\d+/, "Live"],
  [/^\/widget\//, ""],
  [/^\/events\/\d+/, "Event"],
  [/^\/riders\/\d+/, "Rider"],
];

/** The default tab title for a path (no query string). */
export function routeTitle(path: string): string {
  const p = (path.split(/[?#]/)[0] || "/").replace(/\/+$/, "") || "/";
  if (p === "/") return SITE_NAME;
  if (EXACT[p] != null) return fullTitle(EXACT[p]);
  for (const [re, title] of PREFIXES) if (re.test(p)) return fullTitle(title);
  return fullTitle("Page Not Found");
}
