export type AnnouncerLifecycleState = {
  started: boolean;
  finished: boolean;
  lastAnnouncedLap: number;
  previousPositions: Map<number, number>;
  timeExpiredAnnounced: boolean;
  expiryLeaderLap: number | null;
  lastAnnouncedExtraLap: number;
};

export type AnnouncerRider = {
  riderId: number;
  riderName: string;
  position: number | null;
  laps: number;
  dnf: boolean;
  dns: boolean;
};

export type AnnouncerAction =
  | { kind: "none" }
  | { kind: "start"; lap: 0 }
  | { kind: "lap"; lap: number; positionChanges: Array<{ riderName: string; from: number; to: number }> }
  | { kind: "time_expired"; lap: number; extraLapsRemaining: number }
  | { kind: "extra_lap"; lap: number; extraLapsCompleted: number; extraLapsRemaining: number }
  | { kind: "finish"; lap: number };

export function calculateRaceTimeRemainingMs(
  timing: {
    startedAt: Date | null;
    pausedAt: Date | null;
    totalPausedMs: number;
    timeLimitMs: number | null;
    timeExpiredAt: Date | null;
  },
  nowMs = Date.now(),
): number | null {
  if (timing.timeLimitMs == null || !timing.startedAt) return null;
  if (timing.timeExpiredAt) return 0;
  const effectiveNowMs = timing.pausedAt?.getTime() ?? nowMs;
  const elapsedMs = Math.max(
    0,
    effectiveNowMs - timing.startedAt.getTime() - Math.max(0, timing.totalPausedMs),
  );
  return Math.max(0, timing.timeLimitMs - elapsedMs);
}

export function shouldPublishAnnouncerSnapshotForMotoPatch(
  body: Record<string, unknown>,
): boolean {
  return body.status !== undefined || body.timeExpiredAt !== undefined;
}

export function createAnnouncerLifecycleState(): AnnouncerLifecycleState {
  return {
    started: false,
    finished: false,
    lastAnnouncedLap: 0,
    previousPositions: new Map(),
    timeExpiredAnnounced: false,
    expiryLeaderLap: null,
    lastAnnouncedExtraLap: 0,
  };
}

export function hydrateAnnouncerLifecycle(
  state: AnnouncerLifecycleState,
  persisted: {
    started: boolean;
    finished: boolean;
    lastAnnouncedLap: number;
    timeExpiredAnnounced?: boolean;
    expiryLeaderLap?: number | null;
    lastAnnouncedExtraLap?: number;
  },
): void {
  if (persisted.started) state.started = true;
  state.lastAnnouncedLap = Math.max(state.lastAnnouncedLap, persisted.lastAnnouncedLap);
  if (persisted.timeExpiredAnnounced) state.timeExpiredAnnounced = true;
  if (persisted.expiryLeaderLap != null) state.expiryLeaderLap = persisted.expiryLeaderLap;
  state.lastAnnouncedExtraLap = Math.max(
    state.lastAnnouncedExtraLap,
    persisted.lastAnnouncedExtraLap ?? 0,
  );
  if (persisted.finished) {
    state.started = true;
    state.finished = true;
  }
}

export function advanceAnnouncerLifecycle(
  state: AnnouncerLifecycleState,
  status: string,
  leaderboard: AnnouncerRider[],
  expectedFieldSize = leaderboard.length,
  timing: {
    timeExpired?: boolean;
    plusLaps?: number | null;
  } = {},
): AnnouncerAction {
  const active = leaderboard.filter(rider => !rider.dnf && !rider.dns);
  const leaderLap = active[0]?.laps ?? 0;
  const positions = () => new Map(active.map(rider => [rider.riderId, rider.position ?? 9999]));

  // If the first observation is already past the start, seed from current facts.
  // This is the restart and mid-race-join guard against stale pre-race language.
  if (!state.started && status === "in_progress" && leaderLap > 0) {
    state.started = true;
    state.lastAnnouncedLap = leaderLap;
    state.previousPositions = positions();
    return { kind: "none" };
  }

  if (!state.started && status === "in_progress") {
    state.started = true;
    state.previousPositions = positions();
    return { kind: "start", lap: 0 };
  }

  // Expiry is a separate transition from a normal lap. It is persisted by the
  // caller so a repeated snapshot or a restarted API cannot replay the call.
  // Capture the leader's lap at the flag; every later leader crossing is then
  // an unambiguous extra lap, even if a viewer joins late.
  const plusLaps = Math.max(0, timing.plusLaps ?? 0);
  if (timing.timeExpired && state.started && !state.timeExpiredAnnounced) {
    state.timeExpiredAnnounced = true;
    state.expiryLeaderLap = leaderLap;
    state.lastAnnouncedExtraLap = 0;
    state.lastAnnouncedLap = Math.max(state.lastAnnouncedLap, leaderLap);
    return { kind: "time_expired", lap: leaderLap, extraLapsRemaining: plusLaps };
  }

  if (
    timing.timeExpired &&
    state.timeExpiredAnnounced &&
    state.expiryLeaderLap != null &&
    leaderLap > state.expiryLeaderLap
  ) {
    const extraLapsCompleted = Math.min(plusLaps, leaderLap - state.expiryLeaderLap);
    if (extraLapsCompleted > state.lastAnnouncedExtraLap) {
      state.lastAnnouncedExtraLap = extraLapsCompleted;
      state.lastAnnouncedLap = Math.max(state.lastAnnouncedLap, leaderLap);
      return {
        kind: "extra_lap",
        lap: leaderLap,
        extraLapsCompleted,
        extraLapsRemaining: Math.max(0, plusLaps - extraLapsCompleted),
      };
    }
  }

  if (status === "completed" && !state.finished) {
    state.started = true;
    state.finished = true;
    state.lastAnnouncedLap = Math.max(state.lastAnnouncedLap, leaderLap);
    state.previousPositions = positions();
    return active.length ? { kind: "finish", lap: leaderLap } : { kind: "none" };
  }

  // Once the timed-race transition has happened, only explicit extra-lap and
  // finish actions are valid. Do not fall back to ordinary lap commentary if a
  // stray crossing arrives after the configured extra laps are exhausted.
  if (timing.timeExpired && state.timeExpiredAnnounced) {
    return { kind: "none" };
  }

  if (status !== "in_progress" || state.finished || leaderLap <= state.lastAnnouncedLap) {
    return { kind: "none" };
  }

  const ridersOnLeaderLap = active.filter(rider => rider.laps >= leaderLap).length;
  const announcementThreshold = Math.min(5, Math.max(expectedFieldSize, active.length));
  if (ridersOnLeaderLap < announcementThreshold) return { kind: "none" };

  const positionChanges = active.flatMap(rider => {
    const from = state.previousPositions.get(rider.riderId);
    return from != null && rider.position != null && from !== rider.position
      ? [{ riderName: rider.riderName, from, to: rider.position }]
      : [];
  });
  state.lastAnnouncedLap = leaderLap;
  state.previousPositions = positions();
  return { kind: "lap", lap: leaderLap, positionChanges };
}