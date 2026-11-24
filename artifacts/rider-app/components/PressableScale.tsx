import React, { forwardRef } from "react";
import { type GestureResponderEvent, Pressable, type PressableProps, type StyleProp, type View, type ViewStyle } from "react-native";
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from "react-native-reanimated";

import { haptics } from "@/lib/haptics";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
/** Press-in is quick so the card answers the finger; release springs back, no overshoot. */
const PRESS_IN = { duration: 110, easing: EASE_OUT };
const RELEASE = { duration: 160, dampingRatio: 1 };
/** Reduced motion: no scale, a short dim instead, so the press still shows. */
const DIM = { duration: 100 };

export type PressableScaleProps = Omit<PressableProps, "style"> & {
  /** Static style only: the press state is shown by the scale, not by a style function. */
  style?: StyleProp<ViewStyle>;
  /** Scale at full press. 0.97 for cards and pills; use ~0.95 for small tiles. */
  scaleTo?: number;
  /** A light haptic when the press commits (onPress). Off by default: navigation taps stay silent. */
  haptic?: boolean;
};

/**
 * The app's tappable card / pill. Scales to ~0.97 on press-in and springs back
 * on release, on the UI thread (Reanimated), so it stays smooth while the JS
 * thread is busy starting the next screen. With the OS "reduce motion" setting
 * on, it dims slightly instead of scaling.
 */
export const PressableScale = forwardRef<View, PressableScaleProps>(function PressableScale(
  { style, scaleTo = 0.97, haptic = false, onPressIn, onPressOut, onPress, disabled, pressRetentionOffset, ...rest },
  ref,
) {
  const reduced = useReducedMotion();
  const pressed = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => {
    const p = pressed.get();
    return reduced
      ? { opacity: 1 - p * 0.18 }
      : { transform: [{ scale: 1 - p * (1 - scaleTo) }] };
  });

  return (
    <AnimatedPressable
      ref={ref}
      {...rest}
      disabled={disabled}
      pressRetentionOffset={pressRetentionOffset ?? 16}
      onPressIn={(e: GestureResponderEvent) => {
        pressed.set(withTiming(1, reduced ? DIM : PRESS_IN));
        onPressIn?.(e);
      }}
      onPressOut={(e: GestureResponderEvent) => {
        pressed.set(reduced ? withTiming(0, DIM) : withSpring(0, RELEASE));
        onPressOut?.(e);
      }}
      onPress={onPress ? (e: GestureResponderEvent) => {
        if (haptic) haptics.light();
        onPress(e);
      } : undefined}
      style={[style, animatedStyle]}
    />
  );
});
