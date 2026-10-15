/**
 * Race-scale live timing benchmark.
 *
 * This drives the production timing routes against a disposable development
 * fixture. It intentionally uses HTTP for both crossing ingestion and SSE so
 * the result covers the same path used by readers and live viewers.
 *
 * Usage:
 *   LIVE_TIMING_ALLOW_DATABASE_WRITES=1 \
 *     pnpm --filter @workspace/scripts run benchmark:live-timing
 *
 * Optional environment variables:
 *   LIVE_TIMING_API_URL       loopback API origin including /api (default: localhost:PORT/api)
 *   LIVE_TIMING_RIDERS        riders in the full gate (default: 40)
 *   LIVE_TIMING_LAPS          completed laps (default: 8)
 *   LIVE_TIMING_VIEWERS       simultaneous SSE viewers (default: 20)
 *   LIVE_TIMING_BURST_SIZE     concurrent finish-line crossings (default: 8)
 *   LIVE_TIMING_REQUEST_P95_MS
 *   LIVE_TIMING_BROADCAST_P95_MS
 *   LIVE_TIMING_BROADCAST_MAX_MS
 */

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import {
  clubsTable,
  db,
  eventsTable,
  lapCrossingsTable,
  motosTable,
  raceResultsTable,
  ridersTable,
  checkinsTable,
  rfidAssignmentsTable,
} from "@workspace/db";
import { and, asc, eq, ilike, inArray } from "drizzle-orm";

const DEFAULT_RIDERS = 40;
const DEFAULT_LAPS = 8;
const DEFAULT_VIEWERS = 20;
const REQUEST_P95_BUDGET_MS = Number(process.env.LIVE_TIMING_REQUEST_P95_MS ?? 1_000);
const BROADCAST_P95_BUDGET_MS = Number(process.env.LIVE_TIMING_BROADCAST_P95_MS ?? 2_000);
const BROADCAST_MAX_BUDGET_MS = Number(process.env.LIVE_TIMING_BROADCAST_MAX_MS ?? 5_000);
const RIDER_COUNT = readPositiveInteger("LIVE_TIMING_RIDERS", DEFAULT_RIDERS);
const LAP_COUNT = readPositiveInteger("LIVE_TIMING_LAPS", DEFAULT_LAPS);
const VIEWER_COUNT = readPositiveInteger("LIVE_TIMING_VIEWERS", DEFAULT_VIEWERS);
const BURST_SIZE = readPositiveInteger("LIVE_TIMING_BURST_SIZE", 8);
const API_URL = (
  process.env.LIVE_TIMING_API_URL
  ?? `http://127.0.0.1:${process.env.API_PORT ?? process.env.PORT ?? "8080"}/api`
).replace(/\/$/, "");
const FIXTURE_PREFIX = "Live timing performance benchmark";
const BENCHMARK_RIDER_FIRST_NAME = "__live_timing_benchmark__";

type BenchmarkFixture = {
  eventId: number;
  motoId: number;
  motoName: string;
  riderIds: number[];
};

type Snapshot = {
  motoId?: number;
  motoName?: string;
  leaderboard?: unknown[];
  analytics?: Record<string, unknown>;
};

type Viewer = {
  index: number;
  controller: AbortController;
  initial: Promise<void>;
  waitForCount: (target: number, timeoutMs: number) => Promise<void>;
  get count(): number;
  get latest(): Snapshot | null;
};

function readPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function percentile(values: number[], fraction: number): number {
  assert(values.length > 0, "Cannot calculate a percentile with no samples");
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function formatMs(value: number): string {
  return `${value.toFixed(1)} ms`;
}

async function deleteFixture(eventIds: number[], riderIds: number[]): Promise<void> {
  if (eventIds.length > 0) {
    const motos = await db
      .select({ id: motosTable.id })
      .from(motosTable)
      .where(inArray(motosTable.eventId, eventIds));
    const motoIds = motos.map((moto) => moto.id);

    if (motoIds.length > 0) {
      await db.delete(lapCrossingsTable).where(inArray(lapCrossingsTable.motoId, motoIds));
      await db.delete(raceResultsTable).where(inArray(raceResultsTable.motoId, motoIds));
      await db.delete(motosTable).where(inArray(motosTable.id, motoIds));
    }

    await db.delete(rfidAssignmentsTable).where(inArray(rfidAssignmentsTable.eventId, eventIds));
    await db.delete(checkinsTable).where(inArray(checkinsTable.eventId, eventIds));
    await db.delete(eventsTable).where(inArray(eventsTable.id, eventIds));
  }

  if (riderIds.length > 0) {
    await db.delete(ridersTable).where(inArray(ridersTable.id, riderIds));
  }
}

async function removeStaleFixtures(): Promise<void> {
  const staleEvents = await db
    .select({ id: eventsTable.id })
    .from(eventsTable)
    .where(ilike(eventsTable.name, `${FIXTURE_PREFIX}%`));
  const staleRiders = await db
    .select({ id: ridersTable.id })
    .from(ridersTable)
    .where(eq(ridersTable.firstName, BENCHMARK_RIDER_FIRST_NAME));
  if (staleEvents.length > 0 || staleRiders.length > 0) {
    console.warn(
      `Removing ${staleEvents.length} stale benchmark fixture(s) `
      + `and ${staleRiders.length} tagged rider(s)`,
    );
    await deleteFixture(
      staleEvents.map((event) => event.id),
      staleRiders.map((rider) => rider.id),
    );
  }
}

async function createFixture(
  inserted: { eventIds: number[]; riderIds: number[] },
): Promise<BenchmarkFixture> {
  const [club] = await db.select({ id: clubsTable.id }).from(clubsTable).orderBy(asc(clubsTable.id)).limit(1);
  assert(club, "At least one club is required to create the benchmark fixture");

  const now = new Date();
  const startedAt = new Date(now.getTime() - 15 * 60 * 1_000);
  const raceClass = "Benchmark 250";
  const motoName = `Benchmark Full Gate ${now.toISOString()}`;
  const [event] = await db.insert(eventsTable).values({
    clubId: club.id,
    name: `${FIXTURE_PREFIX} ${now.toISOString()}`,
    date: now.toISOString().slice(0, 10),
    state: "CO",
    location: "Disposable performance fixture",
    trackName: "Benchmark Track",
    raceClasses: [raceClass],
    status: "race_day",
    timingTechnology: "rfid",
  }).returning({ id: eventsTable.id });
  assert(event, "Benchmark event was not created");
  inserted.eventIds.push(event.id);

  const riders = await db.insert(ridersTable).values(
    Array.from({ length: RIDER_COUNT }, (_, index) => ({
      clubId: club.id,
      firstName: BENCHMARK_RIDER_FIRST_NAME,
      lastName: `Rider ${String(index + 1).padStart(2, "0")}`,
      bibNumber: String(9000 + index),
    })),
  ).returning({ id: ridersTable.id, bibNumber: ridersTable.bibNumber });
  const riderIds = riders.map((rider) => rider.id);
  inserted.riderIds.push(...riderIds);

  await db.insert(checkinsTable).values(riders.map((rider) => ({
    eventId: event.id,
    riderId: rider.id,
    raceClass,
    bibNumber: rider.bibNumber,
    checkedIn: true,
    checkedInAt: startedAt,
  })));
  await db.insert(rfidAssignmentsTable).values(riders.map((rider, index) => ({
    eventId: event.id,
    riderId: rider.id,
    rfidNumber: `BENCHMARK-${String(index + 1).padStart(2, "0")}`,
  })));

  const [moto] = await db.insert(motosTable).values({
    eventId: event.id,
    name: motoName,
    type: "main",
    raceClass,
    status: "in_progress",
    motoNumber: 1,
    lineup: riderIds,
    lapCount: LAP_COUNT,
    startedAt,
  }).returning({ id: motosTable.id });
  assert(moto, "Benchmark moto was not created");

  return { eventId: event.id, motoId: moto.id, motoName, riderIds };
}

function connectViewer(motoId: number, index: number): Viewer {
  const controller = new AbortController();
  let count = 0;
  let latest: Snapshot | null = null;
  let streamError: Error | null = null;
  let resolveInitial!: () => void;
  let rejectInitial!: (error: Error) => void;
  const initial = new Promise<void>((resolve, reject) => {
    resolveInitial = resolve;
    rejectInitial = reject;
  });
  const waiters = new Map<number, Array<{ resolve: () => void; reject: (error: Error) => void }>>();

  const notifySnapshot = (snapshot: Snapshot) => {
    count += 1;
    latest = snapshot;
    if (count === 1) resolveInitial();
    for (const [target, pending] of waiters) {
      if (count < target) continue;
      waiters.delete(target);
      pending.forEach(({ resolve }) => resolve());
    }
  };

  const fail = (error: Error) => {
    if (streamError) return;
    streamError = error;
    rejectInitial(error);
    for (const pending of waiters.values()) {
      pending.forEach(({ reject }) => reject(error));
    }
    waiters.clear();
  };

  void (async () => {
    try {
      const response = await fetch(`${API_URL}/timing/live/${motoId}`, {
        signal: controller.signal,
        headers: { Accept: "text/event-stream" },
      });
      if (!response.ok || !response.body) {
        throw new Error(`viewer ${index + 1} SSE returned HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          notifySnapshot(JSON.parse(data) as Snapshot);
        }
      }
      if (!controller.signal.aborted) fail(new Error(`viewer ${index + 1} SSE stream ended`));
    } catch (error) {
      if (!controller.signal.aborted) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  })();

  return {
    index,
    controller,
    initial,
    waitForCount: (target, timeoutMs) => {
      if (streamError) return Promise.reject(streamError);
      if (count >= target) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const pending = waiters.get(target) ?? [];
          waiters.set(target, pending.filter((entry) => entry.resolve !== resolve));
          reject(new Error(`viewer ${index + 1} did not receive event ${target} within ${timeoutMs} ms`));
        }, timeoutMs);
        const resolveWithTimer = () => {
          clearTimeout(timer);
          resolve();
        };
        const rejectWithTimer = (error: Error) => {
          clearTimeout(timer);
          reject(error);
        };
        const pending = waiters.get(target) ?? [];
        pending.push({ resolve: resolveWithTimer, reject: rejectWithTimer });
        waiters.set(target, pending);
      });
    },
    get count() {
      return count;
    },
    get latest() {
      return latest;
    },
  };
}

async function postCrossing(motoId: number, rfidNumber: string, crossingTime: Date): Promise<number> {
  const started = performance.now();
  const response = await fetch(`${API_URL}/timing/crossing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ motoId, rfidNumber, crossingTime: crossingTime.toISOString(), readerId: "BENCHMARK" }),
  });
  const elapsedMs = performance.now() - started;
  const payload = await response.json() as { ok?: boolean; crossingId?: number; error?: string };
  if (!response.ok || !payload.ok || !payload.crossingId) {
    throw new Error(`crossing ${rfidNumber} failed (${response.status}): ${payload.error ?? "unknown error"}`);
  }
  return elapsedMs;
}

async function runBenchmark(): Promise<void> {
  assert(
    process.env.LIVE_TIMING_ALLOW_DATABASE_WRITES === "1",
    "Set LIVE_TIMING_ALLOW_DATABASE_WRITES=1 to confirm this development benchmark may create and delete fixture rows",
  );
  assert(
    process.env.NODE_ENV !== "production"
    && !process.env.REPLIT_DEPLOYMENT
    && !process.env.REPLIT_DEPLOYMENT_ID,
    "Live timing benchmark is disabled in production and deployment environments",
  );
  assert(REQUEST_P95_BUDGET_MS > 0, "LIVE_TIMING_REQUEST_P95_MS must be positive");
  assert(BROADCAST_P95_BUDGET_MS > 0, "LIVE_TIMING_BROADCAST_P95_MS must be positive");
  assert(BROADCAST_MAX_BUDGET_MS > 0, "LIVE_TIMING_BROADCAST_MAX_MS must be positive");
  const parsedApiUrl = new URL(API_URL);
  assert(
    parsedApiUrl.protocol === "http:"
    && ["127.0.0.1", "localhost", "::1"].includes(parsedApiUrl.hostname),
    "LIVE_TIMING_API_URL must use a loopback HTTP address so fixture data and API traffic stay in development",
  );

  const inserted = { eventIds: [] as number[], riderIds: [] as number[] };
  let fixture: BenchmarkFixture | null = null;
  const viewers: Viewer[] = [];
  const requestLatencies: number[] = [];
  const broadcastLatencies: number[] = [];

  try {
    await removeStaleFixtures();
    fixture = await createFixture(inserted);
    const activeFixture = fixture;
    for (let index = 0; index < VIEWER_COUNT; index += 1) {
      viewers.push(connectViewer(activeFixture.motoId, index));
    }
    await Promise.all(viewers.map((viewer) => viewer.initial));
    assert(viewers.every((viewer) => viewer.count === 1), "Every viewer must receive exactly one initial snapshot");
    assert(
      viewers.every((viewer) =>
        viewer.latest?.motoId === activeFixture.motoId
        && viewer.latest?.motoName === activeFixture.motoName,
      ),
      "The local API is not connected to the same benchmark fixture database; refusing to send crossings",
    );

    console.log(
      `Live timing benchmark: ${RIDER_COUNT} riders × ${LAP_COUNT} laps, `
      + `${VIEWER_COUNT} SSE viewers, bursts of ${Math.min(BURST_SIZE, RIDER_COUNT)}, API ${API_URL}`,
    );

    const startedAt = new Date(Date.now() - 15 * 60 * 1_000);
    for (let lap = 1; lap <= LAP_COUNT; lap += 1) {
      const lapLatencies: number[] = [];
      const lapBroadcastLatencies: number[] = [];
      for (let start = 0; start < activeFixture.riderIds.length; start += BURST_SIZE) {
        const burstRiderIds = activeFixture.riderIds.slice(start, start + BURST_SIZE);
        const baselineCounts = viewers.map((viewer) => viewer.count);
        const burstStarted = performance.now();
        const latencies = await Promise.all(burstRiderIds.map((_, offset) => {
          const index = start + offset;
          return postCrossing(
            activeFixture.motoId,
            `BENCHMARK-${String(index + 1).padStart(2, "0")}`,
            new Date(startedAt.getTime() + lap * 90_000 + index * 1_000),
          );
        }));
        requestLatencies.push(...latencies);
        lapLatencies.push(...latencies);

        await Promise.all(viewers.map((viewer, index) =>
          viewer.waitForCount(baselineCounts[index] + burstRiderIds.length, BROADCAST_MAX_BUDGET_MS),
        ));
        const broadcastElapsed = performance.now() - burstStarted;
        broadcastLatencies.push(broadcastElapsed);
        lapBroadcastLatencies.push(broadcastElapsed);

        const analyticsPresent = viewers.every((viewer) => viewer.latest?.analytics);
        assert(analyticsPresent, `analytics missing from lap ${lap} broadcast`);
      }
      console.log(
        `  lap ${lap}/${LAP_COUNT}: request p95 ${formatMs(percentile(lapLatencies, 0.95))}, `
        + `all-viewer burst p95 ${formatMs(percentile(lapBroadcastLatencies, 0.95))}`,
      );
    }

    const requestP95 = percentile(requestLatencies, 0.95);
    const broadcastP95 = percentile(broadcastLatencies, 0.95);
    const broadcastMax = Math.max(...broadcastLatencies);
    console.log(
      `RESULT request p95=${formatMs(requestP95)} (budget ${formatMs(REQUEST_P95_BUDGET_MS)}), `
      + `broadcast p95=${formatMs(broadcastP95)} (budget ${formatMs(BROADCAST_P95_BUDGET_MS)}), `
      + `broadcast max=${formatMs(broadcastMax)} (budget ${formatMs(BROADCAST_MAX_BUDGET_MS)})`,
    );

    assert(
      requestP95 <= REQUEST_P95_BUDGET_MS,
      `crossing request p95 ${formatMs(requestP95)} exceeded ${formatMs(REQUEST_P95_BUDGET_MS)}`,
    );
    assert(
      broadcastP95 <= BROADCAST_P95_BUDGET_MS,
      `SSE broadcast p95 ${formatMs(broadcastP95)} exceeded ${formatMs(BROADCAST_P95_BUDGET_MS)}`,
    );
    assert(
      broadcastMax <= BROADCAST_MAX_BUDGET_MS,
      `SSE broadcast max ${formatMs(broadcastMax)} exceeded ${formatMs(BROADCAST_MAX_BUDGET_MS)}`,
    );
    console.log("PASS live timing stayed within race-scale latency budgets");
  } finally {
    viewers.forEach((viewer) => viewer.controller.abort());
    await deleteFixture(inserted.eventIds, inserted.riderIds);
  }
}

runBenchmark()
  .catch((error) => {
    console.error(`FAIL live timing benchmark: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });