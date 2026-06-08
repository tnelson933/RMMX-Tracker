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
  rfidNumber: string | null;
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
  timingTechnology: string | null;
  raceClass: string;
  motos: MotoResult[];
  totalPoints: number;
  bestPosition: number | null;
}

export interface RiderFull {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  bibNumber: string | null;
  rfidNumber: string | null;
  dateOfBirth: string | null;
  emergencyContact: string | null;
  emergencyPhone: string | null;
  bikeManufacturer: string | null;
  sponsors: string | null;
  amaNumber: string | null;
  hometown: string | null;
  homeState: string | null;
  myLapsTransponderNumber: string | null;
}

export interface RiderHistoryResponse {
  rider: RiderFull;
  history: EventHistory[];
}

export interface CreateProfilePayload {
  firstName: string;
  lastName: string;
  phone?: string | null;
  dateOfBirth?: string | null;
  bibNumber?: string | null;
  amaNumber?: string | null;
  bikeManufacturer?: string | null;
  sponsors?: string | null;
  hometown?: string | null;
  homeState?: string | null;
  myLapsTransponderNumber?: string | null;
}

export interface UpdateProfilePayload {
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  dateOfBirth?: string | null;
  emergencyContact?: string | null;
  emergencyPhone?: string | null;
  bibNumber?: string | null;
  amaNumber?: string | null;
  bikeManufacturer?: string | null;
  sponsors?: string | null;
  hometown?: string | null;
  homeState?: string | null;
  myLapsTransponderNumber?: string | null;
}

export interface PracticeLap {
  lapNumber: number;
  lapTimeMs: number | null;
  crossingTime: string;
}

export interface PracticeSessionHistory {
  sessionId: number;
  sessionName: string;
  startedAt: string | null;
  endedAt: string | null;
  lapCount: number;
  bestLapMs: number | null;
  laps: PracticeLap[];
}

export interface RiderPracticeResponse {
  rider: {
    id: number;
    firstName: string;
    lastName: string;
  };
  sessions: PracticeSessionHistory[];
}

export interface ScheduleMotoLineupEntry {
  gate: number;
  riderId: number;
  riderName: string;
  bibNumber: string | null;
  isFamilyMember: boolean;
}

export interface ScheduleFamilyGate {
  gate: number;
  riderId: number;
  riderName: string;
}

export interface ScheduleMoto {
  motoId: number;
  motoNumber: number;
  name: string;
  type: string;
  raceClass: string | null;
  status: string;
  lapCount: number | null;
  scheduledTime: string | null;
  startedAt: string | null;
  completedAt: string | null;
  isAnyFamilyMemberInMoto: boolean;
  familyGates: ScheduleFamilyGate[];
  lineup: ScheduleMotoLineupEntry[];
}

export interface ScheduleRegistration {
  riderId: number;
  riderName: string;
  raceClass: string | null;
}

export interface ScheduleEvent {
  eventId: number;
  eventName: string;
  eventDate: string | null;
  eventState: string | null;
  eventLocation: string | null;
  status: string;
  registrations: ScheduleRegistration[];
  motos: ScheduleMoto[];
}

export interface RiderScheduleResponse {
  familyRiderIds: number[];
  events: ScheduleEvent[];
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

  practice: (riderId: number): Promise<RiderPracticeResponse> =>
    apiFetch(`/rider/profiles/${riderId}/practice`),

  updateRfid: (riderId: number, rfidNumber: string | null): Promise<{ rfidNumber: string | null }> =>
    apiFetch(`/rider/profiles/${riderId}/rfid`, {
      method: "PATCH",
      body: JSON.stringify({ rfidNumber }),
    }),

  schedule: (riderId: number): Promise<RiderScheduleResponse> =>
    apiFetch(`/rider/profiles/${riderId}/schedule`),

  updateProfile: (riderId: number, payload: UpdateProfilePayload): Promise<RiderFull> =>
    apiFetch(`/rider/profiles/${riderId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  createProfile: (payload: CreateProfilePayload): Promise<{ id: number }> =>
    apiFetch("/rider/profiles", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};
