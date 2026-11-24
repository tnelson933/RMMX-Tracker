/**
 * The app's haptic vocabulary, in one place so it stays sparse and consistent.
 *
 * - iOS: expo-haptics goes through UIFeedbackGenerator, which already does
 *   nothing when the phone's "System Haptics" setting is off.
 * - Android: expo-haptics' impact/notification/selection calls drive the
 *   vibrator directly and ignore the phone's "Touch feedback" setting, so we use
 *   `performAndroidHapticsAsync` (View.performHapticFeedback), which honours it.
 * - Web: no-op.
 *
 * Haptics are never the only feedback: every call site also changes something
 * on screen. Fire at the moment the thing happens, once per user action.
 */
import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

const OS = Platform.OS;

function run(ios: () => Promise<void>, android: Haptics.AndroidHaptics): void {
  try {
    if (OS === "ios") void ios().catch(() => {});
    else if (OS === "android") void Haptics.performAndroidHapticsAsync(android).catch(() => {});
  } catch {
    // A missing native method (older binary) must never break a tap.
  }
}

export const haptics = {
  /** Light tap: tab switch, segmented control, a pressable that commits something small. */
  light(): void {
    run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light), Haptics.AndroidHaptics.Context_Click);
  },
  /** A value stepped: pull-to-refresh trigger, picker detent. */
  selection(): void {
    run(() => Haptics.selectionAsync(), Haptics.AndroidHaptics.Segment_Tick);
  },
  /** Something the user did worked: check-in complete, followed, results went official. */
  success(): void {
    run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success), Haptics.AndroidHaptics.Confirm);
  },
  /** Something the user did failed. */
  error(): void {
    run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error), Haptics.AndroidHaptics.Reject);
  },
};
