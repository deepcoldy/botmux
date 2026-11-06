/**
 * Fail fast when a test file that fakes the filesystem runs without the
 * data-dir fence (test/unit-setup.ts under vitest, test/bun-test-fence.ts
 * under bun test).
 *
 * Why a per-file guard: the fences are wired through vitest.config.ts
 * `setupFiles` and bunfig.toml `preload`. A run that bypasses them — e.g.
 * `vitest run --config <hand-written config>` where the config came out empty —
 * silently falls back to the inherited `SESSION_DATA_DIR=~/.botmux/data`.
 * 2026-11-06: exactly such a run executed test/event-dispatcher.test.ts, whose
 * mocked `readFileSync` returns '[]' for every path while `renameSync` stays
 * real; the VC runtime store read '[]', judged it corrupt and renamed the live
 * fleet's `vc-meeting-runtime-sessions.json` aside. Importing this module first
 * turns that into an immediate, harmless failure.
 *
 * Uses only node:path/node:os (never node:fs) so it stays correct even when the
 * importing file mocks node:fs.
 */
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

export function isFencedTestDataDir(dataDir: string | undefined, tempRoot: string): boolean {
  if (!dataDir) return false;
  const rel = relative(resolve(tempRoot), resolve(dataDir));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// __TEST_DATA_DIR_FENCE is set by the fence itself (unit-setup.ts / bun-test-fence.ts):
// a hand-picked temp SESSION_DATA_DIR without the fence still leaves HOME and
// friends pointing at the real machine, so the path check alone is not enough.
export function fencedTestDataDirProblem(env: NodeJS.ProcessEnv, tempRoot: string): string | undefined {
  if (env.__TEST_DATA_DIR_FENCE === '1' && isFencedTestDataDir(env.SESSION_DATA_DIR, tempRoot)) return undefined;
  return `refusing to run: data-dir fence not active (__TEST_DATA_DIR_FENCE=${env.__TEST_DATA_DIR_FENCE ?? '<unset>'}, `
    + `SESSION_DATA_DIR=${env.SESSION_DATA_DIR ?? '<unset>'}, expected under ${tempRoot}). `
    + 'This file fakes node:fs and must run behind the data-dir fence '
    + '(vitest --project unit / bun test from the repo root), never against live botmux data.';
}

const problem = fencedTestDataDirProblem(process.env, tmpdir());
if (problem) throw new Error(problem);
