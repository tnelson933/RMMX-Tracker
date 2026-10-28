import * as Updates from "expo-updates";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";

// Over-the-air updates (EAS Update). expo-updates already checks on a cold
// start and applies the download on the next one. Riders rarely close the app,
// so also check when it comes back from the background after a while, and
// restart into the new version then: they're between uses, not mid-task.

const AWAY_BEFORE_APPLY_MS = 15 * 60_000;

export function useOtaUpdates(): void {
  const backgroundedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!Updates.isEnabled || __DEV__) return;
    const sub = AppState.addEventListener("change", async (state) => {
      if (state === "background") {
        backgroundedAt.current = Date.now();
        return;
      }
      if (state !== "active" || backgroundedAt.current === null) return;
      const away = Date.now() - backgroundedAt.current;
      backgroundedAt.current = null;
      if (away < AWAY_BEFORE_APPLY_MS) return;
      try {
        const check = await Updates.checkForUpdateAsync();
        if (!check.isAvailable) return;
        const fetched = await Updates.fetchUpdateAsync();
        if (fetched.isNew) await Updates.reloadAsync();
      } catch {
        // Offline or the update server is unreachable: try again next time.
      }
    });
    return () => sub.remove();
  }, []);
}
