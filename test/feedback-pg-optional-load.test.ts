import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

// K1-style module-graph guard for the optional PostgreSQL dependency, run
// against the BUILT dist. The daemon, dashboard and `botmux send` statically
// import the feedback subsystem on every startup, and the default SQLite
// backend must fully work even when `pg` is not installed: importing the
// modules is necessary but not sufficient, so the child really opens storage,
// writes a delivery + terminal and reads the reconciled event back. A static
// `import ... from 'pg'` anywhere on that path (load-time OR a stray dynamic
// import on the SQLite branch) makes this red.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const distDir = resolve(repoRoot, 'dist');
const child = join(here, 'helpers', 'feedback-pg-optional-dist-child.mjs');
const registerHook = join(here, 'helpers', 'register-block-pg.mjs');

describe('feedback default backend without the optional pg dependency (built dist)', () => {
  it.skipIf(!!process.versions.bun || !existsSync(resolve(distDir, 'cli.js')))('SQLite hot path reads and writes with pg unresolvable', async () => {
    const processRef = spawnNodeTsScript(child, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BOTMUX_DIST_DIR: distDir, NODE_OPTIONS: `--import ${registerHook}` },
    });
    let stdout = '';
    let stderr = '';
    processRef.stdout!.on('data', chunk => { stdout += chunk; });
    processRef.stderr!.on('data', chunk => { stderr += chunk; });
    const code = await new Promise<number | null>(exitResolve => processRef.on('exit', exitCode => exitResolve(exitCode)));
    expect({ code, stdout: stdout.trim(), stderr: stderr.slice(-500) }).toMatchObject({
      code: 0, stdout: 'dist sqlite hot path reads and writes without pg',
    });
  });
});
