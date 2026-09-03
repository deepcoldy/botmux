/**
 * CLI-only lifecycle regression coverage for persisted backend targets.
 *
 * These source-CLI subprocesses use a fake Herdr control plane so the tests
 * exercise the same list/auto-prune/offline-delete paths users invoke while
 * proving a shared host session is never collapsed back to bmx-<sid8>.
 */
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import {
  readPersistedSessionRows,
  seedPersistedSessionRows,
} from './helpers/session-store-disk.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(TEST_DIR, '..', 'src', 'cli.ts');
const tempDirs: string[] = [];

interface StoredSession {
  sessionId: string;
  chatId: string;
  rootMessageId: string;
  title: string;
  status: 'active' | 'closed';
  createdAt: string;
  cliId: 'codex';
  backendType: 'herdr';
  persistentBackendTarget: {
    backendType: 'herdr';
    sessionName: string;
    agentName: string;
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The CLI runs without `BOTMUX_LARK_APP_ID`, so its rows live in the legacy
 * flat store (`<dataDir>/sessions.db`), not a per-bot one.
 */
function storedSession(dataDir: string, sessionId: string): Record<string, any> {
  return readPersistedSessionRows(dataDir)[sessionId];
}

function makeFixture(): {
  dataDir: string;
  binDir: string;
  logPath: string;
  session: StoredSession;
} {
  const root = mkdtempSync(join(tmpdir(), 'botmux-cli-target-'));
  tempDirs.push(root);
  const dataDir = join(root, 'data');
  const binDir = join(root, 'bin');
  const logPath = join(root, 'herdr.log');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const session: StoredSession = {
    sessionId: 'abcdef12-1111-2222-3333-444444444444',
    chatId: 'oc_target',
    rootMessageId: 'om_target',
    title: 'shared-herdr-target',
    status: 'active',
    createdAt: '2026-07-30T00:00:00.000Z',
    cliId: 'codex',
    backendType: 'herdr',
    persistentBackendTarget: {
      backendType: 'herdr',
      sessionName: 'work',
      agentName: 'agent-a',
    },
  };
  seedPersistedSessionRows(dataDir, undefined, { [session.sessionId]: session });

  const fakeHerdr = join(binDir, 'herdr');
  writeFileSync(fakeHerdr, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.HERDR_TEST_LOG, JSON.stringify(args) + '\\n');
if (args.join(' ') === 'session list --json') {
  process.stdout.write(JSON.stringify({ sessions: [{ name: 'work', running: true }] }));
} else if (args.join(' ') === '--session work agent list') {
  process.stdout.write(JSON.stringify({ result: { agents: [{ name: 'agent-a', pane_id: 'pane-shared', agent_status: 'idle' }] } }));
} else {
  process.stdout.write('{}');
}
`);
  chmodSync(fakeHerdr, 0o755);

  return { dataDir, binDir, logPath, session };
}

function runCli(
  fixture: Pick<ReturnType<typeof makeFixture>, 'dataDir' | 'binDir' | 'logPath'>,
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
      SESSION_DATA_DIR: fixture.dataDir,
      HERDR_TEST_LOG: fixture.logPath,
    };
    for (const key of [
      'BOTMUX_SESSION_ID',
      'BOTMUX_LARK_APP_ID',
      'BOTMUX_SEND_RELAY',
      'BOTMUX_DAEMON_IPC_PORT',
    ]) {
      delete env[key];
    }
    const child = spawnTsScript(CLI_PATH, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
}

function readLog(path: string): string[][] {
  const raw = readFileSync(path, 'utf8').trim();
  return raw ? raw.split('\n').map(line => JSON.parse(line)) : [];
}

describe('CLI persisted backend targets', () => {
  it('list probes and displays the exact shared Herdr agent instead of auto-pruning it', async () => {
    const fixture = makeFixture();
    const result = await runCli(fixture, ['list', '--plain']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('shared-herdr-target');
    expect(result.stdout).toContain('herdr: work/agent-a');
    expect(readLog(fixture.logPath)).toContainEqual(['--session', 'work', 'agent', 'list']);
    expect(storedSession(fixture.dataDir, fixture.session.sessionId).status).toBe('active');
  });

  it('offline delete closes only the persisted Herdr agent, never a derived whole session', async () => {
    const fixture = makeFixture();
    const result = await runCli(fixture, ['delete', fixture.session.sessionId]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('daemon 离线，本地收口');
    const calls = readLog(fixture.logPath);
    expect(calls).toContainEqual(['--session', 'work', 'agent', 'list']);
    expect(calls).toContainEqual(['--session', 'work', 'pane', 'close', 'pane-shared']);
    expect(calls.some(args => args.includes('bmx-abcdef12'))).toBe(false);
    expect(calls.some(args => args[0] === 'session' && (args[1] === 'stop' || args[1] === 'delete'))).toBe(false);
    expect(storedSession(fixture.dataDir, fixture.session.sessionId).status).toBe('closed');
  });

  it('keeps an offline ZMX session active when exact ownership cannot be proved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-cli-zmx-target-'));
    tempDirs.push(root);
    const dataDir = join(root, 'data');
    const binDir = join(root, 'bin');
    const logPath = join(root, 'zmx.log');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    const sessionId = 'abcdef12-1111-2222-3333-444444444444';
    const sessionName = 'bmx-abcdef12';
    seedPersistedSessionRows(dataDir, undefined, {
      [sessionId]: {
        sessionId,
        chatId: 'oc_zmx_target',
        rootMessageId: 'om_zmx_target',
        title: 'owned-zmx-target',
        status: 'active',
        createdAt: '2026-07-30T00:00:00.000Z',
        cliId: 'codex',
        backendType: 'zmx',
        persistentBackendTarget: {
          backendType: 'zmx',
          sessionName,
        },
      },
    });

    const fakeZmx = join(binDir, 'zmx');
    writeFileSync(fakeZmx, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.HERDR_TEST_LOG, JSON.stringify(args) + '\\n');
if (args.join(' ') === 'list --short') {
  process.stdout.write('${sessionName}\\n');
} else if (args.join(' ') === 'list') {
  process.stdout.write('  name=${sessionName}\\tpid=4242\\tclients=0\\tcmd=codex\\n');
} else if (args[0] === 'get' && args[2] === 'botmux.transport') {
  process.stdout.write('tail-send-v1\\n');
} else if (args[0] === 'get' && args[2] === 'botmux.session') {
  process.stdout.write('different-complete-session-id\\n');
} else if (args[0] === 'get' && args[2] === 'botmux.launch_pid') {
  process.stdout.write('5151\\n');
} else if (args[0] === 'get' && args[2] === 'botmux.gate_nonce') {
  process.stdout.write('0123456789abcdef0123456789abcdef\\n');
} else if (args[0] === 'kill') {
  process.stderr.write('must not kill a mismatched owner\\n');
  process.exitCode = 9;
} else {
  process.stderr.write('unexpected zmx command: ' + args.join(' ') + '\\n');
  process.exitCode = 8;
}
`);
    chmodSync(fakeZmx, 0o755);

    const result = await runCli(
      { dataDir, binDir, logPath },
      ['delete', sessionId],
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('所有权标签不匹配');
    expect(result.stdout).toContain('已关闭 0 个会话');
    const calls = readLog(logPath);
    expect(calls.some(args => args[0] === 'kill')).toBe(false);
    const stored = storedSession(dataDir, sessionId);
    expect(stored.status).toBe('active');
    expect(stored.closedAt).toBeUndefined();
  });
});
