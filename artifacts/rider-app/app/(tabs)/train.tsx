import AsyncStorage from "@react-native-async-storage/async-storage";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Pressable,
  Animated,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useRiderAuth } from "@/context/AuthContext";
import { DirtBikeIcon } from "@/components/DirtBikeIcon";
import { BrandBar } from "@/components/BrandBar";

const ACCENT = "#cf152d";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtLap(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return "—";
  const totalSec = ms / 1000;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return mins > 0 ? `${mins}:${secs.toFixed(3).padStart(6, "0")}` : `${secs.toFixed(3)}s`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function lapDelta(ms: number, bestMs: number): string {
  if (ms <= bestMs) return "";
  return `+${((ms - bestMs) / 1000).toFixed(3)}s`;
}

function equipmentIcon(equipment: string): keyof typeof Feather.glyphMap {
  const eq = equipment.toLowerCase();
  if (eq.includes("treadmill") || eq.includes("cardio")) return "trending-up";
  if (eq.includes("pull-up") || eq.includes("chin")) return "chevron-up";
  if (eq.includes("plyo") || eq.includes("box") || eq.includes("jump")) return "zap";
  if (eq.includes("battle rope") || eq.includes("rope")) return "wind";
  if (eq.includes("foam") || eq.includes("roller")) return "circle";
  if (eq.includes("band") || eq.includes("resistance")) return "link";
  if (eq.includes("cable")) return "activity";
  if (eq.includes("kettlebell")) return "anchor";
  if (eq.includes("bike") || eq.includes("cycle")) return "trending-up";
  return "minus";
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface LapEntry     { lapNumber: number; lapTimeMs: number | null; crossingTime: string }
interface LeaderboardEntry { rank: number; riderId: number | null; riderName: string; bibNumber: string | null; bestLapMs: number | null; lapCount: number; isMe: boolean }
interface SessionItem  { key: string; label: string; status: string; myLaps: LapEntry[]; bestLapMs: number | null; leaderboard?: LeaderboardEntry[] }
interface TrackItem    { key: string; label: string; sublabel: string | null; sessions: SessionItem[] }

interface WorkoutExercise {
  name: string;
  equipment: string;
  duration: string | null;
  sets: number | null;
  reps: string | null;
  restSeconds: number;
  intensity: string;
  muscleGroups: string[];
  mxBenefit: string;
  formTips: string[];
  exerciseNote?: string;
  equipmentSetup?: string;
  progressionTip?: string;
  imageUrl?: string;
}
interface DrillBlock {
  name: string;
  durationMinutes: number;
  reps: number;
  trackSection: string;
  mxFocus: string;
  cues: string[];
}
interface WorkoutPhase {
  name: string;
  duration: number;
  phaseColor: string;
  exercises?: WorkoutExercise[];
  drillBlocks?: DrillBlock[];
}
interface WorkoutPlan {
  planTitle: string;
  totalMinutes: number;
  focus: string[];
  mxRelevance: string | string[];
  phases: WorkoutPhase[];
  proTip: string;
  nutritionTip: string;
  recoveryTip: string;
}

type WorkoutType = "gym" | "bike";
type TabMode = "track" | "coach";
type CoachState = "input" | "loading" | "plan" | "error";

const DURATION_OPTIONS = [30, 45, 60, 90, 120];

const LOADING_MESSAGES = [
  "Analyzing your training needs…",
  "Consulting MX performance data…",
  "Building your personalized workout…",
  "Fine-tuning sets and reps…",
  "Adding pro tips from the pits…",
  "Almost ready…",
];

// ─── Picker chips ─────────────────────────────────────────────────────────────

function ChipBar({ items, selected, onSelect, colors }: {
  items: { key: string; label: string; sub?: string | null }[];
  selected: string | null;
  onSelect: (key: string) => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 16, gap: 8, paddingVertical: 2 }}>
      {items.map(item => {
        const active = item.key === selected;
        return (
          <Pressable key={item.key} onPress={() => onSelect(item.key)} style={{
            paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
            backgroundColor: active ? ACCENT : colors.muted,
            borderWidth: active ? 0 : StyleSheet.hairlineWidth, borderColor: colors.border,
          }}>
            <Text style={{ fontSize: 13, fontWeight: "700", color: active ? "#fff" : colors.foreground, fontFamily: "Inter_700Bold" }}>{item.label}</Text>
            {item.sub ? <Text style={{ fontSize: 10, color: active ? "#fff" : colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 }}>{item.sub}</Text> : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// ─── Lap table ────────────────────────────────────────────────────────────────

function LapTable({ laps, colors }: { laps: LapEntry[]; colors: ReturnType<typeof useColors> }) {
  const validLaps = laps.filter(l => (l.lapTimeMs ?? 0) > 0);
  if (validLaps.length === 0) return (
    <View style={{ padding: 24, alignItems: "center", gap: 6 }}>
      <Feather name="clock" size={28} color={colors.mutedForeground} />
      <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center" }}>No lap times recorded yet.</Text>
    </View>
  );
  const bestMs = Math.min(...validLaps.map(l => l.lapTimeMs!));
  const fastestIdx = validLaps.findIndex(l => l.lapTimeMs === bestMs);
  return (
    <View style={{ borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, overflow: "hidden", backgroundColor: colors.card }}>
      <View style={{ flexDirection: "row", paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.muted + "80", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
        <Text style={{ width: 36, fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5 }}>Lap</Text>
        <Text style={{ flex: 1, fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5 }}>Time</Text>
        <Text style={{ width: 70, fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5, textAlign: "right" }}>Gap</Text>
      </View>
      {validLaps.map((lap, i) => {
        const isBest = i === fastestIdx;
        const delta  = isBest ? "" : lapDelta(lap.lapTimeMs!, bestMs);
        return (
          <View key={i} style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: i < validLaps.length - 1 ? StyleSheet.hairlineWidth : 0, borderBottomColor: colors.border, backgroundColor: isBest ? ACCENT + "10" : "transparent" }}>
            <Text style={{ width: 36, fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>{lap.lapNumber}</Text>
            <Text style={{ flex: 1, fontSize: 15, fontWeight: isBest ? "800" : "400", color: isBest ? ACCENT : colors.foreground, fontFamily: isBest ? "Inter_700Bold" : "Inter_400Regular" }}>{fmtLap(lap.lapTimeMs)}</Text>
            <View style={{ width: 70, alignItems: "flex-end", flexDirection: "row", justifyContent: "flex-end", gap: 4 }}>
              {isBest ? (<><Feather name="zap" size={11} color={ACCENT} /><Text style={{ fontSize: 11, fontWeight: "700", color: ACCENT, fontFamily: "Inter_700Bold" }}>BEST</Text></>) : delta ? (<Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>{delta}</Text>) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────

function Leaderboard({ entries, colors }: { entries: LeaderboardEntry[]; colors: ReturnType<typeof useColors> }) {
  if (entries.length === 0) return null;
  return (
    <View style={{ borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, overflow: "hidden", backgroundColor: colors.card }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: colors.muted + "80", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
        <Feather name="list" size={12} color={colors.mutedForeground} />
        <Text style={{ fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.8, flex: 1 }}>Gate Pick Order</Text>
        <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>Best Lap</Text>
      </View>
      {entries.map((e, i) => (
        <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: i < entries.length - 1 ? StyleSheet.hairlineWidth : 0, borderBottomColor: colors.border, backgroundColor: e.isMe ? ACCENT + "0d" : "transparent" }}>
          <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: e.rank === 1 ? ACCENT : e.isMe ? ACCENT + "30" : colors.muted, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontSize: 12, fontWeight: "700", color: e.rank === 1 ? "#fff" : e.isMe ? ACCENT : colors.mutedForeground, fontFamily: "Inter_700Bold" }}>{e.rank}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: e.isMe ? "700" : "400", color: colors.foreground, fontFamily: e.isMe ? "Inter_700Bold" : "Inter_400Regular" }}>{e.riderName}{e.isMe ? "  ★" : ""}</Text>
            {e.bibNumber && <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>#{e.bibNumber}</Text>}
          </View>
          <View style={{ alignItems: "flex-end", gap: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: e.isMe ? ACCENT : colors.foreground, fontFamily: e.isMe ? "Inter_700Bold" : "Inter_500Medium" }}>{fmtLap(e.bestLapMs)}</Text>
            <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>{e.lapCount} lap{e.lapCount !== 1 ? "s" : ""}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

// ─── Coach: Exercise Card ─────────────────────────────────────────────────────

function ExerciseCard({ ex, phaseColor, index: _index, colors }: {
  ex: WorkoutExercise;
  phaseColor: string;
  index: number;
  colors: ReturnType<typeof useColors>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [imgError, setImgError] = useState(false);

  const metricsStr = [
    ex.sets ? `${ex.sets} sets` : null,
    ex.reps ? ex.reps : null,
    ex.duration ?? null,
  ].filter(Boolean).join(" × ");

  const restStr = ex.restSeconds > 0 ? `${ex.restSeconds}s rest` : null;

  const noteText = ex.exerciseNote
    ?? (ex.equipmentSetup && ex.progressionTip
      ? `${ex.equipmentSetup} Next: ${ex.progressionTip}`
      : ex.equipmentSetup ?? ex.progressionTip ?? null);

  return (
    <View style={{ borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.card, overflow: "hidden", borderLeftWidth: 3, borderLeftColor: phaseColor }}>
      {/* Illustration banner — shown when imageUrl is present and loaded */}
      {ex.imageUrl && !imgError ? (
        <Image
          source={{ uri: ex.imageUrl }}
          style={{ width: "100%", aspectRatio: 16 / 9, borderTopLeftRadius: 9, borderTopRightRadius: 9 }}
          resizeMode="cover"
          onError={() => setImgError(true)}
        />
      ) : null}
      {/* Header row — always visible */}
      <Pressable
        onPress={() => setExpanded(v => !v)}
        style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, paddingBottom: 10 }}
      >
        <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: phaseColor + "20", alignItems: "center", justifyContent: "center" }}>
          <Feather name={equipmentIcon(ex.equipment)} size={18} color={phaseColor} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 15, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>{ex.name}</Text>
          <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 }}>{ex.equipment}</Text>
        </View>
        <Feather name={expanded ? "chevron-up" : "chevron-down"} size={16} color={colors.mutedForeground} />
      </Pressable>

      {/* Metrics + MX hint row — always visible */}
      <View style={{ flexDirection: "row", paddingHorizontal: 14, paddingBottom: 12, gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {metricsStr ? (
          <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: phaseColor + "20" }}>
            <Text style={{ fontSize: 12, fontWeight: "700", color: phaseColor, fontFamily: "Inter_700Bold" }}>{metricsStr}</Text>
          </View>
        ) : null}
        {restStr ? (
          <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: colors.muted }}>
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>{restStr}</Text>
          </View>
        ) : null}
        {ex.intensity ? (
          <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: colors.muted }}>
            <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>{ex.intensity}</Text>
          </View>
        ) : null}
        {ex.mxBenefit ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, backgroundColor: ACCENT + "12" }}>
            <DirtBikeIcon size={11} color={ACCENT} />
            <Text style={{ fontSize: 11, color: ACCENT, fontFamily: "Inter_500Medium" }} numberOfLines={1}>{ex.mxBenefit}</Text>
          </View>
        ) : null}
      </View>

      {expanded && (
        <>
          {/* Form cues — dot bullets */}
          {ex.formTips?.length > 0 && (
            <View style={{ marginHorizontal: 14, marginBottom: 10 }}>
              <Text style={{ fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 }}>Form Cues</Text>
              {ex.formTips.map((tip, i) => (
                <View key={i} style={{ flexDirection: "row", gap: 8, marginBottom: 3, alignItems: "flex-start" }}>
                  <Text style={{ fontSize: 13, color: phaseColor, fontFamily: "Inter_700Bold", lineHeight: 18 }}>·</Text>
                  <Text style={{ flex: 1, fontSize: 13, color: colors.foreground, fontFamily: "Inter_400Regular", lineHeight: 18 }}>{tip}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Muscle groups */}
          {ex.muscleGroups?.length > 0 && (
            <View style={{ marginHorizontal: 14, marginBottom: 10, flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {ex.muscleGroups.map((m, i) => (
                <View key={i} style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: colors.muted, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
                  <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>{m}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Note line — setup + progression condensed */}
          {noteText ? (
            <View style={{ marginHorizontal: 14, marginBottom: 13, flexDirection: "row", gap: 7, alignItems: "flex-start" }}>
              <Feather name="info" size={12} color={colors.mutedForeground} style={{ marginTop: 2 }} />
              <Text style={{ flex: 1, fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", lineHeight: 16 }}>
                <Text style={{ fontFamily: "Inter_700Bold", color: colors.foreground }}>Note: </Text>{noteText}
              </Text>
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

// ─── Coach: Drill Card ───────────────────────────────────────────────────────

function DrillCard({ drill, phaseColor, colors }: {
  drill: DrillBlock;
  phaseColor: string;
  colors: ReturnType<typeof useColors>;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={{ borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.card, overflow: "hidden", borderLeftWidth: 3, borderLeftColor: phaseColor }}>
      <Pressable onPress={() => setExpanded(v => !v)} style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, paddingBottom: 10 }}>
        <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: phaseColor + "20", alignItems: "center", justifyContent: "center" }}>
          <Feather name="flag" size={18} color={phaseColor} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 15, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>{drill.name}</Text>
          <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 }}>{drill.trackSection}</Text>
        </View>
        <Feather name={expanded ? "chevron-up" : "chevron-down"} size={16} color={colors.mutedForeground} />
      </Pressable>

      <View style={{ flexDirection: "row", paddingHorizontal: 14, paddingBottom: 12, gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: phaseColor + "20" }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: phaseColor, fontFamily: "Inter_700Bold" }}>{drill.durationMinutes} min</Text>
        </View>
        {drill.reps > 0 ? (
          <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: colors.muted }}>
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>{drill.reps} reps/set</Text>
          </View>
        ) : null}
        {drill.mxFocus ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, backgroundColor: ACCENT + "12" }}>
            <DirtBikeIcon size={11} color={ACCENT} />
            <Text style={{ fontSize: 11, color: ACCENT, fontFamily: "Inter_500Medium" }} numberOfLines={1}>{drill.mxFocus}</Text>
          </View>
        ) : null}
      </View>

      {expanded && drill.cues?.length > 0 && (
        <View style={{ marginHorizontal: 14, marginBottom: 13 }}>
          <Text style={{ fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 }}>Technique Cues</Text>
          {drill.cues.map((cue, i) => (
            <View key={i} style={{ flexDirection: "row", gap: 8, marginBottom: 3, alignItems: "flex-start" }}>
              <Text style={{ fontSize: 13, color: phaseColor, fontFamily: "Inter_700Bold", lineHeight: 18 }}>·</Text>
              <Text style={{ flex: 1, fontSize: 13, color: colors.foreground, fontFamily: "Inter_400Regular", lineHeight: 18 }}>{cue}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// ─── Coach: Tip Card ─────────────────────────────────────────────────────────

function splitTipSentences(text: string): string[] {
  const parts = text.split(/[.!?]\s+/).reduce<string[]>((acc, seg, i, arr) => {
    if (i < arr.length - 1) acc.push(seg + ".");
    else if (seg.trim()) acc.push(seg.trim());
    return acc;
  }, []).filter(Boolean);
  return parts.length > 1 ? parts : [text];
}

function TipCard({ emoji, label, labelColor, text, colors }: {
  emoji: string;
  label: string;
  labelColor: string;
  text: string;
  colors: ReturnType<typeof useColors>;
}) {
  const bullets = splitTipSentences(text);
  return (
    <View style={{ borderRadius: 12, backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, padding: 14 }}>
      <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
        <Text style={{ fontSize: 20 }}>{emoji}</Text>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 11, fontWeight: "700", color: labelColor, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 }}>{label}</Text>
          {bullets.length > 1 ? (
            <View style={{ gap: 3 }}>
              {bullets.map((b, i) => (
                <View key={i} style={{ flexDirection: "row", gap: 7, alignItems: "flex-start" }}>
                  <Text style={{ fontSize: 13, color: labelColor, fontFamily: "Inter_700Bold", lineHeight: 18 }}>·</Text>
                  <Text style={{ flex: 1, fontSize: 13, color: colors.foreground, fontFamily: "Inter_400Regular", lineHeight: 18 }}>{b}</Text>
                </View>
              ))}
            </View>
          ) : (
            <Text style={{ fontSize: 13, color: colors.foreground, fontFamily: "Inter_400Regular", lineHeight: 18 }}>{text}</Text>
          )}
        </View>
      </View>
    </View>
  );
}

const WORKOUT_TYPE_META: Record<WorkoutType, { label: string; emoji: string; icon: keyof typeof Feather.glyphMap }> = {
  gym:  { label: "Gym Workout",  emoji: "🏋️", icon: "activity" },
  bike: { label: "On the Bike",  emoji: "🏁",  icon: "wind" },
};

// ─── Coach: Plan Screen ───────────────────────────────────────────────────────

function PlanScreen({ plan, workoutType, onReset, colors, insets }: {
  plan: WorkoutPlan;
  workoutType: WorkoutType;
  onReset: () => void;
  colors: ReturnType<typeof useColors>;
  insets: ReturnType<typeof useSafeAreaInsets>;
}) {
  const typeMeta = WORKOUT_TYPE_META[workoutType];
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: insets.bottom + 32 }}>
      {/* Plan header */}
      <View style={{ borderRadius: 14, overflow: "hidden", borderWidth: 1.5, borderColor: ACCENT + "44" }}>
        <View style={{ padding: 16, backgroundColor: ACCENT + "12" }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8 }}>
            <Text style={{ flex: 1, fontSize: 20, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold", letterSpacing: -0.5, lineHeight: 24 }}>
              {plan.planTitle}
            </Text>
            <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: ACCENT, marginLeft: 10 }}>
              <Text style={{ fontSize: 12, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" }}>{plan.totalMinutes} min</Text>
            </View>
          </View>
          {/* Workout type badge */}
          <View style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: ACCENT + "22", marginBottom: 10 }}>
            <Text style={{ fontSize: 12 }}>{typeMeta.emoji}</Text>
            <Text style={{ fontSize: 11, fontWeight: "700", color: ACCENT, fontFamily: "Inter_700Bold" }}>{typeMeta.label}</Text>
          </View>
          {/* Focus tags */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
            {(plan.focus ?? []).map((f, i) => (
              <View key={i} style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: ACCENT + "25" }}>
                <Text style={{ fontSize: 11, fontWeight: "700", color: ACCENT, fontFamily: "Inter_700Bold" }}>{f}</Text>
              </View>
            ))}
          </View>
          {/* MX relevance — bullet list */}
          {Array.isArray(plan.mxRelevance) ? (
            <View style={{ gap: 3 }}>
              {(plan.mxRelevance as string[]).map((bullet, i) => (
                <View key={i} style={{ flexDirection: "row", gap: 7, alignItems: "flex-start" }}>
                  <Text style={{ fontSize: 13, color: ACCENT, fontFamily: "Inter_700Bold", lineHeight: 19 }}>·</Text>
                  <Text style={{ flex: 1, fontSize: 13, color: colors.foreground, fontFamily: "Inter_400Regular", lineHeight: 19 }}>{bullet}</Text>
                </View>
              ))}
            </View>
          ) : (
            <Text style={{ fontSize: 13, color: colors.foreground, fontFamily: "Inter_400Regular", lineHeight: 19 }}>{plan.mxRelevance as string}</Text>
          )}
        </View>
        {/* Phase overview strip */}
        <View style={{ flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border + "80" }}>
          {(plan.phases ?? []).map((phase, i) => (
            <View key={i} style={{ flex: 1, padding: 8, alignItems: "center", borderRightWidth: i < plan.phases.length - 1 ? StyleSheet.hairlineWidth : 0, borderRightColor: colors.border + "60" }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: phase.phaseColor, marginBottom: 3 }} />
              <Text style={{ fontSize: 9, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", textAlign: "center" }}>{phase.name}</Text>
              <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>{phase.duration}m</Text>
            </View>
          ))}
        </View>
      </View>

      {/* Phases + exercises or drill blocks */}
      {(plan.phases ?? []).map((phase, pi) => (
        <View key={pi} style={{ gap: 10 }}>
          {/* Phase header */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: phase.phaseColor }} />
            <Text style={{ fontSize: 12, fontWeight: "800", color: phase.phaseColor, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 1, flex: 1 }}>
              {phase.name}
            </Text>
            <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, backgroundColor: phase.phaseColor + "20" }}>
              <Text style={{ fontSize: 11, fontWeight: "700", color: phase.phaseColor, fontFamily: "Inter_700Bold" }}>{phase.duration} min</Text>
            </View>
          </View>
          {/* Exercise cards or drill blocks */}
          {Array.isArray(phase.drillBlocks) && phase.drillBlocks.length > 0
            ? phase.drillBlocks.map((drill, di) => (
                <DrillCard key={di} drill={drill} phaseColor={phase.phaseColor} colors={colors} />
              ))
            : (phase.exercises ?? []).map((ex, ei) => (
                <ExerciseCard key={ei} ex={ex} phaseColor={phase.phaseColor} index={ei} colors={colors} />
              ))
          }
        </View>
      ))}

      {/* Footer tips */}
      {plan.proTip && (
        <TipCard emoji="🏆" label="Pro Tip" labelColor={ACCENT} text={plan.proTip} colors={colors} />
      )}
      {plan.nutritionTip && (
        <TipCard emoji="🥗" label="Nutrition" labelColor="#22c55e" text={plan.nutritionTip} colors={colors} />
      )}
      {plan.recoveryTip && (
        <TipCard emoji="💤" label="Recovery" labelColor="#8b5cf6" text={plan.recoveryTip} colors={colors} />
      )}

      {/* New plan button */}
      <Pressable onPress={onReset} style={({ pressed }) => ({ marginTop: 4, borderRadius: 12, borderWidth: 1.5, borderColor: ACCENT, paddingVertical: 14, alignItems: "center", opacity: pressed ? 0.7 : 1 })}>
        <Text style={{ fontSize: 15, fontWeight: "700", color: ACCENT, fontFamily: "Inter_700Bold" }}>Generate New Plan</Text>
      </Pressable>
    </ScrollView>
  );
}

// ─── Coach: Loading Screen ────────────────────────────────────────────────────

function LoadingScreen({ colors, insets }: { colors: ReturnType<typeof useColors>; insets: ReturnType<typeof useSafeAreaInsets> }) {
  const [msgIdx, setMsgIdx] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const interval = setInterval(() => {
      Animated.sequence([
        Animated.timing(fadeAnim, { toValue: 0, duration: 300, useNativeDriver: true }),
        Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
      ]).start();
      setMsgIdx(i => (i + 1) % LOADING_MESSAGES.length);
    }, 2200);
    return () => clearInterval(interval);
  }, []);

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 40, gap: 24 }}>
      {/* Animated logo / spinner */}
      <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: ACCENT + "20", alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" color={ACCENT} />
      </View>
      <View style={{ alignItems: "center", gap: 8 }}>
        <Text style={{ fontSize: 18, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center" }}>
          Building Your Plan
        </Text>
        <Animated.Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", opacity: fadeAnim }}>
          {LOADING_MESSAGES[msgIdx]}
        </Animated.Text>
      </View>
      <Text style={{ fontSize: 11, color: colors.mutedForeground + "80", fontFamily: "Inter_400Regular", textAlign: "center" }}>
        Claude is consulting professional MX training protocols…
      </Text>
    </View>
  );
}

// ─── Coach: Input Screen ──────────────────────────────────────────────────────

const WORKOUT_TYPES: { key: WorkoutType; emoji: string; label: string }[] = [
  { key: "gym",  emoji: "🏋️", label: "Gym Workout" },
  { key: "bike", emoji: "🏁",  label: "On the Bike" },
];

const DURATION_LABEL: Record<WorkoutType, string> = {
  gym:  "Total Time",
  bike: "Practice Time",
};

const LAST_WORKOUT_TYPE_KEY = "last_workout_type_v1";

const SUGGESTIONS_BY_TYPE: Record<WorkoutType | "default", string[]> = {
  default: [
    "Reduce arm pump on long motos",
    "Improve explosive holeshot speed",
    "Better core stability in whoops",
    "Increase overall moto endurance",
    "Strengthen grip and wrist control",
  ],
  gym: [
    "Reduce arm pump with targeted forearm training",
    "Build explosive holeshot power with plyometrics",
    "Core stability for whoops and rhythm sections",
    "Grip strength and wrist endurance",
    "Increase moto cardio endurance",
  ],
  bike: [
    "Improve gate start reaction time",
    "Rut riding confidence and line choice",
    "Corner entry and exit speed",
    "Scrub technique over jumps",
    "Whoops section momentum and flow",
  ],
};

function InputScreen({ onGenerate, colors, insets }: {
  onGenerate: (goal: string, duration: number, workoutType: WorkoutType) => void;
  colors: ReturnType<typeof useColors>;
  insets: ReturnType<typeof useSafeAreaInsets>;
}) {
  const [goal, setGoal]               = useState("");
  const [duration, setDuration]       = useState<number | null>(null);
  const [workoutType, setWorkoutType] = useState<WorkoutType | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(LAST_WORKOUT_TYPE_KEY).then(val => {
      if (val === "gym" || val === "bike") {
        setWorkoutType(val);
      } else if (val === "mix") {
        setWorkoutType("gym");
      }
    }).catch(() => {});
  }, []);

  const handleSetWorkoutType = useCallback((wt: WorkoutType) => {
    setWorkoutType(wt);
    AsyncStorage.setItem(LAST_WORKOUT_TYPE_KEY, wt).catch(() => {});
  }, []);

  const canGenerate = goal.trim().length > 10 && duration !== null && workoutType !== null;

  const suggestions = workoutType ? SUGGESTIONS_BY_TYPE[workoutType] : SUGGESTIONS_BY_TYPE.default;

  const durationLabel = workoutType ? DURATION_LABEL[workoutType] : "How long do you have?";

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 24, paddingBottom: insets.bottom + 32 }}>
        {/* Hero */}
        <View style={{ alignItems: "center", gap: 8, paddingTop: 8 }}>
          <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: ACCENT + "20", alignItems: "center", justifyContent: "center" }}>
            <DirtBikeIcon size={44} color={ACCENT} />
          </View>
          <Text style={{ fontSize: 22, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center", letterSpacing: -0.5 }}>
            MX Training Coach
          </Text>
          <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 19 }}>
            AI-powered workouts built exclusively for{"\n"}Supercross and Motocross racers
          </Text>
        </View>

        {/* Goal input */}
        <View style={{ gap: 10 }}>
          <Text style={{ fontSize: 13, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
            What do you want to improve?
          </Text>
          <TextInput
            value={goal}
            onChangeText={setGoal}
            placeholder="e.g. I get bad arm pump in the last 10 minutes of a moto and my grip strength falls apart in rutted corners…"
            placeholderTextColor={colors.mutedForeground + "80"}
            multiline
            numberOfLines={4}
            style={{
              borderRadius: 12, borderWidth: 1.5,
              borderColor: goal.trim().length > 0 ? ACCENT + "80" : colors.border,
              backgroundColor: colors.card, padding: 14,
              fontSize: 14, color: colors.foreground, fontFamily: "Inter_400Regular",
              lineHeight: 20, minHeight: 110, textAlignVertical: "top",
            }}
          />
          {/* Quick suggestions */}
          <View style={{ gap: 6 }}>
            <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>
              {workoutType ? `Quick picks for ${WORKOUT_TYPE_META[workoutType].label.toLowerCase()}:` : "Quick picks:"}
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {suggestions.map((s, i) => (
                <Pressable key={i} onPress={() => setGoal(s)} style={({ pressed }) => ({ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, backgroundColor: colors.muted, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, opacity: pressed ? 0.7 : 1 })}>
                  <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>{s}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        </View>

        {/* Workout type selector */}
        <View style={{ gap: 10 }}>
          <Text style={{ fontSize: 13, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
            What kind of session?
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {WORKOUT_TYPES.map(wt => {
              const active = workoutType === wt.key;
              return (
                <Pressable
                  key={wt.key}
                  onPress={() => handleSetWorkoutType(wt.key)}
                  style={({ pressed }) => ({
                    flex: 1, paddingVertical: 12, paddingHorizontal: 6, borderRadius: 12,
                    backgroundColor: active ? ACCENT : colors.muted,
                    borderWidth: active ? 0 : StyleSheet.hairlineWidth, borderColor: colors.border,
                    alignItems: "center", gap: 4, opacity: pressed ? 0.75 : 1,
                  })}
                >
                  <Text style={{ fontSize: 18 }}>{wt.emoji}</Text>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: active ? "#fff" : colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center", lineHeight: 14 }}>{wt.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Duration picker */}
        <View style={{ gap: 10 }}>
          <Text style={{ fontSize: 13, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
            {durationLabel}
          </Text>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {DURATION_OPTIONS.map(d => {
              const active = duration === d;
              return (
                <Pressable key={d} onPress={() => setDuration(d)} style={({ pressed }) => ({
                  flex: 1, minWidth: "18%", paddingVertical: 12, borderRadius: 10,
                  backgroundColor: active ? ACCENT : colors.muted,
                  borderWidth: active ? 0 : StyleSheet.hairlineWidth, borderColor: colors.border,
                  alignItems: "center", opacity: pressed ? 0.7 : 1,
                })}>
                  <Text style={{ fontSize: 14, fontWeight: "800", color: active ? "#fff" : colors.foreground, fontFamily: "Inter_700Bold" }}>{d}</Text>
                  <Text style={{ fontSize: 9, color: active ? "#fff" : colors.mutedForeground, fontFamily: "Inter_500Medium", textTransform: "uppercase", letterSpacing: 0.3 }}>min</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Generate button */}
        <Pressable
          disabled={!canGenerate}
          onPress={() => onGenerate(goal.trim(), duration!, workoutType!)}
          style={({ pressed }) => ({
            borderRadius: 14, paddingVertical: 16, alignItems: "center",
            backgroundColor: canGenerate ? ACCENT : colors.muted,
            opacity: pressed ? 0.8 : 1,
          })}
        >
          <Text style={{ fontSize: 16, fontWeight: "800", color: canGenerate ? "#fff" : colors.mutedForeground, fontFamily: "Inter_700Bold" }}>
            Generate My Plan
          </Text>
          {!canGenerate && (
            <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 }}>
              {goal.trim().length === 0
                ? "Describe what you want to improve"
                : goal.trim().length <= 10
                ? "Add a bit more detail"
                : !workoutType
                ? "Select a session type above"
                : "Pick a duration above"}
            </Text>
          )}
        </Pressable>

        {/* Powered by notice */}
        <Text style={{ fontSize: 11, color: colors.mutedForeground + "70", fontFamily: "Inter_400Regular", textAlign: "center" }}>
          Powered by Claude AI · Trained on professional MX/SX conditioning programs
        </Text>

        {/* Disclaimer */}
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 7, backgroundColor: colors.muted, borderRadius: 10, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
          <Feather name="info" size={12} color={colors.mutedForeground} style={{ marginTop: 1, flexShrink: 0 }} />
          <Text style={{ flex: 1, fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", lineHeight: 16 }}>
            <Text style={{ fontFamily: "Inter_700Bold" }}>For informational purposes only.</Text>
            {" "}AI-generated training plans are suggestions and may not be suitable for your fitness level or health condition. Consult a certified personal trainer before starting any new gym program, and always ride within your ability level under the guidance of a qualified coach.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function TrainScreen() {
  const colors  = useColors();
  const insets  = useSafeAreaInsets();
  const router  = useRouter();
  const { isAuthenticated, isLoading: authLoading, activeProfiles, riderFetch, account } = useRiderAuth();

  // ── Tab mode ────────────────────────────────────────────────────────────────
  const [tabMode, setTabMode] = useState<TabMode>("track");

  // ── Track data ───────────────────────────────────────────────────────────────
  const [tracks, setTracks]             = useState<TrackItem[]>([]);
  const [trackLoading, setTrackLoading] = useState(false);
  const [refreshing, setRefreshing]     = useState(false);
  const [trackError, setTrackError]     = useState<string | null>(null);
  const [selectedTrack, setSelectedTrack]     = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);

  // ── Coach data ───────────────────────────────────────────────────────────────
  const [coachState, setCoachState]     = useState<CoachState>("input");
  const [plan, setPlan]                 = useState<WorkoutPlan | null>(null);
  const [savedWorkoutType, setSavedWorkoutType] = useState<WorkoutType>("gym");
  const [coachError, setCoachError]     = useState<string | null>(null);
  const [planStorageReady, setPlanStorageReady] = useState(false);

  const planStorageKey = account ? `workout_plan_v2_${account.id}` : null;

  // Load persisted plan whenever the account changes.
  // Always reset in-memory state first so a prior rider's plan never bleeds
  // into a new session (logout, account switch).
  useEffect(() => {
    if (authLoading) return;

    setPlan(null);
    setCoachState("input");
    setSavedWorkoutType("gym");
    setPlanStorageReady(false);

    if (!planStorageKey) {
      setPlanStorageReady(true);
      return;
    }

    async function loadSavedPlan() {
      try {
        const raw = await AsyncStorage.getItem(planStorageKey!);
        if (raw) {
          const saved = JSON.parse(raw);
          // Support new format { plan, workoutType } and old format (raw WorkoutPlan)
          if (saved && typeof saved === "object" && "plan" in saved) {
            setPlan(saved.plan as WorkoutPlan);
            const rawType = saved.workoutType as string;
            setSavedWorkoutType((rawType === "gym" || rawType === "bike") ? rawType : "gym");
          } else {
            // Legacy: treat as gym plan
            setPlan(saved as WorkoutPlan);
            setSavedWorkoutType("gym");
          }
          setCoachState("plan");
        } else {
          setPlan(null);
          setCoachState("input");
        }
      } catch {
        setPlan(null);
        setCoachState("input");
      } finally {
        setPlanStorageReady(true);
      }
    }
    void loadSavedPlan();
  }, [authLoading, planStorageKey]);

  const primaryProfile = activeProfiles[0] ?? null;

  // ── Load track data ──────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    if (!primaryProfile) return;
    setTrackError(null);
    setTrackLoading(true);
    try {
      const [practiceRes, eventPracticeRes] = await Promise.all([
        riderFetch(`/api/rider/profiles/${primaryProfile.id}/practice`),
        riderFetch(`/api/rider/profiles/${primaryProfile.id}/event-practice`),
      ]);
      const built: TrackItem[] = [];
      if (eventPracticeRes.ok) {
        const { events } = await eventPracticeRes.json();
        for (const ev of (events ?? [])) {
          const sessions: SessionItem[] = (ev.sessions ?? []).map((s: any) => ({
            key: `event-moto-${s.motoId}`,
            label: s.sessionName,
            status: s.status,
            myLaps: (s.myLaps ?? []).sort((a: LapEntry, b: LapEntry) => a.lapNumber - b.lapNumber),
            bestLapMs: s.myLaps?.length ? (() => { const v = (s.myLaps as LapEntry[]).filter(l => (l.lapTimeMs ?? 0) > 0); return v.length ? Math.min(...v.map(l => l.lapTimeMs!)) : null; })() : null,
            leaderboard: s.leaderboard ?? [],
          }));
          if (sessions.length === 0) continue;
          built.push({ key: `event-${ev.eventId}`, label: ev.eventName, sublabel: [fmtDate(ev.eventDate), ev.eventState].filter(Boolean).join(" · "), sessions });
        }
      }
      if (practiceRes.ok) {
        const { sessions: standaloneSessions } = await practiceRes.json();
        if ((standaloneSessions ?? []).length > 0) {
          built.push({
            key: "standalone", label: "Standalone Sessions",
            sublabel: `${standaloneSessions.length} session${standaloneSessions.length !== 1 ? "s" : ""}`,
            sessions: (standaloneSessions as any[]).map(s => ({
              key: `practice-${s.sessionId}`, label: s.sessionName, status: s.endedAt ? "completed" : "in_progress",
              myLaps: (s.laps ?? []).sort((a: LapEntry, b: LapEntry) => a.lapNumber - b.lapNumber),
              bestLapMs: s.bestLapMs ?? null, leaderboard: undefined,
            })),
          });
        }
      }
      setTracks(built);
      if (built.length > 0) {
        setSelectedTrack(prev => prev ?? built[0].key);
        if (built[0].sessions.length > 0) setSelectedSession(prev => prev ?? built[0].sessions[0].key);
      }
    } catch {
      setTrackError("Couldn't load practice data. Pull to refresh.");
    } finally {
      setTrackLoading(false);
    }
  }, [primaryProfile?.id, riderFetch]);

  useEffect(() => {
    if (isAuthenticated && primaryProfile) void loadData();
  }, [isAuthenticated, primaryProfile?.id]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  // ── Coach generation ──────────────────────────────────────────────────────────
  const handleGenerate = useCallback(async (goal: string, duration: number, workoutType: WorkoutType) => {
    setCoachState("loading");
    setCoachError(null);
    try {
      const res = await riderFetch("/api/rider/training-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal, durationMinutes: duration, workoutType }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error ?? "Failed to generate plan");
      }
      const data: WorkoutPlan = await res.json();
      setPlan(data);
      setSavedWorkoutType(workoutType);
      setCoachState("plan");
      if (planStorageKey) {
        AsyncStorage.setItem(planStorageKey, JSON.stringify({ plan: data, workoutType })).catch(() => {});
      }
    } catch (e: any) {
      setCoachError(e?.message ?? "Something went wrong. Please try again.");
      setCoachState("error");
    }
  }, [riderFetch, planStorageKey]);

  const handleResetPlan = useCallback(() => {
    setPlan(null);
    setSavedWorkoutType("gym");
    setCoachState("input");
    if (planStorageKey) {
      AsyncStorage.removeItem(planStorageKey).catch(() => {});
    }
  }, [planStorageKey]);

  // ── Derived track data ────────────────────────────────────────────────────────
  const currentTrack   = useMemo(() => tracks.find(t => t.key === selectedTrack) ?? null, [tracks, selectedTrack]);
  const currentSession = useMemo(() => currentTrack?.sessions.find(s => s.key === selectedSession) ?? null, [currentTrack, selectedSession]);

  const handleTrackSelect = useCallback((key: string) => {
    setSelectedTrack(key);
    const track = tracks.find(t => t.key === key);
    if (track?.sessions.length) setSelectedSession(track.sessions[0].key);
    else setSelectedSession(null);
  }, [tracks]);

  const allSessions = tracks.flatMap(t => t.sessions);
  const totalLaps   = allSessions.reduce((n, s) => n + s.myLaps.filter(l => (l.lapTimeMs ?? 0) > 0).length, 0);
  const allBests    = allSessions.map(s => s.bestLapMs).filter((ms): ms is number => ms != null && ms > 0);
  const overallBest = allBests.length ? Math.min(...allBests) : null;

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header:    { paddingTop: insets.top + 16, paddingHorizontal: 20, paddingBottom: 12, backgroundColor: colors.background, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    statsRow:  { flexDirection: "row", gap: 10, marginTop: 14 },
    statBox:   { flex: 1, backgroundColor: colors.muted, borderRadius: 10, padding: 12, alignItems: "center" },
    statValue: { fontSize: 18, fontWeight: "700", color: ACCENT, fontFamily: "Inter_700Bold" },
    statLabel: { fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_500Medium", marginTop: 2, textTransform: "uppercase", letterSpacing: 0.5 },
    segControl: { flexDirection: "row", margin: 16, borderRadius: 10, backgroundColor: colors.muted, padding: 3, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
    segBtn:    { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center" },
    pickerRow: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    pickerLabel: { fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.8, paddingHorizontal: 16, marginBottom: 6 },
    footer:    { height: insets.bottom + 32 },
  });

  if (authLoading) {
    return <View style={[styles.container, { flex: 1, alignItems: "center", justifyContent: "center" }]}><ActivityIndicator color={ACCENT} /></View>;
  }

  if (!isAuthenticated) {
    return (
      <View style={[styles.container, { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 }]}>
        <Feather name="activity" size={48} color={colors.mutedForeground} />
        <Text style={{ fontSize: 18, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center" }}>Your training lives here</Text>
        <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 }}>Sign in to see your practice sessions and lap times.</Text>
        <Pressable style={{ marginTop: 12, backgroundColor: ACCENT, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 10 }} onPress={() => router.push("/(tabs)/profile")}>
          <Text style={{ color: "#fff", fontSize: 15, fontWeight: "700", fontFamily: "Inter_700Bold" }}>Sign In</Text>
        </Pressable>
      </View>
    );
  }

  if (!primaryProfile) {
    return (
      <View style={[styles.container, { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 }]}>
        <Feather name="user-x" size={40} color={colors.mutedForeground} />
        <Text style={{ fontSize: 18, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center" }}>No rider profile linked</Text>
        <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 }}>Register for an event using this email to link your rider profile.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* ── Shared header ── */}
      <View style={styles.header}>
        <BrandBar />
        <Text style={{ fontSize: 26, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold", letterSpacing: -0.5 }}>Train</Text>

        {/* Segmented control: Track | Coach */}
        <View style={[styles.segControl, { marginTop: 14, marginHorizontal: 0 }]}>
          {(["track", "coach"] as TabMode[]).map(mode => {
            const active = tabMode === mode;
            return (
              <Pressable key={mode} onPress={() => setTabMode(mode)} style={[styles.segBtn, { backgroundColor: active ? colors.background : "transparent" }]}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                  <Feather name={mode === "track" ? "activity" : "cpu"} size={13} color={active ? ACCENT : colors.mutedForeground} />
                  <Text style={{ fontSize: 13, fontWeight: "700", color: active ? ACCENT : colors.mutedForeground, fontFamily: "Inter_700Bold" }}>
                    {mode === "track" ? "Track" : "Train"}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>

        {/* Track-mode stats (only shown in track mode) */}
        {tabMode === "track" && (
          <View style={styles.statsRow}>
            <View style={styles.statBox}>
              <Text style={styles.statValue}>{allSessions.length}</Text>
              <Text style={styles.statLabel}>Sessions</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statValue}>{totalLaps}</Text>
              <Text style={styles.statLabel}>Total Laps</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statValue}>{fmtLap(overallBest)}</Text>
              <Text style={styles.statLabel}>Best Ever</Text>
            </View>
          </View>
        )}
      </View>

      {/* ── Track mode ── */}
      {tabMode === "track" && (
        <>
          {tracks.length > 0 && (
            <View style={styles.pickerRow}>
              <Text style={styles.pickerLabel}>Track</Text>
              <ChipBar items={tracks.map(t => ({ key: t.key, label: t.label, sub: t.sublabel }))} selected={selectedTrack} onSelect={handleTrackSelect} colors={colors} />
            </View>
          )}
          {currentTrack && currentTrack.sessions.length > 1 && (
            <View style={[styles.pickerRow, { borderBottomWidth: StyleSheet.hairlineWidth }]}>
              <Text style={styles.pickerLabel}>Session</Text>
              <ChipBar items={currentTrack.sessions.map(s => ({ key: s.key, label: s.label }))} selected={selectedSession} onSelect={setSelectedSession} colors={colors} />
            </View>
          )}
          <ScrollView
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />}
            contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, gap: 16, paddingBottom: insets.bottom + 32 }}
          >
            {trackLoading && !refreshing ? (
              <View style={{ marginTop: 60, alignItems: "center" }}><ActivityIndicator color={ACCENT} /></View>
            ) : trackError ? (
              <View style={{ padding: 32, alignItems: "center", gap: 8 }}>
                <Feather name="alert-circle" size={32} color={colors.mutedForeground} />
                <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center" }}>{trackError}</Text>
              </View>
            ) : tracks.length === 0 ? (
              <View style={{ paddingTop: 48, alignItems: "center", gap: 10 }}>
                <Feather name="activity" size={40} color={colors.mutedForeground} />
                <Text style={{ fontSize: 17, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center" }}>No practice sessions yet</Text>
                <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 }}>Practice lap times from events or standalone sessions will appear here.</Text>
              </View>
            ) : !currentSession ? (
              <View style={{ paddingTop: 48, alignItems: "center", gap: 8 }}>
                <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>Select a session above</Text>
              </View>
            ) : (
              <>
                {/* Session summary */}
                <View style={{ borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: ACCENT + "44", backgroundColor: colors.card, padding: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 16, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold" }}>{currentSession.label}</Text>
                    {currentTrack && (
                      <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 }}>
                        {currentTrack.label}{currentTrack.sublabel ? `  ·  ${currentTrack.sublabel}` : ""}
                      </Text>
                    )}
                    {currentSession.status === "in_progress" && (
                      <View style={{ alignSelf: "flex-start", marginTop: 6, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, backgroundColor: "#ef444420" }}>
                        <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: "#ef4444" }} />
                        <Text style={{ fontSize: 10, fontWeight: "700", color: "#ef4444", fontFamily: "Inter_700Bold" }}>LIVE</Text>
                      </View>
                    )}
                  </View>
                  <View style={{ alignItems: "flex-end", gap: 2 }}>
                    <Text style={{ fontSize: 24, fontWeight: "800", color: ACCENT, fontFamily: "Inter_700Bold" }}>{fmtLap(currentSession.bestLapMs)}</Text>
                    <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_500Medium", textTransform: "uppercase", letterSpacing: 0.5 }}>Best Lap</Text>
                    <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>{currentSession.myLaps.filter(l => (l.lapTimeMs ?? 0) > 0).length} laps</Text>
                  </View>
                </View>
                <View>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>Lap Times</Text>
                  <LapTable laps={currentSession.myLaps} colors={colors} />
                </View>
                {currentSession.leaderboard && currentSession.leaderboard.length > 0 && (
                  <View>
                    <Text style={{ fontSize: 11, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>Class Leaderboard</Text>
                    <Leaderboard entries={currentSession.leaderboard} colors={colors} />
                  </View>
                )}
              </>
            )}
          </ScrollView>
        </>
      )}

      {/* ── Coach mode ── */}
      {tabMode === "coach" && (
        <>
          {coachState === "input" && planStorageReady && (
            <InputScreen onGenerate={handleGenerate} colors={colors} insets={insets} />
          )}
          {coachState === "loading" && (
            <LoadingScreen colors={colors} insets={insets} />
          )}
          {coachState === "plan" && plan && (
            <PlanScreen plan={plan} workoutType={savedWorkoutType} onReset={handleResetPlan} colors={colors} insets={insets} />
          )}
          {coachState === "error" && (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 40, gap: 16 }}>
              <Feather name="alert-circle" size={40} color="#ef4444" />
              <Text style={{ fontSize: 17, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center" }}>Couldn't Generate Plan</Text>
              <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 }}>{coachError}</Text>
              <Pressable onPress={() => setCoachState("input")} style={{ backgroundColor: ACCENT, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 10 }}>
                <Text style={{ color: "#fff", fontSize: 15, fontWeight: "700", fontFamily: "Inter_700Bold" }}>Try Again</Text>
              </Pressable>
            </View>
          )}
        </>
      )}
    </View>
  );
}
