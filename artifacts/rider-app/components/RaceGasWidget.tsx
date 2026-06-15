import { Feather } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";

export function RaceGasWidget() {
  const colors = useColors();
  const { isAuthenticated, riderFetch } = useRiderAuth();
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    if (!isAuthenticated) { setBalance(null); return; }
    riderFetch("/api/rider/race-gas-balance")
      .then(r => (r.ok ? r.json() : null))
      .then((d: { balance: number } | null) => {
        if (d?.balance !== undefined) setBalance(d.balance);
      })
      .catch(() => {});
  }, [isAuthenticated, riderFetch]);

  if (!isAuthenticated || balance === null) return null;

  return (
    <View style={[styles.pill, { backgroundColor: colors.muted, borderColor: colors.border }]}>
      <Feather name="zap" size={10} color="#16a34a" />
      <View>
        <Text style={[styles.label, { color: colors.mutedForeground }]}>RACE GAS</Text>
        <Text style={[styles.amount, { color: "#16a34a" }]}>${balance.toFixed(2)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  label: {
    fontSize: 8,
    fontWeight: "700",
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    lineHeight: 10,
  },
  amount: {
    fontSize: 13,
    fontWeight: "800",
    fontFamily: "Inter_700Bold",
    lineHeight: 15,
  },
});
