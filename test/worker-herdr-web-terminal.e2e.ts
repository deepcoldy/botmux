import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { HerdrBackend } from '../src/adapters/backend/herdr-backend.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const children = new Set<ChildProcess>();
const sessions = new Set<string>();
const tempDirs = new Set<string>();

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const session of sessions) HerdrBackend.killSession(session);
  sessions.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

async function waitFor<T>(
  probe: () => T | null | undefined | false,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

function spawnWorker(dataDir: string, sessionId: string, logs: string[]): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: sessionId,
      LARK_APP_ID: 'app_worker_herdr_e2e',
      LARK_APP_SECRET: 'secret',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  return child;
}

function waitForReady(
  child: ChildProcess,
  logs: string[],
): Promise<Extract<WorkerToDaemon, { type: 'ready' }>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`worker ready timeout\n${logs.join('')}`));
    }, 20_000);
    child.on('message', raw => {
      const msg = raw as WorkerToDaemon;
      if (msg.type === 'ready') {
        clearTimeout(timer);
        resolvePromise(msg);
      } else if (msg.type === 'error') {
        clearTimeout(timer);
        rejectPromise(new Error(`worker error: ${msg.message}\n${logs.join('')}`));
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      rejectPromise(new Error(`worker exited before ready (${code ?? signal})\n${logs.join('')}`));
    });
  });
}

async function openWriteWebSocket(ready: Extract<WorkerToDaemon, { type: 'ready' }>): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/?token=${encodeURIComponent(ready.token)}`);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('websocket open timeout')), 5_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolvePromise();
    });
    ws.once('error', err => {
      clearTimeout(timer);
      rejectPromise(err);
    });
  });
  return ws;
}

function latestSizeRecord(path: string): { pid: string; size: string; count: number } | null {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  const [pid, rows, cols] = lines.at(-1)!.split(/\s+/);
  return { pid, size: `${rows} ${cols}`, count: lines.length };
}

function agentPaneId(sessionName: string): string {
  const raw = execFileSync(
    'herdr',
    ['--session', sessionName, 'agent', 'get', 'botmux'],
    { encoding: 'utf8', timeout: 5_000 },
  );
  const paneId = JSON.parse(raw)?.result?.agent?.pane_id;
  if (typeof paneId !== 'string' || !paneId) throw new Error('missing Herdr pane id');
  return paneId;
}

function terminalBufferText(renderer: TerminalRenderer): string {
  const buffer = renderer.xterm.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index++) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
}

describe('worker Herdr web terminal lifecycle', () => {
  it.skipIf(!HerdrBackend.isAvailable())(
    'restores the connected browser grid automatically after an in-worker restart',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'botmux-herdr-restart-'));
      tempDirs.add(root);
      const sizeLog = join(root, 'sizes.log');
      const fakeCli = join(root, 'fake-claude');
      writeFileSync(fakeCli, `#!/bin/bash
record_size() { printf '%s %s\\n' "$$" "$(stty size)" >> '${sizeLog}'; }
trap record_size WINCH
record_size
while :; do sleep 0.1; done
`);
      chmodSync(fakeCli, 0o755);

      const sessionId = `hrrst${Date.now().toString(36)}`;
      const herdrSession = HerdrBackend.sessionName(sessionId);
      sessions.add(herdrSession);
      const logs: string[] = [];
      const child = spawnWorker(root, sessionId, logs);
      const init: DaemonToWorker = {
        type: 'init',
        sessionId,
        chatId: 'oc_herdr_restart',
        rootMessageId: 'om_herdr_restart',
        workingDir: root,
        cliId: 'claude-code',
        cliPathOverride: fakeCli,
        backendType: 'herdr',
        prompt: '',
        larkAppId: 'app_worker_herdr_e2e',
        larkAppSecret: 'secret',
      };
      child.send(init);
      const ready = await waitForReady(child, logs);
      const ws = await openWriteWebSocket(ready);
      let received = '';
      ws.on('message', data => { received += data.toString(); });
      ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 36 }));

      const before = await waitFor(() => {
        const record = latestSizeRecord(sizeLog);
        return record?.size === '36 120' ? record : null;
      }, 12_000, 'initial browser grid reaches Herdr pane');

      child.send({ type: 'restart' } satisfies DaemonToWorker);
      const after = await waitFor(() => {
        const record = latestSizeRecord(sizeLog);
        return record
          && record.pid !== before.pid
          && record.size === '36 120'
          && record.count > before.count
          ? record
          : null;
      }, 20_000, 'replacement Herdr pane restores browser grid without another resize');

      expect(after.pid).not.toBe(before.pid);
      expect(after.size).toBe('36 120');
      await waitFor(
        () => received.includes('\x1b]1989;frame\x07'),
        5_000,
        'observer full frame reaches browser after resize',
      );
      expect(received).toContain('\x1b]1989;frame\x07');
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      child.send({ type: 'close' } satisfies DaemonToWorker);
    },
    35_000,
  );

  it.skipIf(!HerdrBackend.isAvailable())(
    'streams live native frames from an adopted external Herdr pane',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'botmux-herdr-adopt-'));
      tempDirs.add(root);
      const trigger = join(root, 'emit-live');
      const busyDone = join(root, 'emit-live-done');
      const externalSession = `adopt-e2e-${Date.now().toString(36)}`;
      sessions.add(externalSession);
      const external = new HerdrBackend(externalSession);
      external.spawn('/bin/bash', [
        '-lc',
        `for i in $(seq -w 1 40); do echo HISTORY-$i; done; echo ADOPT_INITIAL; `
        + `while [ ! -f '${trigger}' ]; do sleep 0.1; done; `
        + 'for i in $(seq -w 1 40); do echo ADOPT_LIVE_UPDATE-$i; sleep 0.05; done; '
        + `touch '${busyDone}'; while :; do sleep 1; done`,
      ], {
        cwd: root,
        cols: 100,
        rows: 30,
        env: { ...process.env } as Record<string, string>,
      });
      await waitFor(
        () => external.captureCurrentScreen().includes('ADOPT_INITIAL'),
        10_000,
        'external pane initial marker',
      );
      // The fixture backend only starts the external pane. Detach its observer
      // before the worker adopts the pane: Herdr currently exposes one native
      // terminal observer stream per pane session.
      external.kill();
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500));

      const sessionId = `hradp${Date.now().toString(36)}`;
      const logs: string[] = [];
      const child = spawnWorker(root, sessionId, logs);
      const paneId = agentPaneId(externalSession);
      const init: DaemonToWorker = {
        type: 'init',
        sessionId,
        chatId: 'oc_herdr_adopt',
        rootMessageId: 'om_herdr_adopt',
        workingDir: root,
        cliId: 'claude-code',
        backendType: 'herdr',
        prompt: '',
        larkAppId: 'app_worker_herdr_e2e',
        larkAppSecret: 'secret',
        adoptMode: true,
        adoptSource: 'herdr',
        adoptHerdrSessionName: externalSession,
        adoptHerdrTarget: paneId,
        adoptHerdrPaneId: paneId,
        adoptPaneCols: 100,
        adoptPaneRows: 30,
      };
      child.send(init);
      const ready = await waitForReady(child, logs);
      const ws = await openWriteWebSocket(ready);
      const rendered = new TerminalRenderer(100, 30);
      const messages: string[] = [];
      let liveOutputStarted = false;
      let historyRefreshedWhileBusy = false;
      ws.on('message', raw => {
        let data = raw.toString();
        messages.push(data);
        if (
          liveOutputStarted
          && data.startsWith('\x1b]1989;history;')
          && data.includes('ADOPT_LIVE_UPDATE')
          && !existsSync(busyDone)
        ) historyRefreshedWhileBusy = true;
        const marker = data.match(/^\x1b\]1989;(?:frame|history;\d+)\x07/);
        if (marker) {
          data = data.slice(marker[0].length);
          rendered.replace(data, 100, 30);
        } else {
          rendered.write(data);
        }
      });
      await waitFor(
        () => terminalBufferText(rendered).includes('ADOPT_INITIAL'),
        5_000,
        'adopt observer full viewport',
      );

      // Enter line-history mode through the same mouse-wheel packet used by
      // the browser. Subsequent native CUP/grid deltas are intentionally not
      // applied to that coordinate space, so each output burst must schedule
      // a fresh explicit capture instead of leaving the browser frozen.
      ws.send(JSON.stringify({ type: 'input', data: '\x1b[<64;1;1M' }));
      await waitFor(
        () => messages.some(message => message.startsWith('\x1b]1989;history;')),
        5_000,
        'remote scroll enters captured history mode',
      );
      const historyMessagesBeforeLive = messages.filter(message =>
        message.startsWith('\x1b]1989;history;')).length;

      liveOutputStarted = true;
      writeFileSync(trigger, 'go');
      await waitFor(
        () => external.captureCurrentScreen().includes('ADOPT_LIVE_UPDATE'),
        5_000,
        'external pane live marker',
      );
      try {
        await waitFor(
          () => messages.filter(message => message.startsWith('\x1b]1989;history;')).length
              > historyMessagesBeforeLive
            && rendered.rawSnapshot().includes('ADOPT_LIVE_UPDATE')
            && historyRefreshedWhileBusy,
          5_000,
          '50ms continuous output refreshes history before the stream becomes quiet',
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${logs.join('')}`
          + `\nterminal=${JSON.stringify(terminalBufferText(rendered))}`
          + `\nlast-message=${JSON.stringify(messages.at(-1)?.slice(-2000))}`,
        );
      }

      expect(rendered.rawSnapshot()).toContain('ADOPT_LIVE_UPDATE');
      rendered.dispose();
      ws.close();
      child.send({ type: 'close' } satisfies DaemonToWorker);
      external.destroySession();
    },
    35_000,
  );
});
