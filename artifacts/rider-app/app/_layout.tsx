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
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AuthProvider, useRiderAuth } from "@/context/AuthContext";
import { RockyChatProvider } from "@/context/RockyChatContext";
import { ThemeProvider } from "@/context/ThemeContext";

// Set API base URL for generated hooks (public endpoints like events list)
setBaseUrl(`https://${process.env.EXPO_PUBLIC_DOMAIN ?? ""}`);

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootLayoutNav() {
  const { isAuthenticated, isLoading } = useRiderAuth();
  const router = useRouter();
  const segments = useSegments();

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
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false, animation: "fade" }} />
      <Stack.Screen name="mechanic" options={{ headerShown: false, animation: "slide_from_bottom" }} />
      <Stack.Screen name="event/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="result/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="rider/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="rider/new" options={{ headerShown: false }} />
    </Stack>
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
