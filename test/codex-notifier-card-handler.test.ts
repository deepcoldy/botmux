import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

let tempDir = '';

async function fresh() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const handler = await import('../src/im/lark/card-handler.js');
  registry.loadBotConfigs().forEach(config => registry.registerBot(config));
  return handler;
}

function action(actionName = 'codex_notifier_continue', operator?: string) {
  return {
    ...(operator ? { operator: { open_id: operator } } : {}),
    action: { value: { action: actionName, event_id: 'event-1' } },
    context: { open_message_id: 'om_card' },
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'botmux-codex-notifier-card-'));
  const configPath = join(tempDir, 'bots.json');
  writeFileSync(configPath, JSON.stringify([{
    larkAppId: 'h1',
    larkAppSecret: 'secret',
    cliId: 'codex',
    allowedUsers: ['ou_owner'],
  }]));
  process.env.BOTS_CONFIG = configPath;
});

afterEach(() => {
  delete process.env.BOTS_CONFIG;
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('codex notifier card action', () => {
  it.each([
    'codex_notifier_continue',
    'codex_notifier_open_app',
  ])('把带可信操作者身份的 %s 点击交给 daemon 统一鉴权', async (actionName) => {
    const handler = await fresh();
    const codexNotifierCardAction = vi.fn(async () => ({ ok: true }));
    const data = action(actionName, 'ou_operator');
    const result = await handler.handleCardAction(data, {
      activeSessions: new Map(),
      sessionReply: vi.fn(async () => 'om_reply'),
      lastRepoScan: new Map(),
      codexNotifierCardAction,
    }, 'h1');

    expect(result).toEqual({ ok: true });
    expect(codexNotifierCardAction).toHaveBeenCalledWith(data, 'h1');
  });

  it('缺少飞书校验过的操作者身份时不进入 daemon', async () => {
    const handler = await fresh();
    const codexNotifierCardAction = vi.fn();
    const result = await handler.handleCardAction(action('codex_notifier_open_app'), {
      activeSessions: new Map(),
      sessionReply: vi.fn(async () => 'om_reply'),
      lastRepoScan: new Map(),
      codexNotifierCardAction,
    }, 'h1');

    expect(result?.toast?.type).toBe('error');
    expect(codexNotifierCardAction).not.toHaveBeenCalled();
  });

  it('未知的 Codex notifier 动作不会进入 daemon', async () => {
    const handler = await fresh();
    const codexNotifierCardAction = vi.fn();
    await handler.handleCardAction(action('codex_notifier_unknown', 'ou_operator'), {
      activeSessions: new Map(),
      sessionReply: vi.fn(async () => 'om_reply'),
      lastRepoScan: new Map(),
      codexNotifierCardAction,
    }, 'h1');

    expect(codexNotifierCardAction).not.toHaveBeenCalled();
  });
});
