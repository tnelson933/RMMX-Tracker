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

import { useRockyChat } from "@/context/RockyChatContext";
import { useColors } from "@/hooks/useColors";
import { resolveFollowUpChips } from "@/utils/rockyFollowUps";

const ACCENT = "#cf152d";

// ─── Capability chips ─────────────────────────────────────────────────────────

interface Chip {
  label: string;
  question: string;
}

const CHIPS: Chip[] = [
  { label: "Suspension setup", question: "How do I set up my suspension for a motocross track?" },
  { label: "Arm pump fix", question: "How do I fix arm pump while riding?" },
  { label: "Corner technique", question: "What's the best technique for cornering on a dirt bike?" },
  { label: "Jetting help", question: "How do I know if my jetting is off and how do I fix it?" },
  { label: "Starts", question: "How do I get a better holeshot start?" },
  { label: "Bike maintenance", question: "What are the most important regular maintenance tasks for a motocross bike?" },
];

// ─── Main widget ──────────────────────────────────────────────────────────────

export function RockyHomeWidget() {
  const colors = useColors();
  const router = useRouter();
  const { messages, isTyping, error, setError, inputText, setInputText, sendMessage, suggestedFollowUps } =
    useRockyChat();

  function handleChip(chip: Chip) {
    void sendMessage(chip.question);
  }

  function handleSend() {
    void sendMessage();
  }

  // Find last user + last assistant messages
  const lastUser = [...messages].reverse().find(m => m.role === "user");
  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
  const hasConversation = messages.length > 0;

  // Show follow-up chips when Rocky has finished replying to at least one user message
  const showFollowUpChips = !isTyping && !!lastUser && !!lastAssistant;
  // Prefer AI-suggested follow-ups; fall back to keyword-matched chips via shared utility
  const followUpChips: Chip[] = showFollowUpChips
    ? resolveFollowUpChips(suggestedFollowUps, lastUser!.content)
    : [];

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
        },
      ]}
    >
      {/* ── Header ── */}
      <View style={styles.header}>
        <View style={styles.iconWrap}>
          <Feather name="zap" size={14} color={ACCENT} />
        </View>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>
          Rocky{" "}
          <Text style={[styles.headerSubtitle, { color: colors.mutedForeground }]}>
            · AI Mechanic
          </Text>
        </Text>
        <Pressable
          onPress={() => router.push("/mechanic" as any)}
          hitSlop={10}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Feather name="arrow-right" size={16} color={colors.mutedForeground} />
        </Pressable>
      </View>

      {/* ── Last exchange (only when conversation exists) ── */}
      {hasConversation && (
        <View style={[styles.exchangeArea, { borderTopColor: colors.border }]}>
          {lastUser && (
            <View style={[styles.userBubble, { backgroundColor: colors.primary }]}>
              <Text style={styles.userBubbleText} numberOfLines={3}>
                {lastUser.content}
              </Text>
            </View>
          )}
          {isTyping ? (
            <View style={[styles.assistantBubble, { backgroundColor: colors.muted, borderColor: colors.border }]}>
              <ActivityIndicator size="small" color={ACCENT} />
            </View>
          ) : lastAssistant ? (
            <View style={[styles.assistantBubble, { backgroundColor: colors.muted, borderColor: colors.border }]}>
              <Text style={[styles.assistantBubbleText, { color: colors.foreground }]} numberOfLines={5}>
                {lastAssistant.content}
              </Text>
            </View>
          ) : null}
        </View>
      )}

      {/* ── Capability chips (empty state) ── */}
      {!hasConversation && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipsRow}
        >
          {CHIPS.map((chip) => (
            <Pressable
              key={chip.label}
              onPress={() => handleChip(chip)}
              style={({ pressed }) => [
                styles.chip,
                {
                  backgroundColor: colors.muted,
                  borderColor: colors.border,
                  opacity: pressed ? 0.72 : 1,
                },
              ]}
            >
              <Text style={[styles.chipText, { color: colors.mutedForeground }]}>
                {chip.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
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
              onPress={() => handleChip(chip)}
              style={({ pressed }) => [
                styles.followUpChip,
                {
                  backgroundColor: ACCENT + "12",
                  borderColor: ACCENT + "40",
                  opacity: pressed ? 0.72 : 1,
                },
              ]}
            >
              <Text style={[styles.followUpChipText, { color: ACCENT }]}>
                {chip.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* ── Error banner ── */}
      {error && (
        <View style={styles.errorBanner}>
          <Feather name="alert-circle" size={12} color="#DC2626" />
          <Text style={styles.errorText} numberOfLines={2}>{error}</Text>
          <Pressable onPress={() => setError(null)} hitSlop={8}>
            <Feather name="x" size={12} color="#DC2626" />
          </Pressable>
        </View>
      )}

      {/* ── Input bar ── */}
      <View style={[styles.inputBar, { borderTopColor: colors.border }]}>
        <TextInput
          style={[
            styles.input,
            {
              backgroundColor: colors.muted,
              borderColor: colors.border,
              color: colors.foreground,
            },
          ]}
          placeholder="Ask Rocky anything…"
          placeholderTextColor={colors.mutedForeground}
          value={inputText}
          onChangeText={setInputText}
          multiline
          maxLength={1000}
          returnKeyType="send"
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
          editable={!isTyping}
        />
        <Pressable
          onPress={handleSend}
          disabled={!inputText.trim() || isTyping}
          style={({ pressed }) => ({
            width: 34,
            height: 34,
            borderRadius: 17,
            backgroundColor: inputText.trim() && !isTyping ? ACCENT : colors.muted,
            borderWidth: 1,
            borderColor: inputText.trim() && !isTyping ? ACCENT : colors.border,
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.75 : 1,
          })}
        >
          <Feather
            name="send"
            size={14}
            color={inputText.trim() && !isTyping ? "#fff" : colors.mutedForeground}
          />
        </Pressable>
      </View>

      {/* ── Disclaimer ── */}
      <Text style={[styles.disclaimer, { color: colors.mutedForeground }]}>
        Advice is for informational purposes only. Always consult a qualified mechanic and certified riding coach.
      </Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginBottom: 24,
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  iconWrap: {
    width: 26,
    height: 26,
    borderRadius: 8,
    backgroundColor: ACCENT + "18",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: "700",
    fontFamily: "Inter_700Bold",
  },
  headerSubtitle: {
    fontSize: 13,
    fontWeight: "400",
    fontFamily: "Inter_400Regular",
  },
  exchangeArea: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
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
  chipsRow: {
    paddingHorizontal: 12,
    paddingTop: 2,
    paddingBottom: 12,
    gap: 8,
    flexDirection: "row",
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 12,
    fontWeight: "600",
    fontFamily: "Inter_600SemiBold",
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 12,
    borderTopWidth: 1,
  },
  input: {
    flex: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
    fontSize: 13,
    lineHeight: 18,
    borderWidth: 1,
    maxHeight: 90,
    fontFamily: "Inter_400Regular",
  },
  followUpChipsRow: {
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 10,
    gap: 8,
    flexDirection: "row",
  },
  followUpChip: {
    paddingHorizontal: 11,
    paddingVertical: 5,
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
    marginBottom: 6,
    padding: 8,
    borderRadius: 8,
    backgroundColor: "#FEE2E2",
  },
  errorText: {
    flex: 1,
    fontSize: 11,
    color: "#DC2626",
    fontFamily: "Inter_400Regular",
  },
  disclaimer: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    paddingHorizontal: 14,
    paddingBottom: 10,
    lineHeight: 14,
    opacity: 0.65,
  },
});
