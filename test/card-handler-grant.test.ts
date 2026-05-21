/**
 * card-handler 群内授权动作：owner 强闸门 + nonce + 撤回卡/通知/兜底 patch。
 * Run: pnpm vitest run test/card-handler-grant.test.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

const replyMock = vi.fn(async () => 'om_notify');
const deleteMock = vi.fn(async () => {});
vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return { ...actual, replyMessage: (...a: any[]) => replyMock(...a), deleteMessage: (...a: any[]) => deleteMock(...a) };
});

let configPath: string;
const deps = { activeSessions: new Map(), sessionReply: vi.fn(async () => 'mid'), lastRepoScan: new Map() } as any;

async function fresh() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const pending = await import('../src/im/lark/grant-pending.js');
  const handler = await import('../src/im/lark/card-handler.js');
  registry.loadBotConfigs().forEach(c => registry.registerBot(c));
  return { registry, pending, handler };
}

function action(a: string, extra: Record<string, any> = {}, openMsgId?: string) {
  const data: any = { operator: { open_id: extra.operator ?? 'ou_owner' }, action: { value: { action: a, target_open_id: 'ou_g', chat_id: 'oc_1', nonce: extra.nonce } } };
  if (openMsgId) data.context = { open_message_id: openMsgId };
  return data;
}

beforeEach(() => {
  replyMock.mockClear(); deleteMock.mockClear(); deleteMock.mockImplementation(async () => {});
  const dir = mkdtempSync(join(tmpdir(), 'botmux-cardgrant-'));
  configPath = join(dir, 'bots.json');
  writeFileSync(configPath, JSON.stringify([{ larkAppId: 'h1', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] }], null, 2));
  process.env.BOTS_CONFIG = configPath;
});
afterEach(() => { delete process.env.BOTS_CONFIG; vi.restoreAllMocks(); });

describe('card-handler grant actions', () => {
  it('non-owner click → owner_only toast, no grant', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const res = await handler.handleCardAction(action('grant_chat', { operator: 'ou_x', nonce }), deps, 'h1');
    expect(res?.toast?.type).toBe('error');
    expect(registry.getBot('h1').config.chatGrants).toBeUndefined();
  });

  it('stale nonce → expired toast, no grant', async () => {
    const { registry, handler } = await fresh();
    const res = await handler.handleCardAction(action('grant_global', { nonce: 'stale' }), deps, 'h1');
    expect(res?.toast?.type).toBe('error');
    expect(registry.getBot('h1').resolvedAllowedUsers).not.toContain('ou_g');
  });

  it('owner grant_chat WITH card id → @notify + withdraw + persists, returns nothing', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const res = await handler.handleCardAction(action('grant_chat', { nonce }, 'om_card'), deps, 'h1');
    expect(res).toBeUndefined();
    expect(replyMock).toHaveBeenCalledWith('h1', 'om_card', expect.stringContaining('ou_g'), 'interactive', true);
    expect(deleteMock).toHaveBeenCalledWith('h1', 'om_card');
    expect(registry.getBot('h1').config.chatGrants).toEqual({ oc_1: ['ou_g'] });
    expect(pending.checkNonce('h1', 'oc_1', 'ou_g', nonce)).toBe(false);
  });

  it('owner grant_chat WITHOUT card id → fallback in-place card patch, persists', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const res = await handler.handleCardAction(action('grant_chat', { nonce }), deps, 'h1');
    expect(res?.elements).toBeTruthy();           // raw card body (dispatcher wraps as patch)
    expect(deleteMock).not.toHaveBeenCalled();
    expect(registry.getBot('h1').config.chatGrants).toEqual({ oc_1: ['ou_g'] });
  });

  it('grant_global persists to resolvedAllowedUsers', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    await handler.handleCardAction(action('grant_global', { nonce }, 'om_card'), deps, 'h1');
    expect(registry.getBot('h1').resolvedAllowedUsers).toContain('ou_g');
  });

  it('withdraw fails but grant still applied → fallback patch, still persisted', async () => {
    const { registry, pending, handler } = await fresh();
    deleteMock.mockRejectedValueOnce(new Error('recall window passed'));
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const res = await handler.handleCardAction(action('grant_chat', { nonce }, 'om_card'), deps, 'h1');
    expect(res?.elements).toBeTruthy();           // fell through to in-place patch
    expect(registry.getBot('h1').config.chatGrants).toEqual({ oc_1: ['ou_g'] });
  });

  it('deny → in-place result patch + cooldown, never touches grant-store', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const res = await handler.handleCardAction(action('grant_deny', { nonce }, 'om_card'), deps, 'h1');
    expect(res?.elements).toBeTruthy();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(pending.isThrottled('h1', 'oc_1', 'ou_g')).toBe(true);
    expect(registry.getBot('h1').config.chatGrants).toBeUndefined();
  });
});
