import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config for the barcode feature.
 *
 * Both servers are started by Playwright so a run needs no manual setup. The frontend
 * dev server proxies /api to the backend (see frontend/vite.config.js), so the app is
 * same-origin and localhost counts as a secure context — which matters, because
 * getUserMedia and the camera tiers are only reachable there.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.artifacts',
  // Serial: the tests share one database and several of them create and consume stock.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: [
    ['list'],
    ['html', { outputFolder: 'e2e/report', open: 'never' }],
    ['json', { outputFile: 'e2e/report/results.json' }],
  ],

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    // Grant the camera up-front so the live-stream tier can be exercised without a
    // permission prompt blocking the run.
    permissions: ['camera'],
  },

  projects: [
    // Logs in once and saves storage state. /api/auth/login allows only 10 attempts
    // per 15 minutes, so logging in per-test locks the suite out partway through.
    { name: 'setup', testMatch: /auth\.setup\.js/ },
    {
      name: 'desktop',
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        storageState: 'e2e/.auth/admin.json',
        launchOptions: {
          args: [
            // A synthetic camera so the live tier has something to see.
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
          ],
        },
      },
    },
    {
      name: 'mobile',
      testMatch: /mobile\.spec\.js/,
      dependencies: ['setup'],
      use: { ...devices['Pixel 7'], storageState: 'e2e/.auth/admin.json' },
    },
  ],

  webServer: [
    {
      command: 'npm run start',
      cwd: './backend',
      url: 'http://localhost:5000/api/health',
      // The suite logs in once per run, but iterating on tests burns through the
      // production default of 10 logins / 15 min. Raised here only.
      env: { ...process.env, LOGIN_RATE_MAX: '500', API_RATE_MAX: '100000' },
      reuseExistingServer: true,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev',
      cwd: './frontend',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
