import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { config } from '../src/config.js';
import * as store from '../src/services/session-store.js';
import * as pool from '../src/core/worker-pool.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import { WorkspaceRecycleRuntime } from '../src/core/workspace-recycle-runtime.js';
import { WorkspaceRecycler } from '../src/services/workspace-recycle.js';
import { sampleRecycleProcess } from '../src/core/workspace-recycle-resources.js';

const dirs: string[] = [];
const children: ChildProcess[] = [];
const controllers: WorkspaceRecycleRuntime[] = [];
const originalDataDir = config.session.dataDir;
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.stop();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
  }
  pool.setActiveSessionsRegistry(new Map());
  store.init(); config.session.dataDir = originalDataDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startWorker(workspace: string): Promise<{ worker: ChildProcess; pid: number; port: number }> {
  const worker = spawnTsScript(join(process.cwd(), 'test/fixtures/workspace-recycle-worker.ts'), [workspace], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(worker);
  const ready = await new Promise<{ pid: number; port: number }>((resolve, reject) => {
    let stderr = '';
    worker.stderr?.on('data', data => { stderr += data.toString(); });
    const timeout = setTimeout(() => reject(new Error(`fixture_ready_timeout:${stderr}`)), 10_000);
    worker.once('exit', code => { clearTimeout(timeout); reject(new Error(`fixture_exited_before_ready:${code}:${stderr}`)); });
    worker.on('message', message => {
      const event = message as { type: string; pid: number; port: number };
      if (event.type === 'fixture_ready') { clearTimeout(timeout); resolve(event); }
    });
  });
  return { worker, ...ready };
}

describe('isolated real process and standard close', () => {
  it('releases worker sockets/inotify resources and preserves closed history over three rounds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-recycle-real-')); dirs.push(root);
    const dataDir = join(root, 'data'); mkdirSync(dataDir);
    config.session.dataDir = dataDir; store.init('app-recycle-fixture');
    const active = new Map<string, DaemonSession>(); pool.setActiveSessionsRegistry(active);
    const controller = new WorkspaceRecycleRuntime({
      appId: () => 'app-recycle-fixture', dataDir: () => dataDir,
      getSession: id => store.getOwnedSession(id), getRuntime: pool.findActiveBySessionId,
      allSessions: () => store.loadAllSessionsStrict(dataDir), close: pool.closeSession,
      lifecycleBusy: ds => pool.isSessionLifecycleInFlight(ds) || pool.isSessionTransferring(ds),
      closeResidual: session => pool.mojoCloseResidualForRow(session)?.reason,
    }); controllers.push(controller);
    const recycler = new WorkspaceRecycler({
      dataDir, daemons: () => [{ larkAppId: 'app-recycle-fixture', ipcPort: 12345 }],
      call: (_daemon, action, request) => controller.perform(action, request),
    });
    const evidence: unknown[] = [];
    for (let round = 0; round < 3; round++) {
      const workspace = join(root, `workspace-${round}`); mkdirSync(workspace);
      const transcript = join(root, `retained-transcript-${round}.jsonl`); writeFileSync(transcript, 'retained\n');
      const { worker, pid, port } = await startWorker(workspace);
      const session = store.createSession(`fixture-chat-${round}`, `fixture-thread-${round}`, 'isolated recycle fixture', 'group');
      Object.assign(session, { larkAppId: 'app-recycle-fixture', workingDir: workspace, backendType: 'pty', pid });
      store.updateSession(session);
      const ds = {
        session, worker, workerReady: true, workerPort: port, workerToken: 'fixture-token',
        workerGeneration: 1, larkAppId: 'app-recycle-fixture', chatId: session.chatId,
        chatType: 'group', scope: 'thread', workingDir: workspace, spawnedAt: Date.now(),
        cliVersion: 'fixture', lastMessageAt: 1, lastScreenStatus: 'idle', hasHistory: true,
        initConfig: { backendType: 'pty' },
      } as DaemonSession;
      active.set(activeSessionKey(ds), ds);
      const before = sampleRecycleProcess(pid, 'worker');
      expect(before.state).toBe('alive');
      if (process.platform === 'linux') expect(before.inotifyInstances).toBeGreaterThan(0);
      const operationId = `round-${round}`;
      expect((await recycler.prepare(operationId, workspace)).ok).toBe(true);
      rmSync(workspace, { recursive: true });
      const result = await recycler.finish(operationId, { eventId: `end-${round}`, outcome: 'succeeded' });
      expect(result.status).toBe('closed');
      expect(store.getOwnedSession(session.sessionId)?.status).toBe('closed');
      expect(active.size).toBe(0);
      expect(sampleRecycleProcess(pid, 'worker', before.identity).state).toBe('gone');
      expect(readFileSync(transcript, 'utf8')).toBe('retained\n');
      expect((await recycler.finish(operationId, { eventId: `end-${round}`, outcome: 'succeeded' })).status).toBe('closed');
      evidence.push({ round, sessionId: session.sessionId, larkAppId: session.larkAppId, chatId: session.chatId, workspace, before, result });
    }
    expect(store.listSessionsStrict().filter(s => s.status === 'active')).toHaveLength(0);
    expect(store.listSessionsStrict().filter(s => s.status === 'closed')).toHaveLength(3);
    // Optional evidence path is supplied only by this task's isolated validation
    // run. Normal CI leaves no artifact outside the disposable fixture.
    if (process.env.BOTMUX_RECYCLE_TEST_EVIDENCE) writeFileSync(process.env.BOTMUX_RECYCLE_TEST_EVIDENCE, JSON.stringify(evidence, null, 2));
  }, 30_000);
});
