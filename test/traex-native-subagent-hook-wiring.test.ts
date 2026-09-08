import { execFileSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { isBunRuntime, spawnTsScript } from './helpers/ts-runner.js';

type LaunchRecord = {
  argv: string[];
  env: Record<string, string | null>;
};

type InitMessage = Extract<DaemonToWorker, { type: 'init' }>;

interface WorkerHarness {
  child: ChildProcess;
  capturePath: string;
  globalHooksPath: string;
  globalHooksBefore: string;
  logs: string[];
  messages: WorkerToDaemon[];
  projectHooksPath: string;
  projectHooksBefore: string;
  root: string;
  sessionId: string;
}

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();
const tmuxSessions = new Set<string>();
let sequence = 0;

const tmuxAvailable = probeTmuxFunctional().ok;
const directPtyUnavailableInBun = isBunRuntime();
const DIRECT_PTY_BUN_SKIP_REASON =
  'Bun 1.4.0 direct node-pty exits the fake CLI immediately with code 0 / signal 1 before the recorder runs; keep tmux/RPC coverage live.';

function hookOverrides(argv: string[]): string[] {
  return argv.flatMap((arg, index) =>
    arg === '-c' && argv[index + 1]?.startsWith('hooks.PreToolUse=')
      ? [argv[index + 1]!]
      : []);
}

function expectSingleNativeHook(record: LaunchRecord): void {
  const overrides = hookOverrides(record.argv);
  expect(overrides).toHaveLength(1);
  expect(overrides[0]).toContain('matcher="spawn_agent"');
  expect(overrides[0]).toContain('native-subagent-runtime-hook');
  expect(record.argv.join(' ').match(/native-subagent-runtime-hook/g)).toHaveLength(1);
}

function readLaunches(path: string): LaunchRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap(line => {
    if (!line) return [];
    try { return [JSON.parse(line) as LaunchRecord]; } catch { return []; }
  });
}

async function waitFor(
  harness: WorkerHarness,
  predicate: () => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (harness.child.exitCode !== null || harness.child.signalCode !== null) {
      throw new Error(`worker exited before ${description}\n${harness.logs.join('')}`);
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timed out waiting for ${description}\n${harness.logs.join('')}`);
}

function nonProbeLaunches(harness: WorkerHarness): LaunchRecord[] {
  return readLaunches(harness.capturePath).filter(record => record.argv[0] !== '--version');
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise()));
  if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker);
  else child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise<void>(resolvePromise => setTimeout(resolvePromise, 3_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function makeHarness(options: {
  cliId: 'traex' | 'codex';
  backendType: 'pty' | 'tmux';
  resume?: boolean;
  cliSessionId?: string;
  codexRpcInput?: boolean;
}): WorkerHarness {
  const root = mkdtempSync(join(tmpdir(), 'botmux-traex-launch-'));
  tempDirs.add(root);
  const dataDir = join(root, 'data');
  const workingDir = join(root, 'project');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(root, '.trae'), { recursive: true });
  mkdirSync(join(workingDir, '.trae'), { recursive: true });
  const globalHooksPath = join(root, '.trae', 'hooks.json');
  const projectHooksPath = join(workingDir, '.trae', 'hooks.json');
  const globalHooksBefore = '{"hooks":{"PreToolUse":[{"matcher":"Read","hooks":[]}]}}\n';
  const projectHooksBefore = '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[]}]}}\n';
  writeFileSync(globalHooksPath, globalHooksBefore);
  writeFileSync(projectHooksPath, projectHooksBefore);

  const capturePath = join(root, 'launches.jsonl');
  const fakeCli = join(root, 'fake-cli.mjs');
  writeFileSync(fakeCli, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const argv = process.argv.slice(2);
const keys = [
  'BOTMUX_SESSION_ID', 'BOTMUX_CHAT_ID', 'BOTMUX_LARK_APP_ID',
  'BOTMUX_ROOT_MESSAGE_ID', 'BOTMUX_SESSION_SCOPE',
  'BOTMUX_OWNER_OPEN_ID', '__OWNER_OPEN_ID',
  'LARK_APP_ID', 'LARK_APP_SECRET', 'BOTMUX_LARK_APP_SECRET',
];
const env = Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]));
appendFileSync(process.env.LAUNCH_CAPTURE_PATH, JSON.stringify({ argv, env }) + '\\n');
if (argv[0] === '--version') {
  process.stdout.write('fake cli 1.0.0\\n');
  process.exit(0);
}
if (argv[0] === 'app-server') {
  await import(pathToFileURL(process.env.RPC_FIXTURE_PATH).href);
} else {
  process.stdout.write('\\n› \\n');
  process.stdin.resume();
  setInterval(() => {}, 1000);
}
`);
  chmodSync(fakeCli, 0o755);

  const sessionId = `h${(++sequence).toString(36)}${process.pid.toString(36)}${Date.now().toString(36)}`;
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  const workerEnv = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    NODE_ENV: 'test',
    BOTMUX_SANDBOX: '0',
    SESSION_DATA_DIR: dataDir,
    BOTMUX_SESSION_ID: sessionId,
    LARK_APP_ID: 'ambient-app-id-must-be-redacted',
    LARK_APP_SECRET: 'ambient-secret-must-be-redacted',
  };
  const child = spawnTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: workerEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.on('message', raw => {
    const message = raw as WorkerToDaemon;
    messages.push(message);
    if (message.type === 'error') logs.push(`[worker-ipc-error] ${message.message}\n`);
  });

  const init: InitMessage = {
    type: 'init',
    sessionId,
    chatId: 'oc_hook_test',
    chatType: 'group',
    rootMessageId: 'om_hook_root',
    workingDir,
    cliId: options.cliId,
    cliPathOverride: fakeCli,
    backendType: options.backendType,
    prompt: options.codexRpcInput ? 'exercise rpc launch' : '',
    larkAppId: 'app_hook_test',
    larkAppSecret: 'init-secret-must-be-redacted',
    ownerOpenId: 'ou_hook_owner',
    launchShell: process.platform === 'win32' ? undefined : '/bin/sh',
    env: {
      LAUNCH_CAPTURE_PATH: capturePath,
      RPC_FIXTURE_PATH: resolve('test/fixtures/fake-codex-rpc-server.mjs'),
    },
    resume: options.resume,
    cliSessionId: options.cliSessionId,
    codexRpcInput: options.codexRpcInput,
    ...(options.codexRpcInput
      ? {
          cliRuntime: {
            id: 'fake-trae',
            displayName: 'Fake Trae',
            executable: fakeCli,
            source: 'configured',
            update: { provider: 'none' },
          },
        }
      : {}),
  };
  child.send(init);

  if (options.backendType === 'tmux') tmuxSessions.add(`bmx-${sessionId.slice(0, 8)}`);
  return {
    child, capturePath, globalHooksPath, globalHooksBefore, logs, messages,
    projectHooksPath, projectHooksBefore, root, sessionId,
  };
}

function expectAuthenticatedSessionEnv(record: LaunchRecord, sessionId: string): void {
  expect(record.env).toMatchObject({
    BOTMUX_SESSION_ID: sessionId,
    BOTMUX_CHAT_ID: 'oc_hook_test',
    BOTMUX_LARK_APP_ID: 'app_hook_test',
    BOTMUX_ROOT_MESSAGE_ID: 'om_hook_root',
    BOTMUX_OWNER_OPEN_ID: 'ou_hook_owner',
    __OWNER_OPEN_ID: 'ou_hook_owner',
    LARK_APP_ID: null,
    LARK_APP_SECRET: null,
    BOTMUX_LARK_APP_SECRET: null,
  });
  expect(JSON.stringify(record)).not.toContain('ambient-secret-must-be-redacted');
  expect(JSON.stringify(record)).not.toContain('init-secret-must-be-redacted');
}

function expectHookFilesUnchanged(harness: WorkerHarness): void {
  // This is the strongest deterministic seam available without running a real
  // Trae binary: worker launch must leave both persisted hook layers byte-for-
  // byte intact. Proving that Trae executes all three layers belongs to the
  // Task 6 live smoke, where the real CLI owns the merge semantics.
  expect(readFileSync(harness.globalHooksPath, 'utf8')).toBe(harness.globalHooksBefore);
  expect(readFileSync(harness.projectHooksPath, 'utf8')).toBe(harness.projectHooksBefore);
}

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  children.clear();
  for (const session of tmuxSessions) {
    try { execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' }); } catch { /* gone */ }
  }
  tmuxSessions.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe('TRAE native subagent hook worker launches', () => {
  it.skipIf(directPtyUnavailableInBun).each([
    ['fresh', false, undefined],
    ['resume', true, 'trae-native-session'],
  ] as const)(
    // Bun 1.4.0 cannot keep the fake CLI alive under direct node-pty here.
    // Existing Bun-running evidence stays in test/cli-adapters.test.ts:
    //  - "adds one process-scoped native subagent hook for resume=%s"
    //  - "does not attach the native subagent hook to the remote viewer"
    //  - "does not attach the Trae-only hook argument to another adapter"
    // This file keeps the real worker coverage on Node/Vitest and still runs
    // the real tmux/RPC worker paths on Bun.
    `launches a Trae %s PTY with one hook and authenticated non-secret env (${DIRECT_PTY_BUN_SKIP_REASON})`,
    async (_label, resume, cliSessionId) => {
    const harness = makeHarness({ cliId: 'traex', backendType: 'pty', resume, cliSessionId });
    await waitFor(harness, () => (
      harness.messages.some(message => message.type === 'ready')
      && nonProbeLaunches(harness).length === 1
    ), 'worker ready and CLI launch capture');
    const launches = nonProbeLaunches(harness);
    expect(launches).toHaveLength(1);
    const [launch] = launches;
    expectSingleNativeHook(launch);
    if (resume) {
      expect(launch.argv[0]).toBe('resume');
      expect(launch.argv.at(-1)).toBe(cliSessionId);
    } else {
      expect(launch.argv[0]).not.toBe('resume');
    }
    expectAuthenticatedSessionEnv(launch, harness.sessionId);
    expectHookFilesUnchanged(harness);
  }, 20_000);

  it.skipIf(!tmuxAvailable)('launches a persistent Trae tmux pane with the same one-hook/env contract', async () => {
    const harness = makeHarness({ cliId: 'traex', backendType: 'tmux' });
    await waitFor(harness, () => (
      harness.messages.some(message => message.type === 'ready')
      && nonProbeLaunches(harness).length === 1
    ), 'tmux worker ready and CLI launch capture');
    const launches = nonProbeLaunches(harness);
    expect(launches).toHaveLength(1);
    expectSingleNativeHook(launches[0]);
    expectAuthenticatedSessionEnv(launches[0], harness.sessionId);
    expectHookFilesUnchanged(harness);
  }, 25_000);

  it.skipIf(!tmuxAvailable)('puts the hook on the Trae RPC app-server but not its remote viewer', async () => {
    const harness = makeHarness({ cliId: 'traex', backendType: 'tmux', codexRpcInput: true });
    await waitFor(
      harness,
      () => {
        const launches = readLaunches(harness.capturePath);
        return launches.some(record => record.argv[0] === 'app-server')
          && launches.some(record => record.argv[0] === '--remote')
          && harness.messages.some(message => message.type === 'ready');
      },
      'Trae app-server and remote viewer launches',
      20_000,
    );
    const launches = readLaunches(harness.capturePath);
    const appServer = launches.find(record => record.argv[0] === 'app-server');
    const viewer = launches.find(record => record.argv[0] === '--remote');
    expect(appServer).toBeDefined();
    expect(viewer).toBeDefined();
    expectSingleNativeHook(appServer!);
    expect(appServer!.argv).toContain('default_mode_request_user_input');
    expect(hookOverrides(viewer!.argv)).toEqual([]);
    expect(viewer!.argv).toEqual([
      '--remote', expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
      'resume', '--no-alt-screen', '-c', 'check_for_update_on_startup=false', 'thread-fake-1',
    ]);
    expectAuthenticatedSessionEnv(appServer!, harness.sessionId);
    expectAuthenticatedSessionEnv(viewer!, harness.sessionId);
    expect(appServer!.env.BOTMUX_SESSION_SCOPE).toBe('thread');
    expectHookFilesUnchanged(harness);
  }, 25_000);

  it.skipIf(directPtyUnavailableInBun)(`keeps a non-Trae worker launch free of the Trae hook (${DIRECT_PTY_BUN_SKIP_REASON})`, async () => {
    const harness = makeHarness({ cliId: 'codex', backendType: 'pty' });
    await waitFor(harness, () => (
      harness.messages.some(message => message.type === 'ready')
      && nonProbeLaunches(harness).length === 1
    ), 'Codex worker ready and CLI launch capture');
    const launches = nonProbeLaunches(harness);
    expect(launches).toHaveLength(1);
    expect(hookOverrides(launches[0].argv)).toEqual([]);
    expectAuthenticatedSessionEnv(launches[0], harness.sessionId);
    expectHookFilesUnchanged(harness);
  }, 20_000);

  it.skipIf(!tmuxAvailable)('keeps both processes in a non-Trae RPC launch free of the Trae hook', async () => {
    const harness = makeHarness({ cliId: 'codex', backendType: 'tmux', codexRpcInput: true });
    await waitFor(
      harness,
      () => {
        const launches = readLaunches(harness.capturePath);
        return launches.some(record => record.argv[0] === 'app-server')
          && launches.some(record => record.argv[0] === '--remote')
          && harness.messages.some(message => message.type === 'ready');
      },
      'Codex app-server and remote viewer launches',
      20_000,
    );
    const launches = readLaunches(harness.capturePath);
    const appServer = launches.find(record => record.argv[0] === 'app-server');
    const viewer = launches.find(record => record.argv[0] === '--remote');
    expect(appServer).toBeDefined();
    expect(viewer).toBeDefined();
    expect(hookOverrides(appServer!.argv)).toEqual([]);
    expect(hookOverrides(viewer!.argv)).toEqual([]);
    expectAuthenticatedSessionEnv(appServer!, harness.sessionId);
    expectAuthenticatedSessionEnv(viewer!, harness.sessionId);
    expectHookFilesUnchanged(harness);
  }, 25_000);
});
