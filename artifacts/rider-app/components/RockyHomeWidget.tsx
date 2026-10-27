import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { ROCKY_QUICK_QUESTIONS, RockyAvatar } from "@/components/RockyAvatar";
import { useRockyChat } from "@/context/RockyChatContext";
import { useColors } from "@/hooks/useColors";

/**
 * Compact Home banner for Rocky. He also floats on every screen (RockyLauncher),
 * so this is a quick way in: tap the banner to chat, or a chip to ask straight away.
 */
export function RockyHomeWidget() {
  const colors = useColors();
  const router = useRouter();
  const { sendMessage, isTyping, messages } = useRockyChat();
  const lastUser = [...messages].reverse().find(m => m.role === "user");

  function ask(question: string) {
    void sendMessage(question);
    router.push("/mechanic" as any);
  }

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.primary + "55" }]}>
      <Pressable onPress={() => router.push("/mechanic" as any)} style={({ pressed }) => [styles.row, { opacity: pressed ? 0.85 : 1 }]}>
        <RockyAvatar size={40} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: colors.foreground }]}>Ask Rocky</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
            {isTyping ? "Rocky is typing…" : lastUser ? `You asked: ${lastUser.content}` : "AI mechanic & riding coach"}
          </Text>
        </View>
        <View style={[styles.openBtn, { backgroundColor: colors.primary }]}>
          <Feather name="message-circle" size={16} color="#fff" />
        </View>
      </Pressable>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {ROCKY_QUICK_QUESTIONS.map(q => (
          <Pressable
            key={q.label}
            onPress={() => ask(q.question)}
            style={({ pressed }) => [styles.chip, { backgroundColor: colors.muted, borderColor: colors.border, opacity: pressed ? 0.72 : 1 }]}
          >
            <Feather name={q.icon} size={12} color={colors.primary} />
            <Text style={[styles.chipText, { color: colors.foreground }]}>{q.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginBottom: 20,
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
  },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10 },
  title: { fontSize: 16, fontFamily: "Inter_700Bold", fontStyle: "italic", letterSpacing: 0.4, textTransform: "uppercase" },
  subtitle: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 1 },
  openBtn: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  chips: { flexDirection: "row", gap: 6, paddingHorizontal: 12, paddingBottom: 12 },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1 },
  chipText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
});
