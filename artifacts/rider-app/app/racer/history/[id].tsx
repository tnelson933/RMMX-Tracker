import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ResultCard } from "@/components/RaceCards";
import { fonts } from "@/constants/fonts";
import { useRiderAuth } from "@/context/AuthContext";
import { useBottomSpace } from "@/hooks/useBottomSpace";
import { useColors } from "@/hooks/useColors";
import { NETWORK_ERROR_MESSAGE, serverErrorMessage } from "@/lib/friendlyErrors";
import { goBack } from "@/lib/navigation";

interface HistoryItem {
  eventId: number;
  eventName: string;
  eventDate: string;
  raceClass: string;
  bestPosition: number | null;
  official?: boolean;
  track?: string | null;
  motos?: Array<{ motoName: string; position: number | null; dnf: boolean; dns: boolean }>;
}

interface History {
  filters?: { years?: string[]; classes?: string[]; tracks?: string[] };
  total?: number;
  items?: HistoryItem[];
}

type FilterKey = "year" | "class" | "track";
type Filters = Record<FilterKey, string | null>;

/** A racer's full results history, newest first, filtered by year, class and track. */
export default function RacerHistoryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const bottomSpace = useBottomSpace();
  const router = useRouter();
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { riderFetch } = useRiderAuth();
  const [filters, setFilters] = useState<Filters>({ year: null, class: null, track: null });
  const [data, setData] = useState<History | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request may fill the list, so quick chip taps can't show stale results.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    const query = (Object.keys(filters) as FilterKey[])
      .filter(k => filters[k])
      .map(k => `${k}=${encodeURIComponent(filters[k]!)}`)
      .join("&");
    try {
      const r = await riderFetch(`/api/rider/riders/${id}/history${query ? `?${query}` : ""}`);
      if (mine !== seq.current) return;
      if (!r.ok) {
        setError(r.status === 404
          ? "The full history isn't available for this rider yet. Go back to see their recent results."
          : r.status >= 500 ? serverErrorMessage(r.status) : `Couldn't load the results history (error ${r.status}). Try again.`);
        return;
      }
      const body = await r.json() as History;
      if (mine !== seq.current) return;
      setData(body);
    } catch {
      if (mine === seq.current) setError(NETWORK_ERROR_MESSAGE);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [filters, id, riderFetch]);
  useEffect(() => { void load(); }, [load]);

  const s = styles(colors);
  const items = Array.isArray(data?.items) ? data!.items! : [];
  const total = data?.total ?? items.length;
  const filtered = !!(filters.year || filters.class || filters.track);
  const rows: Array<{ key: FilterKey; label: string; options: string[] }> = [
    { key: "year", label: "Year", options: data?.filters?.years ?? [] },
    { key: "class", label: "Class", options: data?.filters?.classes ?? [] },
    { key: "track", label: "Track", options: data?.filters?.tracks ?? [] },
  ];

  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => goBack(router)} accessibilityRole="button" accessibilityLabel="Back" style={({ pressed }) => [s.backBtn, { opacity: pressed ? 0.6 : 1 }]}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle} numberOfLines={1}>Results history</Text>
          {name ? <Text style={s.muted} numberOfLines={1}>{name}</Text> : null}
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingTop: 12, paddingBottom: bottomSpace }}>
        {rows.map(row => (row.options.length === 0 ? null : (
          <View key={row.key} style={s.filterRow}>
            <Text style={s.filterLabel}>{row.label}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 16 }}>
              {[null, ...row.options].map(option => {
                const selected = filters[row.key] === option;
                return (
                  <Pressable key={option ?? "__all"} onPress={() => setFilters(f => ({ ...f, [row.key]: option }))}
                    accessibilityRole="button" accessibilityState={{ selected }}
                    style={({ pressed }) => [s.chip, selected ? s.chipOn : null, { opacity: pressed ? 0.7 : 1 }]}>
                    <Text style={[s.chipText, selected ? { color: "#FFFFFF" } : null]} numberOfLines={1}>{option ?? "All"}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        )))}

        {error ? (
          <View style={s.center}>
            <Text style={[s.muted, { textAlign: "center" }]}>{error}</Text>
            <Pressable onPress={() => { void load(); }} style={({ pressed }) => ({ marginTop: 12, opacity: pressed ? 0.6 : 1 })}>
              <Text style={s.link}>Try again</Text>
            </Pressable>
          </View>
        ) : !data ? (
          <View style={s.center}><ActivityIndicator color={colors.primaryText} /></View>
        ) : (
          <>
            <View style={s.countRow}>
              <Text style={s.muted}>
                {filtered ? `${items.length} of ${total} ${total === 1 ? "result" : "results"}` : `${total} ${total === 1 ? "result" : "results"}`}
              </Text>
              {loading ? <ActivityIndicator size="small" color={colors.mutedForeground} /> : null}
            </View>
            {items.length === 0 ? (
              <View style={s.center}>
                <Text style={[s.muted, { textAlign: "center" }]}>
                  {filtered ? "No results match these filters." : "No published results yet."}
                </Text>
                {filtered ? (
                  <Pressable onPress={() => setFilters({ year: null, class: null, track: null })} style={({ pressed }) => ({ marginTop: 12, opacity: pressed ? 0.6 : 1 })}>
                    <Text style={s.link}>Clear filters</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : items.map((r, i) => (
              <ResultCard
                key={`${r.eventId}-${r.raceClass}-${i}`}
                position={r.bestPosition}
                title={r.eventName}
                dateIso={r.eventDate}
                raceClass={r.raceClass}
                place={r.track}
                motos={r.motos}
                official={r.official}
                onPress={() => router.push(`/event/${r.eventId}` as any)}
              />
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = (colors: ReturnType<typeof useColors>) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, gap: 12 },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.muted, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontSize: 17, color: colors.foreground, fontFamily: fonts.bold },
  filterRow: { flexDirection: "row", alignItems: "center", paddingLeft: 16, marginBottom: 10 },
  filterLabel: { width: 52, fontSize: 12, letterSpacing: 1, textTransform: "uppercase", color: colors.mutedForeground, fontFamily: fonts.display },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, maxWidth: 220 },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, color: colors.foreground, fontFamily: fonts.semibold },
  countRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 10, minHeight: 30 },
  center: { alignItems: "center", justifyContent: "center", padding: 32 },
  link: { color: colors.primaryText, fontFamily: fonts.semibold, fontSize: 14 },
  muted: { fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.regular, lineHeight: 17 },
});
