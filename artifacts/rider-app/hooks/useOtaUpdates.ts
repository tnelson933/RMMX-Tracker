import * as Updates from "expo-updates";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";

// Over-the-air updates (EAS Update). expo-updates already checks on a cold
// start and applies the download on the next one. Riders rarely close the app,
// so also check when it comes back from the background after a while. The
// download runs while the rider is using the app, so it is never applied then:
// it restarts into the new version the next time the app returns from a long
// break (instantly, before they can start anything) or on a cold start.

const AWAY_BEFORE_APPLY_MS = 15 * 60_000;

export function useOtaUpdates(): void {
  const backgroundedAt = useRef<number | null>(null);
  const downloaded = useRef(false);

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
        if (downloaded.current) {
          await Updates.reloadAsync();
          return;
        }
        const check = await Updates.checkForUpdateAsync();
        if (!check.isAvailable) return;
        const fetched = await Updates.fetchUpdateAsync();
        if (fetched.isNew) downloaded.current = true;
      } catch {
        // Offline or the update server is unreachable: try again next time.
      }
    });
    return () => sub.remove();
  }, []);
}
