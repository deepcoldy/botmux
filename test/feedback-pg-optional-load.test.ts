import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

// K1-style module-graph guard for the optional PostgreSQL dependency. The
// daemon and `botmux send` statically import the feedback maintenance/store
// modules on every startup, so those modules must not transitively value-import
// `pg` — otherwise a SQLite-only install (node_modules without pg, e.g. a
// checkout that deployed new dist without re-running `bun install`) crashes at
// module load before any try/catch can fail soft. The guard uses a real Node
// resolve hook that makes `pg` unresolvable and then loads the actual modules.
const here = dirname(fileURLToPath(import.meta.url));
const child = join(here, 'helpers', 'feedback-pg-optional-child.ts');
const registerHook = join(here, 'helpers', 'register-block-pg.mjs');

describe('feedback hot path without the optional pg dependency', () => {
  // Custom resolve hooks are a Node ESM-loader feature; the bun production leg
  // is verified the same way manually (bun dist/cli.js with pg removed) and by
  // the bun-binary smoke matrix, which bundles pg.
  it.skipIf(!!process.versions.bun)('daemon/send modules load when pg cannot be resolved', async () => {
    const processRef = spawnNodeTsScript(child, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // nodeTsRunnerPrefix supplies ['--import','tsx']; add the pg-block hook.
      env: { ...process.env, NODE_OPTIONS: `--import ${registerHook}` },
    });
    let stdout = '';
    let stderr = '';
    processRef.stdout!.on('data', chunk => { stdout += chunk; });
    processRef.stderr!.on('data', chunk => { stderr += chunk; });
    const code = await new Promise<number | null>(resolve => processRef.on('exit', exitCode => resolve(exitCode)));
    expect({ code, stdout: stdout.trim(), stderr: stderr.slice(-400) }).toMatchObject({
      code: 0, stdout: 'feedback hot path loads without pg',
    });
  });
});
