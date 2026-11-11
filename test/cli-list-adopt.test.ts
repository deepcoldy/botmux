import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mutatePersistedSessionRow, readPersistedSessionRows, seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { spawnTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';

const APP_ID = 'cli_list_adopt_test';
const SESSION_ID = 'list-adopt-session';
// Allows the same behavior cases to verify the unmodified release CLI too.
const CLI_PATH = process.env.BOTMUX_TEST_LIST_CLI_PATH ?? join(__dirname, '..', 'src', 'cli.ts');
const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(originalCliPid?: number, workerPid?: number) {
  const home = mkdtempSync(join(tmpdir(), 'list-adopt-home-'));
  directories.push(home);
  const dataDir = join(home, '.botmux', 'data');
  const session = {
    sessionId: SESSION_ID, larkAppId: APP_ID, chatId: 'oc_list_adopt', rootMessageId: 'om_list_adopt',
    title: 'external-terminal', status: 'active', createdAt: '2026-11-10T00:00:00.000Z',
    cliId: 'traex', backendType: 'tmux', pid: workerPid,
    adoptedFrom: { source: 'tmux', tmuxTarget: 'external:0.0', cliId: 'traex', cwd: home, originalCliPid },
  };
  seedPersistedSessionRows(dataDir, APP_ID, { [SESSION_ID]: session });
  // Match the JSON representation persisted by SQLite (undefined keys omitted).
  const before = readPersistedSessionRows(dataDir, APP_ID)[SESSION_ID];
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('BOTMUX_') && !['BOTMUX', 'BOTS_CONFIG', 'SESSION_DATA_DIR', 'LARK_APP_ID', 'LARK_APP_SECRET'].includes(key)));
  const env: NodeJS.ProcessEnv = { ...inherited, HOME: home, USERPROFILE: home, SESSION_DATA_DIR: dataDir,
    TEST_ADOPT_PROBE_PID: String(originalCliPid ?? workerPid ?? '') };
  return { home, dataDir, before, env };
}

async function onlineOwner(f: ReturnType<typeof fixture>) {
  const writes: string[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === `/api/sessions/${SESSION_ID}/prune`) {
      writes.push(req.url);
      mutatePersistedSessionRow(f.dataDir, APP_ID, SESSION_ID, row => { row.status = 'closed'; });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const registry = join(f.dataDir, 'dashboard-daemons');
  mkdirSync(registry, { recursive: true });
  writeFileSync(join(f.home, '.botmux', '.dashboard-secret'), 'list-adopt-fixture-secret', { mode: 0o600 });
  writeFileSync(join(registry, `${APP_ID}.json`), JSON.stringify({
    larkAppId: APP_ID, ipcPort: (server.address() as { port: number }).port,
    pid: process.pid, lastHeartbeat: Date.now(),
  }));
  return writes;
}

async function runList(env: NodeJS.ProcessEnv, args: string[], sandboxed = false, command = 'list') {
  const runner = tsRunnerPrefix();
  let entry = CLI_PATH;
  if (sandboxed) {
    entry = join(env.HOME!, 'probe-and-list.mjs');
    // A real Seatbelt denial must be observed before invoking the source CLI;
    // otherwise a green test could merely have kept a process it can inspect.
    writeFileSync(entry, `
let code;
try { process.kill(Number(process.env.TEST_ADOPT_PROBE_PID), 0); } catch (error) { code = error.code; }
if (code !== 'EPERM') throw new Error('expected denied external process probe, got ' + code);
console.error(code);
process.argv = [process.execPath, ${JSON.stringify(CLI_PATH)}, ${JSON.stringify(command)}, ...process.argv.slice(2)];
await import(${JSON.stringify(CLI_PATH)});
`);
  }
  const child = sandboxed
    ? spawn('/usr/bin/sandbox-exec', [
      '-p', '(version 1) (allow default) (deny signal)',
      runner.command, ...runner.prefixArgs, entry, ...args,
    ], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawnTsScript(CLI_PATH, [command, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr!.on('data', (chunk: string) => { stderr += chunk; });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  return { status, stdout, stderr };
}

describe('list does not close an external terminal from a local process probe', () => {
  it.each([{ args: [] }, { args: ['--plain'] }, { args: ['--json'] }])('keeps an adopted session with a stale CLI pid for list $args', async ({ args }) => {
    const f = fixture(2_147_483_647);
    const result = await runList(f.env, args);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('external-terminal');
    expect(readPersistedSessionRows(f.dataDir, APP_ID)[SESSION_ID]).toEqual(f.before);
  });

  it('keeps an adopted session whose CLI and worker pid are not recorded', async () => {
    const f = fixture();
    const result = await runList(f.env, ['--plain']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('external-terminal');
    expect(readPersistedSessionRows(f.dataDir, APP_ID)[SESSION_ID]).toEqual(f.before);
  });

  it.skipIf(process.platform !== 'darwin')('keeps a live external CLI when Seatbelt denies the signal-zero probe', async () => {
    const f = fixture(process.pid);
    const writes = await onlineOwner(f);
    const result = await runList(f.env, ['--plain'], true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('EPERM');
    expect(result.stdout).toContain('external-terminal');
    expect(() => process.kill(process.pid, 0)).not.toThrow();
    expect(writes).toEqual([]);
    expect(readPersistedSessionRows(f.dataDir, APP_ID)[SESSION_ID]).toEqual(f.before);
  });

  it.skipIf(process.platform !== 'darwin')('keeps the observer when only its worker pid is recorded and cannot be probed', async () => {
    const f = fixture(undefined, process.pid);
    const writes = await onlineOwner(f);
    const result = await runList(f.env, ['--plain'], true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('EPERM');
    expect(result.stdout).toContain('external-terminal');
    expect(writes).toEqual([]);
    expect(readPersistedSessionRows(f.dataDir, APP_ID)[SESSION_ID]).toEqual(f.before);
  });

  it('still closes a stale adopted session when the user explicitly deletes it', async () => {
    const f = fixture(2_147_483_647);
    const result = await runList(f.env, [SESSION_ID], false, 'delete');
    expect(result.status, result.stderr).toBe(0);
    expect(readPersistedSessionRows(f.dataDir, APP_ID)[SESSION_ID].status).toBe('closed');
  });
});
