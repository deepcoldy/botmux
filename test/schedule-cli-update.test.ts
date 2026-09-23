import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows, readPersistedSessionRows } from './helpers/session-store-disk.js';
import { managedOriginCapabilityPath, replaceManagedOriginCapabilityFile } from '../src/core/managed-origin-capability.js';
import { MANAGED_ORIGIN_PROOF_DOMAIN, writeManagedOriginAttestationProof, type ManagedOriginAttestation } from '../src/core/managed-origin-attestation.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';
import { readSchedulePromptUpdate } from '../src/cli/schedule-update.js';

const app = 'cli_schedule';
const sid = 'schedule-session';
const channel = '77'.repeat(32);
const capability = 'ab'.repeat(32);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'schedule-cli-update-')); roots.push(root);
  const dataDir = join(root, '.botmux', 'data');
  const storeDir = join(root, '.botmux', 'bots', app);
  mkdirSync(storeDir, { recursive: true });
  const path = join(storeDir, 'schedules.json');
  const task = { id: 'aabbccdd', name: 'daily', schedule: '0 12 * * *',
    parsed: { kind: 'cron', expr: '0 12 * * *', display: 'daily' }, prompt: 'old prompt',
    workingDir: root, chatId: 'oc_chat', larkAppId: app, scope: 'chat', executionPosition: 'new-topic', deliver: 'origin',
    enabled: false, disabledReason: 'manual', createdAt: '2026-01-01T00:00:00.000Z',
    nextRunAt: '2030-01-01T04:00:00.000Z', lastRunAt: '2026-01-01T04:00:00.000Z',
    lastStatus: 'ok', lastRunId: 'previous-run', ownerOpenId: 'ou_owner', ownerUnionId: 'on_owner' };
  writeFileSync(path, JSON.stringify({ [task.id]: task }));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir,
    BOTMUX_LARK_APP_ID: app, NO_COLOR: '1' };
  const run = async (args: string[]) => {
    const child = spawnTsScript(cli, ['schedule', ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout!.on('data', data => { output += data; }); child.stderr!.on('data', data => { output += data; });
    return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      child.on('error', reject); child.on('close', code => resolve({ code, output }));
    });
  };
  return { root, dataDir, path, task, env, run, read: () => JSON.parse(readFileSync(path, 'utf8')) };
}

async function managed(f: ReturnType<typeof fixture>, customize?: (proof: ManagedOriginAttestation, index: number) => void) {
  seedPersistedSessionRows(f.dataDir, app, { [sid]: {
    sessionId: sid, status: 'active', larkAppId: app, chatId: 'oc_chat', rootMessageId: 'om_root',
    scope: 'thread', chatType: 'group', workingDir: f.root, cliId: 'codex',
    quoteTargetId: 'om_live', lastCallerOpenId: 'ou_owner',
  } });
  let calls = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const proof: ManagedOriginAttestation = { sessionId: sid, turnId: 'om_live', callerOpenId: 'ou_owner',
      larkAppId: app, requiresCodexAppLedger: false, scheduleCreator: { ok: true, ownerUnionId: 'on_owner' } };
    calls++;
    customize?.(proof, calls);
    writeManagedOriginAttestationProof({ dataDir: f.dataDir, proof: {
      ...proof, domain: MANAGED_ORIGIN_PROOF_DOMAIN, version: 1, nonce: request.nonce,
      channelId: channel, issuedAtMs: Date.now(),
    } });
    res.end(JSON.stringify({ scheduleCreator: { ok: true, ownerUnionId: 'on_forged' } }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  replaceManagedOriginCapabilityFile(managedOriginCapabilityPath(f.dataDir, sid, channel), JSON.stringify({
    sessionId: sid, channelId: channel, capability, turnId: 'om_live', larkAppId: app, ipcPort: port,
  }));
  Object.assign(f.env, { BOTMUX_SESSION_ID: sid, BOTMUX_ORIGIN_CHANNEL_ID: channel, BOTMUX_READ_ISOLATION: '1' });
  return () => calls;
}

describe('schedule CLI prompt updates', () => {
  it('documents both update inputs without requiring a configured bot', async () => {
    const f = fixture();
    const result = await f.run(['update', '--help']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('--prompt TEXT | --prompt-file FILE');
  });
  it('updates from a UTF-8 file and preserves the task identity, timing, position and history', async () => {
    const f = fixture(); const prompt = '新的完整提示词\n第二行\n';
    const file = join(f.root, 'prompt.md'); writeFileSync(file, prompt);
    const result = await f.run(['update', f.task.id, '--prompt-file', file]);
    expect(result.code, result.output).toBe(0);
    expect(f.read()).toEqual({ [f.task.id]: { ...f.task, prompt } });
  });
  it('rejects missing, empty, conflicting and unknown input without touching the old task', async () => {
    const f = fixture(); const before = readFileSync(f.path, 'utf8');
    for (const args of [ ['--prompt-file', join(f.root, 'missing')], ['--prompt', '  '],
      ['--prompt', 'new', '--prompt-file', 'file'], ['--prompt', 'new', '--typo', 'x'] ]) {
      const result = await f.run(['update', f.task.id, ...args]);
      expect(result.code, result.output).not.toBe(0);
      expect(readFileSync(f.path, 'utf8')).toBe(before);
    }
    const missing = await f.run(['update', 'deadbeef', '--prompt', 'new']);
    expect(missing.code, missing.output).not.toBe(0);
    expect(f.read()).toEqual({ [f.task.id]: f.task });
  });
  it('supports literal prompt values and rejects duplicate flags', () => {
    expect(readSchedulePromptUpdate(['id', '--prompt=--literal\nbody'])).toBe('--literal\nbody');
    expect(() => readSchedulePromptUpdate(['id', '--prompt', 'a', '--prompt', 'b'])).toThrow('duplicate');
  });
  it('creates and updates from an ownerless managed session with no bots.json', async () => {
    const f = fixture(); const calls = await managed(f);
    const add = await f.run(['add', '0 12 * * *', 'new task', '--new-topic', '--id', '11223344']);
    expect(add.code, add.output).toBe(0);
    expect(f.read()['11223344']).toMatchObject({ ownerOpenId: 'ou_owner', ownerUnionId: 'on_owner' });
    const update = await f.run(['update', f.task.id, '--prompt', 'new prompt']);
    expect(update.code, update.output).toBe(0);
    expect(f.read()[f.task.id]).toEqual({ ...f.task, prompt: 'new prompt' });
    expect(calls()).toBe(4);
    expect(readPersistedSessionRows(f.dataDir, app)[sid].ownerOpenId).toBeUndefined();
  });
  it('uses the daemon proof when host ancestry is visible but bots.json is unavailable', async () => {
    const f = fixture(); const calls = await managed(f);
    const markers = join(f.dataDir, '.botmux-cli-pids'); mkdirSync(markers, { recursive: true });
    writeFileSync(join(markers, String(process.pid)), JSON.stringify({
      sessionId: sid, turnId: 'om_live', procStart: readProcessStartIdentity(process.pid),
    }));
    const result = await f.run(['update', f.task.id, '--prompt', 'host-visible ancestry']);
    expect(result.code, result.output).toBe(0);
    expect(calls()).toBe(2);
    expect(f.read()[f.task.id].prompt).toBe('host-visible ancestry');
  });
  it.each(['denied', 'old-daemon', 'turn-rotated', 'permission-revoked', 'cross-bot'] as const)(
    'preserves the old task when authorization is %s', async mode => {
      const f = fixture();
      await managed(f, (proof, index) => {
        if (mode === 'denied' || (mode === 'permission-revoked' && index > 1)) proof.scheduleCreator = { ok: false, error: 'caller_not_allowed' };
        if (mode === 'old-daemon') delete proof.scheduleCreator;
        if (mode === 'turn-rotated' && index > 1) proof.turnId = 'om_next';
        if (mode === 'cross-bot') proof.larkAppId = 'cli_other';
      });
      const before = readFileSync(f.path, 'utf8');
      const result = await f.run(['update', f.task.id, '--prompt', 'new']);
      expect(result.code, result.output).not.toBe(0);
      const errors = { denied: 'not an allowed bot operator', 'old-daemon': 'upgrade the owning daemon',
        'turn-rotated': 'provenance changed before write', 'permission-revoked': 'not an allowed bot operator',
        'cross-bot': 'bot does not match the session' };
      expect(result.output).toContain(errors[mode]);
      expect(readFileSync(f.path, 'utf8')).toBe(before);
    });
});
