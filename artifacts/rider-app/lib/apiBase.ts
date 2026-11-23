// Base URL for every API call. Builds set EXPO_PUBLIC_DOMAIN (eas.json); local
// testing can set EXPO_PUBLIC_API_URL to a full URL such as http://10.0.2.2:8080
// to talk to a dev API without https.
const override = process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, "");
const domain = process.env.EXPO_PUBLIC_DOMAIN;

/** The live site. An update or build with no address set talks to this, never to "" (every call would fail). */
export const PRODUCTION_ORIGIN = "https://www.rmroost.com";

export const API_BASE_URL = override || (domain ? `https://${domain}` : PRODUCTION_ORIGIN);

/** A page on the public website (the API and the website share one address), e.g. webUrl("/racer/12"). */
export function webUrl(path: string): string {
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
