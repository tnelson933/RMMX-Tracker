import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import { ActivityIndicator, Modal, Platform, Pressable, StatusBar, Text, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { useColors } from "@/hooks/useColors";
import { API_BASE_URL } from "@/lib/apiBase";
import { openInApp } from "@/lib/inAppBrowser";

// A PDF (waiver forms) shown in the app's own screen. iPhone's web view shows
// PDFs itself; Android's can't, so there it loads RM Roost's own PDF page
// (/pdf-view on the website), which only shows RM Roost's uploaded files.

const OWN_FILE = /^\/api\/storage\/[A-Za-z0-9/_.-]+\.pdf$/;

/** The page to load, or null when the file isn't one of RM Roost's uploads. */
export function pdfViewerUrl(pdfUrl: string): string | null {
  let path = pdfUrl;
  if (/^https?:\/\//i.test(pdfUrl)) {
    if (!pdfUrl.startsWith(`${API_BASE_URL}/`)) return null;
    path = pdfUrl.slice(API_BASE_URL.length);
  }
  if (!OWN_FILE.test(path) || path.includes("..")) return null;
  return Platform.OS === "ios" ? `${API_BASE_URL}${path}` : `${API_BASE_URL}/pdf-view?src=${encodeURIComponent(path)}`;
}

export function PdfViewer({ url, title, onClose }: { url: string | null; title: string; onClose: () => void }) {
  return (
    <Modal visible={!!url} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      {/* A modal is its own window on Android: it needs its own safe-area insets. */}
      <SafeAreaProvider>
        {url ? <ViewerBody url={url} title={title} onClose={onClose} /> : null}
      </SafeAreaProvider>
    </Modal>
  );
}

function ViewerBody({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const page = pdfViewerUrl(url);

  return (
      <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: Math.max(insets.top, Platform.OS === "android" ? StatusBar.currentHeight ?? 24 : 0) }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.card }}>
          <Text style={{ flex: 1, fontSize: 16, color: colors.foreground, fontFamily: "Barlow_800ExtraBold", textTransform: "uppercase" }} numberOfLines={1}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close" style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.muted, alignItems: "center", justifyContent: "center" }}>
            <Feather name="x" size={18} color={colors.foreground} />
          </Pressable>
        </View>
        {page && !failed ? (
          <View style={{ flex: 1 }}>
            <WebView
              source={{ uri: page }}
              style={{ flex: 1, backgroundColor: "#ECECEC" }}
              originWhitelist={[API_BASE_URL]}
              onLoadEnd={() => setLoading(false)}
              onError={() => { setFailed(true); setLoading(false); }}
              onHttpError={() => { setFailed(true); setLoading(false); }}
              // Stay on the document: links inside it don't navigate the viewer away.
              onShouldStartLoadWithRequest={req => req.url.startsWith(API_BASE_URL) || req.url.startsWith("https://cdn.jsdelivr.net/") || req.url === "about:blank"}
            />
            {loading ? (
              <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
                <ActivityIndicator color={colors.primaryText} size="large" />
              </View>
            ) : null}
          </View>
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 }}>
            <Feather name="file-text" size={36} color={colors.mutedForeground} />
            <Text style={{ fontSize: 15, color: colors.foreground, fontFamily: "Roboto_600SemiBold", textAlign: "center" }}>Couldn't open this document</Text>
            <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", textAlign: "center" }}>Check your connection and try again, or ask for a copy at the gate.</Text>
            {url && /^https:\/\//i.test(url) ? (
              // A form stored somewhere other than RM Roost's uploads: show it in the browser sheet.
              <Pressable onPress={() => { const u = url; onClose(); void openInApp(u); }} style={{ marginTop: 8, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 999, backgroundColor: colors.primary }}>
                <Text style={{ color: "#fff", fontFamily: "Roboto_700Bold" }}>Open the document</Text>
              </Pressable>
            ) : null}
          </View>
        )}
        <View style={{ paddingBottom: insets.bottom }} />
      </View>
  );
}
