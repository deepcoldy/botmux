import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.{test,spec,e2e}.ts'],
    testTimeout: 60_000,
    hookTimeout: 360_000,
    fileParallelism: false,
  },
});
