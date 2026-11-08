/** SQLite reopen and launch resolution behavior. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import * as store from '../src/services/session-store.js';
import * as registry from '../src/bot-registry.js';
import { __testOnly_sessionAgentConfig } from '../src/core/worker-pool.js';

const APP = 'pin-cold-app';
let dir: string, previous: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pin-cold-'));
  previous = config.session.dataDir; config.session.dataDir = dir;
  store.init(APP);
});
afterEach(() => {
  vi.restoreAllMocks();
  config.session.dataDir = previous; store.init(APP);
  rmSync(dir, { recursive: true, force: true });
});

function seed(pinned: boolean) {
  const s = store.createSession('chat', crypto.randomUUID(), 'topic', 'group', 'thread');
  s.larkAppId = APP; s.cliId = 'codex'; s.agentFrozen = true; s.reasoningEffort = 'low';
  if (pinned) {
    s.modelPin = { model: 'gpt-6.1-terra', effort: 'high', source: 'topic-header',
      setBy: 'ou_owner', setAt: '2026-11-06T00:00:00.000Z' };
  }
  store.updateSession(s, { modelPinWrite: true });
  return s.sessionId;
}

function dsFromColdRow(sessionId: string) {
  const row = store.getOwnedSession(sessionId);
  if (!row) throw new Error('cold row missing');
  return { session: row, larkAppId: APP, hasHistory: true, worker: null } as any;
}

it('库重开后，pin 会话跟住 pin，而无 pin 的存量会话跟住被改过的 bot 默认', () => {
  const pinnedId = seed(true), plainId = seed(false);
  // Story 3：管理员把 bot 默认模型从 sol 改成 astra
  const changed = { cliId: 'codex' as const, model: 'gpt-6-astra', reasoningEffort: 'low' as const };
  vi.spyOn(registry, 'getBot').mockReturnValue({ config: changed } as any);

  store.init(APP);                              // 冷启动读库
  expect(store.getOwnedSession(pinnedId)?.modelPin?.model).toBe('gpt-6.1-terra');

  const pinnedCfg = __testOnly_sessionAgentConfig(dsFromColdRow(pinnedId), changed);
  expect(pinnedCfg).toMatchObject({ model: 'gpt-6.1-terra', reasoningEffort: 'high' });

  const plainCfg = __testOnly_sessionAgentConfig(dsFromColdRow(plainId), changed);
  expect(plainCfg).toMatchObject({ model: 'gpt-6-astra', reasoningEffort: 'low' });
  expect(store.getOwnedSession(plainId)?.modelPin).toBeUndefined();
});

it('CLI 换掉之后，重开的库里 pin 仍在但不参与解析', () => {
  const pinnedId = seed(true);
  const switched = { cliId: 'claude-code' as const, model: 'opus' };
  vi.spyOn(registry, 'getBot').mockReturnValue({ config: switched } as any);
  store.init(APP);
  const cfg = __testOnly_sessionAgentConfig(dsFromColdRow(pinnedId), switched as any);
  expect(cfg.model).not.toBe('gpt-6.1-terra');
  expect(store.getOwnedSession(pinnedId)?.modelPin?.model).toBe('gpt-6.1-terra');
});
