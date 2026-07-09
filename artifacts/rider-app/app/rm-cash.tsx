import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as Linking from "expo-linking";
import React, { useEffect, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";

export default function RmCashScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { isAuthenticated, riderFetch, account } = useRiderAuth();
  const [balance, setBalance] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) { setLoading(false); return; }
    riderFetch("/api/rider/rm-cash-balance")
      .then(r => (r.ok ? r.json() : null))
      .then((d: { balance: number } | null) => {
        if (d != null && typeof d.balance === "number") setBalance(d.balance);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isAuthenticated, riderFetch]);

  const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    topBar: {
      paddingTop: insets.top + 10,
      paddingHorizontal: 16,
      paddingBottom: 8,
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.background,
    },
    backBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
    backText: { fontSize: 15, color: colors.primary, fontFamily: "Inter_600SemiBold" },
    content: { flex: 1, paddingHorizontal: 16, paddingTop: 8 },
    iconCircle: {
      width: 64, height: 64, borderRadius: 32,
      backgroundColor: "#dcfce7",
      alignItems: "center", justifyContent: "center",
      alignSelf: "center", marginTop: 12, marginBottom: 12,
    },
    title: {
      fontSize: 22, fontWeight: "800", color: colors.foreground,
      fontFamily: "Inter_700Bold", letterSpacing: -0.3,
      textAlign: "center",
    },
    subtitle: {
      fontSize: 13, color: colors.mutedForeground,
      fontFamily: "Inter_400Regular", textAlign: "center", marginTop: 4, marginBottom: 20,
    },
    balanceCard: {
      borderRadius: 16,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: "#bbf7d0",
      paddingVertical: 28,
      paddingHorizontal: 16,
      alignItems: "center",
      marginBottom: 24,
    },
    balanceLabel: {
      fontSize: 11, fontWeight: "700", color: colors.mutedForeground,
      fontFamily: "Inter_700Bold", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6,
    },
    balanceAmount: {
      fontSize: 52, fontWeight: "800", color: "#16a34a",
      fontFamily: "Inter_700Bold", letterSpacing: -1,
    },
    sectionRow: {
      flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 10,
    },
    sectionTitle: {
      fontSize: 11, fontWeight: "700", color: colors.mutedForeground,
      fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.8,
    },
    emptyCard: {
      borderRadius: 14, backgroundColor: colors.card,
      borderWidth: 1, borderColor: colors.border,
      paddingVertical: 40, paddingHorizontal: 24,
      alignItems: "center", gap: 10,
    },
    emptyText: {
      fontSize: 14, color: colors.mutedForeground,
      fontFamily: "Inter_400Regular", textAlign: "center",
    },
    txCard: {
      borderRadius: 14, backgroundColor: colors.card,
      borderWidth: 1, borderColor: colors.border,
      overflow: "hidden",
    },
    txRow: {
      flexDirection: "row", alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: 14, paddingHorizontal: 16,
    },
    txDivider: {
      height: 1, backgroundColor: colors.border, marginHorizontal: 16,
    },
    txName: {
      fontSize: 14, color: colors.foreground,
      fontFamily: "Inter_600SemiBold",
    },
    txAmount: {
      fontSize: 14, color: "#16a34a",
      fontFamily: "Inter_700Bold",
    },
    useBtn: {
      marginBottom: insets.bottom + 20,
      marginTop: 16,
      marginHorizontal: 16,
      backgroundColor: "#cf152d",
      borderRadius: 14,
      paddingVertical: 16,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
    },
    useBtnText: {
      color: "#fff", fontSize: 16, fontWeight: "800",
      fontFamily: "Inter_700Bold", letterSpacing: 0.4,
    },
  });

  return (
    <View style={s.container}>
      <View style={s.topBar}>
        <Pressable style={s.backBtn} onPress={() => router.back()}>
          <Feather name="chevron-left" size={20} color={colors.primary} />
          <Text style={s.backText}>Back</Text>
        </Pressable>
      </View>

      <ScrollView style={s.content} contentContainerStyle={{ paddingBottom: 16 }}>
        <View style={s.iconCircle}>
          <Feather name="zap" size={30} color="#16a34a" />
        </View>
        <Text style={s.title}>RM Cash</Text>
        <Text style={s.subtitle}>Your Rocky Mountain ATV/MC balance</Text>

        <View style={s.balanceCard}>
          <Text style={s.balanceLabel}>Available Balance</Text>
          <Text style={s.balanceAmount}>
            {loading ? "—" : `$${balance.toFixed(2)}`}
          </Text>
        </View>

        <View style={s.sectionRow}>
          <Feather name="clock" size={13} color={colors.mutedForeground} />
          <Text style={s.sectionTitle}>Transaction History</Text>
        </View>

        {account?.email === "tnelson933@gmail.com" ? (
          <View style={s.txCard}>
            {[
              { name: "RM Fantasy Cash", amount: "+$15.47" },
              { name: "Race Gas", amount: "+$15.00" },
              { name: "RM Quick Cash", amount: "+$17.03" },
            ].map((tx, i, arr) => (
              <React.Fragment key={tx.name}>
                <View style={s.txRow}>
                  <Text style={s.txName}>{tx.name}</Text>
                  <Text style={s.txAmount}>{tx.amount}</Text>
                </View>
                {i < arr.length - 1 && <View style={s.txDivider} />}
              </React.Fragment>
            ))}
          </View>
        ) : (
          <View style={s.emptyCard}>
            <Feather name="inbox" size={32} color={colors.mutedForeground} style={{ opacity: 0.4 }} />
            <Text style={s.emptyText}>
              Your RM Cash history will appear here once you've earned credits
            </Text>
          </View>
        )}
      </ScrollView>

      <Pressable
        style={({ pressed }) => [s.useBtn, pressed && { opacity: 0.85 }]}
        onPress={() => Linking.openURL("https://www.rockymountainatvmc.com")}
      >
        <Text style={s.useBtnText}>Use your cash</Text>
        <Feather name="external-link" size={16} color="#fff" />
      </Pressable>
    </View>
  );
}
