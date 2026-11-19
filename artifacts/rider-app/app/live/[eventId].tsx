import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import { ActivityIndicator, Linking, Platform, Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewNavigation } from "react-native-webview";

import { goBack } from "@/lib/navigation";
import { fonts } from "@/constants/fonts";
import { API_BASE_URL } from "@/lib/apiBase";
import { useLiveStreams, watchPageUrl } from "@/lib/liveStreams";

/**
 * The live stream player: the website's Watch Live page (video plus live
 * standings, multiple cameras, 360° views) shown inside the app. Links
 * elsewhere open in the browser.
 */
export default function LivePlayerScreen() {
  const { eventId: raw } = useLocalSearchParams<{ eventId: string }>();
  const eventId = Number(raw);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { events } = useLiveStreams();
  const event = events.find(e => e.eventId === eventId);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const uri = watchPageUrl(eventId);
  const origin = useMemo(() => API_BASE_URL.replace(/\/+$/, ""), []);

  const allowNavigation = (req: WebViewNavigation) => {
    if (!origin || req.url.startsWith(origin)) return true;
    void Linking.openURL(req.url);
    return false;
  };

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" />
      <View style={[s.header, { paddingTop: insets.top + 6 }]}>
        <Pressable onPress={() => goBack(router)} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8}
          style={({ pressed }) => [s.backBtn, { opacity: pressed ? 0.6 : 1 }]}>
          <Feather name="arrow-left" size={18} color="#fff" />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={s.title} numberOfLines={1}>{event?.name ?? "Live stream"}</Text>
          {!!event && <Text style={s.subtitle} numberOfLines={1}>{event.clubName}</Text>}
        </View>
        <View style={s.livePill}><View style={s.liveDot} /><Text style={s.liveText}>LIVE</Text></View>
      </View>

      {!Number.isFinite(eventId) || eventId <= 0 ? (
        <Text style={s.message}>This stream link looks broken. Go back and pick the event again.</Text>
      ) : Platform.OS === "web" ? (
        React.createElement("iframe", { src: uri, style: { flex: 1, border: 0, width: "100%", height: "100%", background: "#000" }, allow: "autoplay; fullscreen" })
      ) : failed ? (
        <View style={s.center}>
          <Text style={s.message}>Couldn't load the stream. Check your connection and try again.</Text>
          <Pressable onPress={() => { setFailed(false); setLoading(true); setReloadKey(k => k + 1); }} style={s.retry}>
            <Text style={s.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          <WebView
            key={reloadKey}
            source={{ uri }}
            style={{ flex: 1, backgroundColor: "#000" }}
            javaScriptEnabled
            domStorageEnabled
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            allowsFullscreenVideo
            onShouldStartLoadWithRequest={allowNavigation}
            onLoadEnd={() => setLoading(false)}
            onError={() => setFailed(true)}
            onHttpError={e => { if (e.nativeEvent.statusCode >= 500) setFailed(true); }}
          />
          {loading && (
            <View style={[StyleSheet.absoluteFill, s.center]} pointerEvents="none">
              <ActivityIndicator color="#fff" />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingBottom: 10, backgroundColor: "#111" },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.12)", alignItems: "center", justifyContent: "center" },
  title: { color: "#fff", fontFamily: fonts.display, fontSize: 17 },
  subtitle: { color: "rgba(255,255,255,0.6)", fontFamily: fonts.regular, fontSize: 12 },
  livePill: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "#B30000", borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#fff" },
  liveText: { color: "#fff", fontFamily: fonts.display, fontSize: 11, letterSpacing: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14, padding: 24 },
  message: { color: "rgba(255,255,255,0.75)", fontFamily: fonts.regular, fontSize: 14, textAlign: "center", padding: 24 },
  retry: { backgroundColor: "#B30000", borderRadius: 999, paddingHorizontal: 22, paddingVertical: 10 },
  retryText: { color: "#fff", fontFamily: fonts.bold, fontSize: 14 },
});
