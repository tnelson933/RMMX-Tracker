import { logger } from "./logger";

// Finds a track's coordinates for Quick Check-In with OpenStreetMap Nominatim.
// Tries the most specific address first, then falls back to track name and
// city/state. Returns null when nothing matched or the service failed.

type TrackAddress = {
  streetAddress?: string | null;
  trackName?: string | null;
  location?: string | null;
  state?: string | null;
  zip?: string | null;
};

export async function geocodeTrack(address: TrackAddress): Promise<{ lat: number; lng: number } | null> {
  const { streetAddress, trackName, location, state, zip } = address;
  const queries = [
    [streetAddress, location, state, zip],
    [streetAddress, location, state],
    [trackName, location, state],
    [location, state],
  ]
    .map(parts => parts.filter(Boolean).join(", "))
    .filter((q, i, all) => q.length > 0 && all.indexOf(q) === i);

  // Nominatim's usage policy asks for an identifying User-Agent with a contact.
  const contact = process.env.APP_URL ?? "https://www.rmroost.com";
  for (const query of queries) {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=us`,
        { headers: { "User-Agent": `RMRoost/1.0 (${contact})` }, signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) {
        logger.warn({ status: res.status }, "Track geocoding request failed");
        continue;
      }
      const results = (await res.json()) as Array<{ lat: string; lon: string }>;
      const lat = Number(results[0]?.lat);
      const lng = Number(results[0]?.lon);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    } catch (err) {
      logger.warn({ err }, "Track geocoding failed");
    }
  }
  return null;
}
