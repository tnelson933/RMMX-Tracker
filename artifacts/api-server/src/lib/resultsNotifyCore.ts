/**
 * Who hears about an event's official results (pure; lib/resultsNotify.ts
 * keeps the record). The first time an event becomes official everyone is
 * told. If results are corrected and finalized again, only riders whose own
 * results changed (a place, a DNF/DNS mark or a lap time) are told again.
 */

export interface NotifyResultRow {
  riderId: number;
  motoId: number;
  position: number;
  dnf: boolean | null;
  dns: boolean | null;
  lapTimes: unknown;
}

/** A rider's results across the event as one comparable string. */
export function resultsFingerprint(rows: Omit<NotifyResultRow, "riderId">[]): string {
  return JSON.stringify([...rows]
    .sort((a, b) => a.motoId - b.motoId)
    .map(r => [
      r.motoId,
      r.dns ? "dns" : r.dnf ? "dnf" : r.position,
      Array.isArray(r.lapTimes) ? r.lapTimes.map(t => (typeof t === "number" ? Math.round(t) : String(t))) : [],
    ]));
}

/** Each rider's fingerprint from the event's results. */
export function fingerprintsByRider(rows: NotifyResultRow[]): Map<number, string> {
  const byRider = new Map<number, NotifyResultRow[]>();
  for (const r of rows) byRider.set(r.riderId, [...(byRider.get(r.riderId) ?? []), r]);
  return new Map([...byRider].map(([riderId, mine]) => [riderId, resultsFingerprint(mine)]));
}

/**
 * Riders to tell now: `first` have never been told about this event, `changed`
 * were told before and their results are different. Everyone else is skipped.
 */
export function ridersToNotify(
  current: Map<number, string>,
  alreadySent: Map<number, string>,
): { first: number[]; changed: number[] } {
  const first: number[] = [];
  const changed: number[] = [];
  for (const [riderId, fingerprint] of current) {
    const sent = alreadySent.get(riderId);
    if (sent === undefined) first.push(riderId);
    else if (sent !== fingerprint) changed.push(riderId);
  }
  return { first, changed };
}
