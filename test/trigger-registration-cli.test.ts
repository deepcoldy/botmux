import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseTriggerRegistrationCommand } from '../src/cli/trigger-registration.js';
import { startIpcServer, setLarkAppId, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { config } from '../src/config.js';
import * as leases from '../src/services/idempotency-store.js';
const execute = promisify(execFile);
const APP = 'app_cli_registration', SID = 'sid-cli', KEY = 'original &?键';
const repo = fileURLToPath(new URL('..', import.meta.url));
let root: string, previousDataDir: string, dataDir: string, handle: IpcServerHandle;
function leaseSnapshot() {
  const dir = join(dataDir, 'idempotency');
  const read = (p: string): unknown => Object.fromEntries(readdirSync(p, { withFileTypes: true }).map(e => {
    const f = join(p, e.name); return [e.name, e.isDirectory() ? read(f) : [readFileSync(f, 'utf8'), statSync(f).mtimeMs]];
  }));
  return read(dir);
}
async function run(extraEnv: Record<string, string> = {}, bot = APP) {
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    SESSION_DATA_DIR: dataDir, BOTMUX_NO_CLAIM: '1', ...extraEnv };
  try {
    const result = await execute(process.execPath, [
      ...(process.versions.bun ? [] : ['--import', 'tsx']),
      join(repo, 'src/cli.ts'), 'trigger-registration', '--bot', bot, '--session', SID, '--key', KEY,
    ], { env, cwd: repo, timeout: 20000, maxBuffer: 128 * 1024, encoding: 'utf8' });
    return { code: 0, ...result };
  } catch (e: any) { return { code: e.code, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }; }
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'botmux-registration-cli-'));
  dataDir = join(root, 'data');
  mkdirSync(join(root, 'home/.botmux'), { recursive: true });
  mkdirSync(join(dataDir, 'dashboard-daemons'), { recursive: true });
  writeFileSync(join(root, 'home/.botmux/.dashboard-secret'), 'registration-cli-fixture', { mode: 0o600 });
  previousDataDir = config.session.dataDir; config.session.dataDir = dataDir;
  setLarkAppId(APP); setIpcAuthSecret('registration-cli-fixture');
  handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  writeFileSync(join(dataDir, 'dashboard-daemons', APP + '.json'), JSON.stringify({ larkAppId: APP, ipcPort: handle.port, pid: process.pid, lastHeartbeat: Date.now() }));
  leases.claim({ ownerLarkAppId: APP, sessionId: SID, triggerId: 'trg-original', key: SID + '\0' + KEY,
    requestHash: 'sha256:original', ownerBootId: 'boot-original', now: 1000, kind: 'turn' });
});
afterEach(async () => {
  await handle.close(); setIpcAuthSecret(''); config.session.dataDir = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});
describe('host trigger registration CLI', () => {
  it('uses a real CLI child, discovery and authenticated IPC without advancing the original lease', async () => {
    const before = leaseSnapshot();
    const first = await run();
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ schemaVersion: 1, larkAppId: APP, sessionId: SID, state: 'registered',
      registration: { triggerId: 'trg-original', state: 'reserved', requestHash: 'sha256:original' }, inputCommitted: { state: 'unknown' } });
    expect(await run()).toEqual(first);
    expect(leaseSnapshot()).toEqual(before);
  }, 45000);
  it('does not expose a misrouted daemon observation as the requested bot', async () => {
    setLarkAppId('app_other');
    const result = await run();
    expect(result.code).not.toBe(0); expect(result.stderr).toContain('identity mismatch'); expect(result.stdout).toBe('');
  });
  it('fails closed with an invalid host secret and does not advance the lease', async () => {
    const before = leaseSnapshot();
    writeFileSync(join(root, 'home/.botmux/.dashboard-secret'), 'incorrect-fixture-secret');
    const result = await run(); expect(result.code).not.toBe(0); expect(leaseSnapshot()).toEqual(before);
  });
  it.each([{ BOTMUX_SESSION_ID: SID }, { BOTMUX_SEND_RELAY: '/fixture/relay' }])('refuses a Worker or relay context %j', async env => {
    const result = await run(env); expect(result.code).not.toBe(0); expect(result.stderr).toContain('Host context required');
    expect(result.stdout).toBe('');
  });
  it('does not infer another daemon when the selected bot is offline', async () => {
    const result = await run({}, 'app_offline'); expect(result.code).not.toBe(0); expect(result.stderr).toContain('unavailable'); expect(result.stdout).toBe('');
  });
  it('requires complete explicit identities and safely encodes the original key', () => {
    expect(parseTriggerRegistrationCommand(['--bot', APP, '--session', SID, '--key', ' ' + KEY + ' ']).path)
      .toBe(`/api/sessions/${SID}/trigger-registration?turnIdempotencyKey=${encodeURIComponent(KEY)}`);
    for (const args of [[], ['--bot', APP], ['--bot', APP, '--bot', 'other'], ['--session', '../x'],
      ['--bot', APP, '--session', SID, '--key', 'x', '--dispatch', 'true']]) expect(() => parseTriggerRegistrationCommand(args)).toThrow();
  });
});
