const BASE = "/api";

async function apiFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export interface RiderAccount {
  id: number;
  email: string;
  createdAt: string;
}

export interface RiderProfile {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  bibNumber: string | null;
  dateOfBirth: string | null;
  eventsRaced: number;
  totalPoints: number;
  bestPosition: number | null;
  lastRaced: string | null;
}

export interface MotoResult {
  motoId: number;
  motoName: string;
  motoNumber: number;
  motoType: string;
  position: number;
  points: number | null;
  totalTime: string | null;
  lapTimes: string[];
  dnf: boolean;
  dns: boolean;
  bibNumber: string | null;
}

export interface EventHistory {
  eventId: number;
  eventName: string;
  eventDate: string;
  eventState: string;
  eventLocation: string | null;
  raceClass: string;
  motos: MotoResult[];
  totalPoints: number;
  bestPosition: number | null;
}

export interface RiderHistoryResponse {
  rider: {
    id: number;
    firstName: string;
    lastName: string;
    email: string | null;
    bibNumber: string | null;
    dateOfBirth: string | null;
  };
  history: EventHistory[];
}

export const riderApi = {
  register: (email: string, password: string): Promise<RiderAccount> =>
    apiFetch("/rider/auth/register", { method: "POST", body: JSON.stringify({ email, password }) }),

  login: (email: string, password: string): Promise<RiderAccount> =>
    apiFetch("/rider/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),

  logout: (): Promise<{ ok: boolean }> =>
    apiFetch("/rider/auth/logout", { method: "POST" }),

  me: (): Promise<RiderAccount> =>
    apiFetch("/rider/auth/me"),

  profiles: (): Promise<RiderProfile[]> =>
    apiFetch("/rider/profiles"),

  history: (riderId: number): Promise<RiderHistoryResponse> =>
    apiFetch(`/rider/profiles/${riderId}/history`),
};
