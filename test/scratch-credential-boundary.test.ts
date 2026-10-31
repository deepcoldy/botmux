/**
 * Credential masks hold for files the host creates AFTER a scratch session
 * started: the overlay's lower layer is the live host, so a mask computed from
 * a spawn-time listing would miss them. Real mounts, real bwrap container, all
 * inside a private mount + PID namespace (helpers/private-mount-ns.ts). Root
 * only; everything else skips.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lastJsonLine, privateMountNsAvailable, runInPrivateMountNs } from './helpers/private-mount-ns.js';

const runtime = privateMountNsAvailable();

// Outside /tmp (container-owned in scratch); a namespace-private tmpfs on top.
const bases: string[] = [];
function freshBase(): string {
  const base = mkdtempSync(join(resolve('.'), '.scratch-cred-'));
  bases.push(base);
  return base;
}
afterEach(() => {
  for (const base of bases.splice(0)) rmdirSync(base);
});

describe.skipIf(!runtime)('scratch credential masks (real container, private namespace)', () => {
  it('per-person secret dirs stay unreadable for files created after the session started', () => {
    const base = freshBase();
    const run = runInPrivateMountNs(`
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { prepareScratchSandbox } from './src/adapters/backend/scratch-sandbox.js';
import { enumerateScratchSecretPaths } from './src/adapters/backend/scratch-credentials.js';
const base = ${JSON.stringify(base)};
spawnSync('mount', ['-t', 'tmpfs', 'tmpfs', base]);
const home = join(base, 'home');
const botmux = join(home, '.botmux');
const data = join(botmux, 'data');
const work = join(base, 'work');
for (const d of [data, work]) mkdirSync(d, { recursive: true });
// At spawn: one person's bytedcli login exists; nobody has a pending OAuth login,
// a VC auth dir or a cli-identity dir yet.
mkdirSync(join(data, 'bytedcli-home', 'ou_early'), { recursive: true });
writeFileSync(join(data, 'bytedcli-home', 'ou_early', 'login.json'), 'early-secret');
writeFileSync(join(data, 'notes.txt'), 'not a secret');
const secrets = enumerateScratchSecretPaths({ botmuxHomes: [botmux], dataDirs: [data], homeDir: home, sessionId: 'sid-cred' });
// The CLI: wait for the host to say "go", then try every path and report.
const probes = {
  bytedcliLate: join(data, 'bytedcli-home', 'ou_late', 'login.json'),
  bytedcliEarly: join(data, 'bytedcli-home', 'ou_early', 'login.json'),
  oauthPendingLate: join(data, 'oauth-pending', 'state.json'),
  vcAuthLate: join(data, 'vc-meeting-daemon-auth', '57'),
  otherIdentityLate: join(data, 'cli-identity', 'sess-OTHER.bin', '.data', 'lark-cli.env'),
  ordinary: join(data, 'notes.txt'),
};
const code = \`
const fs = require('fs');
const relay = process.env.BOTMUX_SEND_RELAY;
const tick = setInterval(() => {
  if (!fs.existsSync(relay + '/go')) return;
  clearInterval(tick);
  const out = {};
  for (const [k, p] of Object.entries(\${JSON.stringify(probes)})) {
    try { out[k] = fs.readFileSync(p, 'utf8'); } catch (e) { out[k] = e.code; }
  }
  fs.writeFileSync(relay + '/report.json', JSON.stringify(out));
}, 50);
\`;
const sbx = prepareScratchSandbox({ sessionId: 'sid-cred', dataDir: data, storage: 'tmpfs', chdir: work, home,
  cliBin: process.execPath, cliArgs: ['-e', code], denyPaths: secrets.denyPaths, readOnlyCarvePaths: secrets.readOnlyCarvePaths });
if (!sbx) throw new Error('prepare failed');
const child = spawn(sbx.bin, sbx.args, { env: { ...process.env, ...sbx.env }, stdio: 'inherit' });
await new Promise(r => setTimeout(r, 1500));
// Mid-session: the daemon writes new per-person secrets on the host.
const late = (p, body) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); };
late(probes.bytedcliLate, 'late-secret');
late(probes.oauthPendingLate, 'late-secret');
late(probes.vcAuthLate, 'late-secret');
late(probes.otherIdentityLate, 'late-secret');
writeFileSync(join(sbx.outbox, 'go'), '');
const deadline = Date.now() + 20_000;
while (Date.now() < deadline && !existsSync(join(sbx.outbox, 'report.json'))) await new Promise(r => setTimeout(r, 100));
const report = existsSync(join(sbx.outbox, 'report.json')) ? JSON.parse(readFileSync(join(sbx.outbox, 'report.json'), 'utf8')) : null;
const exited = new Promise(r => { if (child.exitCode !== null || child.signalCode !== null) r(); else child.once('exit', r); });
child.kill('SIGKILL');
await exited;
sbx.cleanup();
console.log(JSON.stringify({ report }));
`, { timeoutMs: 90_000 });
    const { report } = lastJsonLine<{ report: Record<string, string> | null }>(run);
    expect(report, run.stderr).not.toBeNull();
    for (const key of ['bytedcliLate', 'bytedcliEarly', 'oauthPendingLate', 'vcAuthLate', 'otherIdentityLate']) {
      expect([report![key], key]).not.toEqual(['late-secret', key]);
      expect([report![key], key]).not.toEqual(['early-secret', key]);
    }
    expect(report!.ordinary).toBe('not a secret');
  }, 120_000);
});
