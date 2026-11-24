import { BlurView } from "expo-blur";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Tabs, useSegments } from "expo-router";
import { Icon, Label, NativeTabs } from "expo-router/unstable-native-tabs";
import { SymbolView } from "expo-symbols";
import { Feather } from "@expo/vector-icons";
import React, { useEffect, useRef } from "react";
import { Platform, StyleSheet, View } from "react-native";

import { useTheme } from "@/context/ThemeContext";
import { useColors } from "@/hooks/useColors";
import { haptics } from "@/lib/haptics";

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
  // The native tab bar has no press listener: a light tap when the shown tab changes.
  // Typed routes narrow the segment tuple differently per environment; read it as a plain list.
  const segments: readonly string[] = useSegments();
  const tab = segments[1] ?? "index";
  const lastTab = useRef(tab);
  useEffect(() => {
    if (lastTab.current !== tab) haptics.light();
    lastTab.current = tab;
  }, [tab]);
  return (
    <NativeTabs tintColor={colors.primaryText}>
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
      // A light tap when switching tabs (not when re-tapping the current one).
      screenListeners={({ navigation }) => ({
        tabPress: () => { if (!navigation.isFocused()) haptics.light(); },
      })}
      screenOptions={{
        tabBarActiveTintColor: colors.primaryText,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        // Screen background behind every tab, so no light navigation default shows through.
        sceneStyle: { backgroundColor: colors.background },
        tabBarLabelStyle: { fontFamily: "Barlow_700Bold", fontSize: 12, letterSpacing: 0.8, textTransform: "uppercase" },
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
