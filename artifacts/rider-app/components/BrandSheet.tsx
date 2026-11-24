/**
 * The app's bottom sheet and pill buttons (the shared component kit for
 * pop-ups). The sheet slides up on a spring with the red race stripe and a
 * grab handle, closes with a swipe down, a tap outside or Back, rises above
 * the keyboard and keeps clear of the home indicator. With "reduce motion"
 * on, it fades instead of sliding.
 */
import { Feather } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View,
  type StyleProp, type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  Easing, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PressableScale } from "@/components/PressableScale";
import { fonts } from "@/constants/fonts";
import { useColors } from "@/hooks/useColors";

const OPEN_SPRING = { damping: 26, stiffness: 260, mass: 0.9 };
const CLOSE = { duration: 200, easing: Easing.in(Easing.quad) };

export function BrandSheet({ visible, onClose, title, subtitle, children, dismissable = true, maxHeight = "85%", scrollable }: {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  /** False while saving: no swipe, outside tap or Back. */
  dismissable?: boolean;
  maxHeight?: `${number}%` | number;
  /** The content manages its own scrolling (a FlatList): the sheet takes its full height. */
  scrollable?: boolean;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const reduced = useReducedMotion();
  // Stay mounted through the closing slide.
  const [mounted, setMounted] = useState(visible);
  const y = useSharedValue(height);
  const fade = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      y.value = reduced ? 0 : height;
      fade.value = 0;
      requestAnimationFrame(() => {
        fade.value = withTiming(1, { duration: 180 });
        if (!reduced) y.value = withSpring(0, OPEN_SPRING);
      });
    } else if (mounted) {
      fade.value = withTiming(0, CLOSE);
      if (reduced) setTimeout(() => setMounted(false), 200);
      else y.value = withTiming(height, CLOSE, done => { if (done) runOnJS(setMounted)(false); });
    }
  }, [visible]);

  const requestClose = () => { if (dismissable) onClose(); };

  const pan = Gesture.Pan()
    .enabled(dismissable)
    .activeOffsetY(8)
    .failOffsetX([-20, 20])
    .onUpdate(e => { y.value = Math.max(0, e.translationY); })
    .onEnd(e => {
      if (e.translationY > 120 || e.velocityY > 900) runOnJS(onClose)();
      else y.value = withSpring(0, OPEN_SPRING);
    });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }], opacity: reduced ? fade.value : 1 }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: fade.value }));

  if (!mounted) return null;
  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={requestClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardAvoidingView style={{ flex: 1, justifyContent: "flex-end" }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.55)" }, backdropStyle]}>
            <Pressable style={{ flex: 1 }} onPress={requestClose} accessibilityRole="button" accessibilityLabel="Close" />
          </Animated.View>
          <Animated.View
            accessibilityViewIsModal
            style={[{
              maxHeight, ...(scrollable ? { height: maxHeight } : null),
              backgroundColor: colors.card, borderTopLeftRadius: 22, borderTopRightRadius: 22, overflow: "hidden",
              paddingBottom: Math.max(insets.bottom, 16),
            }, sheetStyle]}
          >
            <GestureDetector gesture={pan}>
              <View>
                <View style={{ height: 4, backgroundColor: colors.primary }} />
                <View style={{ alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: colors.border, marginTop: 8 }} />
                <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 12 }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text accessibilityRole="header" style={{ fontSize: 22, color: colors.foreground, fontFamily: fonts.displayItalic, textTransform: "uppercase" }}>{title}</Text>
                    {subtitle ? <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: fonts.regular }}>{subtitle}</Text> : null}
                  </View>
                  {dismissable && (
                    <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close"
                      style={{ width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.background }}>
                      <Feather name="x" size={18} color={colors.foreground} />
                    </Pressable>
                  )}
                </View>
              </View>
            </GestureDetector>
            <View style={scrollable ? { flex: 1 } : { paddingHorizontal: 20 }}>{children}</View>
          </Animated.View>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}

/** The app's pill button: primary (brand red), secondary (outlined) or danger. */
export function BrandButton({ label, onPress, variant = "primary", loading, disabled, icon, style }: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  loading?: boolean;
  disabled?: boolean;
  icon?: React.ComponentProps<typeof Feather>["name"];
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useColors();
  const filled = variant !== "secondary";
  const bg = variant === "primary" ? colors.primary : variant === "danger" ? colors.destructive : "transparent";
  const fg = filled ? "#FFFFFF" : colors.foreground;
  const off = disabled || loading;
  return (
    <PressableScale onPress={onPress} disabled={off} accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      style={[{
        flex: 1, minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
        paddingHorizontal: 18, borderRadius: 999, backgroundColor: bg, borderWidth: filled ? 0 : 1, borderColor: colors.border,
        opacity: disabled && !loading ? 0.5 : 1,
      }, style]}>
      {loading ? <ActivityIndicator color={fg} /> : (
        <>
          {icon && <Feather name={icon} size={16} color={fg} />}
          <Text style={{ color: fg, fontSize: 15, fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 1 }}>{label}</Text>
        </>
      )}
    </PressableScale>
  );
}

/** Two buttons side by side at the bottom of a sheet. */
export function SheetActions({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>{children}</View>;
}
