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
import { SCHEDULE_DELEGATED_ADD_ROUTE, SCHEDULE_MANAGED_MUTATE_ROUTE } from '../src/core/dispatch-user-delegation.js';
import {
  activateSchedulePrecondition,
  resolveSchedulePrecondition,
  stageSchedulePrecondition,
} from '../src/services/schedule-precondition-store.js';

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

async function managed(
  f: ReturnType<typeof fixture>,
  customize?: (proof: ManagedOriginAttestation, index: number) => void,
  managedTurnId = 'om_live',
) {
  seedPersistedSessionRows(f.dataDir, app, { [sid]: {
    sessionId: sid, status: 'active', larkAppId: app, chatId: 'oc_chat', rootMessageId: 'om_root',
    scope: 'thread', chatType: 'group', workingDir: f.root, cliId: 'codex',
    quoteTargetId: managedTurnId, lastCallerOpenId: 'ou_owner',
  } });
  let calls = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const proof: ManagedOriginAttestation = { sessionId: sid, turnId: managedTurnId, callerOpenId: 'ou_owner',
      larkAppId: app, requiresCodexAppLedger: false, scheduleCreator: { ok: true, ownerUnionId: 'on_owner' } };
    calls++;
    customize?.(proof, calls);
    if (req.url === SCHEDULE_DELEGATED_ADD_ROUTE) {
      if (proof.turnId !== managedTurnId) {
        res.statusCode = 409;
        return res.end(JSON.stringify({ ok: false, error: 'provenance changed before write' }));
      }
      if (proof.larkAppId !== app) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ ok: false, error: 'schedule creator bot does not match the session' }));
      }
      if (proof.scheduleCreator?.ok !== true) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      }
      const created = { ...request.task, parsed: { kind: 'cron', expr: request.task.schedule, display: 'daily' },
        ownerOpenId: 'ou_owner', ownerUnionId: 'on_owner', enabled: true,
        createdAt: '2026-09-28T00:00:00.000Z' };
      const rows = f.read(); rows[created.id] = created; writeFileSync(f.path, JSON.stringify(rows));
      res.statusCode = 201;
      return res.end(JSON.stringify({ ok: true, task: created }));
    }
    if (req.url === SCHEDULE_MANAGED_MUTATE_ROUTE) {
      if (proof.turnId !== managedTurnId) {
        res.statusCode = 409;
        return res.end(JSON.stringify({ ok: false, error: 'provenance changed before write' }));
      }
      if (proof.larkAppId !== app) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ ok: false, error: 'schedule creator bot does not match the session' }));
      }
      if (proof.scheduleCreator?.ok !== true) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ ok: false, error: 'current turn caller is not an allowed bot operator' }));
      }
      const taskId = request.id === 'self'
        ? /^schedule:([0-9a-z_]{1,50}):/.exec(managedTurnId)?.[1]
        : request.id;
      const rows = f.read();
      const current = taskId ? rows[taskId] : undefined;
      if (!current) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ ok: false, error: 'schedule_not_found' }));
      }
      if (current.preconditionRef) {
        res.statusCode = 409;
        return res.end(JSON.stringify({ ok: false, error: 'schedule_precondition_dashboard_update_required' }));
      }
      if (request.action === 'remove') delete rows[taskId!];
      else if (request.action === 'pause') rows[taskId!] = { ...current, enabled: false, disabledReason: 'manual', manualRunRequested: undefined };
      else if (request.action === 'resume') rows[taskId!] = { ...current, enabled: true, disabledReason: undefined, manualRunRequested: undefined };
      else if (request.action === 'run') {
        if (!current.enabled) {
          res.statusCode = 409;
          return res.end(JSON.stringify({ ok: false, error: 'schedule_task_disabled' }));
        }
        rows[taskId!] = { ...current, manualRunRequested: true };
      } else {
        // update: prompt and/or work-calendar fields, mirroring daemon normalization
        const patch: Record<string, unknown> = {};
        if (typeof request.prompt === 'string') patch.prompt = request.prompt;
        if (request.calendar !== undefined) {
          patch.calendar = request.calendar === null ? undefined : request.calendar;
          if (request.calendar === null) patch.calendarDayType = undefined;
        }
        if (request.calendarDayType !== undefined) {
          patch.calendarDayType = current.calendar ? request.calendarDayType : undefined;
        }
        rows[taskId!] = { ...current, ...patch };
      }
      writeFileSync(f.path, JSON.stringify(rows));
      return res.end(JSON.stringify({ ok: true }));
    }
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
    sessionId: sid, channelId: channel, capability, turnId: managedTurnId, larkAppId: app, ipcPort: port,
  }));
  Object.assign(f.env, { BOTMUX_SESSION_ID: sid, BOTMUX_ORIGIN_CHANNEL_ID: channel, BOTMUX_READ_ISOLATION: '1' });
  f.env.BOTMUX_DAEMON_IPC_PORT = String(port);
  return () => calls;
}

describe('schedule CLI prompt updates', () => {
  it('documents both update inputs without requiring a configured bot', async () => {
    const f = fixture();
    const result = await f.run(['update', '--help']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('--prompt TEXT | --prompt-file FILE');
  });
  it('fails explicitly instead of mutating JSON when the daemon route is unavailable', async () => {
    const f = fixture(); const prompt = '新的完整提示词\n第二行\n';
    const file = join(f.root, 'prompt.md'); writeFileSync(file, prompt);
    const before = readFileSync(f.path, 'utf8');
    const result = await f.run(['update', f.task.id, '--prompt-file', file]);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain('daemon 不在线');
    expect(readFileSync(f.path, 'utf8')).toBe(before);
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
  it('keeps the original creator-auth error when delegated add returns non-OK', async () => {
    const f = fixture();
    await managed(f, proof => { proof.scheduleCreator = { ok: false, error: 'caller_not_allowed' }; });
    const result = await f.run(['add', '0 12 * * *', 'new task', '--id', '11223344']);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain('not an allowed bot operator');
    expect(result.output).not.toContain('unauthorized');
    expect(f.read()['11223344']).toBeUndefined();
  });
  it('lets a scheduled turn remove itself through the daemon without human creator auth', async () => {
    const f = fixture();
    const scheduledTurnId = `schedule:${f.task.id}:12345678-1234-1234-1234-123456789abc`;
    await managed(f, undefined, scheduledTurnId);
    const result = await f.run(['remove', 'self']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('已删除任务 self');
    expect(f.read()[f.task.id]).toBeUndefined();
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
  it('refuses to touch a task bound to a protected precondition and keeps the binding valid', async () => {
    // A CLI prompt rewrite changes canonical schedule input. The host-only
    // precondition sidecar is unreadable inside the worker sandbox, so the CLI
    // cannot rebind it; a successful update here would leave every future fire
    // failing resolution with canonical_input_mismatch and the task silently
    // never running again.
    const f = fixture(); await managed(f);
    const staged = stageSchedulePrecondition(app, f.task.id, {
      enabled: true, source: { kind: 'inline', script: 'exit 0' },
    }, { dataDir: f.dataDir });
    const bound = { ...f.task, preconditionRef: staged.preconditionRef };
    writeFileSync(f.path, JSON.stringify({ [f.task.id]: bound }));
    activateSchedulePrecondition(bound, app, { dataDir: f.dataDir });
    const before = readFileSync(f.path, 'utf8');

    const result = await f.run(['update', f.task.id, '--prompt', 'new prompt']);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toMatch(/precondition|前置条件/);
    expect(readFileSync(f.path, 'utf8')).toBe(before);

    const resolved = resolveSchedulePrecondition(f.read()[f.task.id], app, { dataDir: f.dataDir });
    expect(resolved).toMatchObject({ kind: 'configured', enabled: true });
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

describe('work calendar CLI configuration and persisted manual intent', () => {
  it('lists the bundled CN region, coverage and official source without a local calendar file', async () => {
    const f = fixture();
    await managed(f);
    const listed = await f.run(['calendars']);
    expect(listed.code, listed.output).toBe(0);
    const cn = listed.output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(row => row.name === 'cn');
    expect(cn).toMatchObject({ name: 'cn', kind: 'builtin', region: 'CN', dataVersion: '2026.1',
      timeZone: 'Asia/Shanghai', coverage: { start: '2026-01-01', end: '2026-12-31' },
      source: { authority: '国务院办公厅', documentNo: '国办发明电〔2025〕7号' } });
    const updated = await f.run(['update', f.task.id, '--calendar', 'cn']);
    expect(updated.code, updated.output).toBe(0);
    expect(f.read()[f.task.id]).toMatchObject({ calendar: 'cn', ownerOpenId: f.task.ownerOpenId });
    const rest = await f.run(['update', f.task.id, '--calendar-day-type', 'restday']);
    expect(rest.code, rest.output).toBe(0);
    expect(f.read()[f.task.id]).toMatchObject({ calendar: 'cn', calendarDayType: 'restday' });
    const invalid = await f.run(['update', f.task.id, '--calendar-day-type', 'weekend']);
    expect(invalid.code).not.toBe(0);
    expect(f.read()[f.task.id].calendarDayType).toBe('restday');
    const local = join(f.root, '.botmux', 'bots', app, 'work-calendars.json');
    writeFileSync(local, JSON.stringify({ version: 1, calendars: { cn: {} } }));
    const shadowed = await f.run(['calendars']);
    expect(shadowed.code, shadowed.output).toBe(0);
    expect(shadowed.output).toContain('reserved_builtin_calendar');
    expect((await f.run(['update', f.task.id, '--calendar', 'none'])).code).toBe(0);
    expect(f.read()[f.task.id].calendarDayType).toBeUndefined();
  });
  it('binds, reads in another process and clears a calendar without changing routing/owner', async () => {
    const f = fixture();
    await managed(f);
    const before = f.read()[f.task.id];
    const updated = await f.run(['update', f.task.id, '--calendar', 'demo']);
    expect(updated.code, updated.output).toBe(0);
    expect(f.read()[f.task.id]).toMatchObject({ ...before, calendar: 'demo' });
    const definitions = JSON.parse(readFileSync(new URL('./fixtures/work-calendar/demo.json', import.meta.url), 'utf8'));
    writeFileSync(join(f.root, '.botmux', 'bots', app, 'work-calendars.json'), JSON.stringify(definitions));
    const list = await f.run(['list']);
    expect(list.code, list.output).toBe(0);
    expect(list.output).toContain('calendar: demo');
    expect(list.output).toContain('nextEligibleRunAt');
    const calendars = await f.run(['calendars']);
    expect(calendars.code, calendars.output).toBe(0);
    expect(calendars.output).toContain('"name":"demo"');
    expect((await f.run(['resume', f.task.id])).code).toBe(0);
    const requested = await f.run(['run', f.task.id]);
    expect(requested.code, requested.output).toBe(0);
    expect(f.read()[f.task.id].manualRunRequested).toBe(true);
    const cleared = await f.run(['update', f.task.id, '--calendar', 'none']);
    expect(cleared.code, cleared.output).toBe(0);
    expect(f.read()[f.task.id].calendar).toBeUndefined();
    expect(f.read()[f.task.id].ownerUnionId).toBe(before.ownerUnionId);
  });
  it('adds with --calendar and preserves exact prompt bytes', async () => {
    const f = fixture();
    await managed(f);
    const added = await f.run(['add', '0 9 * * *', 'fixture prompt', '--id', 'aabbcc01', '--calendar', 'demo', '--calendar-day-type', 'restday', '--chat-id', 'fixture_chat', '--new-topic', '--workdir', f.root]);
    expect(added.code, added.output).toBe(0);
    expect(f.read().aabbcc01).toMatchObject({ calendar: 'demo', calendarDayType: 'restday', prompt: 'fixture prompt', executionPosition: 'new-topic', larkAppId: app });
  });
  it('refuses run on a paused task and tells the user to resume first', async () => {
    const f = fixture();
    await managed(f);
    expect((await f.run(['pause', f.task.id])).code).toBe(0);
    const paused = f.read()[f.task.id];
    const result = await f.run(['run', f.task.id]);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('已暂停');
    expect(result.output).toContain('先恢复');
    expect(f.read()[f.task.id]).toEqual(paused);
  });
});
