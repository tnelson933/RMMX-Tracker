import { useFocusEffect, useNavigation } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";

// Repeating refreshes only run while someone can see them: the screen is the one
// on top and the app is in the foreground. Saves battery and data on race day,
// when the app sits in a pocket between motos.

/** True while the app is in the foreground ("inactive" on iPhone, e.g. pulling down Control Center, still counts). */
export function useAppActive(): boolean {
  const [state, setState] = useState<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener("change", setState);
    return () => sub.remove();
  }, []);
  return state !== "background";
}

/** True while this screen is focused. Must be used inside a screen (navigation context). */
export function useScreenFocused(): boolean {
  const navigation = useNavigation();
  const [focused, setFocused] = useState(() => navigation.isFocused?.() ?? true);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));
  return focused;
}

/** Focused and in the foreground. */
export function useScreenVisible(): boolean {
  const focused = useScreenFocused();
  const active = useAppActive();
  return focused && active;
}

/**
 * Runs `callback` every `ms` while `enabled` and the screen is visible (focused,
 * app in the foreground). After being hidden it runs once straight away on
 * coming back, then resumes the interval. The first load is the caller's job.
 */
export function useVisibleInterval(callback: () => unknown, ms: number, enabled = true): void {
  const visible = useScreenVisible();
  const callbackRef = useRef(callback);
  useEffect(() => { callbackRef.current = callback; }, [callback]);
  const missed = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    if (!visible) { missed.current = true; return; }
    if (missed.current) {
      missed.current = false;
      void callbackRef.current();
    }
    const timer = setInterval(() => { void callbackRef.current(); }, ms);
    return () => clearInterval(timer);
  }, [enabled, visible, ms]);
}
