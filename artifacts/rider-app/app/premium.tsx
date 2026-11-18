import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useBottomSpace } from "@/hooks/useBottomSpace";
import { useRiderAuth } from "@/context/AuthContext";
import { fonts } from "@/constants/fonts";
import { goBack } from "@/lib/navigation";
import { API_BASE_URL } from "@/lib/apiBase";
import {
  LIST_PRICES, buy, loadPackages, restore, storeAvailable,
  type ProductKey, type StorePackage,
} from "@/lib/premium";
import { usePremium } from "@/hooks/usePremium";

const PLANS: Array<{ key: ProductKey; title: string; sub: string; badge?: string }> = [
  { key: "individualYearly", title: "Premium yearly", sub: "1 rider · 1 phone", badge: "Best value" },
  { key: "individualMonthly", title: "Premium monthly", sub: "1 rider · 1 phone" },
  { key: "familyYearly", title: "Family yearly", sub: "Up to 4 riders · 4 phones" },
];

const FEATURES = [
  { icon: "clock", text: "Every past race and practice: laps, trends and career stats" },
  { icon: "message-circle", text: "Unlimited Rocky: coach, mechanic, training and maintenance plans" },
  { icon: "video", text: "Unlimited live streams of every race" },
] as const;

/** RM Roost Premium: buy (App Store / Google Play only), restore, pick riders, manage. */
export default function PremiumScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const bottomSpace = useBottomSpace();
  const { account, profiles } = useRiderAuth();
  const { summary, loading, error, refresh, pickRiders } = usePremium();
  const [packages, setPackages] = useState<StorePackage[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [chosen, setChosen] = useState<number[]>([]);
  const s = styles(colors);

  useEffect(() => {
    if (!account || !storeAvailable()) return;
    loadPackages(account.id).then(setPackages).catch(() => setPackages([]));
  }, [account]);

  useEffect(() => { if (summary) setChosen(summary.riderIds); }, [summary]);

  const price = (key: ProductKey) => packages.find(p => p.key === key)?.price ?? LIST_PRICES[key].split("/")[0];
  const period = (key: ProductKey) => (key === "individualMonthly" ? "/month" : "/year");
  const canBuy = storeAvailable() && !!summary?.enforced;

  async function afterPurchase() {
    await refresh(true);
  }

  // Right after buying: one rider (or no more riders than slots) → cover them automatically.
  useEffect(() => {
    if (!summary?.active || !summary.needsRiderChoice) return;
    if (profiles.length > 0 && profiles.length <= summary.riderSlots) {
      void pickRiders(profiles.map(p => p.id)).catch(() => {});
    }
  }, [summary, profiles, pickRiders]);

  async function onBuy(key: ProductKey) {
    if (!account) return;
    const pkg = packages.find(p => p.key === key);
    if (!pkg) { Alert.alert("Not available yet", "This plan isn't available in the store yet. Try again later."); return; }
    setBusy(key);
    const r = await buy(account.id, pkg);
    if (r.ok) await afterPurchase();
    else if (!r.cancelled) Alert.alert("Purchase didn't go through", r.message);
    setBusy(null);
  }

  async function onRestore() {
    if (!account) return;
    setBusy("restore");
    const r = await restore(account.id);
    if (r.ok) { await afterPurchase(); Alert.alert("Purchases restored", "If this Apple or Google account has RM Roost Premium, it's back on this account."); }
    else Alert.alert("Couldn't restore", r.message);
    setBusy(null);
  }

  async function onSaveRiders() {
    setBusy("riders");
    try { await pickRiders(chosen); }
    catch (err) { Alert.alert("Couldn't save", (err as Error).message); }
    finally { setBusy(null); }
  }

  const locked = useMemo(() => new Set(summary?.riderIds ?? []), [summary]);
  const toggleRider = (id: number) => setChosen(prev => {
    if (locked.has(id)) return prev;
    if (prev.includes(id)) return prev.filter(x => x !== id);
    const slots = summary?.riderSlots ?? 1;
    const next = [...prev, id];
    return next.length > slots ? [...[...locked], ...next.filter(x => !locked.has(x)).slice(-(slots - locked.size))] : next;
  });

  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => goBack(router)} accessibilityRole="button" accessibilityLabel="Back" style={({ pressed }) => [s.backBtn, { opacity: pressed ? 0.6 : 1 }]}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </Pressable>
        <Text style={s.headerTitle}>RM Roost Premium</Text>
      </View>

      <ScrollView contentContainerStyle={[s.content, { paddingBottom: bottomSpace + 32 }]}>
        {loading && !summary ? <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} /> : null}
        {!!error && <Text style={[s.muted, { color: "#DC2626" }]}>{error}</Text>}

        {summary && !summary.enforced && !summary.active && (
          <View style={s.notice}>
            <Feather name="gift" size={18} color={colors.primary} />
            <Text style={s.noticeText}>Every feature is free right now, so there's nothing to buy. Premium plans will appear here when RM Roost starts them.</Text>
          </View>
        )}

        {summary?.active ? (
          <>
            <View style={s.card}>
              <Text style={s.cardKicker}>YOUR PLAN</Text>
              <Text style={s.cardTitle}>{summary.plan === "family" ? "Premium Family" : "Premium"}</Text>
              <Text style={s.muted}>
                {summary.until ? `Renews or ends ${new Date(summary.until).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}` : ""}
                {` · ${summary.riderSlots} rider${summary.riderSlots === 1 ? "" : "s"} · ${summary.maxPhones} phone${summary.maxPhones === 1 ? "" : "s"}`}
              </Text>
            </View>

            <Text style={s.section}>Riders with Premium ({summary.riderIds.length} of {summary.riderSlots})</Text>
            {profiles.length === 0 ? (
              <Text style={s.muted}>Add a rider profile first; Premium unlocks for the riders you pick here.</Text>
            ) : (
              <View style={s.card}>
                {profiles.map(p => {
                  const on = chosen.includes(p.id);
                  return (
                    <Pressable key={p.id} onPress={() => toggleRider(p.id)} disabled={locked.has(p.id)} style={s.riderRow}
                      accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: locked.has(p.id) }}>
                      <Feather name={on ? "check-square" : "square"} size={20} color={on ? colors.primary : colors.mutedForeground} />
                      <Text style={s.riderName}>{`${p.firstName} ${p.lastName}`.trim()}</Text>
                      {locked.has(p.id) && <Text style={s.mutedSmall}>Premium</Text>}
                    </Pressable>
                  );
                })}
                {chosen.length > summary.riderIds.length && (
                  <Pressable onPress={onSaveRiders} disabled={busy === "riders"} style={[s.primaryBtn, { marginTop: 10 }]}>
                    <Text style={s.primaryBtnText}>{busy === "riders" ? "Saving…" : "Save riders"}</Text>
                  </Pressable>
                )}
                <Text style={[s.mutedSmall, { marginTop: 8 }]}>
                  {summary.plan === "individual"
                    ? "Premium covers 1 rider. To cover up to 4, choose Family. Changing a rider who already has Premium goes through RM Roost support."
                    : "Family covers up to 4 riders. Changing a rider who already has Premium goes through RM Roost support."}
                </Text>
              </View>
            )}

            {summary.source === "stripe" ? (
              <Text style={[s.muted, { textAlign: "center" }]}>This Premium was bought on the RM Roost website. Manage or cancel it there, under your profile.</Text>
            ) : (summary.source === "apple" || summary.source === "google") && Platform.OS !== "web" ? (
              <Pressable onPress={() => { void Linking.openURL(summary.source === "google" ? "https://play.google.com/store/account/subscriptions" : "https://apps.apple.com/account/subscriptions"); }} style={s.linkRow}>
                <Feather name="settings" size={15} color={colors.primaryText} />
                <Text style={s.link}>Manage or cancel in {summary.source === "google" ? "Google Play" : "the App Store"}</Text>
              </Pressable>
            ) : null}
          </>
        ) : (
          <>
            <View style={s.hero}>
              <Text style={s.heroTitle}>Get the whole season, not just race day</Text>
              {FEATURES.map(f => (
                <View key={f.text} style={s.featureRow}>
                  <Feather name={f.icon} size={16} color="#fff" />
                  <Text style={s.featureText}>{f.text}</Text>
                </View>
              ))}
              <Text style={s.heroSmall}>Free: today's live results, registration, check-in, 1 Rocky question every 72 hours and 30 minutes of live streaming.</Text>
            </View>

            {PLANS.map(p => (
              <View key={p.key} style={s.planCard}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={s.planTitle}>{p.title}</Text>
                    {!!p.badge && <Text style={s.badge}>{p.badge}</Text>}
                  </View>
                  <Text style={s.muted}>{p.sub}</Text>
                </View>
                <Pressable onPress={() => onBuy(p.key)} disabled={!canBuy || busy != null}
                  style={({ pressed }) => [s.buyBtn, { opacity: !canBuy ? 0.4 : pressed ? 0.8 : 1 }]}
                  accessibilityRole="button" accessibilityLabel={`Buy ${p.title} for ${price(p.key)}${period(p.key)}`}>
                  {busy === p.key ? <ActivityIndicator color="#fff" /> : <Text style={s.buyText}>{price(p.key)}<Text style={s.buyPeriod}>{period(p.key)}</Text></Text>}
                </Pressable>
              </View>
            ))}

            {!storeAvailable() && (
              <Text style={s.muted}>Premium is bought in the RM Roost app on iPhone or Android.</Text>
            )}
          </>
        )}

        {storeAvailable() && (
          <Pressable onPress={onRestore} disabled={busy != null} style={s.linkRow}>
            <Feather name="rotate-ccw" size={15} color={colors.primaryText} />
            <Text style={s.link}>{busy === "restore" ? "Restoring…" : "Restore purchases"}</Text>
          </Pressable>
        )}

        <Text style={s.legal}>
          Subscriptions renew automatically at the price shown until cancelled. Payment is charged to your {Platform.OS === "android" ? "Google Play" : "Apple ID"} account
          at confirmation. Cancel any time in your {Platform.OS === "android" ? "Google Play" : "App Store"} subscriptions at least 24 hours before the period ends. No free trial.
        </Text>
        <View style={{ flexDirection: "row", gap: 16, justifyContent: "center" }}>
          <Pressable onPress={() => { void Linking.openURL(`${API_BASE_URL}/terms`); }}><Text style={s.link}>Terms</Text></Pressable>
          <Pressable onPress={() => { void Linking.openURL(`${API_BASE_URL}/privacy`); }}><Text style={s.link}>Privacy</Text></Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = (colors: ReturnType<typeof useColors>) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, gap: 12 },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.muted, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, fontSize: 17, color: colors.foreground, fontFamily: fonts.bold },
  content: { padding: 16, gap: 14 },
  notice: { flexDirection: "row", gap: 10, alignItems: "flex-start", backgroundColor: colors.card, borderRadius: 12, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  noticeText: { flex: 1, fontFamily: fonts.regular, fontSize: 14, color: colors.foreground, lineHeight: 20 },
  hero: { backgroundColor: "#1A1A1A", borderRadius: 16, padding: 16, gap: 10 },
  heroTitle: { color: "#fff", fontFamily: fonts.displayHeavy, fontSize: 22 },
  featureRow: { flexDirection: "row", gap: 10, alignItems: "center" },
  featureText: { flex: 1, color: "#fff", fontFamily: fonts.medium, fontSize: 14 },
  heroSmall: { color: "rgba(255,255,255,0.6)", fontFamily: fonts.regular, fontSize: 12, marginTop: 4 },
  planCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.card, borderRadius: 14, padding: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  planTitle: { fontFamily: fonts.display, fontSize: 17, color: colors.foreground },
  badge: { fontFamily: fonts.bold, fontSize: 11, color: "#fff", backgroundColor: colors.primary, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, overflow: "hidden" },
  buyBtn: { backgroundColor: colors.primary, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10, minWidth: 110, alignItems: "center" },
  buyText: { color: "#fff", fontFamily: fonts.bold, fontSize: 15 },
  buyPeriod: { color: "rgba(255,255,255,0.8)", fontFamily: fonts.regular, fontSize: 12 },
  card: { backgroundColor: colors.card, borderRadius: 14, padding: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, gap: 4 },
  cardKicker: { fontFamily: fonts.display, fontSize: 11, letterSpacing: 1, color: colors.mutedForeground },
  cardTitle: { fontFamily: fonts.displayHeavy, fontSize: 22, color: colors.foreground },
  section: { fontFamily: fonts.display, fontSize: 15, color: colors.foreground, marginTop: 4 },
  riderRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  riderName: { flex: 1, fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
  primaryBtn: { backgroundColor: colors.primary, borderRadius: 999, paddingVertical: 11, alignItems: "center" },
  primaryBtnText: { color: "#fff", fontFamily: fonts.bold, fontSize: 15 },
  linkRow: { flexDirection: "row", alignItems: "center", gap: 8, justifyContent: "center", paddingVertical: 6 },
  link: { color: colors.primaryText, fontFamily: fonts.medium, fontSize: 14 },
  muted: { fontFamily: fonts.regular, fontSize: 13, color: colors.mutedForeground, lineHeight: 19 },
  mutedSmall: { fontFamily: fonts.regular, fontSize: 12, color: colors.mutedForeground },
  legal: { fontFamily: fonts.regular, fontSize: 11, color: colors.mutedForeground, lineHeight: 16, textAlign: "center", marginTop: 8 },
});
