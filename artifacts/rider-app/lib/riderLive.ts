import Constants from "expo-constants";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";

import { API_BASE_URL } from "@/lib/apiBase";

/**
 * Rider live video (api-server routes/rider-live.ts). The camera runs in a
 * website page inside a WebView (race-platform pages/public/PhoneLive.tsx and
 * RiderLiveWatch.tsx); tickets travel in the URL fragment, which never reaches a server.
 */

export interface RiderLiveStatus {
  riderId: number;
  name: string;
  live: boolean;
  since: string | null;
  viewers: number;
  reconnecting: boolean;
  canWatch: boolean;
  watchTicket: string | null;
}

/**
 * Sound needs the app's microphone permission, added after 1.0.24. Under the
 * "appVersion" runtime policy the running JS always matches the installed
 * build's version, so older builds stream video only (asking for the
 * microphone without the permission would close the app on iPhone).
 */
export function canSendSound(version = Constants.expoConfig?.version ?? "0"): boolean {
  const [a, b, c] = version.split(".").map(n => Number(n) || 0);
  return a > 1 || (a === 1 && (b > 0 || c > 24));
}

const frag = (params: Record<string, string>) => new URLSearchParams(params).toString();

export function phoneLiveUrl(riderId: number, ticket: string, name: string): string {
  return `${API_BASE_URL}/phone-live/${riderId}#${frag({ ticket, name, audio: canSendSound() ? "1" : "0" })}`;
}

export function riderWatchUrl(riderId: number, ticket: string, name: string): string {
  return `${API_BASE_URL}/rider-live/${riderId}#${frag({ ticket, name })}`;
}

/** The rider's live status while the screen is open, checked every 20 s. */
export function useRiderLive(riderId: number, riderFetch: (path: string, options?: RequestInit) => Promise<Response>) {
  const [status, setStatus] = useState<RiderLiveStatus | null>(null);
  useFocusEffect(useCallback(() => {
    if (!Number.isInteger(riderId) || riderId <= 0) return;
    let stopped = false;
    const load = async () => {
      try {
        const r = await riderFetch(`/api/rider/live/${riderId}`);
        if (r.ok && !stopped) setStatus(await r.json());
      } catch { /* offline: keep the last status */ }
    };
    void load();
    const timer = setInterval(load, 20_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [riderId, riderFetch]));
  return status;
}
