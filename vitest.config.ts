import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.{test,spec,e2e}.ts'],
    testTimeout: 60_000,
  },
});
