import { expect, test } from "@playwright/test";

test("Add Moto stays usable when the moto list request fails", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", error => pageErrors.push(error));

  await page.route("**/api/**", async route => {
    const { pathname } = new URL(route.request().url());

    if (pathname === "/api/auth/me") {
      return route.fulfill({
        json: {
          id: 1,
          email: "organizer@example.test",
          firstName: "Test",
          lastName: "Organizer",
          role: "club_organizer",
          clubId: 1,
          tourCompleted: true,
          permissions: [],
        },
      });
    }
    if (pathname === "/api/events/7") {
      return route.fulfill({
        json: {
          id: 7,
          name: "Browser Test National",
          date: "2026-08-27",
          status: "race_day",
          state: "CO",
          raceClasses: ["Open"],
          raceStyle: "motocross",
        },
      });
    }
    if (pathname === "/api/events/7/motos") {
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Moto list unavailable" }),
      });
    }

    return route.fulfill({ json: [] });
  });

  await page.goto("/events/7/schedule");
  await page.getByRole("button", { name: "Add Moto" }).click();

  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add Moto" })).toBeVisible();
  await page.waitForTimeout(250);
  expect(pageErrors).toEqual([]);
});