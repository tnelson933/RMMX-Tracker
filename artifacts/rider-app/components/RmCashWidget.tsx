import { Feather } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";

/**
 * RM Cash balance chip. Shown only once a rider actually has RM Cash: while
 * monetization is off almost everyone is at $0.00, and a zero chip in every
 * header is noise. Hidden while the balance is loading or unknown too.
 */
export function RmCashWidget({ onPress }: { onPress?: () => void } = {}) {
  const colors = useColors();
  const { isAuthenticated, riderFetch } = useRiderAuth();
  // null until the balance is known: a failed request must not read as "$0.00".
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    if (!isAuthenticated) { setBalance(null); return; }

    riderFetch("/api/rider/rm-cash-balance")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { balance: number } | null) => {
        if (data != null && typeof data.balance === "number") {
          setBalance(data.balance);
        }
      })
      .catch(() => {});
  }, [isAuthenticated, riderFetch]);

  if (balance == null || balance <= 0) return null;
  const amount = `$${balance.toFixed(2)}`;

  const pill = (
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
        <Text style={[styles.amount, { fontVariant: ["tabular-nums"] }]}>{amount}</Text>
      </View>
    </View>
  );
  if (!onPress) return pill;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`RM Cash balance, ${amount}`}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      {pill}
    </Pressable>
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
    fontFamily: "Roboto_700Bold",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    lineHeight: 10,
  },
  amount: {
    fontSize: 13,
    fontWeight: "800",
    fontFamily: "Roboto_700Bold",
    lineHeight: 15,
    color: "#16a34a",
  },
});