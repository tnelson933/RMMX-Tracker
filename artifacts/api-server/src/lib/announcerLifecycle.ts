export type AnnouncerLifecycleState = {
  started: boolean;
  finished: boolean;
  lastAnnouncedLap: number;
  previousPositions: Map<number, number>;
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
  | { kind: "finish"; lap: number };

export function createAnnouncerLifecycleState(): AnnouncerLifecycleState {
  return {
    started: false,
    finished: false,
    lastAnnouncedLap: 0,
    previousPositions: new Map(),
  };
}

export function hydrateAnnouncerLifecycle(
  state: AnnouncerLifecycleState,
  persisted: { started: boolean; finished: boolean; lastAnnouncedLap: number },
): void {
  if (persisted.started) state.started = true;
  state.lastAnnouncedLap = Math.max(state.lastAnnouncedLap, persisted.lastAnnouncedLap);
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

  if (status === "completed" && !state.finished) {
    state.started = true;
    state.finished = true;
    state.lastAnnouncedLap = Math.max(state.lastAnnouncedLap, leaderLap);
    state.previousPositions = positions();
    return active.length ? { kind: "finish", lap: leaderLap } : { kind: "none" };
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