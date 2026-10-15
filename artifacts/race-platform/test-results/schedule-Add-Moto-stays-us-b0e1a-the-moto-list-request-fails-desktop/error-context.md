# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: schedule.spec.ts >> Add Moto stays usable when the moto list request fails
- Location: tests/browser/schedule.spec.ts:3:1

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: page.goto: Test timeout of 30000ms exceeded.
Call log:
  - navigating to "http://127.0.0.1:4174/events/7/schedule", waiting until "load"

```

# Test source

```ts
  1  | import { expect, test } from "@playwright/test";
  2  | 
  3  | test("Add Moto stays usable when the moto list request fails", async ({ page }) => {
  4  |   const pageErrors: Error[] = [];
  5  |   page.on("pageerror", error => pageErrors.push(error));
  6  | 
  7  |   await page.route("**/api/**", async route => {
  8  |     const { pathname } = new URL(route.request().url());
  9  | 
  10 |     if (pathname === "/api/auth/me") {
  11 |       return route.fulfill({
  12 |         json: {
  13 |           id: 1,
  14 |           email: "organizer@example.test",
  15 |           firstName: "Test",
  16 |           lastName: "Organizer",
  17 |           role: "club_organizer",
  18 |           clubId: 1,
  19 |           tourCompleted: true,
  20 |           permissions: [],
  21 |         },
  22 |       });
  23 |     }
  24 |     if (pathname === "/api/events/7") {
  25 |       return route.fulfill({
  26 |         json: {
  27 |           id: 7,
  28 |           name: "Browser Test National",
  29 |           date: "2026-08-27",
  30 |           status: "race_day",
  31 |           state: "CO",
  32 |           raceClasses: ["Open"],
  33 |           raceStyle: "motocross",
  34 |         },
  35 |       });
  36 |     }
  37 |     if (pathname === "/api/events/7/motos") {
  38 |       return route.fulfill({
  39 |         status: 500,
  40 |         contentType: "application/json",
  41 |         body: JSON.stringify({ error: "Moto list unavailable" }),
  42 |       });
  43 |     }
  44 | 
  45 |     return route.fulfill({ json: [] });
  46 |   });
  47 | 
> 48 |   await page.goto("/events/7/schedule");
     |              ^ Error: page.goto: Test timeout of 30000ms exceeded.
  49 |   await page.getByRole("button", { name: "Add Moto" }).click();
  50 | 
  51 |   await expect(page.getByRole("dialog")).toBeVisible();
  52 |   await expect(page.getByRole("heading", { name: "Add Moto" })).toBeVisible();
  53 |   await page.waitForTimeout(250);
  54 |   expect(pageErrors).toEqual([]);
  55 | });
```