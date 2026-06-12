import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Platform } from "react-native";

const TOKEN_KEY = "rider_mobile_token";
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
  eventsRaced: number;
  totalPoints: number;
  bestPosition: number | null;
  lastRaced: string | null;
}

interface AuthContextType {
  account: RiderAccount | null;
  profiles: RiderProfile[];
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
  const [isLoading, setIsLoading] = useState(true);

  const riderFetch = useCallback(
    (path: string, options: RequestInit = {}): Promise<Response> => {
      return authedFetch(path, account?.mobileToken ?? null, options);
    },
    [account?.mobileToken],
  );

  async function loadProfiles(token: string): Promise<void> {
    try {
      const res = await authedFetch("/api/rider/profiles", token);
      if (res.ok) setProfiles(await res.json());
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
      const token = await AsyncStorage.getItem(TOKEN_KEY);
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
    await AsyncStorage.removeItem(TOKEN_KEY);
    setAccount(null);
    setProfiles([]);
  }

  async function refreshProfiles(): Promise<void> {
    if (account?.mobileToken) await loadProfiles(account.mobileToken);
  }

  return (
    <AuthContext.Provider
      value={{
        account,
        profiles,
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
