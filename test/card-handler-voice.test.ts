/**
 * card-handler 🔊 语音总结 动作：注入会话精简指令 + 请耐心等待 toast + 只生成一次去重。
 * Run: pnpm vitest run test/card-handler-voice.test.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

const deps = { activeSessions: new Map(), sessionReply: vi.fn(async () => 'mid'), lastRepoScan: new Map() } as any;

function fakeSession(workerSend: ReturnType<typeof vi.fn>, killed = false): any {
  return {
    larkAppId: 'h1',
    chatId: 'oc_1',
    rootMessageId: 'om_root',
    scope: 'thread',
    hasHistory: true,
    worker: { send: workerSend, killed },
    session: { sessionId: 'sess1', cliId: 'claude-code' },
  };
}

function voiceAction(openMsgId?: string): any {
  const data: any = {
    operator: { open_id: 'ou_clicker' },
    action: { value: { action: 'voice_summary', root_id: 'om_root', session_id: 'sess1', lark_app_id: 'h1', chat_id: 'oc_1' } },
  };
  if (openMsgId) data.context = { open_message_id: openMsgId };
  return data;
}

async function fresh() {
  vi.resetModules();
  const types = await import('../src/core/types.js');
  const registry = await import('../src/bot-registry.js');
  const handler = await import('../src/im/lark/card-handler.js');
  registry.loadBotConfigs().forEach((c) => registry.registerBot(c));
  return { types, handler };
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-cardvoice-'));
  const cfg = join(dir, 'bots.json');
  writeFileSync(cfg, JSON.stringify([{ larkAppId: 'h1', larkAppSecret: 's', cliId: 'claude-code' }], null, 2));
  process.env.BOTS_CONFIG = cfg;
  deps.activeSessions = new Map();
});
afterEach(() => { delete process.env.BOTS_CONFIG; vi.restoreAllMocks(); });

describe('card-handler voice_summary', () => {
  it('injects a condense+speak instruction and returns the "please wait" toast', async () => {
    const { types, handler } = await fresh();
    const send = vi.fn();
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), fakeSession(send));

    const res = await handler.handleCardAction(voiceAction('om_card1'), deps, 'h1');

    expect(res?.toast?.type).toBe('success');
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.type).toBe('message');
    expect(msg.content).toContain('botmux send --voice');
    expect(msg.content).toContain('口语');
  });

  it('dedupes by card id: a second click on the same card only toasts, no re-inject', async () => {
    const { types, handler } = await fresh();
    const send = vi.fn();
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), fakeSession(send));

    const r1 = await handler.handleCardAction(voiceAction('om_card1'), deps, 'h1');
    const r2 = await handler.handleCardAction(voiceAction('om_card1'), deps, 'h1');

    expect(r1?.toast?.type).toBe('success');
    expect(r2?.toast?.type).toBe('info'); // already-on-the-way
    expect(send).toHaveBeenCalledTimes(1); // only the first click injected
  });

  it('session offline → warning toast, no injection', async () => {
    const { handler } = await fresh();
    // activeSessions empty → ds resolves to undefined
    const res = await handler.handleCardAction(voiceAction('om_card1'), deps, 'h1');
    expect(res?.toast?.type).toBe('warning');
  });

  it('unauthorized user (not canTalk/canOperate) → needs-auth toast, no injection', async () => {
    // Bot WITH an allowlist; clicker (ou_clicker) is NOT on it → blocked.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cardvoice-auth-'));
    const cfg = join(dir, 'bots.json');
    writeFileSync(cfg, JSON.stringify([{ larkAppId: 'h1', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] }], null, 2));
    process.env.BOTS_CONFIG = cfg;
    const { types, handler } = await fresh();
    const send = vi.fn();
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), fakeSession(send));

    const res = await handler.handleCardAction(voiceAction('om_card1'), deps, 'h1'); // operator = ou_clicker
    expect(res?.toast?.type).toBe('warning');
    expect(send).not.toHaveBeenCalled();
  });
});
