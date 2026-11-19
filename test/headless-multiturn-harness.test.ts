/**
 * Controllable harness — NOT a real model run.
 *
 * Proves a groupless headless session accepts a second turn on the same
 * session id, delivers it to the same live worker that saw the first prompt,
 * and that the result store can be read back. The "model" is a local function
 * over that worker transcript. Feishu client methods throw if called.
 *
 * Real CLI login and a real model reply were not exercised.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { createHeadlessSession } from '../src/core/session-manager.js';
import { triggerSessionTurn } from '../src/core/trigger-session.js';
import type { DaemonSession } from '../src/core/types.js';
import { lookup, recordCompleted } from '../src/services/async-trigger-store.js';

const state = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  forks: [] as any[],
  sends: [] as any[],
  feishuCalls: [] as string[],
}));
const appId = 'local_harness';

vi.mock('../src/bot-registry.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  getBot: () => ({
    config: {
      larkAppId: 'local_harness',
      apiOnly: true,
      localIdentity: true,
      cliId: 'codex',
      backendType: 'pty',
      lang: 'zh',
    },
  }),
  effectiveDefaultWorkingDir: () => undefined,
}));
vi.mock('../src/services/session-store.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  createSession: (chatId: string, rootMessageId: string, title: string) => {
    const row = { sessionId: `session-${state.rows.size + 1}`, chatId, rootMessageId, title, status: 'active' };
    state.rows.set(row.sessionId, row);
    return row;
  },
  getSession: (id: string) => state.rows.get(id),
  getOwnedSession: (id: string) => state.rows.get(id),
  updateSession: (row: any) => state.rows.set(row.sessionId, row),
  closeSession: () => {},
}));
vi.mock('../src/core/worker-pool.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  forkWorker: (ds: any, input: any, options: any) => {
    state.forks.push({ ds, input, options });
    ds.worker = { killed: false, pid: 4242 };
    ds.hasHistory = true;
    ds.session.cliSessionId = 'harness-cli-session';
  },
  sendWorkerInput: (ds: any, input: any) => {
    state.sends.push({ ds, input });
    return true;
  },
  getCurrentCliVersion: () => 'test',
}));
vi.mock('../src/services/message-queue.js', () => ({ ensureQueue: vi.fn() }));
vi.mock('../src/services/groups-store.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  isInChat: vi.fn(async () => { state.feishuCalls.push('isInChat'); throw new Error('feishu isInChat'); }),
}));
vi.mock('../src/im/lark/client.js', () => ({
  getChatMode: async () => { state.feishuCalls.push('getChatMode'); throw new Error('feishu getChatMode'); },
  getMessageChatId: async () => { state.feishuCalls.push('getMessageChatId'); throw new Error('feishu getMessageChatId'); },
  sendMessage: async () => { state.feishuCalls.push('sendMessage'); throw new Error('feishu sendMessage'); },
  replyMessage: async () => { state.feishuCalls.push('replyMessage'); throw new Error('feishu replyMessage'); },
}));

function promptText(input: any): string {
  return typeof input === 'string' ? input : String(input?.content ?? '');
}

/** Stand-in for the CLI process. It only knows what that worker was given. */
function harnessAnswer(transcript: string[]): string {
  const remembered = transcript.join('\n').match(/CODEWORD=([A-Za-z0-9_-]+)/)?.[1];
  const asking = /codeword/i.test(transcript.at(-1) ?? '');
  return asking && remembered ? remembered : 'unknown';
}

let root: string;
let previousDataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'headless-multiturn-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = root;
  state.rows.clear();
  state.forks.length = 0;
  state.sends.length = 0;
  state.feishuCalls.length = 0;
});
afterEach(() => {
  config.session.dataDir = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

it('continues one headless session for a second turn and reads the harness result', async () => {
  const activeSessions = new Map<string, DaemonSession>();
  const created = await createHeadlessSession(activeSessions, undefined, {
    larkAppId: appId,
    title: 'harness',
    workingDir: root,
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.error);

  const first = await triggerSessionTurn({
    source: { type: 'headless', requestId: created.headlessId },
    target: { kind: 'turn', botId: appId, sessionId: created.sessionId },
    envelope: { format: 'text', sourceName: 'headless-harness', trusted: false },
    instruction: 'Remember CODEWORD=apricot',
    options: { asyncReturnSessionId: true },
  }, { larkAppId: appId, activeSessions });
  expect(first.ok).toBe(true);
  expect(first.target?.sessionId).toBe(created.sessionId);
  expect(state.forks).toHaveLength(1);
  expect(state.forks[0].options.resume).toBe(false);
  expect(promptText(state.forks[0].input)).toContain('CODEWORD=apricot');

  const second = await triggerSessionTurn({
    source: { type: 'headless', requestId: created.headlessId },
    target: { kind: 'turn', botId: appId, sessionId: created.sessionId },
    envelope: { format: 'text', sourceName: 'headless-harness', trusted: false },
    instruction: 'What codeword did I give you?',
    options: { asyncReturnSessionId: true },
  }, { larkAppId: appId, activeSessions });
  expect(second.ok).toBe(true);
  expect(second.target?.sessionId).toBe(created.sessionId);
  expect(second.target?.chatId?.startsWith('headless_')).toBe(true);
  expect(state.forks).toHaveLength(1);
  expect(state.sends).toHaveLength(1);
  expect(state.sends[0].ds).toBe(state.forks[0].ds);
  expect(state.sends[0].ds.session.cliSessionId).toBe('harness-cli-session');
  expect(promptText(state.sends[0].input)).toContain('What codeword did I give you?');

  const transcript = [promptText(state.forks[0].input), promptText(state.sends[0].input)];
  const answer = harnessAnswer(transcript);
  expect(answer).toBe('apricot');

  const pending = lookup(created.sessionId, second.triggerId);
  expect(pending?.result.status).toBe('pending');
  recordCompleted(created.sessionId, second.triggerId!, answer, Date.now(), appId);
  const stored = lookup(created.sessionId, second.triggerId);
  expect(stored?.result.status).toBe('completed');
  if (stored?.result.status === 'completed') expect(stored.result.content).toBe('apricot');
  expect(state.feishuCalls).toEqual([]);
});
