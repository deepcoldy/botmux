import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, inject, vi } from 'vitest';
import { fenceHomeRootedEnv } from './helpers/fence-home-env.js';

const inheritedDataDir = process.env.SESSION_DATA_DIR;
const fileRoot = mkdtempSync(join(inject('unitSessionDataRoot'), 'file-'));
const dataDir = join(fileRoot, 'data');
mkdirSync(dataDir);

process.env.SESSION_DATA_DIR = dataDir;

// Fence every unit-test worker inside a disposable home before the test module
// is imported. Bun caches os.homedir() at process startup, so changing HOME via
// vi.stubEnv() alone still points filesystem helpers at the developer's real
// ~/.botmux. Keep children safe through their inherited HOME/USERPROFILE and
// make in-process homedir() follow the current test override, matching Node's
// POSIX behaviour while retaining the USERPROFILE rule on Windows.
const fileHome = join(fileRoot, 'home');
mkdirSync(fileHome);
process.env.HOME = fileHome;
process.env.USERPROFILE = fileHome;

// Same reasoning as the bun fence: BOTS_CONFIG / PM2_HOME are explicit pointers
// at a live home that never go through `homedir()`, and a normal Botmux shell has
// them set to the real fleet.
fenceHomeRootedEnv(fileHome);

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const fencedHome = () => (process.platform === 'win32'
    ? process.env.USERPROFILE || actual.homedir()
    : process.env.HOME || actual.homedir());
  const fenced = {
    ...actual,
    homedir: fencedHome,
    // `userInfo().homedir` is a SECOND route to the home directory that does NOT
    // go through `homedir()` — measured under this very fence: `homedir()`
    // returned the temp home while `userInfo().homedir` still returned `/root`.
    // Four production call sites read it (src/cli.ts, src/worker.ts ×3), so
    // without this the fence leaks on exactly the paths that motivated it. Keep
    // the real uid/username/shell fields (those call sites use them too) and
    // redirect only the home field.
    // Preserve the field's ORIGINAL type: `userInfo({ encoding: 'buffer' })`
    // returns Buffers under Node, so substituting a plain string produced a mixed
    // `username: Buffer, homedir: string` object that no runtime ever returns —
    // and the `as typeof userInfo` cast hid the mismatch.
    userInfo: ((options?: { encoding?: string }) => {
      const info = (actual.userInfo as (o?: unknown) => ReturnType<typeof actual.userInfo>)(options);
      const homedir = Buffer.isBuffer((info as { homedir: unknown }).homedir)
        ? Buffer.from(fencedHome())
        : fencedHome();
      return { ...info, homedir };
    }) as typeof actual.userInfo,
  };
  // Hand the SAME fenced object out as the default export. Under vitest the
  // default binding is separate from the namespace, and spreading `actual` alone
  // carried the REAL module through as `default` — measured: with only the
  // namespace fenced, `import os from 'node:os'; os.homedir()` returned `/root`
  // while the named `homedir()` returned the temp home. Every `import os from
  // 'node:os'` caller would have escaped the fence.
  return { ...fenced, default: fenced };
});

// Same fencing for mojo's per-session isolated workspaces: without this, any
// test that drives a real MojoBackend turn mints directories under the
// developer's real ~/.botmux/mojo-workspaces (observed live). Tests that care
// about the path pass an explicit home instead.
const mojoWorkspaceRoot = join(fileRoot, 'mojo-workspaces');
mkdirSync(mojoWorkspaceRoot);
process.env.BOTMUX_MOJO_WORKSPACE_ROOT = mojoWorkspaceRoot;

// setupFiles runs before the test module. Capture a file-wide temp override made
// at module scope or in beforeAll once, then repair per-test mutations back to it.
let fileDataDir = '';
beforeEach(() => {
  if (!fileDataDir) {
    const candidate = process.env.SESSION_DATA_DIR;
    fileDataDir = candidate && candidate !== inheritedDataDir ? candidate : dataDir;
  }
  process.env.SESSION_DATA_DIR = fileDataDir;
});

afterAll(() => {
  // Keep leaked async work fenced inside the managed root until the worker exits.
  // Restoring the invoking environment here could briefly expose live Botmux data.
  process.env.SESSION_DATA_DIR = dataDir;
  rmSync(fileRoot, { recursive: true, force: true });
});
