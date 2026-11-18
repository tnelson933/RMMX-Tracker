import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";

import { useRiderAuth } from "@/context/AuthContext";
import type { PremiumSummary } from "@/lib/premium";

/** This account's Premium, refreshed on focus. */
export function usePremium() {
  const { account, riderFetch } = useRiderAuth();
  const [summary, setSummary] = useState<PremiumSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (sync = false) => {
    if (!account) { setSummary(null); setLoading(false); return; }
    try {
      const r = await riderFetch(sync ? "/api/rider/premium/sync" : "/api/rider/premium", sync ? { method: "POST" } : {});
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error ?? `Couldn't load Premium (error ${r.status}).`);
      setSummary(body as PremiumSummary);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [account, riderFetch]);

  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  /** Pick which riders Premium covers (empty slots only). */
  const pickRiders = useCallback(async (riderIds: number[]) => {
    const r = await riderFetch("/api/rider/premium/riders", { method: "PUT", body: JSON.stringify({ riderIds }) });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error(body?.error ?? "Couldn't save. Try again.");
    setSummary(body as PremiumSummary);
  }, [riderFetch]);

  return { summary, loading, error, refresh, pickRiders };
}
