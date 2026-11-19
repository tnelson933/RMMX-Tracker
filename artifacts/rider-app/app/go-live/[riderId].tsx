import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { fonts } from "@/constants/fonts";
import { useRiderAuth } from "@/context/AuthContext";
import { NETWORK_ERROR_MESSAGE } from "@/lib/friendlyErrors";
import { goBack } from "@/lib/navigation";
import { phoneLiveUrl } from "@/lib/riderLive";

/**
 * Go Live: streams this phone's camera as the chosen rider. The camera runs in
 * the website's phone-live page (WebView) with a broadcast ticket from
 * /api/rider/live/start; followers get a push once the stream is up.
 */
export default function GoLiveScreen() {
  const { riderId: raw } = useLocalSearchParams<{ riderId: string }>();
  const riderId = Number(raw);
  const { riderFetch } = useRiderAuth();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState("");
  const liveRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await riderFetch("/api/rider/live/start", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ riderId }),
        });
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) { setError(j.error ?? "Couldn't start live video. Try again."); return; }
        setUri(phoneLiveUrl(riderId, j.ticket, j.name ?? ""));
      } catch {
        if (!cancelled) setError(NETWORK_ERROR_MESSAGE);
      }
    })();
    return () => { cancelled = true; };
  }, [riderId, riderFetch]);

  // Leaving while live ends the stream: ask first.
  useEffect(() => navigation.addListener("beforeRemove", (e: any) => {
    if (!liveRef.current) return;
    e.preventDefault();
    Alert.alert("End live video?", "Your followers will stop seeing the video.", [
      { text: "Keep streaming", style: "cancel" },
      { text: "End", style: "destructive", onPress: () => { liveRef.current = false; navigation.dispatch(e.data.action); } },
    ]);
  }), [navigation]);

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as { type?: string; state?: string };
      if (msg.type !== "live-state") return;
      liveRef.current = msg.state === "live" || msg.state === "reconnecting" || msg.state === "starting";
      if (msg.state === "stopped") goBack(router);
    } catch { /* not ours */ }
  };

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" />
      {uri ? (
        <WebView
          source={{ uri }}
          style={{ flex: 1, backgroundColor: "#000" }}
          javaScriptEnabled
          domStorageEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          mediaCapturePermissionGrantType="grant"
          onMessage={onMessage}
          onError={() => setError("Couldn't load the camera page. Check your connection and try again.")}
        />
      ) : (
        <View style={s.center}>
          {error ? <Text style={s.message}>{error}</Text> : <ActivityIndicator color="#fff" />}
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
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  message: { color: "rgba(255,255,255,0.8)", fontFamily: fonts.regular, fontSize: 14, textAlign: "center" },
  close: { position: "absolute", right: 14, width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center" },
});
