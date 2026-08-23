/**
 * NON-LINUX EMULATION PROBE (evidence tooling, not part of `pnpm test`).
 *
 * There is no Darwin machine in this environment, so platform gating cannot be
 * validated on a real Mac. This project runs the normal unit files with
 * process.platform forced to 'darwin' AND every read of the real /proc forced to
 * ENOENT, which is the pair of conditions that made the containment suites fail
 * on macOS. A case that still needs the host's /proc therefore fails loudly here
 * instead of passing silently on Linux.
 *
 * Run:  npx vitest run --config vitest.non-linux-probe.config.ts test/mojo-*.test.ts
 *
 * This is an emulation. Results from it must be reported as
 * "procRoot injection + platform/fs mock, no Darwin hardware".
 */
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    name: 'non-linux-probe',
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e-browser/**', '**/*.e2e.ts', 'node_modules/**'],
    testTimeout: 30_000,
    globalSetup: ['./test/unit-global-setup.ts'],
    setupFiles: ['./test/unit-setup.ts', './test/helpers/non-linux-probe-setup.ts'],
  },
});
