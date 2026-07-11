import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./vitest.setup.js'],
    testTimeout: 10000,
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
        'src/html.js.bak.initGallery',
        'src/extended-routes.js'
      ],
      // Ratcheting floor: set just below current so regressions fail CI.
      // Raise these as coverage improves. Current (post-exclude) baseline noted
      // in the PR.
      thresholds: {
        statements: 62,
        branches: 79,
        functions: 65,
        lines: 62
      }
    }
  }
});
