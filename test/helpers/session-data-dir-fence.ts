import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach } from 'vitest';

/**
 * The botmux-data half of the test fences (vitest `unit` and `e2e` setup files):
 * gives this test file its own disposable SESSION_DATA_DIR (plus the mojo
 * workspace root, the other botmux-owned state outside HOME-derived paths) so
 * nothing a test does reaches the developer's live ~/.botmux/data.
 *
 * Must run from a vitest setupFile, i.e. before the test module is imported.
 * Publishes the root in __TEST_DATA_DIR_FENCE for
 * test/helpers/require-fenced-data-dir.ts.
 */
export function installSessionDataDirFence(parentRoot: string, prefix: string): { fileRoot: string; dataDir: string } {
  const inheritedDataDir = process.env.SESSION_DATA_DIR;
  const fileRoot = mkdtempSync(join(parentRoot, prefix));
  const dataDir = join(fileRoot, 'data');
  mkdirSync(dataDir);

  process.env.SESSION_DATA_DIR = dataDir;
  // Proof for test/helpers/require-fenced-data-dir.ts that this fence ran in this
  // process: SESSION_DATA_DIR must sit inside this exact root (a temp-looking
  // SESSION_DATA_DIR alone is not proof).
  process.env.__TEST_DATA_DIR_FENCE = fileRoot;

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
    // A debug terminal's bash may still be exiting and writing history after
    // shutdown; retry the disposable tree if removal races that final write.
    rmSync(fileRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  return { fileRoot, dataDir };
}
