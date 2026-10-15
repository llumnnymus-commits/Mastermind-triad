import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The fixture tree contains a file that looks like a test because that is
    // exactly what the adapter is being asked to recognize. It is input, not a
    // suite to run.
    exclude: ['**/node_modules/**', '**/dist/**', 'test/fixture-project/**'],
  },
});
