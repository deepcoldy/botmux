import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/**/*.{test,spec,e2e}.ts',
      'src/**/__tests__/**/*.{test,spec}.ts',
    ],
    testTimeout: 60_000,
  },
});
