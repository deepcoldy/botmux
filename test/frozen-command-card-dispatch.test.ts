import { describe, expect, it, vi } from 'vitest';
import { handleCardAction, type CardHandlerDeps } from '../src/im/lark/card-handler.js';

function deps(handler: NonNullable<CardHandlerDeps['frozenCommandCardAction']>): CardHandlerDeps {
  return {
    activeSessions: new Map(),
    lastRepoScan: new Map(),
    sessionReply: vi.fn(async () => 'om_reply'),
    frozenCommandCardAction: handler,
  };
}

describe('Frozen Command card dispatch', () => {
  it.each([
    'frozen_command_run_confirm',
    'frozen_command_run_cancel',
    'frozen_command_lifecycle_confirm',
    'frozen_command_lifecycle_cancel',
  ])(
    'routes %s to the host-owned handler without requiring a live session',
    async (action) => {
      const handler = vi.fn(async () => ({ toast: { type: 'info', content: 'ok' } }));
      const data = {
        operator: { open_id: 'ou_actor', union_id: 'on_actor' },
        action: { value: { action, transition_id: 'id', nonce: 'nonce' } },
        context: { open_message_id: 'om_card' },
      };
      await expect(handleCardAction(data, deps(handler), 'cli_app')).resolves.toEqual({
        toast: { type: 'info', content: 'ok' },
      });
      expect(handler).toHaveBeenCalledWith(data, 'cli_app');
    },
  );

  it('fails closed when the daemon handler is absent', async () => {
    const result = await handleCardAction({
      action: { value: { action: 'frozen_command_run_confirm', transition_id: 'id', nonce: 'nonce' } },
    }, deps(undefined as never), 'cli_app');
    expect(result).toMatchObject({ toast: { type: 'error' } });
  });
});
