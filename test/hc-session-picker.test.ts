/**
 * `botmux list` Enter on an hc row takes the hc attach path: the row is
 * attachable through the core it recorded, a core that is not running is
 * refused rather than started, and an owned live terminal is attached until
 * Ctrl+\ detaches it, leaving it running.
 *
 * Run:  BOTMUX_HC_TEST_BIN=<herdr-core> npx vitest run --project unit test/hc-session-picker.test.ts
 */
import * as pty from 'node-pty';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { isBunRuntime, nodeTsRunnerPrefix, spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { ensureHcCore, hcControlEnv, hcCoreAddress, hcCorePaths, type HcCoreAddress } from '../src/adapters/backend/hc/core.js';
import { resetHcAvailabilityCache } from '../src/setup/ensure-hc.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(TEST_DIR, '..', 'src', 'cli.ts');
const FRAME_END = '↑/↓ 选择';
const tempDirs: string[] = [];
const children: pty.IPty[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch { /* already exited */ }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seedHcRow(dataDir: string, sessionId: string, target: { sessionName: string } & HcCoreAddress): void {
  seedPersistedSessionRows(dataDir, 'picker-hc', {
    [sessionId]: {
      sessionId,
      chatId: 'oc_picker_hc',
      rootMessageId: 'om_picker_hc',
      title: 'hc-picker-row',
      workingDir: '/tmp',
      status: 'active',
      createdAt: '2026-07-30T00:00:00.000Z',
      cliId: 'codex',
      backendType: 'hc',
      persistentBackendTarget: { backendType: 'hc', ...target },
      lastCliInput: 'hello',
      pid: process.pid,
    },
  });
}

interface Picker {
  child: pty.IPty;
  output: () => string;
  waitForOutput: (text: string, from?: number) => Promise<void>;
  waitForExit: () => Promise<number>;
}

function spawnPicker(root: string, dataDir: string, extraEnv: Record<string, string> = {}): Picker {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: root,
    SESSION_DATA_DIR: dataDir,
    TERM: 'xterm-256color',
    ...extraEnv,
  };
  for (const key of ['BOTMUX_SESSION_ID', 'BOTMUX_LARK_APP_ID', 'BOTMUX_SEND_RELAY', 'BOTMUX_DAEMON_IPC_PORT']) delete env[key];
  const { command, prefixArgs } = nodeTsRunnerPrefix();
  const child = pty.spawn(command, [...prefixArgs, CLI_PATH, 'list'], {
    cwd: join(TEST_DIR, '..'), env, cols: 120, rows: 30, name: 'xterm-256color',
  });
  children.push(child);
  let raw = '';
  let exitCode: number | undefined;
  const pending = new Set<() => void>();
  const recheck = () => { for (const check of [...pending]) check(); };
  child.onData(data => { raw += data; recheck(); });
  child.onExit(event => { exitCode = event.exitCode; recheck(); });
  onTestFinished(({ task }) => {
    if (task.result?.state === 'fail') console.error(`picker output: ${JSON.stringify(raw.slice(-3000))}`);
  });
  const waitUntil = (done: () => boolean, what: string, allowExit = false) => new Promise<void>((resolve, reject) => {
    const check = () => {
      if (done()) { pending.delete(check); resolve(); }
      else if (exitCode !== undefined && !allowExit) {
        pending.delete(check);
        reject(new Error(`picker exited (${exitCode}) before ${what}: ${JSON.stringify(raw.slice(-800))}`));
      }
    };
    pending.add(check);
    check();
  });
  return {
    child,
    output: () => raw,
    waitForOutput: (text, from = 0) => waitUntil(() => raw.indexOf(text, from) >= 0, JSON.stringify(text)),
    waitForExit: async () => {
      await waitUntil(() => exitCode !== undefined, 'exit', true);
      return exitCode!;
    },
  };
}

describe.runIf(!isBunRuntime())('botmux list on an hc row', () => {
  it('offers the row for attach and refuses Enter when its core is not running, without starting one', async () => {
    const sessionId = 'abcdef12-1111-4222-8333-444444444444';
    const sessionName = 'bmx-abcdef12';
    const root = mkdtempSync('/tmp/bmhcp-');
    tempDirs.push(root);
    const dataDir = join(root, 'data');
    const runtimeDir = join(root, 'run');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    const socket = join(runtimeDir, 'herdr-core', 'botmux.sock');
    // A holder keeps the program while its core is down: the listing asks hc,
    // the attach finds no core.
    mkdirSync(dirname(socket));
    writeFileSync(join(dirname(socket), 'botmux.holder.0a1b2c3d.sock'), '');
    seedHcRow(dataDir, sessionId, { sessionName, hcSession: 'botmux', socket });
    const logPath = join(root, 'hc.log');
    const live = JSON.stringify({
      address: 't3', name: sessionName, labels: { botmux: '1', botmux_sid: sessionId }, state: 'live',
      pid: 4242, exit_code: null, signal: null, reason: null, cols: 120, rows: 30,
    });
    const hcBin = join(root, 'herdr-core');
    writeFileSync(hcBin, `#!/bin/sh
printf '%s\\n' "$*" >> '${logPath}'
case "$*" in
  --version) echo 'hc 0.1.19' ;;
  '--json ls --all') printf '%s' '{"terminals":[${live}]}' ;;
  *) echo "unexpected hc command: $*" >&2; exit 8 ;;
esac
`, { mode: 0o755 });

    const picker = spawnPicker(root, dataDir, { BOTMUX_HC_BIN: hcBin });
    await picker.waitForOutput(FRAME_END);
    expect(picker.output()).toContain(`hc: ${sessionName}`);
    expect(picker.output()).not.toContain('不可连接');

    picker.child.write('\r');
    await picker.waitForOutput('attach 不会替它启动');
    expect(picker.output()).toContain(socket);
    expect(existsSync(socket)).toBe(false);
    expect(readFileSync(logPath, 'utf8')).not.toMatch(/attach|server/);
    picker.child.write('q');
    await picker.waitForExit();
  }, 60_000);
});

describe('__hc-attach-managed (the Dashboard local-attach entrypoint)', () => {
  it('rejects incomplete arguments and refuses a recorded core that is not running', () => {
    const root = mkdtempSync('/tmp/bmhcp-');
    tempDirs.push(root);
    const runtimeDir = join(root, 'run');
    mkdirSync(runtimeDir, { recursive: true });
    const socket = join(runtimeDir, 'herdr-core', 'botmux.sock');
    const logPath = join(root, 'hc.log');
    const hcBin = join(root, 'herdr-core');
    writeFileSync(hcBin, `#!/bin/sh
printf '%s\\n' "$*" >> '${logPath}'
[ "$*" = --version ] && echo 'hc 0.1.19' && exit 0
exit 8
`, { mode: 0o755 });
    const env = { ...process.env, BOTMUX_HC_BIN: hcBin, SESSION_DATA_DIR: join(root, 'data') };
    const run = (args: string[]) => spawnSyncTsScript(CLI_PATH, ['__hc-attach-managed', ...args], { env, encoding: 'utf8' });

    expect(run(['bmx-abcdef12', 'abcdef12-1111-4222-8333-444444444444']).status).toBe(2);

    const refused = run(['bmx-abcdef12', 'abcdef12-1111-4222-8333-444444444444', 'botmux', socket]);
    expect(refused.status).toBe(1);
    expect(String(refused.stderr)).toContain('不会替它启动');
    expect(existsSync(socket)).toBe(false);
    expect(readFileSync(logPath, 'utf8').trim()).toBe('--version');
  }, 60_000);
});

const realHc = process.env.BOTMUX_HC_TEST_BIN;

describe.runIf(!isBunRuntime() && !!realHc)('botmux list attaches an owned hc terminal with the real binary', () => {
  let home: HcCoreAddress;

  beforeAll(async () => {
    if (!process.env.BOTMUX_HC_BIN) throw new Error('the hc test fence did not set BOTMUX_HC_BIN');
    resetHcAvailabilityCache();
    home = hcCoreAddress(hcCorePaths(process.env));
    await ensureHcCore();
  }, 60_000);

  afterAll(() => {
    if (home) hc(['server', 'stop']);
    resetHcAvailabilityCache();
  });

  function hc(args: string[]) {
    const result = spawnSync(process.env.BOTMUX_HC_BIN!, args, {
      env: hcControlEnv(process.env, hcCorePaths(process.env, { core: home })),
      cwd: '/',
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('attaches by the verified address and Ctrl+\\ detaches, leaving the terminal live', async () => {
    const sessionId = randomUUID();
    const sessionName = `bmx-${sessionId.slice(0, 8)}`;
    const ran = hc([
      '--json', 'run', '--bg', '--name', sessionName,
      '--label', 'botmux=1', '--label', `botmux_sid=${sessionId}`,
      '--no-parent', '--no-notify', '--', 'sh', '-c', 'printf "HC-PICKER-%s\\n" READY; exec sleep 600',
    ]);
    expect(ran.status, ran.stderr).toBe(0);
    const address = JSON.parse(ran.stdout).address as string;
    try {
      const root = mkdtempSync('/tmp/bmhcp-');
      tempDirs.push(root);
      const dataDir = join(root, 'data');
      mkdirSync(dataDir, { recursive: true });
      seedHcRow(dataDir, sessionId, { sessionName, ...home });

      const picker = spawnPicker(root, dataDir);
      await picker.waitForOutput(FRAME_END);
      expect(picker.output()).not.toContain('不可连接');
      const beforeEnter = picker.output().length;
      picker.child.write('\r');
      await picker.waitForOutput('HC-PICKER-READY', beforeEnter);
      picker.child.write('\x1c');
      expect(await picker.waitForExit()).toBe(0);

      const after = hc(['--json', 'get', address]);
      expect(after.status, after.stderr).toBe(0);
      expect(JSON.parse(after.stdout)).toMatchObject({ name: sessionName, state: 'live' });
    } finally {
      hc(['--json', 'kill', address]);
      hc(['--json', 'rm', address]);
    }
  }, 90_000);
});
