/**
 * Real network-policy sandbox launch (unshare + slirp4netns + bwrap) with a
 * fake `traex` leaf: the TRAE ownership resolver must find the leaf through the
 * whole chain. Mounts and namespaces are created, so the launch runs inside a
 * private mount + PID namespace (see helpers/private-mount-ns.ts); run this file
 * under isolate-run on a dev host. Imports the BUILT tree: the network runner is
 * re-exec'd from dist, as in production (`bun run build` first).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { lastJsonLine, privateMountNsAvailable, runInPrivateMountNs } from './helpers/private-mount-ns.js';

const toolsPresent = process.platform === 'linux'
  && spawnSync('sh', ['-c', 'command -v slirp4netns && command -v nft && command -v unshare && command -v ip'], { stdio: 'ignore' }).status === 0;
const runtime = toolsPresent && existsSync('dist/sandbox-network-runner.js') && privateMountNsAvailable();

describe.skipIf(!runtime)('TRAE leaf pid under a real network-policy sandbox', () => {
  const base = mkdtempSync(join(tmpdir(), 'traex-leaf-real-'));
  afterAll(() => { rmSync(base, { recursive: true, force: true }); });

  it('resolves the traex leaf that the generic 6-level search cannot reach', () => {
    const binDir = join(base, 'bin');
    const work = join(base, 'work');
    spawnSync('mkdir', ['-p', binDir, work]);
    const fake = join(binDir, 'traex');
    writeFileSync(fake, '#!/bin/sh\nwhile :; do sleep 1; done\n');
    chmodSync(fake, 0o755);
    const run = runInPrivateMountNs(`
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { prepareDirectSandbox } from './dist/adapters/backend/sandbox.js';
import { findLaunchedCliPid, readComm } from './dist/core/session-discovery.js';
import { findTraexLeafPid } from './dist/core/traex-leaf-pid.js';
const work = ${JSON.stringify(work)};
const paths = ['/usr', '/etc', '/bin', '/lib', '/lib64', dirname(realpathSync(process.execPath)), ${JSON.stringify(binDir)}, work];
const sbx = prepareDirectSandbox({ sessionId: 'traex-leaf-' + process.pid, dataDir: work,
  networkPolicy: { version: 1, public: { mode: 'allow' }, private: { mode: 'allow' } },
  policy: { net: true, writeRegexes: [], rules: [...new Set(paths)].map(path => ({ path, access: path === work ? 'readWrite' : 'readOnly', source: 'baseline' })) },
  chdir: work, home: work, cliBin: ${JSON.stringify(fake)}, cliArgs: [] });
if (!sbx) throw new Error('sandbox setup failed');
// The session-scope supervisor sh a real pane has in front of the payload.
const pane = spawn('/bin/sh', ['-c', '"$@"; exit $?', 'scope', sbx.bin, ...sbx.args], { env: { ...process.env, ...sbx.env }, stdio: ['pipe', 'ignore', 'inherit'] });
let leaf = null;
for (let i = 0; i < 120 && leaf === null; i++) {
  await new Promise(resolve => setTimeout(resolve, 250));
  leaf = findTraexLeafPid(pane.pid);
}
console.log(JSON.stringify({ leaf, leafComm: leaf ? readComm(leaf) : null, generic: findLaunchedCliPid(pane.pid, 'traex') }));
pane.kill('SIGKILL');
sbx.cleanup();
process.exit(0);
`, { timeoutMs: 90_000 });
    const result = lastJsonLine<{ leaf: number | null; leafComm: string | null; generic: number | null }>(run);
    expect(result.leafComm, run.stderr).toBe('traex');
    // The chain really is deeper than the generic wrapper search reaches.
    expect(result.generic).toBeNull();
  }, 120_000);
});
