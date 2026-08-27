import { expect, test, type Page } from "@playwright/test";

type Moto = {
  id: number;
  name: string;
  raceClass: string;
  status: "in_progress" | "completed";
  type: "heat";
  motoNumber: number;
  lineup: Array<{ position: number; riderId: number; riderName: string; bibNumber: string }>;
};

const rider = (riderId: number, riderName: string, position: number) => ({
  position,
  riderId,
  riderName,
  bibNumber: String(riderId),
  laps: 2,
  lapTimes: ["1:00.000", "0:59.000"],
  lastLap: "0:59.000",
  totalTime: "1:59.000",
  gap: position === 1 ? "Leader" : "+1.000",
  dnf: false,
  dns: false,
  bestLapMs: 59_000,
  bestLap: "0:59.000",
});

const snapshot = (
  motoId: number,
  motoName: string,
  leaderboard = [rider(11, "Avery Rider", 1), rider(22, "Blake Rider", 2)],
  correction = false,
) => ({
  motoId,
  motoName,
  raceClass: "Open",
  status: "in_progress",
  startedAt: new Date(Date.now() - 30_000).toISOString(),
  completedAt: null,
  timeLimitMs: null,
  plusLaps: null,
  timeExpiredAt: null,
  leaderboard,
  updatedAt: new Date().toISOString(),
  correction,
  analytics: {
    lastCompletedLap: 2,
    movingUp: null,
    mostPasses: null,
    fallingBack: null,
    fastestLap: null,
    fastestLaps: leaderboard.map(({ riderId, riderName, bibNumber, bestLapMs, bestLap }) => ({
      riderId, riderName, bibNumber, bestLapMs, bestLap,
    })),
  },
});

const moto = (id: number, name: string): Moto => ({
  id,
  name,
  raceClass: "Open",
  status: "in_progress",
  type: "heat",
  motoNumber: id,
  lineup: [
    { position: 1, riderId: 11, riderName: "Avery Rider", bibNumber: "11" },
    { position: 2, riderId: 22, riderName: "Blake Rider", bibNumber: "22" },
  ],
});

async function installRealtimeFakes(page: Page) {
  await page.addInitScript(() => {
    type FakeSse = {
      url: string;
      readyState: number;
      onopen: ((event: Event) => void) | null;
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: ((event: Event) => void) | null;
      close: () => void;
    };
    const streams: FakeSse[] = [];
    class FakeEventSource {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      url: string;
      readyState = 0;
      withCredentials = false;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(url: string | URL) {
        this.url = String(url);
        streams.push(this);
      }
      close() { this.readyState = 2; }
      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() { return true; }
    }
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      binaryType = "blob";
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      private listeners = new Map<string, Array<(event: Event) => void>>();
      constructor() {
        sockets.push(this);
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
        }, 0);
      }
      send() {}
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        const event = new CloseEvent("close");
        this.onclose?.(event);
        this.listeners.get("close")?.forEach(listener => listener(event));
      }
      addEventListener(type: string, listener: (event: Event) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      removeEventListener() {}
      dispatchEvent() { return true; }
    }
    class FakeSourceBuffer extends EventTarget {
      updating = false;
      mode = "segments";
      buffered = { length: 0, start: () => 0, end: () => 0 };
      appendBuffer() {
        this.updating = true;
        setTimeout(() => {
          this.updating = false;
          this.dispatchEvent(new Event("updateend"));
        }, 0);
      }
      remove() {}
    }
    class FakeMediaSource extends EventTarget {
      static isTypeSupported() { return true; }
      readyState = "closed";
      constructor() {
        super();
        setTimeout(() => {
          this.readyState = "open";
          this.dispatchEvent(new Event("sourceopen"));
        }, 0);
      }
      addSourceBuffer() { return new FakeSourceBuffer(); }
    }
    const sockets: FakeWebSocket[] = [];
    Object.defineProperty(window, "EventSource", { value: FakeEventSource });
    Object.defineProperty(window, "WebSocket", { value: FakeWebSocket });
    Object.defineProperty(window, "MediaSource", { value: FakeMediaSource });
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:browser-test" });
    Object.defineProperty(URL, "revokeObjectURL", { value: () => {} });
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value() { return Promise.resolve(); },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "load", {
      configurable: true,
      value() {},
    });
    Object.assign(window, {
      __raceStreams: {
        open(urlPart: string) {
          const stream = [...streams].reverse().find(item => item.url.includes(urlPart) && item.readyState !== 2);
          if (!stream) throw new Error(`No open stream matching ${urlPart}`);
          stream.readyState = 1;
          stream.onopen?.(new Event("open"));
        },
        message(urlPart: string, payload: unknown) {
          const stream = [...streams].reverse().find(item => item.url.includes(urlPart) && item.readyState !== 2);
          if (!stream) throw new Error(`No open stream matching ${urlPart}`);
          stream.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
        },
        error(urlPart: string) {
          const stream = [...streams].reverse().find(item => item.url.includes(urlPart) && item.readyState !== 2);
          if (!stream) throw new Error(`No open stream matching ${urlPart}`);
          stream.onerror?.(new Event("error"));
        },
        count(urlPart: string) {
          return streams.filter(item => item.url.includes(urlPart)).length;
        },
      },
      __raceSocket: {
        message(payload: unknown) {
          const socket = [...sockets].reverse().find(item => item.readyState === 1);
          if (!socket) throw new Error("No open WebSocket");
          socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
        },
        binary(bytes: number[]) {
          const socket = [...sockets].reverse().find(item => item.readyState === 1);
          if (!socket) throw new Error("No open WebSocket");
          socket.onmessage?.(new MessageEvent("message", { data: new Uint8Array(bytes).buffer }));
        },
      },
    });
  });
}

async function streamAction(page: Page, action: "open" | "message" | "error" | "count", url: string, payload?: unknown) {
  return page.evaluate(({ action, url, payload }) => {
    const api = (window as unknown as { __raceStreams: Record<string, (...args: unknown[]) => unknown> }).__raceStreams;
    return api[action](url, ...(payload === undefined ? [] : [payload]));
  }, { action, url, payload });
}

async function socketAction(page: Page, action: "message" | "binary", payload: unknown) {
  await page.evaluate(({ action, payload }) => {
    const api = (window as unknown as { __raceSocket: Record<string, (value: unknown) => void> }).__raceSocket;
    api[action](payload);
  }, { action, payload });
}

async function mockCommonApi(page: Page, getMotos: () => Moto[] = () => []) {
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/events/7") {
      return route.fulfill({ json: {
        id: 7,
        name: "Browser Test National",
        date: "2026-08-27",
        status: "race_day",
        state: "CO",
        raceClasses: ["Open"],
        raceStyle: "motocross",
      } });
    }
    if (url.pathname === "/api/events/7/motos") return route.fulfill({ json: getMotos() });
    if (url.pathname === "/api/events/7/results") return route.fulfill({ json: [] });
    if (url.pathname === "/api/video/status/7") return route.fulfill({ json: { live: false } });
    return route.fulfill({ json: [] });
  });
}

async function expectAllTabsUsable(page: Page) {
  const tablist = page.getByRole("tablist", { name: "Live race views" });
  await expect(tablist).toBeVisible();
  for (const name of ["Live Timing", "Quick Analytics", "Fastest Lap"]) {
    const tab = tablist.getByRole("tab", { name });
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
}

test("standalone leaderboard covers loading, disconnect, and reconnect", async ({ page }) => {
  await installRealtimeFakes(page);
  await mockCommonApi(page);
  await page.goto("/live/101");

  await expect(page.getByText("Connecting to timing system…")).toBeVisible();
  await expect(page.getByText("Reconnecting…")).toBeVisible();
  await streamAction(page, "open", "/timing/live/101");
  await streamAction(page, "message", "/timing/live/101", snapshot(101, "Heat 1"));
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(page.getByText("Heat 1")).toBeVisible();

  await streamAction(page, "error", "/timing/live/101");
  await expect(page.getByText("Reconnecting…")).toBeVisible();
  await expect.poll(() => streamAction(page, "count", "/timing/live/101"), { timeout: 5_000 }).toBe(2);
  await streamAction(page, "open", "/timing/live/101");
  await streamAction(page, "message", "/timing/live/101", snapshot(101, "Heat 1"));
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expectAllTabsUsable(page);
});

test("switching active motos in place clears correction and position-gain state", async ({ page }) => {
  test.setTimeout(60_000);
  await installRealtimeFakes(page);
  let activeMotos = [moto(101, "Heat 1")];
  await mockCommonApi(page, () => activeMotos);
  await page.goto("/results/7");
  await streamAction(page, "open", "/timing/live/101");
  await streamAction(page, "message", "/timing/live/101", snapshot(101, "Heat 1"));
  await page.evaluate(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      nativeSetTimeout(handler, timeout === 2_000 || timeout === 5_000 ? 60_000 : timeout, ...args)
    ) as typeof window.setTimeout;
  });
  await streamAction(page, "message", "/timing/live/101", snapshot(
    101,
    "Heat 1",
    [rider(22, "Blake Rider", 1), rider(11, "Avery Rider", 2)],
    true,
  ));
  await expect(page.getByText(/Results corrected/)).toBeVisible();
  await expect(page.locator('[data-rider-id="22"]')).toHaveAttribute("data-position-gain", "true");

  activeMotos = [moto(202, "Heat 2")];
  await expect.poll(() => streamAction(page, "count", "/timing/live/202"), { timeout: 35_000 }).toBe(1);
  await expect(page).toHaveURL(/\/results\/7$/);
  await expect(page.getByText(/Results corrected/)).toHaveCount(0);
  await expect(page.locator('[data-position-gain="true"]')).toHaveCount(0);
  await streamAction(page, "open", "/timing/live/202");
  await streamAction(page, "message", "/timing/live/202", snapshot(202, "Heat 2"));
  await expect(page.getByText("Heat 2").first()).toBeVisible();
  await expect(page.locator('[data-position-gain="true"]')).toHaveCount(0);
});

test("Event Results exposes the shared live tabs", async ({ page }) => {
  await installRealtimeFakes(page);
  await mockCommonApi(page, () => [moto(101, "Heat 1")]);
  await page.goto("/results/7");
  await streamAction(page, "open", "/timing/live/101");
  await streamAction(page, "message", "/timing/live/101", snapshot(101, "Heat 1"));
  await expect(page.getByText("Browser Test National")).toBeVisible();
  await expectAllTabsUsable(page);
  await expect(await streamAction(page, "count", "/timing/live/101")).toBe(1);
});

test("Watch keeps one timing stream while announcements and tabs update", async ({ page }) => {
  await installRealtimeFakes(page);
  await mockCommonApi(page, () => [moto(101, "Heat 1")]);
  await page.goto("/watch/7");
  await expect.poll(() => page.evaluate(() => document.readyState)).toBe("complete");
  await socketAction(page, "message", {
    type: "init",
    mimeType: 'video/webm; codecs="vp8,opus"',
    is360: false,
    isDualFisheye: false,
  });
  await socketAction(page, "binary", [0x1a, 0x45, 0xdf, 0xa3]);
  await expect(page.locator('[data-viewer-state="playing"]')).toBeVisible();
  await expect.poll(() => streamAction(page, "count", "/timing/live/101")).toBe(1);
  await expect.poll(() => streamAction(page, "count", "/timing/announcer-live/101")).toBe(1);
  await streamAction(page, "open", "/timing/live/101");
  await streamAction(page, "message", "/timing/live/101", snapshot(101, "Heat 1"));
  await streamAction(page, "message", "/timing/announcer-live/101", {
    announcement: { sequence: 1, label: "Blake takes the lead", audioUrl: "/api/test-audio" },
  });
  await expect(page.getByText("Blake takes the lead")).toBeVisible();
  await expectAllTabsUsable(page);
  await expect(await streamAction(page, "count", "/timing/live/101")).toBe(1);

  const video = page.locator("video");
  await expect(video).toBeVisible();
  const box = await video.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(100);
});