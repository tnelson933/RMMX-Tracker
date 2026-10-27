import { BlurView } from "expo-blur";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Tabs } from "expo-router";
import { Icon, Label, NativeTabs } from "expo-router/unstable-native-tabs";
import { SymbolView } from "expo-symbols";
import { Feather } from "@expo/vector-icons";
import React from "react";
import { Platform, StyleSheet, View } from "react-native";

import { useTheme } from "@/context/ThemeContext";
import { useColors } from "@/hooks/useColors";

/** Tab icon with a red race-stripe marker above the active tab. */
function TabIcon({ focused, color, sf, feather }: { focused: boolean; color: string; sf: string; feather: React.ComponentProps<typeof Feather>["name"] }) {
  const colors = useColors();
  return (
    <View style={{ alignItems: "center" }}>
      <View style={{ position: "absolute", top: -9, width: 22, height: 3, borderRadius: 2, backgroundColor: focused ? colors.primary : "transparent" }} />
      {Platform.OS === "ios"
        ? <SymbolView name={sf as any} tintColor={color} size={22} />
        : <Feather name={feather} size={22} color={color} />}
    </View>
  );
}

function NativeTabLayout() {
  const colors = useColors();
  return (
    <NativeTabs tintColor={colors.primary}>
      <NativeTabs.Trigger name="index">
        <Icon sf={{ default: "house", selected: "house.fill" }} />
        <Label>Home</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="my-races">
        <Icon sf={{ default: "trophy", selected: "trophy.fill" }} />
        <Label>My Races</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="results">
        <Icon sf={{ default: "flag.checkered", selected: "flag.checkered" }} />
        <Label>Results</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="train">
        <Icon sf={{ default: "figure.run", selected: "figure.run" }} />
        <Label>Train</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile">
        <Icon sf={{ default: "person.circle", selected: "person.circle.fill" }} />
        <Label>Profile</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

function ClassicTabLayout() {
  const colors = useColors();
  const isDark = useTheme().resolvedScheme === "dark";
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        tabBarLabelStyle: { fontFamily: "Inter_700Bold", fontSize: 10, letterSpacing: 0.8, textTransform: "uppercase" },
        tabBarStyle: {
          position: "absolute",
          backgroundColor: isIOS ? "transparent" : colors.background,
          borderTopWidth: isWeb ? 1 : StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView
              intensity={100}
              tint={isDark ? "dark" : "light"}
              style={StyleSheet.absoluteFill}
            />
          ) : isWeb ? (
            <View
              style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}
            />
          ) : null,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, focused }) => <TabIcon focused={focused} color={color} sf="house" feather="home" />,
        }}
      />
      <Tabs.Screen
        name="my-races"
        options={{
          title: "My Races",
          tabBarIcon: ({ color, focused }) => <TabIcon focused={focused} color={color} sf="trophy" feather="award" />,
        }}
      />
      <Tabs.Screen
        name="results"
        options={{
          title: "Results",
          tabBarIcon: ({ color, focused }) => <TabIcon focused={focused} color={color} sf="flag.checkered" feather="flag" />,
        }}
      />
      <Tabs.Screen
        name="train"
        options={{
          title: "Train",
          tabBarIcon: ({ color, focused }) => <TabIcon focused={focused} color={color} sf="figure.run" feather="activity" />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ color, focused }) => <TabIcon focused={focused} color={color} sf="person.circle" feather="user" />,
        }}
      />
    </Tabs>
  );
}

export default function TabLayout() {
  if (isLiquidGlassAvailable()) {
    return <NativeTabLayout />;
  }
  return <ClassicTabLayout />;
}
