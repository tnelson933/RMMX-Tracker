import AsyncStorage from "@react-native-async-storage/async-storage";
import { Feather } from "@expo/vector-icons";
import { usePathname, useRouter, useSegments } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RockyAvatar } from "@/components/RockyAvatar";
import { useRockyChat } from "@/context/RockyChatContext";
import { useColors } from "@/hooks/useColors";

/** Set once Rocky has introduced himself (first sign-in, or first launch after this update). */
export const ROCKY_INTRO_SEEN_KEY = "rocky_intro_seen";
/** Set when the rider minimizes the intro, so the launcher shows a one-time "I'm here" hint. */
export const ROCKY_HINT_PENDING_KEY = "rocky_hint_pending";

const HIDDEN_ROUTES = new Set(["/login", "/mechanic"]);

/**
 * Rocky, minimized: a floating button on every signed-in screen that expands
 * into the full chat. It also runs Rocky's one-time intro.
 */
export function RockyLauncher() {
  const colors = useColors();
  const router = useRouter();
  const pathname = usePathname();
  const segments = useSegments();
  const insets = useSafeAreaInsets();
  const { isTyping, messages } = useRockyChat();
  const [hint, setHint] = useState(false);
  const pulse = useRef(new Animated.Value(0)).current;

  const hidden = HIDDEN_ROUTES.has(pathname);
  const onTabs = segments[0] === "(tabs)";
  // Sit above the tab bar on tab screens; near the bottom edge elsewhere
  const bottom = onTabs ? insets.bottom + (Platform.OS === "ios" ? 62 : 70) : insets.bottom + 20;

  // First time on a tab screen: Rocky opens and introduces himself. The chat
  // screen records the intro as seen once it's actually on screen.
  const introLaunched = useRef(false);
  useEffect(() => {
    if (!onTabs || introLaunched.current) return;
    let cancelled = false;
    AsyncStorage.getItem(ROCKY_INTRO_SEEN_KEY).then(seen => {
      if (seen || cancelled || introLaunched.current) return;
      introLaunched.current = true;
      setTimeout(() => { if (!cancelled) router.push("/mechanic?intro=1" as any); }, 600);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [onTabs]);

  // After the intro is minimized, point at the button once
  useEffect(() => {
    if (hidden) return;
    AsyncStorage.getItem(ROCKY_HINT_PENDING_KEY).then(pending => {
      if (!pending) return;
      void AsyncStorage.removeItem(ROCKY_HINT_PENDING_KEY);
      setHint(true);
      setTimeout(() => setHint(false), 7000);
    }).catch(() => {});
  }, [hidden, pathname]);

  // Gentle pulse so the button reads as "live"
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 1400, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      Animated.delay(1800),
    ]));
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  if (hidden) return null;

  const hasReply = messages.some(m => m.role === "user");

  return (
    <View pointerEvents="box-none" style={{ position: "absolute", right: 16, bottom, alignItems: "flex-end" }}>
      {hint && (
        <Pressable onPress={() => setHint(false)} style={{
          marginBottom: 10, width: 236, backgroundColor: colors.foreground, borderRadius: 14,
          paddingVertical: 10, paddingHorizontal: 12, flexDirection: "row", gap: 8, alignItems: "center",
          shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 8,
        }}>
          <Text style={{ flex: 1, fontSize: 13, color: colors.background, fontFamily: "Inter_600SemiBold", lineHeight: 18 }}>
            I'm here on every screen. Tap me anytime you've got a question.
          </Text>
          <Feather name="x" size={14} color={colors.background} />
          <View style={{ position: "absolute", right: 22, bottom: -6, width: 12, height: 12, backgroundColor: colors.foreground, transform: [{ rotate: "45deg" }] }} />
        </Pressable>
      )}
      <Pressable
        onPress={() => { setHint(false); router.push("/mechanic" as any); }}
        accessibilityRole="button"
        accessibilityLabel="Ask Rocky, your AI mechanic"
        hitSlop={8}
        style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.92 : 1 }] })}
      >
        <Animated.View pointerEvents="none" style={{
          position: "absolute", top: -6, left: -6, right: -6, bottom: -6, borderRadius: 999,
          borderWidth: 2, borderColor: colors.primary,
          opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] }),
          transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] }) }],
        }} />
        <RockyAvatar size={58} online />
        {(isTyping || hasReply) && (
          <View style={{
            position: "absolute", top: -4, left: -4, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5,
            backgroundColor: colors.foreground, alignItems: "center", justifyContent: "center",
          }}>
            <Feather name={isTyping ? "more-horizontal" : "message-circle"} size={11} color={colors.background} />
          </View>
        )}
      </Pressable>
    </View>
  );
}
