import { expect, test, type Page } from "@playwright/test";

// Regression guard (2026-11-20, ed959337): on phones the Watch page's side panel
// was a fixed 176px that the race title and status filled, so the rider list had
// zero height. The rider app's live screen embeds this page, so riders saw no list.
// Playwright's toBeVisible() ignores clipping by overflow:hidden ancestors, so
// this measures how much of the first rider row is actually on screen.

test.use({ viewport: { width: 375, height: 667 } });

const lineup = [
  { position: 1, riderId: 11, riderName: "Avery Rider", bibNumber: "11" },
  { position: 2, riderId: 22, riderName: "Blake Rider", bibNumber: "22" },
];

async function fakeRealtime(page: Page) {
  await page.addInitScript(() => {
    const streams: Array<{ url: string; readyState: number; onopen: ((e: Event) => void) | null; onmessage: ((e: MessageEvent) => void) | null }> = [];
    class FakeEventSource {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      url: string;
      readyState = 0;
      withCredentials = false;
      onopen: ((e: Event) => void) | null = null;
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      constructor(url: string | URL) { this.url = String(url); streams.push(this); }
      close() { this.readyState = 2; }
      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() { return true; }
    }
    // No video in this test: the socket opens and stays quiet.
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      binaryType = "blob";
      onopen: ((e: Event) => void) | null = null;
      onmessage: ((e: MessageEvent) => void) | null = null;
      onclose: ((e: CloseEvent) => void) | null = null;
      constructor() { setTimeout(() => { this.readyState = 1; this.onopen?.(new Event("open")); }, 0); }
      send() {}
      close() { this.readyState = 3; }
      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() { return true; }
    }
    Object.defineProperty(window, "EventSource", { value: FakeEventSource });
    Object.defineProperty(window, "WebSocket", { value: FakeWebSocket });
    Object.assign(window, {
      __sendLive(urlPart: string, payload: unknown) {
        const s = [...streams].reverse().find(item => item.url.includes(urlPart) && item.readyState !== 2);
        if (!s) throw new Error(`No open stream matching ${urlPart}`);
        s.readyState = 1;
        s.onopen?.(new Event("open"));
        s.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
      },
    });
  });
}

async function mockApi(page: Page) {
  await page.route("**/api/**", async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/events/7") {
      return route.fulfill({ json: {
        id: 7, name: "Browser Test National", date: "2026-08-27", status: "race_day",
        state: "CO", raceClasses: ["Open"], raceStyle: "motocross",
      } });
    }
    if (pathname === "/api/events/7/motos") {
      return route.fulfill({ json: [{
        id: 101, name: "Heat 1", raceClass: "Open", status: "in_progress", type: "heat", motoNumber: 1, lineup,
      }] });
    }
    if (pathname === "/api/video/status/7") return route.fulfill({ json: { live: false } });
    return route.fulfill({ json: [] });
  });
}

/**
 * Visible height (px) of the first element named `name` that comes before the
 * live tabs in the page, after clipping by every scrolling/overflow-hidden
 * ancestor and the viewport. The side panel precedes the tabs in the DOM.
 */
async function sidePanelRowHeight(page: Page, name: string) {
  return page.evaluate((label) => {
    const tabs = document.querySelector('[role="tablist"][aria-label="Live race views"]');
    const candidates = [...document.querySelectorAll("button, span")]
      .filter(el => el.textContent?.trim() === label && el.children.length === 0)
      .filter(el => !tabs || (el.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING));
    const el = candidates[0];
    if (!el) return -1;
    const r = el.getBoundingClientRect();
    let top = Math.max(r.top, 0);
    let bottom = Math.min(r.bottom, window.innerHeight);
    for (let a = el.parentElement; a; a = a.parentElement) {
      const style = getComputedStyle(a);
      if (style.overflowY === "visible" && style.overflowX === "visible") continue;
      const ar = a.getBoundingClientRect();
      top = Math.max(top, ar.top);
      bottom = Math.min(bottom, ar.bottom);
    }
    return Math.max(0, bottom - top);
  }, name);
}

test("Watch shows the rider list on a 375px phone, before and after live timing starts", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "phone layout only");
  await fakeRealtime(page);
  await mockApi(page);
  await page.goto("/watch/7");

  // Lineup (no timing yet).
  await expect(page.getByText("Heat 1").first()).toBeVisible();
  await expect.poll(() => sidePanelRowHeight(page, "Avery Rider")).toBeGreaterThan(8);

  // Live leaderboard rows replace the lineup in the same panel.
  await page.evaluate(() => (window as unknown as { __sendLive: (u: string, p: unknown) => void }).__sendLive("/timing/live/101", {
    motoId: 101, motoName: "Heat 1", raceClass: "Open", status: "in_progress",
    startedAt: new Date(Date.now() - 30_000).toISOString(), completedAt: null,
    timeLimitMs: null, plusLaps: null, timeExpiredAt: null, updatedAt: new Date().toISOString(), correction: false,
    leaderboard: [
      { position: 1, riderId: 22, riderName: "Blake Rider", bibNumber: "22", laps: 2, lapTimes: ["1:00.000", "0:59.000"], lastLap: "0:59.000", totalTime: "1:59.000", gap: "Leader", dnf: false, dns: false, bestLapMs: 59_000, bestLap: "0:59.000" },
      { position: 2, riderId: 11, riderName: "Avery Rider", bibNumber: "11", laps: 2, lapTimes: ["1:00.000", "1:00.000"], lastLap: "1:00.000", totalTime: "2:00.000", gap: "+1.000", dnf: false, dns: false, bestLapMs: 60_000, bestLap: "1:00.000" },
    ],
    analytics: { lastCompletedLap: 2, movingUp: null, mostPasses: null, fallingBack: null, fastestLap: null, fastestLaps: [] },
  }));
  await expect.poll(() => sidePanelRowHeight(page, "Blake Rider")).toBeGreaterThan(8);
});
