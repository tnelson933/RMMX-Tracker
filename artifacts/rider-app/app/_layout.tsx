// Defines the background task for the Quick Check-In arrival alert at startup.
import { useOtaUpdates } from "@/hooks/useOtaUpdates";
import "@/lib/quickCheckinGeofence";
import { API_BASE_URL } from "@/lib/apiBase";
import { useFonts } from "expo-font";
import { Roboto_400Regular } from "@expo-google-fonts/roboto/400Regular";
import { Roboto_500Medium } from "@expo-google-fonts/roboto/500Medium";
import { Roboto_600SemiBold } from "@expo-google-fonts/roboto/600SemiBold";
import { Roboto_700Bold } from "@expo-google-fonts/roboto/700Bold";
import { Barlow_700Bold } from "@expo-google-fonts/barlow/700Bold";
import { Barlow_800ExtraBold } from "@expo-google-fonts/barlow/800ExtraBold";
import { Barlow_800ExtraBold_Italic } from "@expo-google-fonts/barlow/800ExtraBold_Italic";
import { setBaseUrl } from "@workspace/api-client-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import * as Notifications from "expo-notifications";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useRef } from "react";
import { ActivityIndicator, Platform, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useReducedMotion } from "react-native-reanimated";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { RockyLauncher } from "@/components/RockyLauncher";
import { AuthProvider, useRiderAuth } from "@/context/AuthContext";
import { RockyChatProvider } from "@/context/RockyChatContext";
import { ThemeProvider, useTheme } from "@/context/ThemeContext";
import { StatusBar } from "react-native";
import * as SystemUI from "expo-system-ui";
import { useColors } from "@/hooks/useColors";
import { openInApp } from "@/lib/inAppBrowser";
import { initErrorReporting, reportError, setErrorReportRoute } from "@/lib/errorReport";
import { routeFromSegments } from "@/lib/errorReportCore";

/** Race-theme background, shown before the theme preference has loaded. */
const LAUNCH_BACKGROUND = "#161616";

/**
 * Status bar icons and background follow the in-app Appearance setting. On
 * Android builds that don't draw edge to edge the status bar has its own
 * background (light by default, which hid the white icons), so it is painted
 * with the screen background. The root view gets the same colour so nothing
 * white shows between the launch screen and the first frame, or behind
 * screen transitions.
 */
function ThemedStatusBar() {
  const { resolvedScheme } = useTheme();
  const colors = useColors();
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(colors.background).catch(() => {});
  }, [colors.background]);
  return (
    <StatusBar
      barStyle={resolvedScheme === "dark" ? "light-content" : "dark-content"}
      backgroundColor={Platform.OS === "android" ? colors.background : undefined}
    />
  );
}

// Paint the root view dark before React renders anything (fonts and the theme
// preference load first), so the launch screen hands off to dark, not white.
if (Platform.OS !== "web") {
  SystemUI.setBackgroundColorAsync(LAUNCH_BACKGROUND).catch(() => {});
}

// JS errors (uncaught, unhandled rejections) go to our API: lib/errorReport.ts.
initErrorReporting();

// Set API base URL for generated hooks (public endpoints like events list)
setBaseUrl(API_BASE_URL);

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

// Show pushes that arrive while the app is in the foreground.
if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

const queryClient = new QueryClient();

// Notification responses aren't available on web; keep the hook call unconditional.
const useLastNotificationResponse: () => Notifications.NotificationResponse | null | undefined =
  Platform.OS === "web" ? () => null : Notifications.useLastNotificationResponse;

/**
 * Open the screen a tapped push points at. Server payloads (api-server/src/lib):
 * `{ type: "quick_checkin" | "quick_checkin_arrival" | "follow-results", eventId }`,
 * `{ type: "follow-race-start", eventId, motoId, riderId, streaming }`, `{ type: "rider-live", riderId }`
 * and broadcast `{ url }`.
 */
function useNotificationNavigation(ready: boolean) {
  const router = useRouter();
  const response = useLastNotificationResponse();
  const handledId = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || !response) return;
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = response.notification.request.identifier;
    if (handledId.current === id) return;
    handledId.current = id;

    const data = (response.notification.request.content.data ?? {}) as Record<string, unknown>;
    // Quick Check-In pushes open Home, where the Check In card is.
    if (data.type === "quick_checkin" || data.type === "quick_checkin_arrival") {
      router.push("/(tabs)" as any);
      return;
    }
    // A followed rider went live from their phone: their stream.
    const liveRiderId = Number(data.riderId);
    if (data.type === "rider-live" && Number.isInteger(liveRiderId) && liveRiderId > 0) {
      router.push(`/live/rider/${liveRiderId}` as any);
      return;
    }
    const eventId = Number(data.eventId);
    // A followed rider is about to race: the live stream (with live standings)
    // if the event is streaming now, otherwise that race's live timing.
    if (data.type === "follow-race-start" && Number.isInteger(eventId) && eventId > 0) {
      void openRaceStart(router, eventId, Number(data.motoId));
      return;
    }
    if (Number.isInteger(eventId) && eventId > 0) {
      router.push(`/event/${eventId}` as any);
      return;
    }
    if (typeof data.url === "string" && /^https?:\/\//i.test(data.url)) {
      void openInApp(data.url);
    }
  }, [ready, response]);
}

/** Is the event streaming right now? Checked at tap time: the push may be minutes old. */
async function isStreamingNow(eventId: number): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`${API_BASE_URL}/api/video/status/${eventId}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return false;
    return (await r.json() as { live?: boolean }).live === true;
  } catch {
    return false;
  }
}

async function openRaceStart(router: ReturnType<typeof useRouter>, eventId: number, motoId: number): Promise<void> {
  if (await isStreamingNow(eventId)) {
    // The native live screen: that race's timing, with the stream one tap away.
    const pick = Number.isInteger(motoId) && motoId > 0 ? `?motoId=${motoId}` : "";
    router.push(`/live/${eventId}${pick}` as any);
    return;
  }
  const moto = Number.isInteger(motoId) && motoId > 0 ? `&motoId=${motoId}` : "";
  router.push(`/(tabs)/results?eventId=${eventId}${moto}` as any);
}

/** The launch screen stays up until the saved sign-in is back, but never longer than this. */
const LAUNCH_SCREEN_MAX_MS = 3_000;

function RootLayoutNav() {
  const { isAuthenticated, isLoading } = useRiderAuth();
  const colors = useColors();
  const router = useRouter();
  const segments = useSegments();
  // Route template only ("/racer/[id]"), for error reports.
  const routeKey = routeFromSegments(segments);
  useEffect(() => { setErrorReportRoute(routeKey); }, [routeKey]);

  // Keep the launch screen until the account is restored (usually at once, from
  // this phone), so the app never flashes its signed-out screen first.
  useEffect(() => {
    if (!isLoading) { void SplashScreen.hideAsync(); return; }
    const t = setTimeout(() => { void SplashScreen.hideAsync(); }, LAUNCH_SCREEN_MAX_MS);
    return () => clearTimeout(t);
  }, [isLoading]);

  // Pushes slide in from the right on both platforms; full-screen flows (live video,
  // registration, Rocky) rise from the bottom. Reduce motion: cross-fades only.
  const reduceMotion = useReducedMotion();
  const push = reduceMotion ? "fade" : "slide_from_right";
  const rise = reduceMotion ? "fade" : "slide_from_bottom";

  useNotificationNavigation(!isLoading && isAuthenticated);
  useOtaUpdates();

  useEffect(() => {
    if (isLoading) return;
    const inLoginScreen = segments[0] === "login";
    if (!isAuthenticated && !inLoginScreen) {
      router.replace("/login" as any);
    } else if (isAuthenticated && inLoginScreen) {
      router.replace("/(tabs)" as any);
    }
  }, [isAuthenticated, isLoading, segments]);

  return (
    <>
    <Stack screenOptions={{ headerShown: false, animation: push, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false, animation: "fade" }} />
      <Stack.Screen name="mechanic" options={{ headerShown: false, animation: rise }} />
      <Stack.Screen name="event/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="live/index" options={{ headerShown: false }} />
      <Stack.Screen name="live/[eventId]" options={{ headerShown: false, animation: rise }} />
      <Stack.Screen name="live/watch/[eventId]" options={{ headerShown: false, animation: rise }} />
      <Stack.Screen name="live/rider/[riderId]" options={{ headerShown: false, animation: rise }} />
      <Stack.Screen name="go-live/[riderId]" options={{ headerShown: false, animation: rise, gestureEnabled: false }} />
      <Stack.Screen name="register/[eventId]" options={{ headerShown: false, animation: rise }} />
      <Stack.Screen name="result/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="rider/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="rider/new" options={{ headerShown: false }} />
      <Stack.Screen name="stats/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="follow" options={{ headerShown: false }} />
      <Stack.Screen name="racer/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="racer/history/[id]" options={{ headerShown: false }} />
    </Stack>
    {/* Rocky, minimized, on every signed-in screen */}
    {isAuthenticated && !isLoading && <RockyLauncher />}
    {/* A slow restore (no remembered account, weak signal): a quiet loading cover, not the signed-out screen. */}
    {isLoading && (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: "#0a0a0a", alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color="#ffffff" />
      </View>
    )}
    </>
  );
}

function onBoundaryError(error: Error, componentStack: string) {
  reportError(error, { source: "boundary", componentStack });
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Roboto_400Regular,
    Roboto_500Medium,
    Roboto_600SemiBold,
    Roboto_700Bold,
    Barlow_700Bold,
    Barlow_800ExtraBold,
    Barlow_800ExtraBold_Italic,
  });

  if (!fontsLoaded && !fontError) return <View style={{ flex: 1, backgroundColor: LAUNCH_BACKGROUND }} />;

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ThemedStatusBar />
        <ErrorBoundary onError={onBoundaryError}>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <RockyChatProvider>
                <GestureHandlerRootView>
                  <KeyboardProvider>
                    <RootLayoutNav />
                  </KeyboardProvider>
                </GestureHandlerRootView>
              </RockyChatProvider>
            </AuthProvider>
          </QueryClientProvider>
        </ErrorBoundary>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
