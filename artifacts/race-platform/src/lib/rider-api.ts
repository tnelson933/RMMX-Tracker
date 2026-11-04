import { isNetworkError, NETWORK_ERROR_MESSAGE, serverErrorMessage } from "./friendlyErrors";

const BASE = "/api";

async function apiFetch(path: string, options?: RequestInit) {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch (err) {
    throw new Error(isNetworkError(err) ? NETWORK_ERROR_MESSAGE : String((err as Error)?.message ?? err));
  }
  if (!res.ok) {
    if (res.status >= 500) throw new Error(serverErrorMessage(res.status));
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (error ${res.status}). Please try again.`);
  }
  return res.json();
}

export interface RiderBike {
  id: number;
  riderId: number;
  bikeManufacturer: string | null;
  bikeModel: string | null;
  bikeYear: string | null;
  isDefault: boolean;
  createdAt: string;
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
  bikes: RiderBike[];
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
  lapGaps?: Array<{ leader: number | null; ahead: number | null }>;
  /** Running position at the end of each lap (1 = leading). */
  positionByLap?: Array<number | null>;
  /** Riders who started this moto. */
  fieldSize?: number;
  /** The moto winner's average lap in ms, for % off the winner's pace. */
  winnerAvgLapMs?: number | null;
  /** Split (sector) times, when the course had split readers. */
  sectors?: {
    names: string[];
    laps: Array<{ lapNumber: number; sectorsMs: Array<number | null> }>;
    bestMs: Array<number | null>;
    fieldBestMs: Array<number | null>;
  } | null;
  dnf: boolean;
  dns: boolean;
  bibNumber: string | null;
  /** Finalized by the organizer; otherwise unofficial results. */
  official?: boolean;
  /** Group races: the team's riders and the laps each of them rode. */
  team?: TeamBreakdown | null;
}

export interface TeamBreakdown {
  name: string | null;
  members: Array<{ position: number; name: string; isYou: boolean; lapCount: number; lapTimes: string[]; totalTime: string | null; bestLap: string | null }>;
}

export interface EventHistory {
  eventId: number;
  eventName: string;
  eventDate: string;
  eventState: string;
  eventLocation: string | null;
  /** Organizer's event image ("/api/storage/..." path). */
  eventImageUrl?: string | null;
  timingTechnology: string | null;
  /** Group races: the team this rider rode on. */
  teamName?: string | null;
  /** Which kinds of tag the event's readers used (RM TrackR, RFID or both). */
  timingTags?: { transponder: boolean; rfid: boolean; fromReaders: boolean };
  raceStyle?: string | null;
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
  /** Racer profile (riders.bio / plate_color / profile_visibility). */
  bio?: string | null;
  plateColor?: string | null;
  profileVisibility?: "public" | "private" | null;
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
  venueName: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  lapCount: number;
  bestLapMs: number | null;
  laps: PracticeLap[];
  /** Sector times when the practice's track has split readers. */
  sectorNames?: string[];
  sectorLaps?: Array<{ lapNumber: number; sectorsMs: Array<number | null>; complete: boolean }>;
  bestSectors?: Array<number | null>;
}

export interface RiderPracticeResponse {
  rider: {
    id: number;
    firstName: string;
    lastName: string;
  };
  sessions: PracticeSessionHistory[];
}

export interface EventPracticeLap {
  lapNumber: number;
  lapTimeMs: number | null;
  crossingTime: string;
}

export interface EventPracticeLeaderboardEntry {
  rank: number;
  riderId: number | null;
  riderName: string;
  bibNumber: string | null;
  bestLapMs: number | null;
  lapCount: number;
  isMe: boolean;
}

export interface EventPracticeSession {
  motoId: number;
  sessionName: string;
  status: string;
  leaderboard: EventPracticeLeaderboardEntry[];
  myLaps: EventPracticeLap[];
}

export interface EventPracticeEvent {
  eventId: number;
  eventName: string;
  eventDate: string | null;
  eventState: string | null;
  raceClass: string | null;
  raceStyle?: string | null;
  sessions: EventPracticeSession[];
}

export interface RiderEventPracticeResponse {
  events: EventPracticeEvent[];
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

export interface PracticeLeaderboardEntry {
  rank: number;
  riderId: number | null;
  riderName: string;
  bestLapMs: number | null;
  isMe: boolean;
}

export interface PracticeLapEntry {
  riderId: number;
  lapNumber: number;
  lapTimeMs: number | null;
}

export interface ScheduleMoto {
  motoId: number;
  motoNumber: number;
  name: string;
  type: string;
  raceClass: string | null;
  status: string;
  lapCount: number | null;
  timeLimitMs?: number | null;
  scheduledTime: string | null;
  startedAt: string | null;
  completedAt: string | null;
  isAnyFamilyMemberInMoto: boolean;
  familyGates: ScheduleFamilyGate[];
  lineup: ScheduleMotoLineupEntry[];
  practiceLaps?: PracticeLapEntry[];
  practiceLeaderboard?: PracticeLeaderboardEntry[];
}

export interface ScheduleRegistration {
  id: number;
  riderId: number;
  riderName: string;
  raceClass: string | null;
}

export interface ScheduleEvent {
  eventId: number;
  eventName: string;
  eventDate: string | null;
  eventEndDate?: string | null;
  eventState: string | null;
  eventLocation: string | null;
  /** Organizer's event image ("/api/storage/..." path). */
  eventImageUrl?: string | null;
  status: string;
  raceStyle: string;
  classStartTimes: Record<string, string | null>;
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

  eventPractice: (riderId: number): Promise<RiderEventPracticeResponse> =>
    apiFetch(`/rider/profiles/${riderId}/event-practice`),

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

  getBikes: (riderId: number): Promise<RiderBike[]> =>
    apiFetch(`/rider/profiles/${riderId}/bikes`),

  addBike: (riderId: number, payload: { bikeManufacturer?: string | null; bikeModel?: string | null; bikeYear?: string | null }): Promise<RiderBike> =>
    apiFetch(`/rider/profiles/${riderId}/bikes`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  updateBike: (riderId: number, bikeId: number, payload: { bikeManufacturer?: string | null; bikeModel?: string | null; bikeYear?: string | null }): Promise<RiderBike> =>
    apiFetch(`/rider/profiles/${riderId}/bikes/${bikeId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  deleteBike: (riderId: number, bikeId: number): Promise<{ ok: boolean }> =>
    apiFetch(`/rider/profiles/${riderId}/bikes/${bikeId}`, { method: "DELETE" }),

  setDefaultBike: (riderId: number, bikeId: number): Promise<RiderBike> =>
    apiFetch(`/rider/profiles/${riderId}/bikes/${bikeId}/set-default`, { method: "POST" }),

  cancelRegistrations: (eventId: number, registrationIds: number[]): Promise<{ cancelled: number }> =>
    apiFetch(`/rider/events/${eventId}/registrations/cancel`, {
      method: "POST",
      body: JSON.stringify({ registrationIds }),
    }),

  // ── Shared with the rider app: profile settings, series, stats, following ──
  profile: (riderId: number): Promise<RiderProfileDetail> =>
    apiFetch(`/rider/profiles/${riderId}`),

  updateRacerProfile: (riderId: number, payload: { bio?: string | null; plateColor?: string | null; profileVisibility?: "public" | "private" | null }): Promise<RiderProfileDetail> =>
    apiFetch(`/rider/profiles/${riderId}`, { method: "PATCH", body: JSON.stringify(payload) }),

  /** This rider's series positions (season and events let the Season view match them). */
  series: (riderId: number): Promise<RiderSeriesEntry[]> =>
    apiFetch(`/rider/series?riderId=${riderId}`),

  careerStats: (riderId: number): Promise<{ riderId: number; name: string; stats: CareerStats }> =>
    apiFetch(`/rider/profiles/${riderId}/stats`),

  managers: (riderId: number): Promise<{ isOwner: boolean; managers: ProfileManager[] }> =>
    apiFetch(`/rider/profiles/${riderId}/managers`),

  addManager: (riderId: number, email: string): Promise<unknown> =>
    apiFetch(`/rider/profiles/${riderId}/managers`, { method: "POST", body: JSON.stringify({ email }) }),

  removeManager: (riderId: number, managerId: number): Promise<unknown> =>
    apiFetch(`/rider/profiles/${riderId}/managers/${managerId}`, { method: "DELETE" }),

  racer: (riderId: number): Promise<RacerProfile> =>
    apiFetch(`/rider/riders/${riderId}/public`),

  searchRiders: (q: string): Promise<{ riders: Array<{ id: number; name: string; lastRaced: string | null; clubName: string | null; following: boolean }> }> =>
    apiFetch(`/rider/riders/search?q=${encodeURIComponent(q)}`),

  follows: (): Promise<{ following: Array<{ riderId: number; name: string; since: string }> }> =>
    apiFetch("/rider/follows"),

  follow: (riderId: number): Promise<unknown> =>
    apiFetch(`/rider/follows/${riderId}`, { method: "POST" }),

  unfollow: (riderId: number): Promise<unknown> =>
    apiFetch(`/rider/follows/${riderId}`, { method: "DELETE" }),

  feed: (): Promise<{ items: Array<FeedItem & { isMine: boolean }> }> =>
    apiFetch("/rider/feed"),
};

export interface RiderProfileDetail extends RiderFull {
  effectiveVisibility: "public" | "private";
  isMinor?: boolean;
}

export interface RiderSeriesEntry {
  seriesId: number;
  seriesName: string;
  raceClass: string;
  totalPoints: number;
  position: number;
  season?: number | null;
  eventIds?: number[];
}

export interface CareerStats {
  starts: number;
  finishes: number;
  dnfs?: number;
  wins: number;
  podiums: number;
  top5s: number;
  avgFinish: number | null;
  totalLaps: number;
  lapsLed: number;
  pctLapsLed: number | null;
  lap1Leads: number;
  avgLap1Position: number | null;
  positionsGained: number;
  avgPositionsGained: number | null;
  bestLap: { ms: number; eventId: number; eventName: string; motoName: string } | null;
}

export interface ProfileManager { id: number; email: string; joined: boolean; isYou: boolean }

export interface FeedItem {
  riderId: number;
  riderName: string;
  eventId: number;
  eventName: string;
  eventDate: string;
  raceClass: string;
  official: boolean;
  bestPosition: number | null;
  motos: Array<{ motoName: string; position: number | null; dnf: boolean; dns: boolean }>;
}

export interface RacerProfile {
  riderId: number;
  name: string;
  following: boolean;
  followerCount: number;
  stats: CareerStats;
  recent: FeedItem[];
  resume?: {
    headline: string | null;
    highlights: {
      bestFinish: { position: number; eventId: number; eventName: string; eventDate: string } | null;
      bestComeback: { gained: number; eventId: number; eventName: string } | null;
    };
    seasons: Array<{ year: string; avgFinish: number | null; motos: number }>;
    badges: Array<{ key: string; label: string }>;
    classes: string[];
    tracks: string[];
    firstYear: string | null;
  };
  profile?: { number: string | null; plateColor: string | null; state: string | null; bio: string | null };
  visibility?: "public" | "private";
  isManager?: boolean;
}
