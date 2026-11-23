import { useCallback, useEffect, useRef, useState } from "react";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import { API_BASE_URL } from "@/lib/apiBase";

/** An event streaming live right now (GET /api/video/live-now). */
export interface LiveStreamEvent {
  eventId: number;
  name: string;
  date: string;
  state: string;
  location: string | null;
  trackName: string | null;
  imageUrl: string | null;
  clubName: string;
  cameras: Array<{ id: string; name: string }>;
  viewers: number;
  liveSince: string | null;
}

const POLL_MS = 30_000;

/**
 * Events streaming right now, refreshed every 30 seconds while the screen is
 * on top and the app is in the foreground.
 * Public: no sign-in needed to see what's live.
 */
export function useLiveStreams() {
  const [events, setEvents] = useState<LiveStreamEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE_URL}/api/video/live-now`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json() as { events?: LiveStreamEvent[] };
      if (alive.current) { setEvents(Array.isArray(body.events) ? body.events : []); setError(null); }
    } catch {
      if (alive.current) setError("Couldn't check for live streams. Pull down to try again.");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; };
  }, [refresh]);
  useVisibleInterval(refresh, POLL_MS);

  return { events, loading, error, refresh };
}

/** The website's Watch Live page for an event, which the app shows in its player. */
export function watchPageUrl(eventId: number): string {
  return `${API_BASE_URL}/watch/${eventId}?app=1`;
}

/** "Live 25 min", "Live 1 h 10 min". */
export function liveForLabel(liveSince: string | null, now = Date.now()): string {
  if (!liveSince) return "Live";
  const mins = Math.max(0, Math.round((now - Date.parse(liveSince)) / 60_000));
  if (mins < 60) return `Live ${mins} min`;
  return `Live ${Math.floor(mins / 60)} h ${mins % 60} min`;
}
