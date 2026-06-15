import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { useColors } from "@/hooks/useColors";

export function BrandBar() {
  const colors = useColors();
  return (
    <View style={styles.row}>
      <View style={[styles.logoBox, { backgroundColor: colors.primary }]}>
        <Text style={styles.logoText}>RM</Text>
      </View>
      <View>
        <Text style={[styles.brand, { color: colors.foreground }]}>RMMX</Text>
        <Text style={[styles.sub, { color: colors.mutedForeground }]}>TRACKER</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
  },
  logoBox: {
    width: 34,
    height: 34,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: {
    fontSize: 13,
    fontWeight: "900",
    color: "#fff",
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.5,
  },
  brand: {
    fontSize: 15,
    fontWeight: "800",
    fontFamily: "Inter_700Bold",
    letterSpacing: 1,
    lineHeight: 17,
  },
  sub: {
    fontSize: 9,
    fontWeight: "700",
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    lineHeight: 12,
  },
});
