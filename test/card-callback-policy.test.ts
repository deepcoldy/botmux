import { describe, expect, it } from 'vitest';
import { findDisallowedCardCallback, type InteractiveCardCallbackPolicy } from '../src/core/card-callback-policy.js';

const policy: InteractiveCardCallbackPolicy = {
  allowsAction: action => ['example.approve', 'example.reject'].includes(action),
};
const callback = (action = 'example.approve', extra = {}) => ({ type: 'callback', value: { action, ...extra } });
const button = (behaviors: unknown[]) => ({ tag: 'button', behaviors });

describe('Card 2.0 plugin callback admission', () => {
  it('admits registered callback behaviors in a nested Card 2.0 layout', () => {
    const card = { schema: '2.0', body: { elements: [{ tag: 'column_set', columns: [
      { tag: 'column', elements: [button([callback()]), button([callback('example.reject')])] },
    ] }] } };
    expect(findDisallowedCardCallback(card, 'card', policy)).toBeNull();
  });

  it('still requires an explicit plugin policy', () => {
    expect(findDisallowedCardCallback(button([callback()]))).toBe('card.tag(button)');
  });

  it.each([
    ['unknown action', button([callback('other.submit')])],
    ['mixed callbacks', button([callback(), callback('other.submit')])],
    ['missing action', button([callback(), { type: 'callback', value: {} }])],
    ['URL with unknown callback', button([{ type: 'open_url', url: 'https://example.com' }, callback('other.submit')])],
    ['legacy unknown value', { ...button([callback()]), value: { action: 'other.submit' } }],
    ['legacy empty value', { ...button([callback()]), value: {} }],
    ['reserved key', button([callback('example.approve', { key: 'core' })])],
    ['reserved root_id', button([callback('example.approve', { root_id: 'core' })])],
    ['sibling input', { ...button([callback()]), children: [{ tag: 'input' }] }],
    ['non-callback behavior', button([{ type: 'unknown', value: { action: 'example.approve' } }])],
    ['nested fake behavior', button([{ nested: callback() }])],
    ['callback elsewhere', { tag: 'button', nested: callback() }],
  ])('rejects %s without weakening recursive validation', (_name, card) => {
    expect(findDisallowedCardCallback(card, 'card', policy)).not.toBeNull();
  });

  it('reports the offending callback even after an allowed one', () => {
    expect(findDisallowedCardCallback(button([callback(), callback('other.submit')]), 'card', policy))
      .toBe('card.behaviors[1].type');
  });

  it('allows multiple registered behaviors and URL behavior together', () => {
    expect(findDisallowedCardCallback(button([
      callback(), callback('example.reject'), { type: 'open_url', url: 'https://example.com' },
    ]), 'card', policy)).toBeNull();
  });

  it('preserves legacy buttons, URL-only cards and plugin forms', () => {
    expect(findDisallowedCardCallback({ tag: 'button', value: { action: 'example.approve' } }, 'card', policy)).toBeNull();
    expect(findDisallowedCardCallback(button([{ type: 'open_url', url: 'https://example.com' }]))).toBeNull();
    expect(findDisallowedCardCallback({ tag: 'button', url: 'https://example.com' })).toBeNull();
    expect(findDisallowedCardCallback({ tag: 'form', elements: [
      { tag: 'input', name: 'note' },
      { tag: 'button', form_action_type: 'submit', value: { action: 'example.approve' } },
    ] }, 'card', policy)).toBeNull();
  });
});
