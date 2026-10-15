# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: live-race-tabs.spec.ts >> switching active motos in place clears correction and position-gain state
- Location: tests/browser/live-race-tabs.spec.ts:278:1

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: page.goto: Test timeout of 60000ms exceeded.
Call log:
  - navigating to "http://127.0.0.1:4174/results/7", waiting until "load"

```

# Test source

```ts
  183 |           if (!stream) throw new Error(`No open stream matching ${urlPart}`);
  184 |           stream.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
  185 |         },
  186 |         error(urlPart: string) {
  187 |           const stream = [...streams].reverse().find(item => item.url.includes(urlPart) && item.readyState !== 2);
  188 |           if (!stream) throw new Error(`No open stream matching ${urlPart}`);
  189 |           stream.onerror?.(new Event("error"));
  190 |         },
  191 |         count(urlPart: string) {
  192 |           return streams.filter(item => item.url.includes(urlPart)).length;
  193 |         },
  194 |       },
  195 |       __raceSocket: {
  196 |         message(payload: unknown) {
  197 |           const socket = [...sockets].reverse().find(item => item.readyState === 1);
  198 |           if (!socket) throw new Error("No open WebSocket");
  199 |           socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
  200 |         },
  201 |         binary(bytes: number[]) {
  202 |           const socket = [...sockets].reverse().find(item => item.readyState === 1);
  203 |           if (!socket) throw new Error("No open WebSocket");
  204 |           socket.onmessage?.(new MessageEvent("message", { data: new Uint8Array(bytes).buffer }));
  205 |         },
  206 |       },
  207 |     });
  208 |   });
  209 | }
  210 | 
  211 | async function streamAction(page: Page, action: "open" | "message" | "error" | "count", url: string, payload?: unknown) {
  212 |   return page.evaluate(({ action, url, payload }) => {
  213 |     const api = (window as unknown as { __raceStreams: Record<string, (...args: unknown[]) => unknown> }).__raceStreams;
  214 |     return api[action](url, ...(payload === undefined ? [] : [payload]));
  215 |   }, { action, url, payload });
  216 | }
  217 | 
  218 | async function socketAction(page: Page, action: "message" | "binary", payload: unknown) {
  219 |   await page.evaluate(({ action, payload }) => {
  220 |     const api = (window as unknown as { __raceSocket: Record<string, (value: unknown) => void> }).__raceSocket;
  221 |     api[action](payload);
  222 |   }, { action, payload });
  223 | }
  224 | 
  225 | async function mockCommonApi(page: Page, getMotos: () => Moto[] = () => []) {
  226 |   await page.route("**/api/**", async route => {
  227 |     const url = new URL(route.request().url());
  228 |     if (url.pathname === "/api/events/7") {
  229 |       return route.fulfill({ json: {
  230 |         id: 7,
  231 |         name: "Browser Test National",
  232 |         date: "2026-08-27",
  233 |         status: "race_day",
  234 |         state: "CO",
  235 |         raceClasses: ["Open"],
  236 |         raceStyle: "motocross",
  237 |       } });
  238 |     }
  239 |     if (url.pathname === "/api/events/7/motos") return route.fulfill({ json: getMotos() });
  240 |     if (url.pathname === "/api/events/7/results") return route.fulfill({ json: [] });
  241 |     if (url.pathname === "/api/video/status/7") return route.fulfill({ json: { live: false } });
  242 |     return route.fulfill({ json: [] });
  243 |   });
  244 | }
  245 | 
  246 | async function expectAllTabsUsable(page: Page) {
  247 |   const tablist = page.getByRole("tablist", { name: "Live race views" });
  248 |   await expect(tablist).toBeVisible();
  249 |   for (const name of ["Live Timing", "Quick Analytics", "Fastest Lap"]) {
  250 |     const tab = tablist.getByRole("tab", { name });
  251 |     await expect(tab).toBeVisible();
  252 |     await tab.click();
  253 |     await expect(tab).toHaveAttribute("aria-selected", "true");
  254 |   }
  255 | }
  256 | 
  257 | test("standalone leaderboard covers loading, disconnect, and reconnect", async ({ page }) => {
  258 |   await installRealtimeFakes(page);
  259 |   await mockCommonApi(page);
  260 |   await page.goto("/live/101");
  261 | 
  262 |   await expect(page.getByText("Connecting to timing system…")).toBeVisible();
  263 |   await expect(page.getByText("Reconnecting…")).toBeVisible();
  264 |   await streamAction(page, "open", "/timing/live/101");
  265 |   await streamAction(page, "message", "/timing/live/101", snapshot(101, "Heat 1"));
  266 |   await expect(page.getByText("Live", { exact: true })).toBeVisible();
  267 |   await expect(page.getByText("Heat 1")).toBeVisible();
  268 | 
  269 |   await streamAction(page, "error", "/timing/live/101");
  270 |   await expect(page.getByText("Reconnecting…")).toBeVisible();
  271 |   await expect.poll(() => streamAction(page, "count", "/timing/live/101"), { timeout: 5_000 }).toBe(2);
  272 |   await streamAction(page, "open", "/timing/live/101");
  273 |   await streamAction(page, "message", "/timing/live/101", snapshot(101, "Heat 1"));
  274 |   await expect(page.getByText("Live", { exact: true })).toBeVisible();
  275 |   await expectAllTabsUsable(page);
  276 | });
  277 | 
  278 | test("switching active motos in place clears correction and position-gain state", async ({ page }) => {
  279 |   test.setTimeout(60_000);
  280 |   await installRealtimeFakes(page);
  281 |   let activeMotos = [moto(101, "Heat 1")];
  282 |   await mockCommonApi(page, () => activeMotos);
> 283 |   await page.goto("/results/7");
      |              ^ Error: page.goto: Test timeout of 60000ms exceeded.
  284 |   await streamAction(page, "open", "/timing/live/101");
  285 |   await streamAction(page, "message", "/timing/live/101", snapshot(101, "Heat 1"));
  286 |   await page.evaluate(() => {
  287 |     const nativeSetTimeout = window.setTimeout.bind(window);
  288 |     window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
  289 |       nativeSetTimeout(handler, timeout === 2_000 || timeout === 5_000 ? 60_000 : timeout, ...args)
  290 |     ) as typeof window.setTimeout;
  291 |   });
  292 |   await streamAction(page, "message", "/timing/live/101", snapshot(
  293 |     101,
  294 |     "Heat 1",
  295 |     [rider(22, "Blake Rider", 1), rider(11, "Avery Rider", 2)],
  296 |     true,
  297 |   ));
  298 |   await expect(page.getByText(/Results corrected/)).toBeVisible();
  299 |   await expect(page.locator('[data-rider-id="22"]')).toHaveAttribute("data-position-gain", "true");
  300 | 
  301 |   activeMotos = [moto(202, "Heat 2")];
  302 |   await expect.poll(() => streamAction(page, "count", "/timing/live/202"), { timeout: 35_000 }).toBe(1);
  303 |   await expect(page).toHaveURL(/\/results\/7$/);
  304 |   await expect(page.getByText(/Results corrected/)).toHaveCount(0);
  305 |   await expect(page.locator('[data-position-gain="true"]')).toHaveCount(0);
  306 |   await streamAction(page, "open", "/timing/live/202");
  307 |   await streamAction(page, "message", "/timing/live/202", snapshot(202, "Heat 2"));
  308 |   await expect(page.getByText("Heat 2").first()).toBeVisible();
  309 |   await expect(page.locator('[data-position-gain="true"]')).toHaveCount(0);
  310 | });
  311 | 
  312 | test("Event Results exposes the shared live tabs", async ({ page }) => {
  313 |   await installRealtimeFakes(page);
  314 |   await mockCommonApi(page, () => [moto(101, "Heat 1")]);
  315 |   await page.goto("/results/7");
  316 |   await streamAction(page, "open", "/timing/live/101");
  317 |   await streamAction(page, "message", "/timing/live/101", snapshot(101, "Heat 1"));
  318 |   await expect(page.getByText("Browser Test National")).toBeVisible();
  319 |   await expectAllTabsUsable(page);
  320 |   await expect(await streamAction(page, "count", "/timing/live/101")).toBe(1);
  321 | });
  322 | 
  323 | test("Watch keeps one timing stream while announcements and tabs update", async ({ page }) => {
  324 |   await installRealtimeFakes(page);
  325 |   await mockCommonApi(page, () => [moto(101, "Heat 1")]);
  326 |   await page.goto("/watch/7");
  327 |   await expect.poll(() => page.evaluate(() => document.readyState)).toBe("complete");
  328 |   await socketAction(page, "message", {
  329 |     type: "init",
  330 |     mimeType: 'video/webm; codecs="vp8,opus"',
  331 |     is360: false,
  332 |     isDualFisheye: false,
  333 |   });
  334 |   await socketAction(page, "binary", [0x1a, 0x45, 0xdf, 0xa3]);
  335 |   await expect(page.locator('[data-viewer-state="playing"]')).toBeVisible();
  336 |   await expect.poll(() => streamAction(page, "count", "/timing/live/101")).toBe(1);
  337 |   await expect.poll(() => streamAction(page, "count", "/timing/announcer-live/101")).toBe(1);
  338 |   await streamAction(page, "open", "/timing/live/101");
  339 |   const pageErrors: string[] = [];
  340 |   page.on("pageerror", error => pageErrors.push(error.message));
  341 |   await streamAction(page, "message", "/timing/live/101", {
  342 |     type: "crossing_accepted",
  343 |     motoId: 101,
  344 |     crossingId: 501,
  345 |     lapNumber: 1,
  346 |     lapTimeMs: 59_000,
  347 |     crossingTime: new Date().toISOString(),
  348 |   });
  349 |   await expect(page.locator('[data-viewer-state="playing"]')).toBeVisible();
  350 |   await streamAction(page, "message", "/timing/live/101", snapshot(101, "Heat 1"));
  351 |   await streamAction(page, "message", "/timing/announcer-live/101", {
  352 |     announcement: {
  353 |       sequence: 1,
  354 |       kind: "lap",
  355 |       label: "Blake takes the lead",
  356 |       audioUrl: "/api/test-audio",
  357 |       createdAt: new Date().toISOString(),
  358 |     },
  359 |   });
  360 |   await expect(page.getByText("Blake takes the lead")).toBeVisible();
  361 |   await streamAction(page, "message", "/timing/announcer-live/101", {
  362 |     announcement: {
  363 |       sequence: 2,
  364 |       kind: "time_expired",
  365 |       label: "Time is up — 2 extra laps remaining",
  366 |       audioUrl: "/api/test-audio",
  367 |       createdAt: new Date().toISOString(),
  368 |     },
  369 |   });
  370 |   await expect(page.getByText("Time is up — 2 extra laps remaining")).toBeVisible();
  371 |   await streamAction(page, "message", "/timing/announcer-live/101", {
  372 |     announcement: {
  373 |       sequence: 2,
  374 |       kind: "time_expired",
  375 |       label: "Duplicate time-expired call",
  376 |       audioUrl: "/api/test-audio",
  377 |       createdAt: new Date().toISOString(),
  378 |     },
  379 |   });
  380 |   await expect(page.getByText("Duplicate time-expired call")).toHaveCount(0);
  381 |   await expectAllTabsUsable(page);
  382 |   await expect(await streamAction(page, "count", "/timing/live/101")).toBe(1);
  383 | 
```