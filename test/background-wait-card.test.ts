/**
 * Daemon side of 「主回合已结束 · 后台子任务运行中（N）」: the worker reports the
 * count on screen_update, and the live card must follow it even when the status
 * underneath does not change (the PATCH path otherwise only fires on a status
 * edge). Everything else keyed on status stays untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const mocks = vi.hoisted(() => ({ request: vi.fn(), create: vi.fn(), reply: vi.fn(), patch: vi.fn(), upload: vi.fn() }));
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {
  request = mocks.request;
  im = { v1: {
    message: { create: mocks.create, reply: mocks.reply, patch: mocks.patch },
    file: { create: mocks.upload },
    chat: { get: async () => ({ code: 0, data: { chat_mode: 'group' } }) },
  } };
} }));
import {
  initWorkerPool, setActiveSessionsRegistry, getActiveSessionsRegistry, streamCardLabel,
  __testOnly_setupWorkerHandlers as setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import { registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import * as sessionStore from '../src/services/session-store.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import { __testOnly_activeSessions as activeSessions, __testOnly_sessionReply as sessionReply } from '../src/daemon.js';
import { __testOnly_resetLarkGate } from '../src/im/lark/api-gate.js';

const APP = 'cli_background_wait_card';
const oldDataDir = config.session.dataDir;
const originalRegistry = getActiveSessionsRegistry();
let home: string;
let ds: DaemonSession;
let worker: EventEmitter & { killed: boolean };

beforeEach(() => {
  vi.clearAllMocks(); __testOnly_resetLarkGate();
  vi.stubEnv('BOTMUX_LARK_QPS', '100000');
  vi.stubEnv('BOTMUX_LARK_GATE_RETRY_BASE_MS', '1');
  home = mkdtempSync(join(tmpdir(), 'background-wait-card-'));
  const data = join(home, 'data'); mkdirSync(data, { mode: 0o700 });
  config.session.dataDir = data;
  activeSessions.clear(); setActiveSessionsRegistry(activeSessions);
  registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code', replyCardMode: 'legacy' });
  ds = { larkAppId: APP, chatId: 'oc_bg', scope: 'chat', chatType: 'group',
    currentReplyTarget: { turnId: 'om_turn', rootMessageId: 'om_root' },
    session: { sessionId: 'sid_bg', larkAppId: APP, chatId: 'oc_bg', scope: 'chat',
      rootMessageId: 'om_root', cliId: 'claude-code', status: 'active', title: 'bg', workingDir: data },
  } as unknown as DaemonSession;
  sessionStore.init(APP);
  const stored = sessionStore.createSession('oc_bg', 'om_root', 'bg', 'group', 'chat');
  ds.session = { ...stored, ...ds.session, sessionId: stored.sessionId };
  sessionStore.updateSession(ds.session);
  activeSessions.set(activeSessionKey(ds), ds);
  mocks.request.mockReset().mockResolvedValue({ code: 0, data: { items: [] } });
  mocks.patch.mockReset().mockResolvedValue({ code: 0 });
  initWorkerPool({ sessionReply, getSessionWorkingDir: () => data, getActiveCount: () => 1, closeSession: vi.fn() });
  // A live card for the current turn, so updates take the PATCH path.
  worker = Object.assign(new EventEmitter(), {
    killed: false, send: vi.fn(), kill: vi.fn(), pid: 12345,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
  });
  ds.worker = worker as any;
  ds.workerReady = true;
  ds.displayMode = 'hidden';
  ds.lastScreenStatus = 'working';
  ds.streamCardId = 'om_card';
  ds.streamCardNonce = 'nonce';
  setupWorkerHandlers(ds, worker as any);
});
afterEach(() => {
  activeSessions.clear(); setActiveSessionsRegistry(originalRegistry);
  ds.session.status = 'closed';
  sessionStore.init(APP, { owner: false });
  config.session.dataDir = oldDataDir;
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs(); __testOnly_resetLarkGate();
});

async function screenUpdate(status: 'working' | 'idle' | 'limited', backgroundTasks?: number): Promise<void> {
  await worker.listeners('message')[0]({
    type: 'screen_update', content: 'screen', status, turnId: 'om_turn',
    ...(backgroundTasks !== undefined ? { backgroundTasks } : {}),
  });
  await vi.waitFor(() => expect(ds.cardPatchInFlight ?? false).toBe(false));
}

function patchedHeaders(): string[] {
  return mocks.patch.mock.calls.map(([request]) => JSON.parse(request.data.content).header.title.content as string);
}

describe('background-wait label on the live card', () => {
  it('patches the header when only the background count changes', async () => {
    await screenUpdate('working');
    expect(mocks.patch).not.toHaveBeenCalled();

    await screenUpdate('working', 2);
    expect(ds.backgroundTaskCount).toBe(2);
    expect(streamCardLabel(ds)).toEqual({ backgroundTasks: 2 });
    expect(patchedHeaders().at(-1)).toContain('主回合已结束 · 后台子任务运行中（2）');

    // Same status, same count: nothing to redraw.
    await screenUpdate('working', 2);
    expect(mocks.patch).toHaveBeenCalledTimes(1);

    await screenUpdate('working', 1);
    expect(patchedHeaders().at(-1)).toContain('后台子任务运行中（1）');

    // The worker drops the field once the main agent works again.
    await screenUpdate('working');
    expect(ds.backgroundTaskCount).toBeUndefined();
    expect(patchedHeaders().at(-1)).toContain('工作中');
    expect(mocks.patch).toHaveBeenCalledTimes(3);
  });

  it('shows the label over idle too, and falls back to the idle label when the work is done', async () => {
    ds.completedIdleTurnId = 'om_turn';
    await screenUpdate('idle', 1);
    expect(patchedHeaders().at(-1)).toContain('后台子任务运行中（1）');
    await screenUpdate('idle');
    expect(patchedHeaders().at(-1)).toContain('✓ 本轮已结束 · 等待输入');
    expect(streamCardLabel(ds)).toBe('completed');
  });

  it('ignores the count under a status it does not describe', async () => {
    await screenUpdate('limited', 3);
    expect(ds.backgroundTaskCount).toBeUndefined();
    expect(patchedHeaders().every(header => !header.includes('后台子任务'))).toBe(true);
  });
});
