import { BottomTabBarHeightContext } from "@react-navigation/bottom-tabs";
import { useContext } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** Room for the floating Rocky button (about 64px tall, 20px above whatever is below it). */
const ROCKY_CLEARANCE = 84;

/**
 * Bottom padding for a screen's scroll content so the last card can scroll
 * clear of the tab bar (when shown inside a tab) and the floating Rocky
 * button. Screens opened inside a tab (Race Report from Home, standings from
 * My Races) sit under the tab bar, so safe-area insets alone aren't enough.
 */
export function useBottomSpace(extra = 24): number {
  const tabBar = useContext(BottomTabBarHeightContext) ?? 0;
  const insets = useSafeAreaInsets();
  return Math.max(tabBar, insets.bottom) + ROCKY_CLEARANCE + extra;
}
