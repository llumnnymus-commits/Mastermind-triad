import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Materializing workspaces and running real builds is slower than a unit
    // test; the default 5s timeout fails them for being honest.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    exclude: ['**/node_modules/**', '**/dist/**', 'test/fixture-project/**'],
  },
});
