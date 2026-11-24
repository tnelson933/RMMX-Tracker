/**
 * Shimmer placeholders for a screen's first load, shaped like the content that
 * is coming, so the layout doesn't jump when it lands.
 *
 * One `SkeletonGroup` owns one looping shared value and every block inside it
 * reads it, so a whole screen of blocks costs one animation on the UI thread.
 * With the OS "reduce motion" setting on, blocks are static.
 *
 * Use only when nothing is on screen yet: never swap cached or refreshed
 * content for a skeleton (refreshes keep the RefreshControl / inline spinner).
 */
import { LinearGradient } from "expo-linear-gradient";
import React, { createContext, useContext, useEffect } from "react";
import { type DimensionValue, StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  cancelAnimation, Easing, type SharedValue, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming,
} from "react-native-reanimated";

import { useTheme } from "@/context/ThemeContext";
import { useColors } from "@/hooks/useColors";

const SWEEP_MS = 1300;

const ShimmerContext = createContext<SharedValue<number> | null>(null);

/** The looping 0→1 sweep. `active` false: a still value (a block inside a group uses the group's). */
function useShimmerProgress(active = true): SharedValue<number> {
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);
  useEffect(() => {
    if (reduced || !active) return;
    progress.set(withRepeat(withTiming(1, { duration: SWEEP_MS, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(progress);
  }, [reduced, active]);
  return progress;
}

/** Wraps a screen's placeholders: one shared shimmer, one "Loading" for screen readers. */
export function SkeletonGroup({ children, style, label = "Loading" }: { children: React.ReactNode; style?: ViewStyle; label?: string }) {
  const progress = useShimmerProgress();
  return (
    <ShimmerContext.Provider value={progress}>
      <View style={style} accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityState={{ busy: true }}>
        {children}
      </View>
    </ShimmerContext.Provider>
  );
}

/** One placeholder block. Inside a SkeletonGroup it shares the group's shimmer. */
export function Skeleton({
  width = "100%", height = 14, radius = 6, style,
}: { width?: DimensionValue; height?: DimensionValue; radius?: number; style?: ViewStyle }) {
  const colors = useColors();
  const dark = useTheme().resolvedScheme === "dark";
  const reduced = useReducedMotion();
  const shared = useContext(ShimmerContext);
  const own = useShimmerProgress(shared == null);
  const progress = shared ?? own;
  const w = useSharedValue(0);

  const sweep = useAnimatedStyle(() => {
    const width = w.get();
    return { transform: [{ translateX: -width + progress.get() * width * 2 }] };
  });

  return (
    <View
      onLayout={e => w.set(e.nativeEvent.layout.width)}
      style={[{ width, height, borderRadius: radius, backgroundColor: colors.muted, overflow: "hidden" }, style]}
    >
      {!reduced && (
        <Animated.View style={[StyleSheet.absoluteFill, sweep]}>
          <LinearGradient
            colors={dark
              ? ["rgba(255,255,255,0)", "rgba(255,255,255,0.07)", "rgba(255,255,255,0)"]
              : ["rgba(255,255,255,0)", "rgba(255,255,255,0.75)", "rgba(255,255,255,0)"]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      )}
    </View>
  );
}

// ─── Shaped placeholders ─────────────────────────────────────────────────────

function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const colors = useColors();
  return (
    <View style={[{ marginHorizontal: 16, borderRadius: 16, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border }, style]}>
      {children}
    </View>
  );
}

/** Same footprint as RaceCards' ResultCard: badge, title, chips. */
export function ResultCardSkeleton() {
  return (
    <Card style={{ marginBottom: 10, padding: 14, flexDirection: "row", alignItems: "center", gap: 12 }}>
      <View style={{ minWidth: 56, alignItems: "center" }}>
        <Skeleton width={44} height={44} radius={10} />
      </View>
      <View style={{ flex: 1, gap: 8 }}>
        <Skeleton width="70%" height={16} />
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Skeleton width={78} height={20} radius={999} />
          <Skeleton width={56} height={20} radius={999} />
        </View>
      </View>
    </Card>
  );
}

/** Same footprint as RaceCards' EventCard: date block, title, chips. */
export function EventCardSkeleton() {
  return (
    <Card style={{ marginBottom: 10, padding: 12, flexDirection: "row", alignItems: "center", gap: 12 }}>
      <Skeleton width={52} height={56} radius={12} />
      <View style={{ flex: 1, gap: 8 }}>
        <Skeleton width={90} height={14} radius={999} />
        <Skeleton width="80%" height={16} />
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Skeleton width={70} height={20} radius={999} />
          <Skeleton width={60} height={20} radius={999} />
        </View>
      </View>
    </Card>
  );
}

/** A list of result or event cards. */
export function CardListSkeleton({ count = 4, kind = "result", style }: { count?: number; kind?: "result" | "event"; style?: ViewStyle }) {
  const Row = kind === "event" ? EventCardSkeleton : ResultCardSkeleton;
  return (
    <SkeletonGroup style={style}>
      {Array.from({ length: count }, (_, i) => <Row key={i} />)}
    </SkeletonGroup>
  );
}

/** A person row: avatar, name, one line of detail. */
export function RiderRowSkeleton() {
  return (
    <Card style={{ marginBottom: 8, padding: 12, flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 14 }}>
      <Skeleton width={40} height={40} radius={20} />
      <View style={{ flex: 1, gap: 6 }}>
        <Skeleton width="55%" height={14} />
        <Skeleton width="35%" height={11} />
      </View>
    </Card>
  );
}

/** Home first load: next-race hero and the recent form strip (Following has its own). */
export function HomeSkeleton() {
  return (
    <SkeletonGroup style={{ marginTop: 4, gap: 14 }}>
      <View style={{ marginHorizontal: 16 }}>
        <Skeleton height={210} radius={20} />
      </View>
      <Card style={{ padding: 12, gap: 10, borderRadius: 14 }}>
        <Skeleton width={110} height={13} />
        <View style={{ flexDirection: "row", gap: 8 }}>
          {Array.from({ length: 5 }, (_, i) => (
            <View key={i} style={{ flex: 1, alignItems: "center", gap: 6 }}>
              <Skeleton width={32} height={32} radius={8} />
              <Skeleton width={36} height={10} />
            </View>
          ))}
        </View>
      </Card>
    </SkeletonGroup>
  );
}

/** Racer profile: photo header with avatar and name, follow row, then the three stat tiles. */
export function ProfileHeaderSkeleton({ topInset = 0 }: { topInset?: number }) {
  return (
    <SkeletonGroup>
      <View style={{ height: 250 + topInset, justifyContent: "flex-end" }}>
        <Skeleton height="100%" radius={0} style={{ position: "absolute", top: 0, left: 0, right: 0 }} />
      </View>
      <View style={{ padding: 16, gap: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Skeleton width={56} height={40} radius={8} />
          <Skeleton width={90} height={14} style={{ flex: 1 }} />
          <Skeleton width={96} height={38} radius={999} />
        </View>
        <Skeleton width="90%" height={14} />
        <View style={{ flexDirection: "row", gap: 8 }}>
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={i} style={{ flex: 1, marginHorizontal: 0, paddingVertical: 12, gap: 8, alignItems: "center", borderRadius: 14 }}>
              <Skeleton width={36} height={24} />
              <Skeleton width={52} height={10} />
            </Card>
          ))}
        </View>
        <Card style={{ marginHorizontal: 0, padding: 12, gap: 12, borderRadius: 14 }}>
          <Skeleton width="60%" height={13} />
          <Skeleton width="45%" height={13} />
          <Skeleton width="55%" height={13} />
        </Card>
      </View>
    </SkeletonGroup>
  );
}

/** Event page: the hero card (date block, name, chips), then schedule rows. Sits under the real top bar. */
export function EventPageSkeleton() {
  return (
    <SkeletonGroup style={{ gap: 10 }}>
      <Card style={{ marginTop: 4, marginBottom: 4, padding: 16, gap: 14, borderRadius: 20 }}>
        <Skeleton width={130} height={18} radius={999} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
          <Skeleton width={62} height={66} radius={14} />
          <View style={{ flex: 1, gap: 8 }}>
            <Skeleton width="85%" height={22} />
            <Skeleton width="45%" height={13} />
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Skeleton width={110} height={26} radius={999} />
          <Skeleton width={90} height={26} radius={999} />
        </View>
      </Card>
      <View>
        <ResultCardSkeleton />
        <ResultCardSkeleton />
        <ResultCardSkeleton />
      </View>
    </SkeletonGroup>
  );
}

/** Live leaderboard / finishing order: flat rows (position, name, time), no cards. */
export function LeaderboardSkeleton({ rows = 8 }: { rows?: number }) {
  const colors = useColors();
  return (
    <SkeletonGroup style={{ paddingTop: 14 }}>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border + "55" }}>
          <Skeleton width={36} height={20} />
          <View style={{ flex: 1, gap: 6 }}>
            <Skeleton width={i % 2 ? "58%" : "48%"} height={14} />
            <Skeleton width={40} height={10} />
          </View>
          <Skeleton width={56} height={14} />
        </View>
      ))}
    </SkeletonGroup>
  );
}
