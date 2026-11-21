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
 * Imports nothing: the importing file may mock node:fs, node:os or node:path
 * (vi.mock is hoisted above this import), so the check is plain string work on
 * two env vars the fence itself sets.
 */

/** `child` is strictly inside the absolute directory `root` (no `..` segments). */
export function isInsideDir(child: string | undefined, root: string | undefined): boolean {
  if (!child || !root) return false;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const c = norm(child);
  const r = norm(root);
  if (!r.startsWith('/') && !/^[A-Za-z]:\//.test(r)) return false;
  if (c.split('/').includes('..') || r.split('/').includes('..')) return false;
  return c.startsWith(`${r}/`);
}

/**
 * The fence (unit-setup.ts / bun-test-fence.ts) publishes its disposable root in
 * __TEST_DATA_DIR_FENCE. Requiring SESSION_DATA_DIR to sit inside THAT root —
 * not merely somewhere under a temp dir — rejects a hand-picked data dir from a
 * run where the fence never executed (HOME and friends would still be real).
 */
export function fencedTestDataDirProblem(env: NodeJS.ProcessEnv): string | undefined {
  if (isInsideDir(env.SESSION_DATA_DIR, env.__TEST_DATA_DIR_FENCE)) return undefined;
  return `refusing to run: data-dir fence not active (__TEST_DATA_DIR_FENCE=${env.__TEST_DATA_DIR_FENCE ?? '<unset>'}, `
    + `SESSION_DATA_DIR=${env.SESSION_DATA_DIR ?? '<unset>'}). `
    + 'This file fakes node:fs and must run behind the data-dir fence '
    + '(vitest --project unit / bun test from the repo root), never against live botmux data.';
}

const problem = fencedTestDataDirProblem(process.env);
if (problem) throw new Error(problem);
