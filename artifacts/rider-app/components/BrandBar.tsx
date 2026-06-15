import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { useColors } from "@/hooks/useColors";

export function BrandBar() {
  const colors = useColors();
  return (
    <View style={styles.row}>
      <Image
        source={require("../assets/images/rm-logo.png")}
        style={styles.logo}
        resizeMode="contain"
      />
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
  logo: {
    width: 36,
    height: 36,
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
