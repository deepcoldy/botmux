import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach } from 'vitest';
import { WebSocket } from 'ws';
import type { DaemonToWorker, WorkerToDaemon } from '../../src/types.js';

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();

export const READ_ONLY_SCROLL_SESSION_BUDGET = 12;
export const WHEEL_UP = '\x1b[<64;12;8M';
export const WHEEL_UP_HEX = Buffer.from(WHEEL_UP).toString('hex');
export const FORGED_INPUT = 'FORGED_INPUT\n';
export const FORGED_INPUT_HEX = Buffer.from(FORGED_INPUT).toString('hex');

type ReadyMessage = Extract<WorkerToDaemon, { type: 'ready' }>;
type ErrorMessage = Extract<WorkerToDaemon, { type: 'error' }>;
type TestCliId = 'opencode' | 'opencode2';

type WorkerHarness = {
  readonly child: ChildProcess;
  readonly inputLog: string;
  readonly ready: ReadyMessage;
};

type StableCountOptions = {
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly stablePolls: number;
  readonly minimumCount: number;
};

const DEFAULT_STABLE_COUNT_OPTIONS = {
  timeoutMs: 5_000,
  pollMs: 25,
  stablePolls: 8,
  minimumCount: 0,
} satisfies StableCountOptions;

class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessError';
  }
}

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function hasMessageType(raw: unknown, type: WorkerToDaemon['type']): raw is { readonly type: WorkerToDaemon['type'] } {
  return typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === type;
}

function isReadyMessage(raw: unknown): raw is ReadyMessage {
  return hasMessageType(raw, 'ready');
}

function isErrorMessage(raw: unknown): raw is ErrorMessage {
  return hasMessageType(raw, 'error') && 'message' in raw && typeof raw.message === 'string';
}

function waitForReady(child: ChildProcess, logs: readonly string[]): Promise<ReadyMessage> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new HarnessError(`worker ready timeout\n${logs.join('')}`));
    }, 15_000);
    child.on('message', (raw: unknown) => {
      if (isReadyMessage(raw)) {
        clearTimeout(timer);
        resolvePromise(raw);
      } else if (isErrorMessage(raw)) {
        clearTimeout(timer);
        rejectPromise(new HarnessError(`worker error: ${raw.message}\n${logs.join('')}`));
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      rejectPromise(new HarnessError(`worker exited before ready (${code ?? signal})\n${logs.join('')}`));
    });
  });
}

export async function startOpenCodeWorker(cliId: TestCliId = 'opencode'): Promise<WorkerHarness> {
  const root = mkdtempSync(join(tmpdir(), 'botmux-readonly-scroll-'));
  tempDirs.add(root);
  const dataDir = join(root, 'session');
  mkdirSync(dataDir, { recursive: true });

  const botmuxDir = join(root, '.botmux');
  mkdirSync(botmuxDir, { recursive: true });
  writeFileSync(join(botmuxDir, '.dashboard-secret'), 'integration-host-dashboard-secret', { mode: 0o600 });

  const fakeCli = join(root, 'fake-opencode');
  const inputLog = join(root, 'terminal-input.hex');
  writeFileSync(fakeCli, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', chunk => appendFileSync(${JSON.stringify(inputLog)}, chunk.toString('hex') + '\\n'));
setInterval(() => {}, 1_000);
`);
  chmodSync(fakeCli, 0o755);

  const logs: string[] = [];
  const sessionId = `readonly-scroll-${cliId}`;
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: sessionId,
      LARK_APP_ID: 'app_readonly_scroll',
      LARK_APP_SECRET: 'secret',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));

  child.send({
    type: 'init',
    sessionId,
    chatId: `oc_${sessionId}`,
    rootMessageId: `om_${sessionId}`,
    workingDir: dataDir,
    cliId,
    cliPathOverride: fakeCli,
    backendType: 'pty',
    prompt: '',
    larkAppId: 'app_readonly_scroll',
    larkAppSecret: 'secret',
  } satisfies DaemonToWorker);

  const ready = await waitForReady(child, logs);
  return { child, inputLog, ready };
}

function viewWebSocketUrl(harness: WorkerHarness): string {
  if (!harness.ready.viewToken) throw new HarnessError('worker ready message did not include a view token');
  return `ws://127.0.0.1:${harness.ready.port}/?viewToken=${encodeURIComponent(harness.ready.viewToken)}`;
}

function openWebSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      ws.terminate();
      rejectPromise(new HarnessError('websocket open timeout'));
    }, 5_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolvePromise(ws);
    });
    ws.once('error', err => {
      clearTimeout(timer);
      rejectPromise(err);
    });
  });
}

export async function openViewSocket(harness: WorkerHarness): Promise<WebSocket> {
  return openWebSocket(viewWebSocketUrl(harness));
}

export function closeWorker(child: ChildProcess): void {
  if (child.connected && child.exitCode === null && child.signalCode === null) {
    child.send({ type: 'close' } satisfies DaemonToWorker);
  }
}

export function closeSocket(ws: WebSocket): void {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset < text.length) {
    const found = text.indexOf(needle, offset);
    if (found === -1) return count;
    count += 1;
    offset = found + needle.length;
  }
  return count;
}

export function readTextIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

export async function waitForStableOccurrenceCount(
  path: string,
  needle: string,
  overrides: Partial<StableCountOptions> = {},
): Promise<number> {
  const options = { ...DEFAULT_STABLE_COUNT_OPTIONS, ...overrides };
  const deadline = Date.now() + options.timeoutMs;
  let lastCount = -1;
  let stablePolls = 0;

  while (Date.now() < deadline) {
    const count = countOccurrences(readTextIfPresent(path), needle);
    if (count === lastCount) {
      stablePolls += 1;
      if (count >= options.minimumCount && stablePolls >= options.stablePolls) return count;
    } else {
      lastCount = count;
      stablePolls = 0;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, options.pollMs));
  }

  return Math.max(lastCount, 0);
}

export function sendScroll(ws: WebSocket): void {
  ws.send(JSON.stringify({ type: 'scroll', data: WHEEL_UP }));
}
