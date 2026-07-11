import { defineConfig, devices } from '@playwright/test';

// Client-side smoke: serve the built html.js and drive it in a mobile Chromium.
// Runs per-PR so a broken handler / regression (e.g. the timer-first change) fails
// CI before it ships — the browser verification that unit tests can't give.
export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  fullyParallel: false,
  reporter: 'line',
  use: {
    baseURL: 'http://localhost:4173',
    ...devices['Pixel 5'],
  },
  webServer: {
    command: 'node e2e/serve.mjs',
    url: 'http://localhost:4173/',
    reuseExistingServer: !process.env.CI,
    timeout: 20000,
  },
});
