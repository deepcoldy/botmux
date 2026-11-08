import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { selectShard } from './scripts/duration-shards.mjs';
import { gateVitestRun, resolveTestConcurrency } from './scripts/test-concurrency.mjs';

/**
 * 本机整机并发闸 + 默认 worker 数（scripts/test-concurrency.mjs）。CI 上为
 * `{ maxWorkers: undefined, gated: false }`，行为与之前一致。
 */
const concurrency = resolveTestConcurrency();

/**
 * `--shard=i/N` (CI's unit matrix) splits by recorded duration instead of
 * vitest's equal-file-count hash split; see scripts/duration-shards.mjs. Only
 * the shard selection changes — ordering within a shard stays vitest's own.
 */
class DurationShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    return selectShard(files, this.ctx.config);
  }

  // 排序发生在任何测试文件启动之前，且拿得到本次真正要跑的文件数（分片之后）：
  // 大批量运行在这里排队等整机名额。
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    await gateVitestRun(files.length, concurrency);
    return super.sort(files);
  }
}

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
 *   e2e   — CLI-focused *.e2e.ts files. Feishu browser scenarios under
 *           test/e2e-browser are registered with @midscene/test instead and are
 *           deliberately excluded from Vitest.
 *
 * Run everything: `vitest run` (both projects). Default `pnpm test` scopes to
 * `--project unit`.
 */
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 360_000,
    // Root-level on purpose: vitest builds one sequencer for the whole run.
    sequence: { sequencer: DurationShardSequencer },
    ...(concurrency.maxWorkers !== undefined ? { maxWorkers: concurrency.maxWorkers } : {}),
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.{test,spec}.ts'],
          // Belt-and-suspenders: *.test.ts never matches *.e2e.ts, but keep the
          // e2e dir out explicitly so a stray *.test.ts there can't sneak in.
          exclude: ['test/e2e-browser/**', '**/*.e2e.ts', 'node_modules/**'],
          testTimeout: 30_000,
          // Hooks must get the same ceiling as test bodies. Several unit tests
          // spin up / tear down a REAL private tmux server in beforeEach/
          // afterEach (tmux-pipe-exit-code, tmux-pipe-backend-retire,
          // orphan-tmux-reaper, session-env-backends, kill-worker-orphaned-
          // backend, …); on a scheduler-starved shard that hook work can run
          // past vitest's 10s hook default even though the bodies are allowed
          // 30s. Without this, setup teardown dies at 10s while the same work
          // inside a test would pass (observed as "Hook timed out in 10000ms"
          // on master CI). This does not mask real failures: tests still assert
          // concrete outcomes and keep their own shorter internal deadlines.
          hookTimeout: 30_000,
          globalSetup: ['./test/unit-global-setup.ts', './test/tmux-fence-global-setup.ts'],
          setupFiles: ['./test/tmux-fence-setup.ts', './test/unit-setup.ts'],
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/**/*.e2e.ts'],
          exclude: ['test/e2e-browser/**', 'node_modules/**'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 360_000,
          // unit-global-setup.ts provides the disposable root that e2e-setup.ts
          // carves each file's SESSION_DATA_DIR from (same as the unit project).
          globalSetup: ['./test/global-setup.ts', './test/unit-global-setup.ts', './test/tmux-fence-global-setup.ts'],
          // No test may reach the host's tmux servers (test/helpers/tmux-fence.ts),
          // nor the live botmux data directory (test/e2e-setup.ts).
          setupFiles: ['./test/tmux-fence-setup.ts', './test/e2e-setup.ts'],
        },
      },
    ],
  },
});
