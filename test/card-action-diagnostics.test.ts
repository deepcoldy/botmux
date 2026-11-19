import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeCardActionData } from '../src/im/lark/card-action-data.js';
import { logCardActionDiagnostics } from '../src/im/lark/card-action-diagnostics.js';
import { logger } from '../src/utils/logger.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('opt-in card callback diagnostics', () => {
  it('is silent unless explicitly enabled', () => {
    vi.stubEnv('BOTMUX_CARD_ACTION_DIAGNOSTICS', '0');
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    logCardActionDiagnostics('handler', {}, {});
    expect(info).not.toHaveBeenCalled();
  });

  it('logs callback structure and parsed fields without identity, credentials or user text', () => {
    vi.stubEnv('BOTMUX_CARD_ACTION_DIAGNOSTICS', '1');
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const input = {
      schema: '2.0', header: { token: 'verification-secret' },
      event: {
        token: 'card-secret', operator: { open_id: 'ou_private', union_id: 'on_private' },
        context: { open_message_id: 'om_private', open_chat_id: 'oc_private' },
        action: { tag: 'button', name: 'private-name',
          value: JSON.stringify({ action: 'feedback_submit', result: 'accurate_complete',
            expected_feedback_id: 'fb_0123456789abcdef0123456789abcdef', token: 'value-secret' }),
          form_value: { comment: 'private comment' }, input_value: 'private input',
        },
      },
    };
    logCardActionDiagnostics('dispatcher', input, normalizeCardActionData(input));
    expect(info).toHaveBeenCalledWith('[card-action-diagnostics]', expect.objectContaining({
      hasEvent: true, actionKeys: ['tag', 'name', 'value', 'form_value', 'input_value'], actionValueType: 'string',
      operator: { open_id: '<redacted>', union_id: '<redacted>' },
      parsed: { action: 'feedback_submit', result: 'accurate_complete', expected_feedback_id: 'fb_0123456789abcdef0123456789abcdef' },
    }));
    const output = JSON.stringify(info.mock.calls);
    for (const secret of ['verification-secret', 'card-secret', 'value-secret', 'ou_private', 'on_private',
      'om_private', 'oc_private', 'private-name', 'private comment', 'private input']) {
      expect(output).not.toContain(secret);
    }
  });

  it('does not log arbitrary strings or objects as parsed callback fields', () => {
    vi.stubEnv('BOTMUX_CARD_ACTION_DIAGNOSTICS', '1');
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const input = { action: { behaviors: [{ type: 'callback', value: {
      action: 'feedback_submit', result: 'ou_private', expected_feedback_id: { token: 'nested-secret' },
    } }] } };
    logCardActionDiagnostics('handler', input, normalizeCardActionData(input));
    const output = JSON.stringify(info.mock.calls);
    expect(output).not.toContain('ou_private');
    expect(output).not.toContain('nested-secret');
    expect(output).toContain('"valueType":"object"');
  });
});
