import { API_BASE_URL } from "@/lib/apiBase";
import { reportCaught } from "@/lib/errorReport";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Linking, Platform } from "react-native";
import { NETWORK_ERROR_MESSAGE, postJson, serverErrorMessage } from "@/lib/friendlyErrors";

const TOKEN_KEY = "rider_mobile_token";
const SELECTED_IDS_KEY = "rider_selected_profile_ids";
const BIKE_INFO_KEY = "rider_bike_info";
const BIOMETRIC_ENABLED_KEY = "rider_biometric_enabled";
const BIOMETRIC_EMAIL_SKEY = "rider_bio_email";
const BIOMETRIC_PASS_SKEY = "rider_bio_pass";
const PUSH_TOKEN_KEY = "rider_expo_push_token";
const PUSH_DENIED_PROMPTED_KEY = "rider_push_denied_prompted";
/** Who the saved token belongs to ({ id, email }), so a launch with no signal stays signed in. */
const ACCOUNT_CACHE_KEY = "rider_account_cache";
/** The account's rider profiles from the last successful load ({ accountId, profiles }), shown at once on launch. */
const PROFILES_CACHE_KEY = "rider_profiles_cache";

/** "loading" until the first profile list arrives; "failed" when it couldn't be fetched. */
export type ProfilesStatus = "loading" | "loaded" | "failed";

const BASE_URL = API_BASE_URL;

export interface RiderAccount {
  id: number;
  email: string;
  mobileToken: string;
  /**
   * False until the 6-digit code emailed to the account is entered. An unverified
   * account sees no rider profiles; the sign-in screen asks for the code.
   * Servers before this field read as verified.
   */
  emailVerified: boolean;
}

/** The server's emailVerified (missing on older servers = verified). */
const verifiedFrom = (data: any): boolean => data?.emailVerified !== false;

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
  /** Racer profile photos (/api/storage/... paths), null when not set. */
  avatarUrl?: string | null;
  coverUrl?: string | null;
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
  /** Tells "this account has no riders" apart from "the list hasn't loaded" or "couldn't load". */
  profilesStatus: ProfilesStatus;
  activeProfiles: RiderProfile[];
  selectedProfileIds: number[];
  setSelectedProfileIds: (ids: number[]) => Promise<void>;
  bikeInfoMap: Record<number, Partial<BikeInfo>>;
  setBikeInfo: (profileId: number, info: Partial<BikeInfo>) => Promise<void>;
  /** Signed in with a verified email. */
  isAuthenticated: boolean;
  /** Signed in, but the email isn't confirmed yet: the sign-in screen shows the code step. */
  needsVerification: boolean;
  isLoading: boolean;
  biometricEnabled: boolean;
  /** Resolves true when the account's email is verified (false: show the code step). */
  login: (email: string, password: string) => Promise<boolean>;
  loginWithBiometric: () => Promise<boolean>;
  /** linkedProfiles: rider profiles the new account links to (-1 = unknown until the email is verified). */
  register: (email: string, password: string) => Promise<{ linkedProfiles: number; emailVerified: boolean }>;
  /** Confirm the email with the emailed code; resolves with the number of linked rider profiles. */
  verifyEmail: (code: string) => Promise<number>;
  /** Email a new code (the server allows 1 a minute, 5 an hour). */
  resendVerification: () => Promise<void>;
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
  const [profilesStatus, setProfilesStatus] = useState<ProfilesStatus>("loading");
  const [selectedProfileIds, setSelectedProfileIdsState] = useState<number[]>([]);
  const [bikeInfoMap, setBikeInfoMapState] = useState<Record<number, Partial<BikeInfo>>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [biometricEnabled, setBiometricEnabledState] = useState(false);

  // Requests wait for the saved sign-in to be restored at startup. Otherwise a
  // screen opened straight from a link (or a notification) fetches before the
  // token is loaded, gets "signed out", and never retries.
  const tokenRef = useRef<string | null>(null);
  const restored = useRef<{ done: boolean; promise: Promise<void>; resolve: () => void } | null>(null);
  if (!restored.current) {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    restored.current = { done: false, promise, resolve };
  }
  const markRestored = () => {
    if (restored.current && !restored.current.done) {
      restored.current.done = true;
      restored.current.resolve();
    }
  };
  // Every sign-in, sign-out and restore goes through here so the token used
  // by riderFetch is current before any re-render.
  const applyAccount = (acc: RiderAccount | null) => {
    tokenRef.current = acc?.mobileToken ?? null;
    setAccount(acc);
  };

  const riderFetch = useCallback(
    async (path: string, options: RequestInit = {}): Promise<Response> => {
      if (!restored.current!.done) await restored.current!.promise;
      return authedFetch(path, tokenRef.current, options);
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
      // Signed out or replaced since this request started: its answer isn't ours.
      if (tokenRef.current !== token) return;
      if (!res.ok) { setProfilesStatus(prev => (prev === "loaded" ? prev : "failed")); return; }
      const loaded: RiderProfile[] = await res.json();
      if (tokenRef.current !== token) return;
      setProfiles(loaded);
      setProfilesStatus("loaded");
      const cachedAcc = await AsyncStorage.getItem(ACCOUNT_CACHE_KEY).then(v => (v ? JSON.parse(v) : null)).catch(() => null);
      if (cachedAcc && typeof cachedAcc.id === "number") {
        void AsyncStorage.setItem(PROFILES_CACHE_KEY, JSON.stringify({ accountId: cachedAcc.id, profiles: loaded })).catch(() => {});
      }

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
      // No connection: keep any list already shown, otherwise say it couldn't load.
      if (tokenRef.current === token) setProfilesStatus(prev => (prev === "loaded" ? prev : "failed"));
    }
  }

  /**
   * Check the saved token. It is invalid only when the server says so (401/403);
   * no signal or a server error is "unreachable", which must not sign the rider out.
   */
  async function validateAndLoad(token: string): Promise<{ account: RiderAccount | null; unreachable: boolean }> {
    try {
      const res = await authedFetch("/api/rider/auth/mobile-me", token);
      if (res.status === 401 || res.status === 403) return { account: null, unreachable: false };
      if (!res.ok) return { account: null, unreachable: true };
      const data = await res.json();
      return { account: { id: data.id, email: data.email, mobileToken: token, emailVerified: verifiedFrom(data) }, unreachable: false };
    } catch {
      return { account: null, unreachable: true };
    }
  }

  const rememberAccount = (acc: RiderAccount) =>
    AsyncStorage.setItem(ACCOUNT_CACHE_KEY, JSON.stringify({ id: acc.id, email: acc.email, emailVerified: acc.emailVerified })).catch(() => {});

  useEffect(() => {
    async function init() {
      const [token, bikeRaw, bioFlag] = await Promise.all([
        AsyncStorage.getItem(TOKEN_KEY),
        AsyncStorage.getItem(BIKE_INFO_KEY),
        AsyncStorage.getItem(BIOMETRIC_ENABLED_KEY),
      ]);
      if (bikeRaw) {
        try { setBikeInfoMapState(JSON.parse(bikeRaw)); } catch (e) { reportCaught("auth.bikeInfoCache", e); }
      }
      if (bioFlag === "true") {
        setBiometricEnabledState(true);
      } else {
        // Older builds saved credentials for everyone; only keep them when opted in.
        void secureDelete(BIOMETRIC_EMAIL_SKEY);
        void secureDelete(BIOMETRIC_PASS_SKEY);
      }
      // Fast path: this phone remembers the account (and its riders), so open
      // signed in straight away and confirm with the server in the background.
      // Without this, launch waits on the network and briefly shows the app
      // signed out. The server still decides: a revoked sign-in signs out below.
      const cached = token
        ? await AsyncStorage.getItem(ACCOUNT_CACHE_KEY).then(v => (v ? JSON.parse(v) : null)).catch(() => null)
        : null;
      if (token && cached && typeof cached.id === "number" && typeof cached.email === "string") {
        applyAccount({ id: cached.id, email: cached.email, mobileToken: token, emailVerified: cached.emailVerified !== false });
        const [profRaw, selRaw] = await Promise.all([
          AsyncStorage.getItem(PROFILES_CACHE_KEY).catch(() => null),
          AsyncStorage.getItem(SELECTED_IDS_KEY).catch(() => null),
        ]);
        try {
          const prof = profRaw ? JSON.parse(profRaw) : null;
          if (prof && prof.accountId === cached.id && Array.isArray(prof.profiles)) {
            setProfiles(prof.profiles);
            setProfilesStatus("loaded");
            const sel: number[] = selRaw ? JSON.parse(selRaw) : [];
            const valid = sel.filter(id => prof.profiles.some((p: RiderProfile) => p.id === id));
            if (valid.length) setSelectedProfileIdsState(valid);
          }
        } catch (e) { reportCaught("auth.profilesCache", e); /* profiles load from the server */ }
        setIsLoading(false);
        markRestored();

        const { account: acc, unreachable } = await validateAndLoad(token);
        if (tokenRef.current !== token) return; // signed out or switched meanwhile
        if (acc) {
          applyAccount(acc);
          void rememberAccount(acc);
          if (acc.emailVerified) {
            await loadProfiles(token);
            void tryRegisterPushToken(token);
          } else {
            setProfiles([]);
          }
        } else if (unreachable) {
          setProfilesStatus(prev => (prev === "loaded" ? prev : "failed"));
        } else {
          // The server no longer accepts this sign-in: sign out.
          await AsyncStorage.multiRemove([TOKEN_KEY, ACCOUNT_CACHE_KEY, PROFILES_CACHE_KEY]);
          applyAccount(null);
          setProfiles([]);
          setProfilesStatus("loading");
        }
        return;
      }

      if (token) {
        const { account: acc, unreachable } = await validateAndLoad(token);
        if (acc) {
          applyAccount(acc);
          void rememberAccount(acc);
          if (acc.emailVerified) {
            await loadProfiles(token);
            void tryRegisterPushToken(token);
          }
        } else if (unreachable) {
          // No signal (common at a track) or the server is down: stay signed in as
          // the remembered account and let each screen show its own retry. Builds
          // before this one saved no account, so those wait on the sign-in screen
          // with the token kept for the next launch.
          const cached = await AsyncStorage.getItem(ACCOUNT_CACHE_KEY).then(v => (v ? JSON.parse(v) : null)).catch(() => null);
          if (cached && typeof cached.id === "number" && typeof cached.email === "string") {
            applyAccount({ id: cached.id, email: cached.email, mobileToken: token, emailVerified: cached.emailVerified !== false });
            setProfilesStatus("failed");
          }
        } else {
          await AsyncStorage.multiRemove([TOKEN_KEY, ACCOUNT_CACHE_KEY, PROFILES_CACHE_KEY]);
        }
      }
      setIsLoading(false);
      markRestored();
    }
    void init().catch(() => { setIsLoading(false); markRestored(); });
  }, []);

  // The rider list couldn't load (no signal at launch): try again each time the
  // app comes back to the foreground, so it recovers without a restart.
  useEffect(() => {
    if (profilesStatus !== "failed" || !account?.mobileToken) return;
    const token = account.mobileToken;
    const sub = AppState.addEventListener("change", state => {
      if (state === "active") void loadProfiles(token);
    });
    return () => sub.remove();
  }, [profilesStatus, account?.mobileToken]);

  async function login(email: string, password: string): Promise<boolean> {
    const data = await postJson(`${BASE_URL}/api/rider/auth/login`,
      { email: email.trim().toLowerCase(), password }, "Sign-in failed");
    const acc: RiderAccount = { id: data.id, email: data.email, mobileToken: data.mobileToken, emailVerified: verifiedFrom(data) };
    await AsyncStorage.setItem(TOKEN_KEY, data.mobileToken);
    void rememberAccount(acc);
    setProfilesStatus("loading");
    applyAccount(acc);
    // Refresh the saved credentials only when the rider opted into biometric sign-in
    if (biometricEnabled) {
      await secureSet(BIOMETRIC_EMAIL_SKEY, email.trim().toLowerCase());
      await secureSet(BIOMETRIC_PASS_SKEY, password);
    }
    // Unverified: nothing to load until the code is entered (verifyEmail loads it).
    if (!acc.emailVerified) return false;
    void loadProfiles(data.mobileToken);
    void tryRegisterPushToken(data.mobileToken);
    return true;
  }

  async function loginWithBiometric(): Promise<boolean> {
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

    return login(email, pass);
  }

  async function register(email: string, password: string): Promise<{ linkedProfiles: number; emailVerified: boolean }> {
    const data = await postJson(`${BASE_URL}/api/rider/auth/register`,
      { email: email.trim().toLowerCase(), password }, "Couldn't create your account");
    const acc: RiderAccount = { id: data.id, email: data.email, mobileToken: data.mobileToken, emailVerified: verifiedFrom(data) };
    await AsyncStorage.setItem(TOKEN_KEY, data.mobileToken);
    void rememberAccount(acc);
    setProfilesStatus("loading");
    applyAccount(acc);
    if (!acc.emailVerified) return { linkedProfiles: -1, emailVerified: false };
    void loadProfiles(data.mobileToken);
    void tryRegisterPushToken(data.mobileToken);
    return { linkedProfiles: typeof data.linkedProfiles === "number" ? data.linkedProfiles : -1, emailVerified: true };
  }

  /** POST to a signed-in auth endpoint and return its JSON, with plain-language errors. */
  async function postAuthed(path: string, body: unknown, fallback: string): Promise<any> {
    let res: Response;
    try {
      res = await riderFetch(path, { method: "POST", body: JSON.stringify(body ?? {}) });
    } catch {
      throw new Error(NETWORK_ERROR_MESSAGE);
    }
    if (res.status >= 500) throw new Error(serverErrorMessage(res.status));
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      throw new Error(res.ok ? NETWORK_ERROR_MESSAGE : `${fallback} (error ${res.status}).`);
    }
    if (!res.ok) throw new Error(data?.error ?? `${fallback} (error ${res.status}).`);
    return data;
  }

  async function verifyEmail(code: string): Promise<number> {
    const current = account;
    if (!current) throw new Error("You're signed out. Sign in again, then try once more.");
    const data = await postAuthed("/api/rider/auth/verify-email", { code }, "Couldn't check that code");
    const acc: RiderAccount = { ...current, emailVerified: true };
    void rememberAccount(acc);
    setProfilesStatus("loading");
    applyAccount(acc);
    void loadProfiles(acc.mobileToken);
    void tryRegisterPushToken(acc.mobileToken);
    return typeof data.linkedProfiles === "number" ? data.linkedProfiles : -1;
  }

  async function resendVerification(): Promise<void> {
    await postAuthed("/api/rider/auth/verify-email/resend", {}, "Couldn't send a new code");
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
    const keysToRemove: string[] = [TOKEN_KEY, ACCOUNT_CACHE_KEY, PROFILES_CACHE_KEY, SELECTED_IDS_KEY, PUSH_TOKEN_KEY];
    // The Train tab's saved plan (current key, and the one older builds used).
    if (account) keysToRemove.push(`workout_plan_v2_${account.id}`, `workout_plan_${account.id}`);
    await AsyncStorage.multiRemove(keysToRemove);
    // Clear biometric only if it was enabled; don't clear the stored creds so
    // they stay ready if user re-enables after signing back in.
    applyAccount(null);
    setProfiles([]);
    setProfilesStatus("loading");
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
        profilesStatus,
        activeProfiles,
        selectedProfileIds,
        setSelectedProfileIds,
        bikeInfoMap,
        setBikeInfo,
        isAuthenticated: !!account && account.emailVerified,
        needsVerification: !!account && !account.emailVerified,
        isLoading,
        biometricEnabled,
        login,
        loginWithBiometric,
        register,
        verifyEmail,
        resendVerification,
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
