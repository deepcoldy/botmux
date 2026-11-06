import { describe, expect, it } from 'vitest';
import {
  appendResourceLinkRefCompanion,
  appendToolLinkRefCompanion,
  renderLinkRefCompanion,
} from '../src/services/link-ref-presenter.js';
import type { RegisteredLinkRef } from '../src/services/link-ref-types.js';

const ref = (refId: string, originalUrl: string): RegisteredLinkRef => ({
  refId: refId as RegisteredLinkRef['refId'],
  originalUrl,
  sourceType: 'tool',
});

describe('LinkRef presenter', () => {
  it('renders deterministic source order and exact original URL bytes', () => {
    const refs = [ref('lr_0123456789abcdef0123456789abcdef', 'https://example.test/p#Frag')];
    expect(renderLinkRefCompanion(refs)).toBe([
      '<botmux_link_refs>',
      'lr_0123456789abcdef0123456789abcdef = https://example.test/p#Frag',
      '引用或转发这个来源链接时，请输出 {{botmux_link:lr_0123456789abcdef0123456789abcdef}}。',
      '如果有意只讨论域名或 base URL，可以直接输出普通 URL。',
      '</botmux_link_refs>',
    ].join('\n'));
    expect(renderLinkRefCompanion([])).toBe('');
  });

  it('keeps one row per byte-distinct URL in input order', () => {
    const output = renderLinkRefCompanion([
      ref('lr_11111111111111111111111111111111', 'https://example.test/p'),
      ref('lr_22222222222222222222222222222222', 'https://example.test/p'),
    ]);
    expect(output.indexOf('lr_11111111111111111111111111111111')).toBeLessThan(output.indexOf('lr_22222222222222222222222222222222'));
    expect(output.match(/ = https:\/\/example\.test\/p/g)).toHaveLength(2);
  });

  it('appends a standalone text block without mutating tool result blocks', () => {
    const original = { content: [{ type: 'text', text: '{"business":true}' }, { type: 'image', data: 'abc' }] };
    const snapshot = structuredClone(original.content);
    const result = appendToolLinkRefCompanion(original, [
      ref('lr_11111111111111111111111111111111', 'https://example.test/p'),
    ]);

    expect(original.content).toEqual(snapshot);
    expect(result.content?.slice(0, -1)).toEqual(snapshot);
    expect(result.content?.at(-1)).toEqual(expect.objectContaining({ type: 'text', text: expect.stringContaining('<botmux_link_refs>') }));
  });

  it('appends a synthetic text resource without mutating resources', () => {
    const original = { contents: [{ uri: 'file:///business', mimeType: 'application/json', text: '{"ok":true}' }] };
    const snapshot = structuredClone(original.contents);
    const result = appendResourceLinkRefCompanion(original, [
      ref('lr_11111111111111111111111111111111', 'https://example.test/p'),
    ]);

    expect(original.contents).toEqual(snapshot);
    expect(result.contents?.slice(0, -1)).toEqual(snapshot);
    expect(result.contents?.at(-1)).toEqual({
      uri: 'botmux://link-refs/current-turn',
      mimeType: 'text/plain',
      text: expect.stringContaining('<botmux_link_refs>'),
    });
  });
});
