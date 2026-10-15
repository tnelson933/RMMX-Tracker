# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: live-race-tabs.spec.ts >> standalone leaderboard ignores crossing acknowledgements until the next snapshot
- Location: tests/browser/live-race-tabs.spec.ts:391:1

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: page.goto: Test timeout of 30000ms exceeded.
Call log:
  - navigating to "http://127.0.0.1:4174/live/101", waiting until "load"

```

# Test source

```ts
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
  384 |   const video = page.locator("video");
  385 |   await expect(video).toBeVisible();
  386 |   const box = await video.boundingBox();
  387 |   expect(box?.height ?? 0).toBeGreaterThan(100);
  388 |   expect(pageErrors).toEqual([]);
  389 | });
  390 | 
  391 | test("standalone leaderboard ignores crossing acknowledgements until the next snapshot", async ({ page }) => {
  392 |   await installRealtimeFakes(page);
  393 |   await mockCommonApi(page);
  394 |   const pageErrors: string[] = [];
  395 |   page.on("pageerror", error => pageErrors.push(error.message));
> 396 |   await page.goto("/live/101");
      |              ^ Error: page.goto: Test timeout of 30000ms exceeded.
  397 |   await streamAction(page, "open", "/timing/live/101");
  398 |   await streamAction(page, "message", "/timing/live/101", snapshot(101, "Heat 1"));
  399 |   await streamAction(page, "message", "/timing/live/101", {
  400 |     type: "crossing_accepted",
  401 |     motoId: 101,
  402 |     crossingId: 502,
  403 |     lapNumber: 2,
  404 |     lapTimeMs: 58_500,
  405 |     crossingTime: new Date().toISOString(),
  406 |   });
  407 |   await expect(page.getByText("Heat 1")).toBeVisible();
  408 |   await expect(page.locator('[data-rider-id="11"]')).toBeVisible();
  409 |   expect(pageErrors).toEqual([]);
  410 | });
```