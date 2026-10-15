import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These spawn the built CLI against a real fixture project: real ingest,
    // real mirror, real build. Slower than a unit test and worth it — the CLI
    // is the surface people actually use, and its argument handling and exit
    // codes are only real in a subprocess.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    exclude: ['**/node_modules/**', '**/dist/**', 'test/fixture/**'],
  },
});
