import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { ROCKY_QUICK_QUESTIONS, RockyAvatar } from "@/components/RockyAvatar";
import { useRockyChat } from "@/context/RockyChatContext";
import { useColors } from "@/hooks/useColors";
import { resolveFollowUpChips } from "@/utils/rockyFollowUps";

// ─── Main widget ──────────────────────────────────────────────────────────────

export function RockyHomeWidget() {
  const colors = useColors();
  const router = useRouter();
  const { messages, isTyping, error, setError, inputText, setInputText, sendMessage, suggestedFollowUps } =
    useRockyChat();

  // Questions open the full chat so the answer has room
  function ask(question: string) {
    void sendMessage(question);
    router.push("/mechanic" as any);
  }

  function handleSend() {
    if (!inputText.trim() || isTyping) return;
    void sendMessage();
    router.push("/mechanic" as any);
  }

  // Find last user + last assistant messages
  const lastUser = [...messages].reverse().find(m => m.role === "user");
  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
  // Rocky's built-in greeting doesn't count: a conversation starts with the rider's question
  const hasConversation = !!lastUser;

  // Show follow-up chips when Rocky has finished replying to at least one user message
  const showFollowUpChips = !isTyping && !!lastUser && !!lastAssistant;
  // Prefer AI-suggested follow-ups; fall back to keyword-matched chips via shared utility
  const followUpChips = showFollowUpChips
    ? resolveFollowUpChips(suggestedFollowUps, lastUser!.content)
    : [];

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.primary + "66", shadowColor: colors.primary }]}>
      {/* ── Hero header ── */}
      <Pressable onPress={() => router.push("/mechanic" as any)} style={({ pressed }) => [styles.hero, { opacity: pressed ? 0.85 : 1 }]}>
        <View pointerEvents="none" style={styles.stripes}>
          <View style={{ height: 3, backgroundColor: colors.primary, opacity: 0.3, marginRight: 140 }} />
          <View style={{ height: 8, backgroundColor: colors.primary, opacity: 0.12, marginTop: 9, marginLeft: 110 }} />
          <View style={{ height: 2, backgroundColor: colors.foreground, opacity: 0.06, marginTop: 9, marginRight: 60 }} />
        </View>
        <RockyAvatar size={54} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.kicker, { color: colors.primary }]}>AI mechanic & riding coach</Text>
          <Text style={[styles.title, { color: colors.foreground }]}>Ask Rocky</Text>
          <Text style={[styles.tagline, { color: colors.mutedForeground }]}>Setup, fixes and faster laps, any time.</Text>
        </View>
        <View style={[styles.openBtn, { backgroundColor: colors.primary }]}>
          <Feather name="arrow-right" size={18} color="#fff" />
        </View>
      </Pressable>

      {/* ── Last exchange (only once the rider has asked something) ── */}
      {hasConversation && (
        <Pressable onPress={() => router.push("/mechanic" as any)} style={[styles.exchangeArea, { borderTopColor: colors.border }]}>
          {lastUser && (
            <View style={[styles.userBubble, { backgroundColor: colors.primary }]}>
              <Text style={styles.userBubbleText} numberOfLines={2}>
                {lastUser.content}
              </Text>
            </View>
          )}
          {isTyping ? (
            <View style={[styles.assistantBubble, { backgroundColor: colors.muted, borderColor: colors.border }]}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          ) : lastAssistant ? (
            <View style={[styles.assistantBubble, { backgroundColor: colors.muted, borderColor: colors.border }]}>
              <Text style={[styles.assistantBubbleText, { color: colors.foreground }]} numberOfLines={4}>
                {lastAssistant.content}
              </Text>
            </View>
          ) : null}
        </Pressable>
      )}

      {/* ── Quick questions (before the first question) ── */}
      {!hasConversation && (
        <View style={styles.grid}>
          {ROCKY_QUICK_QUESTIONS.map(q => (
            <Pressable
              key={q.label}
              onPress={() => ask(q.question)}
              style={({ pressed }) => [styles.tile, { backgroundColor: colors.muted, borderColor: colors.border, opacity: pressed ? 0.72 : 1 }]}
            >
              <View style={[styles.tileIcon, { backgroundColor: colors.primaryTint }]}>
                <Feather name={q.icon} size={14} color={colors.primary} />
              </View>
              <Text style={[styles.tileText, { color: colors.foreground }]} numberOfLines={1}>{q.label}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {/* ── Follow-up chips (after a completed exchange) ── */}
      {showFollowUpChips && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.followUpChipsRow}
        >
          {followUpChips.map((chip) => (
            <Pressable
              key={chip.label}
              onPress={() => ask(chip.question)}
              style={({ pressed }) => [
                styles.followUpChip,
                {
                  backgroundColor: colors.primaryTint,
                  borderColor: colors.primary + "55",
                  opacity: pressed ? 0.72 : 1,
                },
              ]}
            >
              <Text style={[styles.followUpChipText, { color: colors.foreground }]}>
                {chip.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* ── Error banner ── */}
      {error && (
        <View style={[styles.errorBanner, { backgroundColor: colors.dangerTint }]}>
          <Feather name="alert-circle" size={12} color={colors.destructive} />
          <Text style={[styles.errorText, { color: colors.destructive }]} numberOfLines={2}>{error}</Text>
          <Pressable onPress={() => setError(null)} hitSlop={8}>
            <Feather name="x" size={12} color={colors.destructive} />
          </Pressable>
        </View>
      )}

      {/* ── Input bar ── */}
      <View style={styles.inputBar}>
        <TextInput
          style={[
            styles.input,
            {
              backgroundColor: colors.muted,
              borderColor: colors.border,
              color: colors.foreground,
            },
          ]}
          placeholder="Ask about your bike or riding…"
          placeholderTextColor={colors.mutedForeground}
          value={inputText}
          onChangeText={setInputText}
          maxLength={1000}
          returnKeyType="send"
          onSubmitEditing={handleSend}
          editable={!isTyping}
        />
        <Pressable
          onPress={handleSend}
          disabled={!inputText.trim() || isTyping}
          style={({ pressed }) => ({
            width: 42,
            height: 42,
            borderRadius: 21,
            backgroundColor: colors.primary,
            alignItems: "center",
            justifyContent: "center",
            opacity: !inputText.trim() || isTyping ? 0.45 : pressed ? 0.75 : 1,
          })}
        >
          <Feather name="send" size={16} color="#fff" />
        </Pressable>
      </View>

      {/* ── Disclaimer ── */}
      <Text style={[styles.disclaimer, { color: colors.mutedForeground }]}>
        Advice is for information only. Check with a qualified mechanic or coach for safety-critical work.
      </Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginBottom: 24,
    borderRadius: 20,
    borderWidth: 1.5,
    overflow: "hidden",
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  hero: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 14,
  },
  stripes: { position: "absolute", top: 14, left: -60, right: -60, transform: [{ rotate: "-12deg" }] },
  kicker: { fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 1.2, textTransform: "uppercase" },
  title: { fontSize: 24, fontFamily: "Inter_700Bold", fontStyle: "italic", letterSpacing: 0.5, textTransform: "uppercase", marginTop: 1 },
  tagline: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  openBtn: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  exchangeArea: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
    borderTopWidth: 1,
    gap: 8,
  },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "80%",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  userBubbleText: {
    fontSize: 13,
    lineHeight: 18,
    color: "#fff",
    fontFamily: "Inter_400Regular",
  },
  assistantBubble: {
    alignSelf: "flex-start",
    maxWidth: "90%",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
  },
  assistantBubbleText: {
    fontSize: 13,
    lineHeight: 18,
    fontFamily: "Inter_400Regular",
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 4,
  },
  tile: {
    width: "48.5%",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  tileIcon: { width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  tileText: { flex: 1, fontSize: 12, fontFamily: "Inter_600SemiBold" },
  inputBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 10,
  },
  input: {
    flex: 1,
    height: 42,
    borderRadius: 21,
    paddingHorizontal: 16,
    fontSize: 13,
    borderWidth: 1,
    fontFamily: "Inter_400Regular",
  },
  followUpChipsRow: {
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 4,
    gap: 8,
    flexDirection: "row",
  },
  followUpChip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
  },
  followUpChipText: {
    fontSize: 12,
    fontWeight: "600",
    fontFamily: "Inter_600SemiBold",
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: 12,
    marginTop: 6,
    padding: 8,
    borderRadius: 8,
  },
  errorText: {
    flex: 1,
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  disclaimer: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    paddingHorizontal: 14,
    paddingBottom: 12,
    lineHeight: 14,
    opacity: 0.65,
  },
});
