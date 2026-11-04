import React from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * A solid strip behind the status bar for screens whose content scrolls to the
 * top edge, so the clock and icons never draw over card text. Render it last
 * inside the screen's root view (it sits on top of the scroll content).
 */
export function StatusBarBackdrop({ color }: { color: string }) {
  const insets = useSafeAreaInsets();
  if (insets.top === 0) return null;
  return <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: insets.top, backgroundColor: color, zIndex: 20 }} />;
}
