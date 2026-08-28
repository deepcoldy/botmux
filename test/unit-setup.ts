import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, inject } from 'vitest';

const inheritedDataDir = process.env.SESSION_DATA_DIR;
const fileRoot = mkdtempSync(join(inject('unitSessionDataRoot'), 'file-'));
const dataDir = join(fileRoot, 'data');
mkdirSync(dataDir);

process.env.SESSION_DATA_DIR = dataDir;

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
