import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Alert, Linking, Platform } from "react-native";
import { NETWORK_ERROR_MESSAGE, postJson, serverErrorMessage } from "@/lib/friendlyErrors";

const TOKEN_KEY = "rider_mobile_token";
const SELECTED_IDS_KEY = "rider_selected_profile_ids";
const BIKE_INFO_KEY = "rider_bike_info";
const BIOMETRIC_ENABLED_KEY = "rider_biometric_enabled";
const BIOMETRIC_EMAIL_SKEY = "rider_bio_email";
const BIOMETRIC_PASS_SKEY = "rider_bio_pass";
const PUSH_TOKEN_KEY = "rider_expo_push_token";
const PUSH_DENIED_PROMPTED_KEY = "rider_push_denied_prompted";

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN ?? ""}`;

export interface RiderAccount {
  id: number;
  email: string;
  mobileToken: string;
}

export interface RiderProfile {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  bibNumber: string | null;
  rfidNumber: string | null;
  dateOfBirth: string | null;
  bikeManufacturer: string | null;
  bikeModel: string | null;
  bikeYear: string | null;
  bikes: Array<{ id: number; bikeManufacturer: string | null; bikeModel: string | null; bikeYear: string | null; isDefault: boolean; createdAt: string }>;
  skillLevel: string | null;
  raceTypes: string[];
  eventsRaced: number;
  totalPoints: number;
  bestPosition: number | null;
  lastRaced: string | null;
}

export interface BikeInfo {
  bikeMake: string;
  bikeModel: string;
  bikeYear: string;
  rideExperience: string;
  bikeHours: string;
}

// ── SecureStore helpers (no-op on web) ───────────────────────────────────────
async function secureGet(key: string): Promise<string | null> {
  if (Platform.OS === "web") return null;
  try {
    const SecureStore = await import("expo-secure-store");
    return await SecureStore.getItemAsync(key);
  } catch { return null; }
}

async function secureSet(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const SecureStore = await import("expo-secure-store");
    await SecureStore.setItemAsync(key, value);
  } catch { /* ignore */ }
}

async function secureDelete(key: string): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const SecureStore = await import("expo-secure-store");
    await SecureStore.deleteItemAsync(key);
  } catch { /* ignore */ }
}

interface AuthContextType {
  account: RiderAccount | null;
  profiles: RiderProfile[];
  activeProfiles: RiderProfile[];
  selectedProfileIds: number[];
  setSelectedProfileIds: (ids: number[]) => Promise<void>;
  bikeInfoMap: Record<number, Partial<BikeInfo>>;
  setBikeInfo: (profileId: number, info: Partial<BikeInfo>) => Promise<void>;
  isAuthenticated: boolean;
  isLoading: boolean;
  biometricEnabled: boolean;
  login: (email: string, password: string) => Promise<void>;
  loginWithBiometric: () => Promise<void>;
  /** Resolves with the number of rider profiles the new account links to. */
  register: (email: string, password: string) => Promise<number>;
  logout: () => Promise<void>;
  refreshProfiles: () => Promise<void>;
  riderFetch: (path: string, options?: RequestInit) => Promise<Response>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  enableBiometric: (password: string) => Promise<void>;
  disableBiometric: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

async function authedFetch(
  path: string,
  token: string | null,
  options: RequestInit = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(`${BASE_URL}${path}`, { ...options, headers });
}

/** Best-effort request that gives up after a few seconds so it can't stall the caller. */
async function bestEffortFetch(path: string, token: string, options: RequestInit): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await authedFetch(path, token, { ...options, signal: controller.signal });
  } catch {
    // ignore — offline or server unreachable; the local sign-out still happens
  } finally {
    clearTimeout(timer);
  }
}

async function tryRegisterPushToken(mobileToken: string): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const Notifications = await import("expo-notifications");
    const Device = await import("expo-device");
    if (!Device.isDevice) return;

    // Android 13+ only shows the permission prompt once a channel exists.
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Race updates",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#B30000",
      });
    }

    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== "granted") {
      // Explain once; don't nag on every cold start.
      const alreadyPrompted = await AsyncStorage.getItem(PUSH_DENIED_PROMPTED_KEY);
      if (!alreadyPrompted) {
        await AsyncStorage.setItem(PUSH_DENIED_PROMPTED_KEY, "true");
        Alert.alert(
          "Notifications are off",
          "Enable notifications to receive race-day updates, gate schedules, and results.",
          [
            { text: "Not now", style: "cancel" },
            { text: "Open Settings", onPress: () => Linking.openSettings() },
          ],
        );
      }
      return;
    }

    const projectId =
      (Constants.easConfig?.projectId as string | undefined) ??
      (Constants.expoConfig?.extra?.eas?.projectId as string | undefined);

    if (!projectId || projectId === "YOUR_EAS_PROJECT_ID") return;

    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    const res = await fetch(`${BASE_URL}/api/rider/push-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mobileToken}`,
      },
      body: JSON.stringify({ expoPushToken: tokenData.data }),
    });
    if (!res.ok) {
      console.warn(`Push token registration failed (HTTP ${res.status})`);
      return;
    }
    // Remembered so logout can unregister this device.
    await AsyncStorage.setItem(PUSH_TOKEN_KEY, tokenData.data);
  } catch (e) {
    // Push is best-effort, but make failures visible in logs.
    console.warn("Push registration failed:", e);
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<RiderAccount | null>(null);
  const [profiles, setProfiles] = useState<RiderProfile[]>([]);
  const [selectedProfileIds, setSelectedProfileIdsState] = useState<number[]>([]);
  const [bikeInfoMap, setBikeInfoMapState] = useState<Record<number, Partial<BikeInfo>>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [biometricEnabled, setBiometricEnabledState] = useState(false);

  const riderFetch = useCallback(
    (path: string, options: RequestInit = {}): Promise<Response> => {
      return authedFetch(path, account?.mobileToken ?? null, options);
    },
    [account?.mobileToken],
  );

  const activeProfiles = useMemo((): RiderProfile[] => {
    if (profiles.length === 0) return [];
    if (selectedProfileIds.length === 0) return [profiles[0]];
    const active = profiles.filter(p => selectedProfileIds.includes(p.id));
    return active.length > 0 ? active : [profiles[0]];
  }, [profiles, selectedProfileIds]);

  async function loadProfiles(token: string): Promise<void> {
    try {
      const res = await authedFetch("/api/rider/profiles", token);
      if (!res.ok) return;
      const loaded: RiderProfile[] = await res.json();
      setProfiles(loaded);

      setBikeInfoMapState(prev => {
        const merged = { ...prev };
        for (const profile of loaded) {
          if (profile.skillLevel) {
            merged[profile.id] = { ...(merged[profile.id] ?? {}), rideExperience: profile.skillLevel };
          }
        }
        return merged;
      });

      const raw = await AsyncStorage.getItem(SELECTED_IDS_KEY);
      if (raw) {
        const saved: number[] = JSON.parse(raw);
        const valid = saved.filter(id => loaded.some(p => p.id === id));
        if (valid.length > 0) {
          setSelectedProfileIdsState(valid);
          return;
        }
      }
      if (loaded.length > 0) {
        const defaultIds = [loaded[0].id];
        setSelectedProfileIdsState(defaultIds);
        await AsyncStorage.setItem(SELECTED_IDS_KEY, JSON.stringify(defaultIds));
      }
    } catch {
      // ignore
    }
  }

  async function validateAndLoad(token: string): Promise<RiderAccount | null> {
    try {
      const res = await authedFetch("/api/rider/auth/mobile-me", token);
      if (!res.ok) return null;
      const data = await res.json();
      return { id: data.id, email: data.email, mobileToken: token };
    } catch {
      return null;
    }
  }

  useEffect(() => {
    async function init() {
      const [token, bikeRaw, bioFlag] = await Promise.all([
        AsyncStorage.getItem(TOKEN_KEY),
        AsyncStorage.getItem(BIKE_INFO_KEY),
        AsyncStorage.getItem(BIOMETRIC_ENABLED_KEY),
      ]);
      if (bikeRaw) {
        try { setBikeInfoMapState(JSON.parse(bikeRaw)); } catch { /* ignore */ }
      }
      if (bioFlag === "true") {
        setBiometricEnabledState(true);
      } else {
        // Older builds saved credentials for everyone; only keep them when opted in.
        void secureDelete(BIOMETRIC_EMAIL_SKEY);
        void secureDelete(BIOMETRIC_PASS_SKEY);
      }
      if (token) {
        const acc = await validateAndLoad(token);
        if (acc) {
          setAccount(acc);
          await loadProfiles(token);
          void tryRegisterPushToken(token);
        } else {
          await AsyncStorage.removeItem(TOKEN_KEY);
        }
      }
      setIsLoading(false);
    }
    void init();
  }, []);

  async function login(email: string, password: string): Promise<void> {
    const data = await postJson(`${BASE_URL}/api/rider/auth/login`,
      { email: email.trim().toLowerCase(), password }, "Sign-in failed");
    const acc: RiderAccount = { id: data.id, email: data.email, mobileToken: data.mobileToken };
    await AsyncStorage.setItem(TOKEN_KEY, data.mobileToken);
    setAccount(acc);
    // Refresh the saved credentials only when the rider opted into biometric sign-in
    if (biometricEnabled) {
      await secureSet(BIOMETRIC_EMAIL_SKEY, email.trim().toLowerCase());
      await secureSet(BIOMETRIC_PASS_SKEY, password);
    }
    void loadProfiles(data.mobileToken);
    void tryRegisterPushToken(data.mobileToken);
  }

  async function loginWithBiometric(): Promise<void> {
    if (Platform.OS === "web") throw new Error("Biometric login is not supported on web");
    const LocalAuth = await import("expo-local-authentication");
    const hasHardware = await LocalAuth.hasHardwareAsync();
    const isEnrolled = await LocalAuth.isEnrolledAsync();
    if (!hasHardware || !isEnrolled) throw new Error("Biometric authentication is not available on this device");

    const result = await LocalAuth.authenticateAsync({
      promptMessage: "Sign in to RM Roost",
      fallbackLabel: "Use password",
      cancelLabel: "Cancel",
    });
    if (!result.success) throw new Error("Biometric authentication was cancelled or failed");

    const email = await secureGet(BIOMETRIC_EMAIL_SKEY);
    const pass = await secureGet(BIOMETRIC_PASS_SKEY);
    if (!email || !pass) throw new Error("No saved credentials — please sign in with your password first");

    await login(email, pass);
  }

  async function register(email: string, password: string): Promise<number> {
    const data = await postJson(`${BASE_URL}/api/rider/auth/register`,
      { email: email.trim().toLowerCase(), password }, "Couldn't create your account");
    const acc: RiderAccount = { id: data.id, email: data.email, mobileToken: data.mobileToken };
    await AsyncStorage.setItem(TOKEN_KEY, data.mobileToken);
    setAccount(acc);
    void loadProfiles(data.mobileToken);
    void tryRegisterPushToken(data.mobileToken);
    return typeof data.linkedProfiles === "number" ? data.linkedProfiles : -1;
  }

  async function logout(): Promise<void> {
    const token = account?.mobileToken;
    if (token) {
      // Best-effort server cleanup: stop pushes to this device, then revoke the token.
      const pushToken = await AsyncStorage.getItem(PUSH_TOKEN_KEY).catch(() => null);
      if (pushToken) {
        await bestEffortFetch("/api/rider/push-token", token, {
          method: "DELETE",
          body: JSON.stringify({ token: pushToken }),
        });
      }
      await bestEffortFetch("/api/rider/auth/logout", token, { method: "POST" });
    }
    const keysToRemove: string[] = [TOKEN_KEY, SELECTED_IDS_KEY, PUSH_TOKEN_KEY];
    if (account) keysToRemove.push(`workout_plan_${account.id}`);
    await AsyncStorage.multiRemove(keysToRemove);
    // Clear biometric only if it was enabled; don't clear the stored creds so
    // they stay ready if user re-enables after signing back in.
    setAccount(null);
    setProfiles([]);
    setSelectedProfileIdsState([]);
  }

  async function refreshProfiles(): Promise<void> {
    if (account?.mobileToken) await loadProfiles(account.mobileToken);
  }

  const setSelectedProfileIds = useCallback(async (ids: number[]): Promise<void> => {
    const valid = ids.filter(id => profiles.some(p => p.id === id));
    const toSave = valid.length > 0 ? valid : (profiles.length > 0 ? [profiles[0].id] : []);
    setSelectedProfileIdsState(toSave);
    await AsyncStorage.setItem(SELECTED_IDS_KEY, JSON.stringify(toSave));
  }, [profiles]);

  const setBikeInfo = useCallback(async (profileId: number, info: Partial<BikeInfo>): Promise<void> => {
    const updated = {
      ...bikeInfoMap,
      [profileId]: { ...(bikeInfoMap[profileId] ?? {}), ...info },
    };
    setBikeInfoMapState(updated);
    await AsyncStorage.setItem(BIKE_INFO_KEY, JSON.stringify(updated));

    if (info.rideExperience !== undefined && account?.mobileToken) {
      authedFetch(`/api/rider/profiles/${profileId}`, account.mobileToken, {
        method: "PATCH",
        body: JSON.stringify({ skillLevel: info.rideExperience }),
      }).catch(() => { /* best-effort */ });
    }
  }, [bikeInfoMap, account?.mobileToken]);

  async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
    let res: Response;
    try {
      res = await riderFetch("/api/rider/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
    } catch {
      throw new Error(NETWORK_ERROR_MESSAGE);
    }
    if (res.status >= 500) throw new Error(serverErrorMessage(res.status));
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      throw new Error(res.ok ? NETWORK_ERROR_MESSAGE : `Couldn't change your password (error ${res.status}).`);
    }
    if (!res.ok) throw new Error(data?.error ?? `Couldn't change your password (error ${res.status}).`);
    // Keep stored credential fresh so biometric login keeps working
    if (biometricEnabled) await secureSet(BIOMETRIC_PASS_SKEY, newPassword);
  }

  /**
   * Turn on biometric sign-in. The caller collects the rider's current password;
   * it's saved to SecureStore only after a successful biometric check.
   */
  async function enableBiometric(password: string): Promise<void> {
    if (Platform.OS === "web") throw new Error("Biometric sign-in is not supported on web");
    if (!account) throw new Error("Sign in first to turn on biometric sign-in");
    if (!password) throw new Error("Enter your password to turn on biometric sign-in");
    const LocalAuth = await import("expo-local-authentication");
    const result = await LocalAuth.authenticateAsync({
      promptMessage: "Turn on biometric sign-in",
      cancelLabel: "Cancel",
    });
    if (!result.success) throw new Error("Biometric check was cancelled or failed");
    await secureSet(BIOMETRIC_EMAIL_SKEY, account.email.trim().toLowerCase());
    await secureSet(BIOMETRIC_PASS_SKEY, password);
    await AsyncStorage.setItem(BIOMETRIC_ENABLED_KEY, "true");
    setBiometricEnabledState(true);
  }

  async function disableBiometric(): Promise<void> {
    await AsyncStorage.removeItem(BIOMETRIC_ENABLED_KEY);
    await secureDelete(BIOMETRIC_EMAIL_SKEY);
    await secureDelete(BIOMETRIC_PASS_SKEY);
    setBiometricEnabledState(false);
  }

  return (
    <AuthContext.Provider
      value={{
        account,
        profiles,
        activeProfiles,
        selectedProfileIds,
        setSelectedProfileIds,
        bikeInfoMap,
        setBikeInfo,
        isAuthenticated: !!account,
        isLoading,
        biometricEnabled,
        login,
        loginWithBiometric,
        register,
        logout,
        refreshProfiles,
        riderFetch,
        changePassword,
        enableBiometric,
        disableBiometric,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useRiderAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useRiderAuth must be used inside AuthProvider");
  return ctx;
}
