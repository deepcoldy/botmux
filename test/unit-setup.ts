import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, inject, vi } from 'vitest';
import { fenceHomeRootedEnv } from './helpers/fence-home-env.js';
import { installSessionDataDirFence } from './helpers/session-data-dir-fence.js';
import { installSystemdFence, systemdFenceError, takeSystemdFenceViolations } from './helpers/systemd-fence.js';

// Disposable SESSION_DATA_DIR / mojo workspace root for this file (shared with
// the e2e project's setup file).
const { fileRoot } = installSessionDataDirFence(inject('testSessionDataRoot'), 'file-');

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

// No test may reach the host's systemd (test/helpers/systemd-fence.ts). A call
// the code under test caught still fails the test that made it.
installSystemdFence(fileRoot);
const failOnSystemdFenceViolations = (): void => {
  const attempts = takeSystemdFenceViolations();
  if (attempts.length > 0) throw systemdFenceError(attempts);
};
afterEach(failOnSystemdFenceViolations);
afterAll(failOnSystemdFenceViolations);

// A React test can return before a lazily imported component it rendered has
// loaded (the dashboard's DropdownMenu imports its Base UI implementation on
// first render). React then retries the suspended tree outside act() and logs
// "A suspended resource finished loading inside a test…". When that lands after
// the file's last test, Vitest is already closing the worker RPC and fails a
// green run with EnvironmentTeardownError ("Closing rpc while
// onUserConsoleLog was pending"). So in act environments a test ends only after
// its in-flight dynamic imports have settled, inside act() so the retry render
// is flushed there too.
afterEach(async () => {
  if ((globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT !== true) return;
  const { act } = await import('react');
  await act(() => vi.dynamicImportSettled());
});

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
