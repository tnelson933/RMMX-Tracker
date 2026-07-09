import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useEffect, useRef } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useRiderAuth } from "@/context/AuthContext";
import { useRockyChat, type ChatMessage } from "@/context/RockyChatContext";
import { resolveFollowUpChips } from "@/utils/rockyFollowUps";

const CONFIRM_CLEAR_LABEL = "Clear chat";

const ACCENT = "#cf152d";

const URL_REGEX = /(https?:\/\/[^\s]+)/g;

// ─── Linked text — renders URLs as tappable links ─────────────────────────────

function LinkedText({
  text,
  textStyle,
  linkColor,
}: {
  text: string;
  textStyle: object;
  linkColor: string;
}) {
  const parts = text.split(URL_REGEX);
  return (
    <Text style={textStyle}>
      {parts.map((part, i) => {
        if (URL_REGEX.test(part)) {
          URL_REGEX.lastIndex = 0;
          return (
            <Text
              key={i}
              style={{ color: linkColor, textDecorationLine: "underline" }}
              onPress={() => Linking.openURL(part).catch(() => {})}
              accessibilityRole="link"
            >
              {part}
            </Text>
          );
        }
        return <React.Fragment key={i}>{part}</React.Fragment>;
      })}
    </Text>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({ msg, colors }: { msg: ChatMessage; colors: ReturnType<typeof useColors> }) {
  const isUser = msg.role === "user";
  return (
    <View style={[
      styles.bubbleRow,
      isUser ? styles.bubbleRowRight : styles.bubbleRowLeft,
    ]}>
      {!isUser && (
        <View style={[styles.avatar, { backgroundColor: ACCENT + "22", borderColor: ACCENT + "44" }]}>
          <Text style={{ fontSize: 14 }}>🔧</Text>
        </View>
      )}
      <View style={[
        styles.bubble,
        isUser
          ? { backgroundColor: ACCENT, maxWidth: "78%" }
          : { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, maxWidth: "82%" },
      ]}>
        <LinkedText
          text={msg.content}
          textStyle={[
            styles.bubbleText,
            { color: isUser ? "#fff" : colors.foreground, fontFamily: "Inter_400Regular" },
          ]}
          linkColor={isUser ? "#ffd0d6" : ACCENT}
        />
      </View>
    </View>
  );
}

// ─── Typing indicator ─────────────────────────────────────────────────────────

function TypingIndicator({ colors }: { colors: ReturnType<typeof useColors> }) {
  return (
    <View style={[styles.bubbleRow, styles.bubbleRowLeft]}>
      <View style={[styles.avatar, { backgroundColor: ACCENT + "22", borderColor: ACCENT + "44" }]}>
        <Text style={{ fontSize: 14 }}>🔧</Text>
      </View>
      <View style={[styles.bubble, { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border }]}>
        <ActivityIndicator size="small" color={ACCENT} />
      </View>
    </View>
  );
}

// ─── Memory panel ─────────────────────────────────────────────────────────────

function MemoryPanel({
  colors,
  memory,
  onClear,
}: {
  colors: ReturnType<typeof useColors>;
  memory: string[];
  onClear: () => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [confirmingClear, setConfirmingClear] = React.useState(false);

  function handleClearPress() {
    if (confirmingClear) {
      onClear();
      setConfirmingClear(false);
      setExpanded(false);
    } else {
      setConfirmingClear(true);
      setTimeout(() => setConfirmingClear(false), 3000);
    }
  }

  return (
    <View style={[styles.memoryContainer, { borderBottomColor: colors.border, backgroundColor: colors.card }]}>
      {/* Header row — always visible */}
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        style={({ pressed }) => [styles.memoryHeader, { opacity: pressed ? 0.7 : 1 }]}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Feather name="cpu" size={13} color={ACCENT} />
          <Text style={{ fontSize: 12, fontFamily: "Inter_700Bold", color: ACCENT, letterSpacing: 0.3 }}>
            Rocky's Memory
          </Text>
          {memory.length > 0 && (
            <View style={[styles.memoryBadge, { backgroundColor: ACCENT + "20", borderColor: ACCENT + "40" }]}>
              <Text style={{ fontSize: 10, color: ACCENT, fontFamily: "Inter_700Bold" }}>{memory.length}</Text>
            </View>
          )}
        </View>
        <Feather
          name={expanded ? "chevron-up" : "chevron-down"}
          size={14}
          color={colors.mutedForeground}
        />
      </Pressable>

      {/* Expanded content */}
      {expanded && (
        <View style={styles.memoryBody}>
          {memory.length === 0 ? (
            <Text style={[styles.memoryEmpty, { color: colors.mutedForeground }]}>
              No memory yet — Rocky will learn from your conversations over time.
            </Text>
          ) : (
            <ScrollView
              style={{ maxHeight: 180 }}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              {memory.map((entry, i) => (
                <View
                  key={i}
                  style={[
                    styles.memoryEntry,
                    {
                      backgroundColor: colors.muted,
                      borderColor: colors.border,
                      borderBottomWidth: i < memory.length - 1 ? 1 : 0,
                    },
                  ]}
                >
                  <Feather name="bookmark" size={11} color={colors.mutedForeground} style={{ marginTop: 2, flexShrink: 0 }} />
                  <Text style={[styles.memoryEntryText, { color: colors.foreground }]}>{entry}</Text>
                </View>
              ))}
            </ScrollView>
          )}

          {/* Clear memory button */}
          <Pressable
            onPress={handleClearPress}
            style={({ pressed }) => [
              styles.clearMemoryBtn,
              {
                backgroundColor: confirmingClear ? "#FEE2E2" : colors.muted,
                borderColor: confirmingClear ? "#FECACA" : colors.border,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <Feather name="trash-2" size={13} color={confirmingClear ? "#DC2626" : colors.mutedForeground} />
            <Text
              style={[
                styles.clearMemoryLabel,
                { color: confirmingClear ? "#DC2626" : colors.mutedForeground },
              ]}
            >
              {confirmingClear ? "Tap again to confirm" : "Clear memory"}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function MechanicScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { activeProfiles, bikeInfoMap } = useRiderAuth();
  const { messages, isTyping, error, setError, inputText, setInputText, sendMessage, clearChat, memory, clearMemory, suggestedFollowUps } = useRockyChat();
  const [confirmingClear, setConfirmingClear] = React.useState(false);

  const primaryProfile = activeProfiles[0] ?? null;
  const bikeStr = [
    primaryProfile?.bikeYear,
    primaryProfile?.bikeManufacturer,
    primaryProfile?.bikeModel,
  ].filter(Boolean).join(" ");
  const storedInfo = primaryProfile ? (bikeInfoMap[primaryProfile.id] ?? {}) : {};

  const listRef = useRef<FlatList>(null);

  const lastUser = [...messages].reverse().find(m => m.role === "user");
  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
  const showFollowUpChips = !isTyping && !!lastUser && !!lastAssistant;
  const followUpChips = showFollowUpChips
    ? resolveFollowUpChips(suggestedFollowUps, lastUser!.content)
    : [];

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages.length, isTyping]);

  function handleSend() {
    void sendMessage();
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, {
        paddingTop: insets.top + 8,
        backgroundColor: colors.card,
        borderBottomColor: colors.border,
      }]}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={({ pressed }) => ({
            width: 36, height: 36, borderRadius: 18,
            backgroundColor: colors.muted,
            alignItems: "center", justifyContent: "center",
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Feather name="chevron-down" size={20} color={colors.foreground} />
        </Pressable>

        <View style={{ flex: 1, alignItems: "center" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={{ fontSize: 17, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold" }}>Rocky</Text>
            <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, backgroundColor: ACCENT + "22", borderWidth: 1, borderColor: ACCENT + "44" }}>
              <Text style={{ fontSize: 9, fontWeight: "700", color: ACCENT, fontFamily: "Inter_700Bold", letterSpacing: 0.8 }}>AI</Text>
            </View>
          </View>
          <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 }}>
            Mechanic & Riding Coach
          </Text>
        </View>

        {/* Clear chat button */}
        <Pressable
          onPress={() => {
            if (confirmingClear) {
              void clearChat();
              setConfirmingClear(false);
            } else {
              setConfirmingClear(true);
              setTimeout(() => setConfirmingClear(false), 3000);
            }
          }}
          hitSlop={12}
          style={({ pressed }) => ({
            height: 36, borderRadius: 18,
            paddingHorizontal: 10,
            backgroundColor: confirmingClear ? "#FEE2E2" : colors.muted,
            alignItems: "center", justifyContent: "center",
            opacity: pressed ? 0.6 : 1,
            flexDirection: "row", gap: 4,
          })}
        >
          <Feather
            name="trash-2"
            size={15}
            color={confirmingClear ? "#DC2626" : colors.mutedForeground}
          />
          {confirmingClear && (
            <Text style={{ fontSize: 11, color: "#DC2626", fontFamily: "Inter_700Bold" }}>
              {CONFIRM_CLEAR_LABEL}
            </Text>
          )}
        </Pressable>
      </View>

      {/* Bike context banner (if bike info set) */}
      {bikeStr.length > 0 && (
        <View style={[styles.contextBanner, { backgroundColor: ACCENT + "10", borderBottomColor: ACCENT + "25" }]}>
          <Feather name="settings" size={11} color={ACCENT} />
          <Text style={{ fontSize: 11, color: ACCENT, fontFamily: "Inter_500Medium" }}>{bikeStr}</Text>
          {storedInfo.rideExperience && (
            <>
              <View style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: ACCENT + "60" }} />
              <Text style={{ fontSize: 11, color: ACCENT, fontFamily: "Inter_500Medium", textTransform: "capitalize" }}>{storedInfo.rideExperience}</Text>
            </>
          )}
        </View>
      )}

      {/* Disclaimer */}
      <View style={{ paddingHorizontal: 14, paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.background }}>
        <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 14 }}>
          Rocky's advice is for informational purposes only. Always consult your owner's manual, a qualified mechanic for safety-critical repairs, and a certified riding coach before making technique changes.
        </Text>
      </View>

      {/* Rocky's Memory panel */}
      <MemoryPanel colors={colors} memory={memory} onClear={clearMemory} />

      {/* Messages */}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={item => item.id}
        renderItem={({ item }) => <MessageBubble msg={item} colors={colors} />}
        ListFooterComponent={isTyping ? <TypingIndicator colors={colors} /> : null}
        contentContainerStyle={{ paddingTop: 16, paddingBottom: 12 }}
        showsVerticalScrollIndicator={false}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      />

      {/* Error banner */}
      {error && (
        <View style={{ marginHorizontal: 12, marginBottom: 6, padding: 10, borderRadius: 8, backgroundColor: "#FEE2E2", flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Feather name="alert-circle" size={14} color="#DC2626" />
          <Text style={{ flex: 1, fontSize: 12, color: "#DC2626", fontFamily: "Inter_400Regular" }}>{error}</Text>
          <Pressable onPress={() => setError(null)}>
            <Feather name="x" size={14} color="#DC2626" />
          </Pressable>
        </View>
      )}

      {/* Follow-up chips — AI-suggested when present, keyword fallback otherwise */}
      {showFollowUpChips && followUpChips.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={[styles.followUpChipsRow, { borderTopColor: colors.border }]}
          keyboardShouldPersistTaps="handled"
        >
          {followUpChips.map((chip) => (
            <Pressable
              key={chip.question}
              onPress={() => void sendMessage(chip.question)}
              style={({ pressed }) => [
                styles.followUpChip,
                {
                  backgroundColor: ACCENT + "12",
                  borderColor: ACCENT + "40",
                  opacity: pressed ? 0.72 : 1,
                },
              ]}
            >
              <Text style={[styles.followUpChipText, { color: ACCENT }]} numberOfLines={1}>
                {chip.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* Input bar */}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        <View style={[styles.inputBar, {
          paddingBottom: insets.bottom + 8,
          backgroundColor: colors.card,
          borderTopColor: colors.border,
        }]}>
          <TextInput
            style={[styles.input, {
              backgroundColor: colors.muted,
              color: colors.foreground,
              borderColor: colors.border,
            }]}
            placeholder="Ask Rocky anything about your bike or riding…"
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
              width: 42, height: 42, borderRadius: 21,
              backgroundColor: inputText.trim() && !isTyping ? ACCENT : colors.muted,
              alignItems: "center", justifyContent: "center",
              opacity: pressed ? 0.75 : 1,
              borderWidth: 1,
              borderColor: inputText.trim() && !isTyping ? ACCENT : colors.border,
            })}
          >
            <Feather name="send" size={17} color={inputText.trim() && !isTyping ? "#fff" : colors.mutedForeground} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingBottom: 12,
    borderBottomWidth: 1,
    gap: 8,
  },
  contextBanner: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 16, paddingVertical: 7,
    borderBottomWidth: 1,
  },
  memoryContainer: {
    borderBottomWidth: 1,
  },
  memoryHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  memoryBadge: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  memoryBody: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    gap: 8,
  },
  memoryEmpty: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  memoryEntry: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 0,
  },
  memoryEntryText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: "Inter_400Regular",
  },
  clearMemoryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 2,
  },
  clearMemoryLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  bubbleRow: {
    flexDirection: "row", marginHorizontal: 12, marginBottom: 12, alignItems: "flex-end", gap: 8,
  },
  bubbleRowLeft: { justifyContent: "flex-start" },
  bubbleRowRight: { justifyContent: "flex-end" },
  avatar: {
    width: 30, height: 30, borderRadius: 15,
    alignItems: "center", justifyContent: "center",
    borderWidth: 1, flexShrink: 0,
  },
  bubble: {
    borderRadius: 16, padding: 12,
  },
  bubbleText: { fontSize: 14, lineHeight: 20 },
  inputBar: {
    flexDirection: "row", alignItems: "flex-end",
    gap: 10, paddingHorizontal: 12, paddingTop: 10,
    borderTopWidth: 1,
  },
  input: {
    flex: 1, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10,
    fontSize: 14, lineHeight: 20,
    borderWidth: 1,
    maxHeight: 120, fontFamily: "Inter_400Regular",
  },
  followUpChipsRow: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 8,
    flexDirection: "row",
    borderTopWidth: 1,
  },
  followUpChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    flexShrink: 0,
  },
  followUpChipText: {
    fontSize: 12,
    fontWeight: "600",
    fontFamily: "Inter_600SemiBold",
  },
});
