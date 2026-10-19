import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { createHeadlessSession } from '../src/core/session-manager.js';
import { triggerSessionTurn } from '../src/core/trigger-session.js';
import { sessionKey } from '../src/core/types.js';
import { usesLarkToolBinding } from '../src/core/lark-tool-binding.js';
import type { DaemonSession } from '../src/core/types.js';

const state = vi.hoisted(() => ({ rows: new Map<string, any>(), fork: vi.fn() }));
const appId = 'cli_headless_contract';
vi.mock('../src/bot-registry.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  getBot: () => ({ config: { larkAppId: 'cli_headless_contract', cliId: 'codex', backendType: 'pty', lang: 'zh' } }),
  effectiveDefaultWorkingDir: () => undefined,
}));
vi.mock('../src/services/session-store.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  createSession: (chatId: string, rootMessageId: string, title: string) => {
    const row = { sessionId: `session-${state.rows.size}`, chatId, rootMessageId, title, status: 'active' };
    state.rows.set(row.sessionId, row);
    return row;
  },
  getSession: (id: string) => state.rows.get(id),
  updateSession: (row: any) => state.rows.set(row.sessionId, row),
}));
vi.mock('../src/core/worker-pool.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  forkWorker: (...args: any[]) => state.fork(...args),
  getCurrentCliVersion: () => 'test',
}));
vi.mock('../src/services/message-queue.js', () => ({ ensureQueue: vi.fn() }));
vi.mock('../src/services/groups-store.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), isInChat: vi.fn(async () => false),
}));

let root: string, previousDataDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'headless-create-run-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = root;
  state.rows.clear(); state.fork.mockReset();
});
afterEach(() => { config.session.dataDir = previousDataDir; rmSync(root, { recursive: true, force: true }); });

it('real create-then-run dispatches bot-only inline guidance and durable headless provenance', async () => {
  const activeSessions = new Map<string, DaemonSession>();
  const created = await createHeadlessSession(activeSessions, undefined, { larkAppId: appId, workingDir: root });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.error);
  const response = await triggerSessionTurn({
    source: { type: 'headless', requestId: created.headlessId },
    target: { kind: 'turn', botId: appId, sessionId: created.sessionId },
    envelope: { format: 'text', sourceName: 'headless', trusted: true },
    instruction: 'read the document', options: { asyncReturnSessionId: true },
  }, { larkAppId: appId, activeSessions });
  expect(response.ok).toBe(true);
  expect(state.fork).toHaveBeenCalledTimes(1);
  const [ds, input, options] = state.fork.mock.calls[0];
  expect(ds.session.headless).toMatchObject({ id: created.headlessId, source: 'cli' });
  expect(ds).toBe(activeSessions.get(sessionKey(ds.chatId, appId)));
  expect(options.resume).toBe(false);
  expect(input.content).toContain('没有真人授权通道');
  expect(input.content).toContain(appId);
  expect(input.content).not.toContain('botmux auth request');
  expect(usesLarkToolBinding({ sessionId: created.sessionId, larkAppId: appId, chatId: ds.chatId,
    headless: ds.session.headless, backendType: 'pty', resume: options.resume }, root)).toBe(true);
});

it('a webhook-created forged headless address cannot acquire the binding', async () => {
  const activeSessions = new Map<string, DaemonSession>();
  const response = await triggerSessionTurn({
    source: { type: 'webhook', connectorId: 'fixture' },
    target: { kind: 'turn', botId: appId, chatId: 'headless_forged-http-chat' },
    envelope: { format: 'text', sourceName: 'fixture', trusted: false },
    instruction: 'read the document', options: { asyncReturnSessionId: true },
  }, { larkAppId: appId, activeSessions });
  expect(response.ok).toBe(true);
  const [ds] = state.fork.mock.calls[0];
  expect(ds.session.headless).toBeUndefined();
  expect(usesLarkToolBinding({ sessionId: ds.session.sessionId, larkAppId: appId, chatId: ds.chatId,
    headless: ds.session.headless, backendType: 'pty' }, root)).toBe(false);
});
