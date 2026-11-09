import { describe, expect, it } from 'vitest';
import { planChatManagerMutation } from '../src/core/lead-only.js';

describe('planChatManagerMutation (chat-manager route validation)', () => {
  it('rejects unknown action', () => {
    expect(planChatManagerMutation({ action: 'nope' }, true)).toEqual({ ok: false, status: 400, error: 'invalid_action' });
  });
  it.each([undefined, 'true', 1, null])('lead-only with non-boolean leadOnly %j -> 400', (v) => {
    expect(planChatManagerMutation({ action: 'lead-only', leadOnly: v }, true)).toEqual({ ok: false, status: 400, error: 'invalid_action' });
  });
  it('set and lead-only on are gated by chatManagerEnabled (409); clear and lead-only off are not', () => {
    expect(planChatManagerMutation({ action: 'set' }, false)).toEqual({ ok: false, status: 409, error: 'chat_manager_disabled' });
    expect(planChatManagerMutation({ action: 'lead-only', leadOnly: true }, false)).toEqual({ ok: false, status: 409, error: 'chat_manager_disabled' });
    expect(planChatManagerMutation({ action: 'clear' }, false)).toMatchObject({ ok: true, authAction: 'clear' });
    expect(planChatManagerMutation({ action: 'lead-only', leadOnly: false }, false)).toMatchObject({ ok: true, action: 'lead-only', authAction: 'lead-only-off', leadOnly: false });
  });
  it('maps lead-only to authorizeHumanManager lead-only-on/off', () => {
    expect(planChatManagerMutation({ action: 'lead-only', leadOnly: true }, true)).toMatchObject({ ok: true, action: 'lead-only', authAction: 'lead-only-on', leadOnly: true });
    expect(planChatManagerMutation({ action: 'lead-only', leadOnly: false }, true)).toMatchObject({ ok: true, authAction: 'lead-only-off', leadOnly: false });
    expect(planChatManagerMutation({ action: 'set' }, true)).toMatchObject({ ok: true, authAction: 'set' });
  });
});
