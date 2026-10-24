import { describe, expect, it } from 'vitest';
import { normalizeCardActionData } from '../src/im/lark/card-action-data.js';

const value = { action: 'feedback_submit', result: 'accurate_complete' };

describe('Lark callback payload normalization', () => {
  it('preserves an already normalized event and dropdown/form fields', () => {
    const data = { operator: { open_id: 'ou_user' }, action: {
      value, option: 'selected', form_value: { comment: '说明' }, input_value: 'query',
    } };
    expect(normalizeCardActionData(data)).toBe(data);
  });

  it('uses explicit action.value before a callback behavior', () => {
    const data = normalizeCardActionData({ action: {
      value: JSON.stringify(value), behaviors: [{ type: 'callback', value: { action: 'close' } }],
    } });
    expect(data.action?.value).toEqual(value);
  });

  it.each(['broken JSON', 'null', '[]', '42', '"feedback_submit"', [], null, 42].map(raw => [raw]))(
    'does not promote an invalid explicit value into a callback action: %j', raw => {
      const data = normalizeCardActionData({ action: {
        value: raw, behaviors: [{ type: 'callback', value }],
      } });
      expect(data.action?.value).toBeUndefined();
    },
  );

  it('ignores URL behaviors and preserves form values for a callback', () => {
    const data = normalizeCardActionData({ action: {
      tag: 'button', name: 'submit', form_value: { comment: '说明' },
      behaviors: [{ type: 'open_url', value: { action: 'close' } }, { type: 'callback', value: JSON.stringify(value) }],
    } });
    expect(data.action).toMatchObject({ value, tag: 'button', name: 'submit', form_value: { comment: '说明' } });
  });

  it('does not use a nested event when the flattened event already has an action', () => {
    const data = normalizeCardActionData({ action: { value }, operator: { open_id: 'ou_verified' },
      event: { action: { value: { action: 'close' } }, operator: { open_id: 'ou_other' } },
    });
    expect(data.operator?.open_id).toBe('ou_verified');
    expect(data.action?.value).toEqual(value);
  });

  it('keeps envelope event ids without mixing outer identity into the event body', () => {
    const data = normalizeCardActionData({ header: { event_id: 'evt_click' }, event_id: 'evt_outer', uuid: 'uuid_click',
      operator: { open_id: 'ou_outer' }, context: { open_message_id: 'om_outer' },
      event: { action: { value: JSON.stringify({ ...value, operator: { open_id: 'ou_value' } }) } },
    });
    expect(data.header?.event_id).toBe('evt_click');
    expect(data.event_id).toBe('evt_outer');
    expect(data.uuid).toBe('uuid_click');
    expect(data.operator).toBeUndefined();
    expect(data.context).toBeUndefined();
    expect(data.action?.value?.action).toBe('feedback_submit');
    // The reconstructed nested event must not inherit outer identity either,
    // and its action must be the normalized one.
    expect((data.event as any)?.operator).toBeUndefined();
    expect((data.event as any)?.context).toBeUndefined();
    expect((data.event as any)?.action?.value?.action).toBe('feedback_submit');
  });

  it('mirrors normalization into the nested event while keeping the inner operator', () => {
    const data = normalizeCardActionData({
      header: { event_id: 'evt_click' },
      operator: { open_id: 'ou_outer' }, context: { open_message_id: 'om_outer' },
      event: {
        operator: { open_id: 'ou_inner' }, context: { open_message_id: 'om_inner' },
        action: { value: JSON.stringify(value) },
      },
    });
    // Top level and nested event both resolve to the INNER, platform-verified identity.
    expect(data.operator?.open_id).toBe('ou_inner');
    expect(data.context?.open_message_id).toBe('om_inner');
    expect((data.event as any)?.operator?.open_id).toBe('ou_inner');
    expect((data.event as any)?.context?.open_message_id).toBe('om_inner');
    // Normalized value is present at both views; outer operator never appears.
    expect(data.action?.value).toEqual(value);
    expect((data.event as any)?.action?.value).toEqual(value);
    expect(JSON.stringify(data)).not.toContain('ou_outer');
  });

  it.each([undefined, null, [], 'invalid', { action: { behaviors: {} } }, { action: { behaviors: [null, { type: 'open_url', value }] } }].map(raw => [raw]))(
    'ignores malformed payloads and non-callback behaviors: %j', raw => {
      expect(normalizeCardActionData(raw).action?.value).toBeUndefined();
    },
  );
});
