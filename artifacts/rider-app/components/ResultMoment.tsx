/**
 * Result moments: after a win, a podium or a rider's best finish yet, Home
 * shows a one-time celebration with the result's share card, ready to post.
 * Which results count lives in lib/resultMoment.ts; what's been shown is kept
 * on the phone, so each moment appears once.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, {
  Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSpring, withTiming,
} from "react-native-reanimated";

import type { EventHistory } from "@/components/RaceSubScreens";
import { podiumColor } from "@/components/RaceStats";
import { ResultShareCard, useShareCapture } from "@/components/ShareCard";
import { fonts } from "@/constants/fonts";
import { haptics } from "@/lib/haptics";
import { localDateString } from "@/lib/format";
import { momentHeadline, momentLine, pickMoment, type Moment } from "@/lib/resultMoment";

const SEEN_KEY = "rm.resultMoments.seen";
const CONFETTI = ["#B30000", "#FFFFFF", "#F5B700", "#B30000", "#C9D1DB", "#FFFFFF"];

async function loadSeen(): Promise<Set<string>> {
  try { return new Set(JSON.parse((await AsyncStorage.getItem(SEEN_KEY)) ?? "[]") as string[]); }
  catch { return new Set(); }
}

async function markSeen(key: string) {
  const seen = await loadSeen();
  seen.add(key);
  // Keep the list short: only the latest 50 matter.
  await AsyncStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-50))).catch(() => {});
}

function Confetti({ index, width, height }: { index: number; width: number; height: number }) {
  const y = useSharedValue(-40);
  const spin = useSharedValue(0);
  const x = useMemo(() => ((index * 73) % 100) / 100 * width, [index, width]);
  useEffect(() => {
    const delay = (index % 7) * 120;
    y.value = withDelay(delay, withRepeat(withTiming(height + 40, { duration: 2600 + (index % 5) * 300, easing: Easing.linear, reduceMotion: ReduceMotion.System }), 2, false));
    spin.value = withDelay(delay, withRepeat(withTiming(360, { duration: 1400, easing: Easing.linear, reduceMotion: ReduceMotion.System }), 4, false));
  }, [index, height, y, spin]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }, { rotate: `${spin.value}deg` }] }));
  return (
    <Animated.View pointerEvents="none" style={[{
      position: "absolute", top: 0, left: x, width: 8, height: 16, borderRadius: 2,
      backgroundColor: CONFETTI[index % CONFETTI.length],
    }, style]} />
  );
}

export function ResultMoment({ history, racingEventIds, nameFor, coverFor }: {
  history: EventHistory[];
  /** Events with races still to run today: celebrate once they're over, not mid-race. */
  racingEventIds: ReadonlySet<number>;
  /** Full name for a result (multi-rider accounts label each result). */
  nameFor: (r: EventHistory) => string;
  coverFor: (r: EventHistory) => string | null | undefined;
}) {
  const { width, height } = useWindowDimensions();
  const [moment, setMoment] = useState<Moment<EventHistory> | null>(null);
  const { ref, share, sharing } = useShareCapture();
  const pop = useSharedValue(0.6);

  const historyKey = history.map(h => `${h.eventId}:${h.raceClass}:${h.bestPosition}`).join(",") + `|${[...racingEventIds].join(",")}`;
  useEffect(() => {
    const finished = history.filter(h => !racingEventIds.has(h.eventId));
    if (finished.length === 0) return;
    let stale = false;
    void loadSeen().then(seen => {
      if (stale) return;
      const m = pickMoment(finished, seen, localDateString());
      if (!m) return;
      setMoment(m);
      void markSeen(m.key);
      haptics.success();
      pop.value = 0.6;
      pop.value = withSpring(1, { damping: 9, stiffness: 140, reduceMotion: ReduceMotion.System });
    });
    return () => { stale = true; };
  }, [historyKey]);

  const popStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));
  if (!moment) return null;
  const r = moment.result;
  const name = nameFor(r);
  const firstName = r.riderName ? r.riderName.split(" ")[0] : null;
  const metal = podiumColor(r.bestPosition) ?? "#FFFFFF";
  const close = () => setMoment(null);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
      <View style={s.backdrop}>
        {Array.from({ length: moment.kind === "best" ? 0 : 18 }, (_, i) => <Confetti key={i} index={i} width={width} height={height} />)}
        <Animated.View style={[{ alignItems: "center", gap: 4 }, popStyle]}>
          <Text style={[s.headline, { color: metal }]} accessibilityRole="header">{momentHeadline(moment.kind, r.bestPosition ?? 0)}</Text>
          <Text style={s.line}>{momentLine(moment, firstName)}</Text>
        </Animated.View>
        <ResultShareCard
          cardRef={ref}
          name={name}
          eventName={r.eventName}
          raceClass={r.raceClass}
          bestPosition={r.bestPosition}
          motos={r.motos.map(m => ({ motoName: m.motoName, position: m.position, dnf: m.dnf, dns: m.dns }))}
          coverUrl={coverFor(r)}
        />
        <View style={s.actions}>
          <Pressable onPress={close} accessibilityRole="button" style={({ pressed }) => [s.btn, s.secondary, { opacity: pressed ? 0.7 : 1 }]}>
            <Text style={s.btnText}>Done</Text>
          </Pressable>
          <Pressable disabled={sharing} accessibilityRole="button" accessibilityLabel="Share this result"
            onPress={() => share(`${name} at ${r.eventName}`)}
            style={({ pressed }) => [s.btn, { opacity: pressed || sharing ? 0.7 : 1 }]}>
            {sharing ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>Share</Text>}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.9)", alignItems: "center", justifyContent: "center", gap: 18, padding: 24, overflow: "hidden" },
  headline: { fontSize: 44, lineHeight: 48, fontFamily: fonts.displayItalic, textTransform: "uppercase", textAlign: "center" },
  line: { color: "#E6E6E6", fontSize: 16, fontFamily: fonts.medium, textAlign: "center", maxWidth: 320 },
  actions: { flexDirection: "row", gap: 12 },
  btn: { minWidth: 130, alignItems: "center", backgroundColor: "#B30000", borderRadius: 999, paddingVertical: 13, paddingHorizontal: 20 },
  secondary: { backgroundColor: "#333" },
  btnText: { color: "#fff", fontSize: 16, textTransform: "uppercase", letterSpacing: 1, fontFamily: fonts.display },
});
