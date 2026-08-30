import { afterAll, beforeEach, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as realOs from 'node:os';
import { fenceHomeRootedEnv } from './helpers/fence-home-env.js';

/**
 * `bun test` counterpart of `test/unit-setup.ts`.
 *
 * WHY A SEPARATE FILE: the vitest fence is mounted through
 * `vitest.config.ts` → `setupFiles`, which `bun test` never reads. Nothing else
 * fences the home directory, and every `~/.botmux` path in `src/` is a hardcoded
 * `join(homedir(), '.botmux', …)` with no env indirection (210 `homedir()` call
 * sites across 111 files) — so an unfenced run writes straight into the
 * developer's real home. That is not hypothetical: a `bun test` run overwrote a
 * live `~/.botmux/config.json` with this repo's own test fixture, dropping
 * `remoteAccess` and silently turning central-platform links back to localhost.
 * The blast radius is wider than `~/.botmux`: `src/` also derives `~/.claude`,
 * `~/.claude.json`, `~/.codex`, `~/.gemini`, `~/.dsh`, `~/.pm2` and more, so an
 * unfenced run can corrupt the user's OTHER CLI configs too.
 *
 * WHY `mock.module` AND NOT JUST `process.env.HOME`: Bun snapshots
 * `os.homedir()` before any JS runs, so assigning `process.env.HOME` here does
 * NOT move `homedir()` in this process (measured — a preload that only sets the
 * env still resolves to the real home). Overriding the module is what actually
 * redirects in-process callers. The env assignment is still required: child
 * processes inherit it and snapshot the fenced value at their own startup.
 *
 * Keep the mocked `homedir()` reading `process.env` on every call (not a
 * captured constant) so a test that legitimately re-points HOME still works, and
 * keep the win32 USERPROFILE rule so the override matches Node's POSIX
 * behaviour rather than inventing a third semantic.
 */

const inheritedDataDir = process.env.SESSION_DATA_DIR;

// One disposable root per test PROCESS — note that `bun test` runs every file
// it was given in a single process (measured: two files report the same
// `process.pid`), unlike vitest which forks a worker per file. So this root is
// shared by the whole invocation rather than per-file. That is fine for the
// purpose here (keeping writes out of the real home) but it means `afterAll`
// below fires once at the end, not between files. `bun test` also has no
// globalSetup hook to hand a shared parent down (vitest uses
// `unit-global-setup.ts` for that), so the root is minted here, under the real
// tmpdir — captured from the unmocked module before the override is installed.
const fileRoot = mkdtempSync(join(realOs.tmpdir(), 'botmux-bun-unit-'));

const dataDir = join(fileRoot, 'data');
mkdirSync(dataDir);
process.env.SESSION_DATA_DIR = dataDir;

const fileHome = join(fileRoot, 'home');
mkdirSync(fileHome);
process.env.HOME = fileHome;
process.env.USERPROFILE = fileHome;

// HOME alone is not enough: BOTS_CONFIG / PM2_HOME and friends point straight at
// a live home and bypass `homedir()` entirely (bot-registry treats BOTS_CONFIG as
// the top of its chain). Redirect them into the fenced tree.
fenceHomeRootedEnv(fileHome);

// Bind the real implementations BEFORE installing the override. Reading them off
// the namespace object inside the factory resolves back through the mocked
// module, so `realOs.userInfo` would call the replacement and recurse forever
// (measured: "Maximum call stack size exceeded").
const actualUserInfo = realOs.userInfo;
const actualHomedir = realOs.homedir;

// Build the fenced surface ONCE, then hand the SAME object out as both the
// namespace and the default export. Pointing `default` at the unfenced `realOs`
// (an earlier shape here) contradicted the intent: a `import os from 'node:os'`
// caller would read the real implementation. Measured on Bun 1.4.0 the default
// import happens to resolve to the namespace anyway, so nothing in `src/` was
// actually escaping — but relying on that is relying on a resolution detail, and
// the code said one thing while meaning another. Now both routes are the fenced
// object by construction.
const fencedOs = {
  ...realOs,
  homedir: () => (process.platform === 'win32'
    ? process.env.USERPROFILE || actualHomedir()
    : process.env.HOME || actualHomedir()),
  // `userInfo().homedir` is a SECOND route to the home directory and it does not
  // go through `homedir()` — measured: with only `homedir` overridden,
  // `userInfo().homedir` still returned the real `/root`. Four production call
  // sites read it (src/cli.ts, src/worker.ts ×3), so leaving it unfenced would
  // let those paths write outside the fence. Keep the real uid/username/shell
  // fields intact and redirect only the home field.
  // Preserve the field's ORIGINAL type. `userInfo({ encoding: 'buffer' })` returns
  // Buffers for username/homedir/shell (Node does; Bun 1.4 returns strings for
  // both overloads), so replacing `homedir` with a plain string produced a mixed
  // `username: Buffer, homedir: string` object — a shape neither runtime ever
  // returns, hidden by the `as typeof userInfo` cast. Mirror whatever the real call
  // gave back.
  userInfo: ((options?: { encoding?: string }) => {
    const info = (actualUserInfo as (o?: unknown) => ReturnType<typeof realOs.userInfo>)(options);
    const fenced = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
    if (!fenced) return info;
    const homedir = Buffer.isBuffer((info as { homedir: unknown }).homedir)
      ? Buffer.from(fenced)
      : fenced;
    return { ...info, homedir };
  }) as typeof realOs.userInfo,
};

mock.module('node:os', () => ({ ...fencedOs, default: fencedOs }));

// Mirrors the vitest fence: mojo mints per-session workspaces under the real
// `~/.botmux/mojo-workspaces` unless redirected (observed live before the vitest
// side was fenced). Tests that assert the path pass an explicit home instead.
const mojoWorkspaceRoot = join(fileRoot, 'mojo-workspaces');
mkdirSync(mojoWorkspaceRoot);
process.env.BOTMUX_MOJO_WORKSPACE_ROOT = mojoWorkspaceRoot;

// A preload runs before the test module, so a file-wide override made at module
// scope or in beforeAll must be captured once and then repaired per test.
let fileDataDir = '';
beforeEach(() => {
  if (!fileDataDir) {
    const candidate = process.env.SESSION_DATA_DIR;
    fileDataDir = candidate && candidate !== inheritedDataDir ? candidate : dataDir;
  }
  process.env.SESSION_DATA_DIR = fileDataDir;
});

afterAll(() => {
  // Keep leaked async work fenced inside the managed root until the process
  // exits; restoring the invoking environment here could briefly re-expose live
  // Botmux data to a straggling write.
  process.env.SESSION_DATA_DIR = dataDir;
  rmSync(fileRoot, { recursive: true, force: true });
});
