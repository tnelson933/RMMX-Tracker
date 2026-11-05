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
import { Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { RockyLauncher } from "@/components/RockyLauncher";
import { AuthProvider, useRiderAuth } from "@/context/AuthContext";
import { RockyChatProvider } from "@/context/RockyChatContext";
import { ThemeProvider, useTheme } from "@/context/ThemeContext";
import { StatusBar } from "react-native";
import { openInApp } from "@/lib/inAppBrowser";

/** Status bar icons follow the in-app Appearance setting. */
function ThemedStatusBar() {
  const { resolvedScheme } = useTheme();
  return <StatusBar barStyle={resolvedScheme === "dark" ? "light-content" : "dark-content"} />;
}

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
 * `{ type: "quick_checkin" | "quick_checkin_arrival" | "follow-results", eventId }` and broadcast `{ url }`.
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
    const eventId = Number(data.eventId);
    if (Number.isInteger(eventId) && eventId > 0) {
      router.push(`/event/${eventId}` as any);
      return;
    }
    if (typeof data.url === "string" && /^https?:\/\//i.test(data.url)) {
      void openInApp(data.url);
    }
  }, [ready, response]);
}

function RootLayoutNav() {
  const { isAuthenticated, isLoading } = useRiderAuth();
  const router = useRouter();
  const segments = useSegments();

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
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false, animation: "fade" }} />
      <Stack.Screen name="mechanic" options={{ headerShown: false, animation: "slide_from_bottom" }} />
      <Stack.Screen name="event/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="register/[eventId]" options={{ headerShown: false, animation: "slide_from_bottom" }} />
      <Stack.Screen name="result/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="rider/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="rider/new" options={{ headerShown: false }} />
      <Stack.Screen name="stats/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="follow" options={{ headerShown: false }} />
      <Stack.Screen name="racer/[id]" options={{ headerShown: false }} />
    </Stack>
    {/* Rocky, minimized, on every signed-in screen */}
    {isAuthenticated && !isLoading && <RockyLauncher />}
    </>
  );
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

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ThemedStatusBar />
        <ErrorBoundary>
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
