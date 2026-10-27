import type { useRouter } from "expo-router";

/**
 * Go back, or to Home when there's nothing to go back to: screens opened from a
 * push notification or a link start with an empty history.
 */
export function goBack(router: ReturnType<typeof useRouter>): void {
  if (router.canGoBack()) router.back();
  else router.replace("/(tabs)" as any);
}
