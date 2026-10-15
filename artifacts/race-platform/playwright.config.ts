import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4174",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "phone", use: { ...devices["iPhone 13"], browserName: "chromium" } },
  ],
  webServer: {
    command: "pnpm run dev",
    cwd: process.cwd(),
    env: { PORT: "4174", BASE_PATH: "/" },
    port: 4174,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});