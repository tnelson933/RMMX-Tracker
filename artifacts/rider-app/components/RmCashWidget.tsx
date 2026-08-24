import { Feather } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";

export function RmCashWidget() {
  const colors = useColors();
  const { isAuthenticated, riderFetch } = useRiderAuth();
  const [balance, setBalance] = useState<number>(0);

  useEffect(() => {
    if (!isAuthenticated) return;

    riderFetch("/api/rider/rm-cash-balance")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { balance: number } | null) => {
        if (data != null && typeof data.balance === "number") {
          setBalance(data.balance);
        }
      })
      .catch(() => {});
  }, [isAuthenticated, riderFetch]);

  return (
    <View
      style={[
        styles.pill,
        { backgroundColor: colors.muted, borderColor: colors.border },
      ]}
    >
      <Feather name="zap" size={10} color="#16a34a" />
      <View>
        <Text style={[styles.label, { color: colors.mutedForeground }]}>
          RM CASH
        </Text>
        <Text style={styles.amount}>${balance.toFixed(2)}</Text>
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
    borderWidth: 1,
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
    color: "#16a34a",
  },
});