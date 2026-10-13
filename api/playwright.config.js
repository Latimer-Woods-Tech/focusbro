import { defineConfig, devices } from '@playwright/test';
import { smokeTarget } from './e2e/target.mjs';

// Client-side smoke: serve the built html.js and drive it in a mobile Chromium.
// Runs per-PR so a broken handler / regression (e.g. the timer-first change) fails
// CI before it ships — the browser verification that unit tests can't give.
//
// BASE_URL=https://staging.focusbro.net points the same smoke at a deployed host
// (the staging deploy job does this); unset, it serves html.js locally as before.
// See e2e/target.mjs and src/__tests__/smoke-target.test.js.
const target = smokeTarget(process.env);

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  fullyParallel: false,
  reporter: 'line',
  use: {
    baseURL: target.baseURL,
    ...devices['Pixel 5'],
  },
  ...(target.webServer ? { webServer: target.webServer } : {}),
});
