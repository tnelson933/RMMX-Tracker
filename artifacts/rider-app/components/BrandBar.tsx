import React from "react";
import { View, Text, Image, StyleSheet, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { useColors } from "@/hooks/useColors";
import { useTheme } from "@/context/ThemeContext";
import { RmCashWidget } from "@/components/RmCashWidget";
import { useRiderAuth } from "@/context/AuthContext";

// ─── Profile Avatars ──────────────────────────────────────────────────────────

const PALETTE = [
  "#cf152d", "#2563eb", "#16a34a", "#d97706",
  "#7c3aed", "#0891b2", "#be185d", "#b45309",
];

function nameColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function initials(first: string, last: string): string {
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

const CIRCLE = 24;

function ProfileAvatars() {
  const { activeProfiles, isAuthenticated } = useRiderAuth();
  const colors = useColors();

  if (!isAuthenticated || activeProfiles.length === 0) return null;

  const MAX = 3;
  const shown = activeProfiles.slice(0, MAX);
  const overflow = activeProfiles.length - MAX;

  return (
    <View style={pa.row}>
      {shown.map((p, idx) => {
        const bg = nameColor(`${p.firstName}${p.lastName}`);
        const ini = initials(p.firstName, p.lastName);
        return (
          <View
            key={p.id}
            style={[
              pa.circle,
              {
                backgroundColor: bg,
                borderColor: colors.background,
                marginLeft: idx === 0 ? 0 : -7,
                zIndex: MAX - idx,
              },
            ]}
          >
            <Text style={pa.text}>{ini}</Text>
          </View>
        );
      })}
      {overflow > 0 && (
        <View
          style={[
            pa.circle,
            { backgroundColor: colors.mutedForeground, borderColor: colors.background, marginLeft: -7, zIndex: 0 },
          ]}
        >
          <Text style={pa.text}>+{overflow}</Text>
        </View>
      )}
    </View>
  );
}

const pa = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    marginRight: 6,
  },
  circle: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
  },
  text: {
    fontSize: 8,
    fontWeight: "800",
    fontFamily: "Inter_700Bold",
    color: "#fff",
    letterSpacing: 0.2,
  },
});

// ─── BrandBar ─────────────────────────────────────────────────────────────────

export function BrandBar() {
  const router = useRouter();
  const isDark = useTheme().resolvedScheme === "dark";
  return (
    <View style={styles.row}>
      <View style={styles.left}>
        {/* White-lettered banner on dark; an inverted (black-lettered) copy on light. Red stays red. */}
        <View style={styles.bannerBare}>
          <Image
            source={isDark ? require("../assets/images/brand-banner-hero.png") : require("../assets/images/brand-banner-hero-light.png")}
            style={styles.bannerLarge}
            resizeMode="contain"
            accessibilityLabel="RM Roost"
          />
        </View>
      </View>

      <View style={styles.right}>
        <ProfileAvatars />
        <TouchableOpacity onPress={() => router.push("/rm-cash")} activeOpacity={0.7}>
          <RmCashWidget />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  left: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
  },
  bannerBare: {
    marginLeft: -6,
  },
  bannerLarge: {
    width: 150,
    height: 47,
  },
});
