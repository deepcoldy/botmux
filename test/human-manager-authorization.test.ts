import { describe, expect, it } from 'vitest';
import { authorizeHumanManager } from '../src/core/human-manager-authorization.js';

type Action = 'set' | 'clear' | 'lead-only-on' | 'lead-only-off';

const CHAT = 'oc_auth';

function authorize(action: Action, text: string, opts: { turnId?: string } = {}) {
  return authorizeHumanManager({
    sessionId: 'sess_auth',
    appId: 'cli_app',
    chatId: CHAT,
    action,
    claim: { originTurnId: 'om_1', originCapability: 'cap', originDispatchAttempt: 1 },
    liveOrigin: () => ({ capability: 'cap', turnId: opts.turnId ?? 'om_1', dispatchAttempt: 1 }),
    readMessage: async () => ({
      items: [{
        message_id: 'om_1',
        chat_id: CHAT,
        sender: { sender_type: 'user', id_type: 'open_id', id: 'ou_human' },
        msg_type: 'text',
        body: { content: JSON.stringify({ text }) },
        mentions: [],
      }],
    }),
    canOperate: () => true,
  });
}

describe('authorizeHumanManager explicit instruction matching', () => {
  it.each<[Action, string]>([
    ['lead-only-on', '执行 botmux manager lead-only on'],
    ['lead-only-on', '/manager LEAD-ONLY  on。'],
    ['lead-only-off', '请执行 manager lead-only off'],
    ['set', 'botmux manager set'],
    ['set', '你作为本群负责人'],
    ['clear', 'manager clear'],
  ])('%s is authorized by %j', async (action, text) => {
    await expect(authorize(action, text)).resolves.toMatchObject({ ok: true, requester: 'ou_human', turnId: 'om_1' });
  });

  it.each<[Action, string]>([
    ['lead-only-on', 'manager lead-only off'],
    ['lead-only-off', 'manager lead-only on'],
    ['lead-only-on', 'manager set'],
    ['lead-only-on', '你作为本群负责人'],
    ['lead-only-on', 'manager lead-only'],
    ['lead-only-on', 'manager lead-only on please'],
    ['set', 'manager lead-only on'],
    ['clear', 'manager lead-only off'],
  ])('%s is refused for %j', async (action, text) => {
    await expect(authorize(action, text)).resolves.toEqual({ ok: false, error: 'explicit_manager_instruction_required' });
  });

  it('refuses a lead-only toggle when the live turn is not the claimed one', async () => {
    await expect(authorize('lead-only-on', 'manager lead-only on', { turnId: 'om_2' }))
      .resolves.toEqual({ ok: false, error: 'human_turn_unproven' });
  });
});
