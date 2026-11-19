import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { fonts } from "@/constants/fonts";
import { useRiderAuth } from "@/context/AuthContext";
import { NETWORK_ERROR_MESSAGE } from "@/lib/friendlyErrors";
import { goBack } from "@/lib/navigation";
import { riderWatchUrl, type RiderLiveStatus } from "@/lib/riderLive";

/**
 * Watching a rider's live phone video: from their racer profile or the
 * "is racing live" push. Plays in the website's rider-live page (WebView).
 */
export default function RiderLiveScreen() {
  const { riderId: raw } = useLocalSearchParams<{ riderId: string }>();
  const riderId = Number(raw);
  const { riderFetch } = useRiderAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<RiderLiveStatus | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await riderFetch(`/api/rider/live/${riderId}`);
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) { setError(j.error ?? "Couldn't load this live video. Try again."); return; }
        setStatus(j);
      } catch {
        if (!cancelled) setError(NETWORK_ERROR_MESSAGE);
      }
    })();
    return () => { cancelled = true; };
  }, [riderId, riderFetch]);

  const message = error
    || (status && !status.canWatch ? "This rider's profile is private. Follow them to watch their live video." : "")
    || (status && !status.live ? `${status.name || "This rider"} isn't live right now.` : "");

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" />
      {status?.canWatch && status.live && status.watchTicket && !error ? (
        <WebView
          source={{ uri: riderWatchUrl(riderId, status.watchTicket, status.name) }}
          style={{ flex: 1, backgroundColor: "#000" }}
          javaScriptEnabled
          domStorageEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          allowsFullscreenVideo
        />
      ) : (
        <View style={s.center}>
          {message ? <Text style={s.message}>{message}</Text> : <ActivityIndicator color="#fff" />}
          {status && !status.live && !error ? (
            <Pressable onPress={() => router.replace(`/racer/${riderId}` as any)} style={s.button}>
              <Text style={s.buttonText}>See {status.name.split(" ")[0] || "their"} profile</Text>
            </Pressable>
          ) : null}
        </View>
      )}
      <Pressable onPress={() => goBack(router)} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8}
        style={({ pressed }) => [s.close, { top: insets.top + (Platform.OS === "android" ? 10 : 4), opacity: pressed ? 0.6 : 1 }]}>
        <Feather name="x" size={20} color="#fff" />
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 },
  message: { color: "rgba(255,255,255,0.8)", fontFamily: fonts.regular, fontSize: 14, textAlign: "center" },
  button: { backgroundColor: "#B30000", borderRadius: 999, paddingHorizontal: 22, paddingVertical: 10 },
  buttonText: { color: "#fff", fontFamily: fonts.bold, fontSize: 14 },
  close: { position: "absolute", right: 14, width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center" },
});
