import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

let tempDir = '';
let handler: typeof import('../src/im/lark/card-handler.js');

// One import for all cases: the module graph behind card-handler is large (it
// takes seconds on a loaded machine), and every case uses the same bot config.
beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'botmux-schedule-claim-route-'));
  const configPath = join(tempDir, 'bots.json');
  writeFileSync(configPath, JSON.stringify([{
    larkAppId: 'h1', larkAppSecret: 'secret', cliId: 'codex', allowedUsers: ['ou_owner'],
  }]));
  process.env.BOTS_CONFIG = configPath;
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  handler = await import('../src/im/lark/card-handler.js');
  registry.loadBotConfigs().forEach(config => registry.registerBot(config));
}, 180_000);

afterAll(() => {
  delete process.env.BOTS_CONFIG;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('schedule identity claim card callbacks', () => {
  it.each([
    'schedule_identity_claim',
    'schedule_identity_reclaim',
    'schedule_identity_rerun',
  ])('hands %s to the daemon before any session lookup', async actionName => {
    const scheduleIdentityClaimCardAction = vi.fn(async () => ({ toast: { type: 'success', content: 'ok' } }));
    // No session matches this card: the claim card is not bound to one.
    const data = {
      operator: { open_id: 'ou_operator', union_id: 'on_operator' },
      action: { value: { action: actionName, task_id: 'a1b2c3d4', claim_rev: '' } },
      context: { open_message_id: 'om_card', open_chat_id: 'oc_chat' },
    };
    const result = await handler.handleCardAction(data, {
      activeSessions: new Map(),
      sessionReply: vi.fn(async () => 'om_reply'),
      lastRepoScan: new Map(),
      scheduleIdentityClaimCardAction,
    }, 'h1');
    expect(result).toEqual({ toast: { type: 'success', content: 'ok' } });
    expect(scheduleIdentityClaimCardAction).toHaveBeenCalledWith(data, 'h1');
  });
});
