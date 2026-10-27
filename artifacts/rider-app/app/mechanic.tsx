import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
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
import { goBack } from "@/lib/navigation";
import { ROCKY_QUICK_QUESTIONS, RockyAvatar } from "@/components/RockyAvatar";
import { ROCKY_HINT_PENDING_KEY, ROCKY_INTRO_SEEN_KEY } from "@/components/RockyLauncher";
import AsyncStorage from "@react-native-async-storage/async-storage";

const CONFIRM_CLEAR_LABEL = "Clear chat";

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
        <RockyAvatar size={30} online={false} />
      )}
      <View style={[
        styles.bubble,
        isUser
          ? { backgroundColor: colors.primary, maxWidth: "78%" }
          : { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, maxWidth: "82%" },
      ]}>
        <LinkedText
          text={msg.content}
          textStyle={[
            styles.bubbleText,
            { color: isUser ? "#fff" : colors.foreground, fontFamily: "Inter_400Regular" },
          ]}
          linkColor={isUser ? "#ffd0d6" : colors.primary}
        />
      </View>
    </View>
  );
}

// ─── Typing indicator ─────────────────────────────────────────────────────────

function TypingIndicator({ colors }: { colors: ReturnType<typeof useColors> }) {
  return (
    <View style={[styles.bubbleRow, styles.bubbleRowLeft]}>
      <RockyAvatar size={30} online={false} />
      <View style={[styles.bubble, { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border }]}>
        <ActivityIndicator size="small" color={colors.primary} />
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
          <Feather name="cpu" size={13} color={colors.primary} />
          <Text style={{ fontSize: 12, fontFamily: "Inter_700Bold", color: colors.primary, letterSpacing: 0.3 }}>
            Rocky's Memory
          </Text>
          {memory.length > 0 && (
            <View style={[styles.memoryBadge, { backgroundColor: colors.primary + "20", borderColor: colors.primary + "40" }]}>
              <Text style={{ fontSize: 10, color: colors.primary, fontFamily: "Inter_700Bold" }}>{memory.length}</Text>
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
                backgroundColor: confirmingClear ? colors.dangerTint : colors.muted,
                borderColor: confirmingClear ? colors.destructive : colors.border,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <Feather name="trash-2" size={13} color={confirmingClear ? colors.destructive : colors.mutedForeground} />
            <Text
              style={[
                styles.clearMemoryLabel,
                { color: confirmingClear ? colors.destructive : colors.mutedForeground },
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
  // First-run intro: Rocky opens himself once and explains what he does
  const { intro } = useLocalSearchParams<{ intro?: string }>();
  const [showIntro, setShowIntro] = React.useState(intro === "1");
  useEffect(() => {
    if (intro === "1") void AsyncStorage.setItem(ROCKY_INTRO_SEEN_KEY, "1");
  }, [intro]);

  function minimize() {
    if (showIntro) void AsyncStorage.setItem(ROCKY_HINT_PENDING_KEY, "1");
    goBack(router);
  }

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
          onPress={minimize}
          accessibilityLabel="Minimize Rocky"
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

        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }}>
          <RockyAvatar size={42} />
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{ fontSize: 19, color: colors.foreground, fontFamily: "Inter_700Bold", fontStyle: "italic", letterSpacing: 0.5, textTransform: "uppercase" }}>Rocky</Text>
              <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, backgroundColor: colors.primary }}>
                <Text style={{ fontSize: 9, color: "#fff", fontFamily: "Inter_700Bold", letterSpacing: 0.8 }}>AI</Text>
              </View>
            </View>
            <Text style={{ fontSize: 11, color: colors.success, fontFamily: "Inter_600SemiBold", marginTop: 1 }}>
              {isTyping ? "Rocky is typing…" : "Online · Mechanic & riding coach"}
            </Text>
          </View>
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
            backgroundColor: confirmingClear ? colors.dangerTint : colors.muted,
            alignItems: "center", justifyContent: "center",
            opacity: pressed ? 0.6 : 1,
            flexDirection: "row", gap: 4,
          })}
        >
          <Feather
            name="trash-2"
            size={15}
            color={confirmingClear ? colors.destructive : colors.mutedForeground}
          />
          {confirmingClear && (
            <Text style={{ fontSize: 11, color: colors.destructive, fontFamily: "Inter_700Bold" }}>
              {CONFIRM_CLEAR_LABEL}
            </Text>
          )}
        </Pressable>
      </View>

      {/* Bike context banner (if bike info set) */}
      {bikeStr.length > 0 && (
        <View style={[styles.contextBanner, { backgroundColor: colors.primary + "10", borderBottomColor: colors.primary + "25" }]}>
          <Feather name="settings" size={11} color={colors.primary} />
          <Text style={{ fontSize: 11, color: colors.primary, fontFamily: "Inter_500Medium" }}>{bikeStr}</Text>
          {storedInfo.rideExperience && (
            <>
              <View style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: colors.primary + "60" }} />
              <Text style={{ fontSize: 11, color: colors.primary, fontFamily: "Inter_500Medium", textTransform: "capitalize" }}>{storedInfo.rideExperience}</Text>
            </>
          )}
        </View>
      )}

      {/* First-run intro */}
      {showIntro && (
        <View style={{ margin: 12, borderRadius: 20, backgroundColor: colors.card, borderWidth: 1.5, borderColor: colors.primary + "88", padding: 18, gap: 12,
          shadowColor: colors.primary, shadowOpacity: 0.35, shadowRadius: 16, shadowOffset: { width: 0, height: 4 }, elevation: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <RockyAvatar size={52} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 10, color: colors.primary, fontFamily: "Inter_700Bold", letterSpacing: 1.2, textTransform: "uppercase" }}>Your new crew chief</Text>
              <Text style={{ fontSize: 22, color: colors.foreground, fontFamily: "Inter_700Bold", fontStyle: "italic", textTransform: "uppercase" }}>Meet Rocky</Text>
            </View>
          </View>
          {([
            ["tool", "Bike problems, setup and maintenance: just describe it."],
            ["trending-up", "Riding tips to get faster: starts, corners, ruts, whoops."],
            ["cpu", "Remembers your bike and riding, so advice fits you."],
            ["message-circle", "Minimize me and I'll wait in the corner of every screen."],
          ] as const).map(([icon, text]) => (
            <View key={text} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: colors.primaryTint, alignItems: "center", justifyContent: "center" }}>
                <Feather name={icon} size={14} color={colors.primary} />
              </View>
              <Text style={{ flex: 1, fontSize: 14, color: colors.foreground, fontFamily: "Inter_500Medium", lineHeight: 19 }}>{text}</Text>
            </View>
          ))}
          <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
            <Pressable onPress={minimize} style={({ pressed }) => ({ flex: 1, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.primary, borderRadius: 999, paddingVertical: 13, opacity: pressed ? 0.85 : 1 })}>
              <Feather name="minimize-2" size={15} color="#fff" />
              <Text style={{ color: "#fff", fontSize: 13, fontFamily: "Inter_700Bold", letterSpacing: 0.8, textTransform: "uppercase" }}>Minimize Rocky</Text>
            </Pressable>
            <Pressable onPress={() => setShowIntro(false)} style={({ pressed }) => ({ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.muted, borderRadius: 999, paddingVertical: 13, borderWidth: 1, borderColor: colors.border, opacity: pressed ? 0.85 : 1 })}>
              <Text style={{ color: colors.foreground, fontSize: 13, fontFamily: "Inter_700Bold", letterSpacing: 0.8, textTransform: "uppercase" }}>Ask a question</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Disclaimer */}
      <View style={{ paddingHorizontal: 14, paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.background }}>
        <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 14 }}>
          Rocky's advice is for information only. Check your owner's manual, and use a qualified mechanic for safety-critical repairs.
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
        ListFooterComponent={isTyping ? <TypingIndicator colors={colors} /> : !lastUser ? (
          <View style={{ paddingHorizontal: 12, paddingTop: 4 }}>
            <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_700Bold", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8, marginLeft: 2 }}>
              Try asking
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {ROCKY_QUICK_QUESTIONS.map(q => (
                <Pressable
                  key={q.label}
                  onPress={() => void sendMessage(q.question)}
                  style={({ pressed }) => ({
                    width: "48.5%", flexDirection: "row", alignItems: "center", gap: 8,
                    paddingHorizontal: 10, paddingVertical: 11, borderRadius: 12,
                    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, opacity: pressed ? 0.72 : 1,
                  })}
                >
                  <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: colors.primaryTint, alignItems: "center", justifyContent: "center" }}>
                    <Feather name={q.icon} size={14} color={colors.primary} />
                  </View>
                  <Text style={{ flex: 1, fontSize: 12, color: colors.foreground, fontFamily: "Inter_600SemiBold" }} numberOfLines={1}>{q.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}
        contentContainerStyle={{ paddingTop: 16, paddingBottom: 12 }}
        showsVerticalScrollIndicator={false}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      />

      {/* Error banner */}
      {error && (
        <View style={{ marginHorizontal: 12, marginBottom: 6, padding: 10, borderRadius: 8, backgroundColor: colors.dangerTint, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Feather name="alert-circle" size={14} color={colors.destructive} />
          <Text style={{ flex: 1, fontSize: 12, color: colors.destructive, fontFamily: "Inter_400Regular" }}>{error}</Text>
          <Pressable onPress={() => setError(null)}>
            <Feather name="x" size={14} color={colors.destructive} />
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
                  backgroundColor: colors.primary + "12",
                  borderColor: colors.primary + "40",
                  opacity: pressed ? 0.72 : 1,
                },
              ]}
            >
              <Text style={[styles.followUpChipText, { color: colors.primary }]} numberOfLines={1}>
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
              backgroundColor: colors.primary,
              alignItems: "center", justifyContent: "center",
              opacity: !inputText.trim() || isTyping ? 0.45 : pressed ? 0.75 : 1,
            })}
          >
            <Feather name="send" size={17} color="#fff" />
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
    flex: 1, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 11,
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
