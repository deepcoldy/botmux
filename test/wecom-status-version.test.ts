/**
 * The VERSION cell of a WeCom member row in `botmux status`: the version its
 * gateway wrote into its runtime record, shown only when that record is the
 * row's own live process; and kept out of the Feishu daemons' restart hint.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fleetProcessIdentityRuntime } from '../src/core/fleet-process-identity.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { listWecomFleetConnections } from '../src/im/wecom/config/fleet-members.js';
import {
  readWecomRuntime,
  wecomBotRoot,
  WECOM_RUNTIME_EVIDENCE_MS,
  WECOM_RUNTIME_REFRESH_MS,
  type WecomRuntimeRecord,
} from '../src/im/wecom/config/runtime.js';
import { wecomFleetMemberName } from '../src/im/wecom/contract/fleet-member.js';
import { wecomMemberVersions, type WecomMemberVersionDeps } from '../src/cli/wecom/status-version.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';
import { readResolvedModules, resolvedModulesPrelude, runRepoSnippet } from './helpers/resolved-modules.js';

const repoRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const cliEntry = join(repoRoot, 'src', 'cli.ts');
const NOW = 1_800_000_000_000;

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A WeCom root with one registered connection of bot `bot-a`. */
function wecomFixture(root: string) {
  const file = join(root, 'a', 'config.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ botId: 'bot-a', coreUrl: 'http://127.0.0.1:18080', allowedUsers: ['u'] }));
  writeFileSync(join(root, 'config-registry.json'), JSON.stringify({ version: 1, paths: [file] }));
  const configId = wecomConfigId(file);
  return { configId, member: wecomFleetMemberName(configId) };
}

function writeRuntime(root: string, record: Partial<WecomRuntimeRecord> & { pid: number }) {
  const dir = wecomBotRoot('bot-a', root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'runtime.json'), JSON.stringify({
    version: 1,
    processStart: 'birth',
    instanceId: 'instance',
    connection: 'connected',
    phase: 'running',
    updatedAt: NOW,
    ...record,
  }));
}

describe('which WeCom member rows show a gateway version', () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'wecom-status-version-'));
    dirs.push(root);
    const f = wecomFixture(root);
    const reads: string[] = [];
    const deps = (overrides: Partial<WecomMemberVersionDeps> = {}): WecomMemberVersionDeps => ({
      listConnections: () => { reads.push('registry'); return listWecomFleetConnections(root); },
      readRuntime: botId => { reads.push('runtime'); return readWecomRuntime(botId, root); },
      isSameProcess: record => record.processStart === 'birth',
      now: () => NOW,
      ...overrides,
    });
    const row = { name: f.member, pid: 4242, alive: true };
    return { root, ...f, reads, deps, row };
  }

  it('shows the version a fresh record of the row\'s own process carries', () => {
    const s = setup();
    writeRuntime(s.root, { configId: s.configId, pid: 4242, botmuxVersion: '3.60.0' });
    expect(wecomMemberVersions([s.row], s.deps())).toEqual(new Map([[s.member, '3.60.0']]));
  });

  it.each<[string, Partial<WecomRuntimeRecord>]>([
    ['a record written before versions were recorded', { botmuxVersion: undefined }],
    ['another pid', { pid: 4343 }],
    ['another connection\'s record', { configId: 'f'.repeat(64) }],
    ['a gateway that recorded it stopped', { phase: 'stopped' }],
    ['a record past the evidence window', { updatedAt: NOW - WECOM_RUNTIME_EVIDENCE_MS }],
    ['a record from the future', { updatedAt: NOW + 1 }],
    ['a pid now held by another process', { processStart: 'other-birth' }],
  ])('shows nothing for %s', (_name, change) => {
    const s = setup();
    writeRuntime(s.root, { configId: s.configId, pid: 4242, botmuxVersion: '3.60.0', ...change });
    expect(wecomMemberVersions([s.row], s.deps())).toEqual(new Map());
  });

  it('shows nothing for a row whose process is gone or has no pid, and reads nothing for it', () => {
    const s = setup();
    writeRuntime(s.root, { configId: s.configId, pid: 4242, botmuxVersion: '3.60.0' });
    expect(wecomMemberVersions([{ ...s.row, alive: false }, { ...s.row, pid: 0 }], s.deps())).toEqual(new Map());
    expect(s.reads).toEqual([]);
  });

  it('reads no WeCom file for a table of Feishu bots and the Dashboard', () => {
    const s = setup();
    const rows = [{ name: 'botmux-0', pid: 4242, alive: true }, { name: 'botmux-dashboard', pid: 4243, alive: true }];
    expect(wecomMemberVersions(rows, s.deps())).toEqual(new Map());
    expect(s.reads).toEqual([]);
  });

  it('treats a gateway as fresh across a missed refresh', () => {
    expect(WECOM_RUNTIME_EVIDENCE_MS).toBeGreaterThan(2 * WECOM_RUNTIME_REFRESH_MS);
  });
});

describe('botmux status with a WeCom member row', () => {
  /** A HOME whose fleet-state has one WeCom member row for a live process. */
  function home(record: (pids: { row: number; other: number }) => Partial<WecomRuntimeRecord>) {
    const dir = mkdtempSync(join(tmpdir(), 'wecom-status-home-'));
    dirs.push(dir);
    const botmux = join(dir, '.botmux');
    mkdirSync(join(botmux, 'logs'), { recursive: true });
    mkdirSync(join(botmux, 'data'), { recursive: true });
    const root = join(botmux, 'wecom');
    const f = wecomFixture(root);
    const [row, other] = [spawn('sleep', ['120'], { stdio: 'ignore' }), spawn('sleep', ['120'], { stdio: 'ignore' })];
    children.push(row, other);
    const identity = (pid: number) => {
      const processStart = fleetProcessIdentityRuntime.readIdentity(pid);
      const pidNamespace = fleetProcessIdentityRuntime.readPidNamespace(pid);
      return { processStart: processStart!, ...(pidNamespace ? { pidNamespace } : {}) };
    };
    const pids = { row: row.pid!, other: other.pid! };
    const fields = record(pids);
    const pid = fields.pid ?? pids.row;
    writeRuntime(root, { configId: f.configId, pid, ...identity(pid), updatedAt: Date.now(), ...fields });
    writeFileSync(join(botmux, 'fleet-state.json'), JSON.stringify({
      supervisorPid: 0,
      supervisorStartedAt: '',
      procs: [{ name: f.member, appId: '', pid: pids.row, generation: 1, status: 'online', restarts: 0, lastExitCode: null, startedAt: new Date().toISOString() }],
    }));
    return { dir, member: f.member };
  }

  function status(dir: string) {
    const { command, prefixArgs } = tsRunnerPrefix();
    const result = spawnSync(command, [...prefixArgs, cliEntry, 'status'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: dir,
        SESSION_DATA_DIR: join(dir, '.botmux', 'data'),
        BOTS_CONFIG: join(dir, '.botmux', 'bots.json'),
        // A comparable installed version, so a running version that differs would raise the restart hint.
        BOTMUX_BAKED_VERSION: '9.0.0',
      },
    });
    return result;
  }

  const versionCell = (stdout: string, member: string) =>
    stdout.split('\n').find(line => line.trim().startsWith(`${member} `))?.trim().split(/\s+/)[5];

  it('shows the gateway\'s version in its row and leaves it out of the restart hint', () => {
    const h = home(() => ({ botmuxVersion: '1.2.3' }));
    const result = status(h.dir);
    expect(result.status, result.stderr).toBe(0);
    expect(versionCell(result.stdout, h.member)).toBe('1.2.3');
    expect(result.stdout.split('1.2.3')).toHaveLength(2);
  }, 60_000);

  it('shows - when the record names another pid than the row', () => {
    const h = home(pids => ({ pid: pids.other, botmuxVersion: '1.2.3' }));
    const result = status(h.dir);
    expect(result.status, result.stderr).toBe(0);
    expect(versionCell(result.stdout, h.member)).toBe('-');
  }, 60_000);
});

describe('botmux status with Feishu rows only', () => {
  it('loads no WeCom CLI module', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wecom-status-feishu-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.botmux', 'data'), { recursive: true });
    const sleeper = spawn('sleep', ['120'], { stdio: 'ignore' });
    children.push(sleeper);
    writeFileSync(join(dir, '.botmux', 'fleet-state.json'), JSON.stringify({
      supervisorPid: 0,
      supervisorStartedAt: '',
      procs: [
        { name: 'botmux-0', appId: 'cli_a', pid: sleeper.pid, generation: 1, status: 'online', restarts: 0, lastExitCode: null, startedAt: null },
        { name: 'botmux-dashboard', appId: '', pid: 0, generation: 1, status: 'stopped', restarts: 0, lastExitCode: null, startedAt: null },
      ],
    }));
    const output = join(dir, 'resolved.json');
    const run = (args: string[]) => runRepoSnippet(`${resolvedModulesPrelude(output)}
      process.argv = [process.argv[0], ${JSON.stringify(cliEntry)}, ...${JSON.stringify(args)}];
      await import(${JSON.stringify(cliEntry)});
    `, dir, { SESSION_DATA_DIR: join(dir, '.botmux', 'data'), BOTS_CONFIG: join(dir, '.botmux', 'bots.json') });
    const result = await run(['status']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('botmux-0');
    expect(readResolvedModules(output).filter(item => item.includes('/src/cli/wecom/status-'))).toEqual([]);

    // The same observer sees them once the table has a WeCom row.
    const wecomRoot = join(dir, '.botmux', 'wecom');
    const f = wecomFixture(wecomRoot);
    writeFileSync(join(dir, '.botmux', 'fleet-state.json'), JSON.stringify({
      supervisorPid: 0,
      supervisorStartedAt: '',
      procs: [{ name: f.member, appId: '', pid: sleeper.pid, generation: 1, status: 'online', restarts: 0, lastExitCode: null, startedAt: null }],
    }));
    const withWecom = await run(['status']);
    expect(withWecom.code, withWecom.stderr).toBe(0);
    expect(readResolvedModules(output).filter(item => item.includes('/src/cli/wecom/status-')).length).toBeGreaterThan(0);
  }, 120_000);
});
