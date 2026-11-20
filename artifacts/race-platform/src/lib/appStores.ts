/**
 * Where riders download the RM Roost rider app. IDs from rider-app/eas.json
 * (App Store Connect app 6791718924) and app.json (Android package).
 * Both listings must be public for these to open (checked 2026-11-20: not yet).
 */
export const APP_STORE_URL = "https://apps.apple.com/app/id6791718924";
export const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.rockymountain.riderapp";

/** The phone's own store first: "ios", "android", or "other" (desktop: show both). */
export function phonePlatform(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): "ios" | "android" | "other" {
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1)) return "ios";
  return "other";
}

const DISMISSED_KEY = "rmroost.appPromoDismissedAt";
const QUIET_DAYS = 14;

/** Show the "get the app" popup unless this browser closed it in the last two weeks. */
export function shouldShowAppPromo(now = Date.now()): boolean {
  try {
    const at = Number(window.localStorage.getItem(DISMISSED_KEY) ?? 0);
    return !(at > 0 && now - at < QUIET_DAYS * 86_400_000);
  } catch {
    return true;
  }
}

export function rememberAppPromoDismissed(now = Date.now()) {
  try { window.localStorage.setItem(DISMISSED_KEY, String(now)); } catch { /* private window */ }
}
