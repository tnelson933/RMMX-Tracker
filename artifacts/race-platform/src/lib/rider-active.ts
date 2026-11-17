import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { riderApi, type RiderProfile } from "@/lib/rider-api";
import { useRiderAuth } from "@/contexts/RiderAuthContext";

// Mirrors the rider app's "checked riders drive the app" (rider-app/context/AuthContext.tsx):
// the account's profiles, with the ones the rider unchecked on the Profile page hidden
// from Home, My Races and Train. Kept per browser; every profile is active by default.
const HIDDEN_KEY = "rider-hidden-profile-ids";
const EVENT = "rider-hidden-profiles-changed";

function readHidden(): number[] {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.filter((n) => typeof n === "number") : [];
  } catch {
    return [];
  }
}

export function useRiderProfiles() {
  const { isAuthenticated } = useRiderAuth();
  return useQuery<RiderProfile[]>({
    queryKey: ["rider-profiles"],
    queryFn: () => riderApi.profiles(),
    enabled: isAuthenticated,
    staleTime: 60_000,
  });
}

export function useActiveRiders() {
  const profilesQuery = useRiderProfiles();
  const [hidden, setHidden] = useState<number[]>(readHidden);

  useEffect(() => {
    const sync = () => setHidden(readHidden());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const profiles = profilesQuery.data ?? [];
  const activeProfiles = useMemo(() => {
    const shown = profiles.filter((p) => !hidden.includes(p.id));
    // Never hide everything: with all unchecked, fall back to all profiles.
    return shown.length > 0 ? shown : profiles;
  }, [profiles, hidden]);

  const isActive = useCallback((id: number) => !hidden.includes(id), [hidden]);

  const toggleActive = useCallback((id: number) => {
    const next = hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id];
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    setHidden(next);
    window.dispatchEvent(new Event(EVENT));
  }, [hidden]);

  return { ...profilesQuery, profiles, activeProfiles, isActive, toggleActive };
}

/** Same avatar colours as the rider app's BrandBar. */
const PALETTE = ["#cf152d", "#2563eb", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#be185d", "#b45309"];
export function nameColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}
export function initials(first: string, last: string): string {
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}
