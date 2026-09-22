import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ordinaryOneShotRoutingAnchor } from '../src/im/lark/event-dispatcher.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

type RoutingEnv = {
  BOTMUX_ROUTING_ANCHOR: string | null;
  BOTMUX_SESSION_SCOPE: string | null;
  BOTMUX_ROOT_MESSAGE_ID: string | null;
};

type Harness = {
  child: ChildProcess;
  capturePath: string;
  expected: RoutingEnv;
  logs: string[];
  messages: WorkerToDaemon[];
  tmuxTmpDir?: string;
};

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();
const tmuxTmpDirs = new Set<string>();
const tmuxAvailable = probeTmuxFunctional().ok;

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise()));
  if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker);
  else child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise<void>(resolvePromise => setTimeout(resolvePromise, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

function killIsolatedTmuxServer(tmuxTmpDir: string): void {
  const env = { ...process.env, TMUX_TMPDIR: tmuxTmpDir };
  delete env.TMUX;
  delete env.TMUX_PANE;
  try {
    execFileSync('tmux', ['kill-server'], { env, stdio: 'ignore', timeout: 3_000 });
  } catch {
    // The worker's normal close path already removes its final session/server.
  }
}

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  children.clear();
  for (const tmuxTmpDir of tmuxTmpDirs) killIsolatedTmuxServer(tmuxTmpDir);
  tmuxTmpDirs.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function startOneShotWorker(backendType: 'pty' | 'tmux'): Harness {
  const root = mkdtempSync(join(tmpdir(), 'botmux-worker-one-shot-routing-'));
  tempDirs.add(root);
  const dataDir = join(root, 'data');
  const workingDir = join(root, 'project');
  const traeHome = join(root, '.trae');
  const tmuxTmpDir = join(root, 'tmux');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(join(traeHome, 'cli'), { recursive: true });
  mkdirSync(tmuxTmpDir, { recursive: true, mode: 0o700 });
  if (backendType === 'tmux') tmuxTmpDirs.add(tmuxTmpDir);

  const suffix = randomBytes(8).toString('hex');
  const sessionId = `one-shot-routing-${suffix}`;
  const appId = `app_one_shot_${suffix}`;
  const physicalMessageId = `om_turn_${suffix}`;
  const visibleRoot = `om_visible_root_${suffix}`;
  const routingAnchor = ordinaryOneShotRoutingAnchor(appId, physicalMessageId);
  const capturePath = join(root, 'routing-env.json');
  const fakeCli = join(root, 'fake-traex.mjs');
  writeFileSync(fakeCli, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write('fake traex 1.0.0\\n');
  process.exit(0);
}
writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  BOTMUX_ROUTING_ANCHOR: process.env.BOTMUX_ROUTING_ANCHOR ?? null,
  BOTMUX_SESSION_SCOPE: process.env.BOTMUX_SESSION_SCOPE ?? null,
  BOTMUX_ROOT_MESSAGE_ID: process.env.BOTMUX_ROOT_MESSAGE_ID ?? null,
}));
process.stdout.write('\\n› \\n');
process.stdin.resume();
setInterval(() => {}, 1_000);
`);
  chmodSync(fakeCli, 0o755);

  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      TRAE_HOME: traeHome,
      TMUX_TMPDIR: tmuxTmpDir,
      NODE_ENV: 'test',
      BOTMUX_SANDBOX: '0',
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: sessionId,
      LARK_APP_ID: appId,
      LARK_APP_SECRET: 'secret',
      // Prove applyInitRoutingEnv replaces ambient values rather than merely
      // allowing already-correct process state to leak into the CLI.
      BOTMUX_ROUTING_ANCHOR: 'stale-routing-anchor',
      BOTMUX_SESSION_SCOPE: 'thread',
      BOTMUX_ROOT_MESSAGE_ID: 'om_stale_root',
    },
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

  child.send({
    type: 'init',
    sessionId,
    chatId: `oc_one_shot_${suffix}`,
    chatType: 'group',
    routingAnchor,
    // An om_ root would infer "thread" in the legacy fallback. Keeping the
    // explicit one-shot scope "chat" proves the exact IPC tuple survives.
    scope: 'chat',
    rootMessageId: visibleRoot,
    replyTarget: { mode: 'thread', rootMessageId: visibleRoot },
    workingDir,
    cliId: 'traex',
    cliPathOverride: fakeCli,
    backendType,
    prompt: '<user_message>capture the one-shot routing environment</user_message>',
    resume: false,
    disableCrossSessionMemories: true,
    larkAppId: appId,
    larkAppSecret: 'secret',
    turnId: physicalMessageId,
    replyTurnId: physicalMessageId,
    launchShell: process.platform === 'win32' ? undefined : '/bin/sh',
  } satisfies DaemonToWorker);

  return {
    child,
    capturePath,
    expected: {
      BOTMUX_ROUTING_ANCHOR: routingAnchor,
      BOTMUX_SESSION_SCOPE: 'chat',
      BOTMUX_ROOT_MESSAGE_ID: visibleRoot,
    },
    logs,
    messages,
    ...(backendType === 'tmux' ? { tmuxTmpDir } : {}),
  };
}

async function waitForSpawnedCliEnvironment(harness: Harness): Promise<RoutingEnv> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const ready = harness.messages.some(message => message.type === 'ready');
    if (ready && existsSync(harness.capturePath)) {
      try {
        return JSON.parse(readFileSync(harness.capturePath, 'utf8')) as RoutingEnv;
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        // The existence check can briefly win the race with writeFileSync's
        // truncate-and-write sequence. Retry until the JSON is complete.
      }
    }
    if (harness.child.exitCode !== null || harness.child.signalCode !== null) {
      throw new Error(`worker exited before the fake CLI captured its environment\n${harness.logs.join('')}`);
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timed out waiting for worker ready and fake CLI environment\n${harness.logs.join('')}`);
}

async function expectRoutingTupleThrough(backendType: 'pty' | 'tmux'): Promise<void> {
  const harness = startOneShotWorker(backendType);
  const actual = await waitForSpawnedCliEnvironment(harness);

  expect(harness.expected.BOTMUX_ROUTING_ANCHOR)
    .toMatch(/^ordinary-one-shot-v1:route:[0-9a-f]{64}$/);
  expect(harness.expected.BOTMUX_ROUTING_ANCHOR).not.toMatch(/[\u0000-\u001f\u007f]/);
  expect(actual).toEqual(harness.expected);
}

describe('worker ordinary one-shot routing environment', () => {
  it('passes the exact printable init routing tuple through a real PTY spawn', async () => {
    await expectRoutingTupleThrough('pty');
  }, 30_000);

  it.skipIf(!tmuxAvailable)('passes the exact printable init routing tuple through a real tmux spawn', async () => {
    await expectRoutingTupleThrough('tmux');
  }, 30_000);
});
