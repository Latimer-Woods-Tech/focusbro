import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./vitest.setup.js'],
    testTimeout: 10000,
    // Only unit tests under src; the Playwright smoke lives in e2e/ (run via
    // `npm run test:smoke`) and must not be collected by vitest.
    include: ['src/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.js'],
      // Exclude tests, the generated HTML bundle, and dead code so the floor
      // reflects real hand-written coverage.
      exclude: [
        'src/**/*.test.js',
        'src/__tests__/**',
        'src/html.js',
        'src/html.js.bak.initGallery'
      ],
      // Ratcheting floor: set just below the current Vitest 4/V8 result so
      // regressions fail CI. Vitest 4's AST-aware V8 remapping counts branches
      // differently from Vitest 1 (68.28% vs 82.47% on the same commit/tests);
      // this is a reporting-baseline reset, not deleted coverage.
      thresholds: {
        statements: 62,
        branches: 68,
        functions: 65,
        lines: 62
      }
    }
  }
});
