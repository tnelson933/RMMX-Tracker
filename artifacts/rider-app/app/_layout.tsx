import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { setBaseUrl } from "@workspace/api-client-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import * as Notifications from "expo-notifications";
import * as SplashScreen from "expo-splash-screen";
import * as WebBrowser from "expo-web-browser";
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

/** Status bar icons follow the in-app Appearance setting. */
function ThemedStatusBar() {
  const { resolvedScheme } = useTheme();
  return <StatusBar barStyle={resolvedScheme === "dark" ? "light-content" : "dark-content"} />;
}

// Set API base URL for generated hooks (public endpoints like events list)
setBaseUrl(`https://${process.env.EXPO_PUBLIC_DOMAIN ?? ""}`);

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
 * `{ type: "quick_checkin" | "follow-results", eventId }` and broadcast `{ url }`.
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
    const eventId = Number(data.eventId);
    if (Number.isInteger(eventId) && eventId > 0) {
      router.push(`/event/${eventId}` as any);
      return;
    }
    if (typeof data.url === "string" && /^https?:\/\//i.test(data.url)) {
      void WebBrowser.openBrowserAsync(data.url).catch(() => { /* ignore */ });
    }
  }, [ready, response]);
}

function RootLayoutNav() {
  const { isAuthenticated, isLoading } = useRiderAuth();
  const router = useRouter();
  const segments = useSegments();

  useNotificationNavigation(!isLoading && isAuthenticated);

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
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
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
