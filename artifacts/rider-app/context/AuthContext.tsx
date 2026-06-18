import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";

const TOKEN_KEY = "rider_mobile_token";
const SELECTED_IDS_KEY = "rider_selected_profile_ids";
const BIKE_INFO_KEY = "rider_bike_info";
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
  skillLevel: string | null;
  eventsRaced: number;
  totalPoints: number;
  bestPosition: number | null;
  lastRaced: string | null;
}

export interface BikeInfo {
  bikeMake: string;
  bikeModel: string;
  bikeYear: string;
  rideExperience: string; // "beginner" | "intermediate" | "advanced" | "expert"
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
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfiles: () => Promise<void>;
  riderFetch: (path: string, options?: RequestInit) => Promise<Response>;
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

async function tryRegisterPushToken(mobileToken: string): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const Notifications = await import("expo-notifications");
    const Device = await import("expo-device");
    if (!Device.default.isDevice) return;

    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== "granted") return;

    const tokenData = await Notifications.getExpoPushTokenAsync();
    await fetch(`${BASE_URL}/api/rider/push-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mobileToken}`,
      },
      body: JSON.stringify({ expoPushToken: tokenData.data }),
    });
  } catch {
    // ignore — push is best-effort
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<RiderAccount | null>(null);
  const [profiles, setProfiles] = useState<RiderProfile[]>([]);
  const [selectedProfileIds, setSelectedProfileIdsState] = useState<number[]>([]);
  const [bikeInfoMap, setBikeInfoMapState] = useState<Record<number, Partial<BikeInfo>>>({});
  const [isLoading, setIsLoading] = useState(true);

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

      // Seed bikeInfoMap.rideExperience from server skillLevel (server is source of truth)
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
      const [token, bikeRaw] = await Promise.all([
        AsyncStorage.getItem(TOKEN_KEY),
        AsyncStorage.getItem(BIKE_INFO_KEY),
      ]);
      if (bikeRaw) {
        try { setBikeInfoMapState(JSON.parse(bikeRaw)); } catch { /* ignore */ }
      }
      if (token) {
        const acc = await validateAndLoad(token);
        if (acc) {
          setAccount(acc);
          await loadProfiles(token);
        } else {
          await AsyncStorage.removeItem(TOKEN_KEY);
        }
      }
      setIsLoading(false);
    }
    void init();
  }, []);

  async function login(email: string, password: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/rider/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Login failed");
    const acc: RiderAccount = { id: data.id, email: data.email, mobileToken: data.mobileToken };
    await AsyncStorage.setItem(TOKEN_KEY, data.mobileToken);
    setAccount(acc);
    void loadProfiles(data.mobileToken);
    void tryRegisterPushToken(data.mobileToken);
  }

  async function register(email: string, password: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/rider/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Registration failed");
    const acc: RiderAccount = { id: data.id, email: data.email, mobileToken: data.mobileToken };
    await AsyncStorage.setItem(TOKEN_KEY, data.mobileToken);
    setAccount(acc);
    void loadProfiles(data.mobileToken);
    void tryRegisterPushToken(data.mobileToken);
  }

  async function logout(): Promise<void> {
    const keysToRemove: string[] = [TOKEN_KEY, SELECTED_IDS_KEY];
    if (account) keysToRemove.push(`workout_plan_${account.id}`);
    await AsyncStorage.multiRemove(keysToRemove);
    setAccount(null);
    setProfiles([]);
    setSelectedProfileIdsState([]);
    // Keep bikeInfoMap — it's stored per profile and is user-entered data
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

    // Persist rideExperience to the server so it survives reinstalls and device changes
    if (info.rideExperience !== undefined && account?.mobileToken) {
      authedFetch(`/api/rider/profiles/${profileId}`, account.mobileToken, {
        method: "PATCH",
        body: JSON.stringify({ skillLevel: info.rideExperience }),
      }).catch(() => { /* best-effort */ });
    }
  }, [bikeInfoMap, account?.mobileToken]);

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
        login,
        register,
        logout,
        refreshProfiles,
        riderFetch,
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
