import { defineConfig } from 'vitest/config';

/**
 * Two projects, two execution profiles:
 *
 *   unit  — *.test.ts. Pure, filesystem-mocked (memfs) or temp-dir-isolated.
 *           Runs with file parallelism ON (forks pool, one process per file),
 *           which is safe: port-binding tests use listen(0), and process.env /
 *           process.chdir mutations are isolated per fork. `pnpm test` runs
 *           ONLY this project, so the default test command is fast and needs no
 *           real CLI binaries or browser.
 *
 *   e2e   — *.e2e.ts. Spawns real CLIs (claude/codex/…) and drives the Feishu
 *           web UI via a shared daemon + single logged-in browser session, so
 *           the files MUST run sequentially (fileParallelism: false) to avoid
 *           interfering with each other. Opt-in only — see the `test:*` scripts
 *           in package.json. globalSetup sweeps stale botmux schedule tasks when
 *           BOTMUX_E2E=1 (set by scripts/run-e2e.ts).
 *
 * Run everything: `vitest run` (both projects). Default `pnpm test` scopes to
 * `--project unit`.
 */
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 360_000,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.{test,spec}.ts'],
          // Belt-and-suspenders: *.test.ts never matches *.e2e.ts, but keep the
          // e2e dir out explicitly so a stray *.test.ts there can't sneak in.
          exclude: ['test/e2e-browser/**', '**/*.e2e.ts', 'node_modules/**'],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/**/*.e2e.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 360_000,
          globalSetup: ['./test/global-setup.ts'],
        },
      },
    ],
  },
});
