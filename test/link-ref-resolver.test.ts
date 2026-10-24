import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinkRefLedger } from '../src/services/link-ref-ledger.js';
import {
  findExecutableLinkRefs,
  resolveOutboundLinkRefs,
} from '../src/services/link-ref-resolver.js';
import type { LinkRefTurnKey } from '../src/services/link-ref-types.js';

const key: LinkRefTurnKey = { appId: 'app', sessionId: 'session', turnId: 'turn', dispatchAttempt: 1 };

describe('LinkRef resolver', () => {
  let dataDir: string;
  let ledger: LinkRefLedger;
  let sequence: number;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-link-ref-resolver-'));
    sequence = 0;
    ledger = new LinkRefLedger(dataDir, { randomBytes: () => Buffer.alloc(16, ++sequence) });
    ledger.openTurn(key);
  });

  afterEach(() => {
    ledger.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function register(originalUrl: string): string {
    return ledger.registerBatch(key, [{ originalUrl, sourceType: 'tool' }]).registered[0]!.refId;
  }

  it('expands executable refs but preserves code and unescapes literal refs', () => {
    const refId = register('https://example.test/p');
    const placeholder = `{{botmux_link:${refId}}}`;
    const text = [
      `expand ${placeholder}`,
      `literal \`${placeholder}\``,
      'literal fenced:',
      '```md',
      placeholder,
      '```',
      `escaped \\${placeholder}`,
      'malformed {{botmux_link:lr_AAAA}}',
    ].join('\n');

    expect(resolveOutboundLinkRefs(ledger, key, { text }).text).toBe([
      'expand https://example.test/p',
      `literal \`${placeholder}\``,
      'literal fenced:',
      '```md',
      placeholder,
      '```',
      `escaped ${placeholder}`,
      'malformed {{botmux_link:lr_AAAA}}',
    ].join('\n'));
  });

  it.each([
    ['~~~ts\n%s\n~~~'],
    ['```` language\n%s\n````'],
    ['``%s``'],
  ])('keeps refs literal inside tilde/backtick fences and inline code: %s', (template) => {
    const refId = register('https://example.test/p');
    const placeholder = `{{botmux_link:${refId}}}`;
    const text = template.replace('%s', placeholder);
    expect(resolveOutboundLinkRefs(ledger, key, { text }).text).toBe(text);
  });

  it('keeps refs literal inside CRLF fenced code blocks', () => {
    const refId = register('https://example.test/private');
    const placeholder = `{{botmux_link:${refId}}}`;
    const text = ['```md', placeholder, '```'].join('\r\n');

    expect(resolveOutboundLinkRefs(ledger, key, { text }).text).toBe(text);
  });

  it('keeps refs literal inside CommonMark indented code blocks', () => {
    const refId = register('https://example.test/private');
    const placeholder = `{{botmux_link:${refId}}}`;
    const text = `    ${placeholder}`;

    expect(resolveOutboundLinkRefs(ledger, key, { text }).text).toBe(text);
  });

  it('expands refs in an indented paragraph continuation that is not code', () => {
    const refId = register('https://example.test/continued');
    const placeholder = `{{botmux_link:${refId}}}`;
    const text = `paragraph\n    ${placeholder}`;

    expect(resolveOutboundLinkRefs(ledger, key, { text }).text)
      .toBe('paragraph\n    https://example.test/continued');
  });

  it('resumes inline literal detection immediately after an indented code block', () => {
    const refId = register('https://example.test/private');
    const placeholder = `{{botmux_link:${refId}}}`;
    const text = `    code block\n\`${placeholder}\``;

    expect(resolveOutboundLinkRefs(ledger, key, { text }).text).toBe(text);
  });

  it.each([
    ['unclosed inline code on the same line', '`unfinished %s'],
    ['unclosed inline code on an earlier line', '`unfinished\n%s'],
    ['unclosed backtick fence', '```md\nunfinished\n%s'],
    ['unclosed tilde fence', '~~~md\nunfinished\n%s'],
  ])('does not let %s hide an outbound ref', (_label, template) => {
    const refId = register('https://example.test/recovered');
    const placeholder = `{{botmux_link:${refId}}}`;

    expect(resolveOutboundLinkRefs(ledger, key, { text: template.replace('%s', placeholder) }).text)
      .toContain('https://example.test/recovered');
  });

  it('handles many unmatched fence candidates without rescanning the remaining document', () => {
    const refId = register('https://example.test/recovered');
    const placeholder = `{{botmux_link:${refId}}}`;
    const text = [
      ...Array.from({ length: 8_000 }, (_, index) => `\`\`\` unmatched-${index}`),
      placeholder,
    ].join('\n');
    const startedAt = performance.now();

    const resolved = resolveOutboundLinkRefs(ledger, key, { text }).text;

    expect(resolved).toContain('https://example.test/recovered');
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  }, 15_000);

  it('deduplicates repeated refs into one ledger lookup', () => {
    const refId = register('https://example.test/p');
    const spy = vi.spyOn(ledger, 'resolveBatch');
    const placeholder = `{{botmux_link:${refId}}}`;

    expect(resolveOutboundLinkRefs(ledger, key, { text: `${placeholder} ${placeholder}` })).toEqual({
      text: 'https://example.test/p https://example.test/p',
      refCount: 1,
    });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(key, [refId]);
  });

  it('recursively expands card string and array leaves without changing non-strings', () => {
    const refId = register('https://example.test/action');
    const placeholder = `{{botmux_link:${refId}}}`;
    const result = resolveOutboundLinkRefs(ledger, key, {
      card: { header: { title: placeholder }, body: [placeholder, 42, { enabled: true }] },
    });
    expect(result.card).toEqual({
      header: { title: 'https://example.test/action' },
      body: ['https://example.test/action', 42, { enabled: true }],
    });
  });

  it('expands and then validates expected links', () => {
    const refId = register('https://example.test/expected');
    expect(resolveOutboundLinkRefs(ledger, key, { expectedLinks: [`{{botmux_link:${refId}}}`] }).expectedLinks)
      .toEqual(['https://example.test/expected']);
    expect(() => resolveOutboundLinkRefs(ledger, key, { expectedLinks: ['not-a-url'] }))
      .toThrowError(expect.objectContaining({ code: 'expected_link_invalid_after_link_ref' }));
  });

  it('never tokenizes placeholder-shaped bytes inserted from the ledger', () => {
    const second = register('https://example.test/second');
    const firstUrl = 'https://example.test/redirect' + `?next={{botmux_link:${second}}}`;
    const first = register(firstUrl);

    expect(resolveOutboundLinkRefs(ledger, key, { text: `{{botmux_link:${first}}}` }).text).toBe(firstUrl);
  });

  it('leaves ordinary base URLs untouched and avoids a ledger query without executable refs', () => {
    const spy = vi.spyOn(ledger, 'resolveBatch');
    expect(resolveOutboundLinkRefs(ledger, key, { text: 'https://example.test' })).toEqual({
      text: 'https://example.test',
      refCount: 0,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(['progress', 'auxiliary'] as const)(
    'does not query a missing turn ledger for %s output without refs',
    (responseKind) => {
      const missingKey = { ...key, turnId: 'missing' };
      const spy = vi.spyOn(ledger, 'listRegistered');

      expect(resolveOutboundLinkRefs(ledger, missingKey, { text: '你好' }, responseKind)).toEqual({
        text: '你好',
        refCount: 0,
      });
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it('treats a missing final turn as having no registered source URLs', () => {
    const missingKey = { ...key, turnId: 'missing-final' };

    expect(resolveOutboundLinkRefs(ledger, missingKey, { text: '纯文本回答' }, 'final')).toEqual({
      text: '纯文本回答',
      refCount: 0,
    });
  });

  it('treats an expired final turn as having no registered source URLs', () => {
    let now = Date.now();
    const root = mkdtempSync(join(tmpdir(), 'botmux-link-ref-resolver-expired-'));
    const expiringLedger = new LinkRefLedger(root, { now: () => now });
    const expiringKey = { ...key, turnId: 'expired-final' };
    expiringLedger.openTurn(expiringKey);
    now += 8 * 24 * 60 * 60_000;

    expect(resolveOutboundLinkRefs(expiringLedger, expiringKey, { text: '纯文本回答' }, 'final'))
      .toEqual({ text: '纯文本回答', refCount: 0 });
    expiringLedger.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects unknown and cross-turn refs with stable codes', () => {
    const refId = register('https://example.test/p');
    expect(() => resolveOutboundLinkRefs(ledger, key, { text: '{{botmux_link:lr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}}' }))
      .toThrowError(expect.objectContaining({ code: 'link_ref_unknown' }));
    expect(() => resolveOutboundLinkRefs(ledger, { ...key, turnId: 'other' }, { text: `{{botmux_link:${refId}}}` }))
      .toThrowError(expect.objectContaining({ code: 'link_ref_identity_mismatch' }));
  });

  it('findExecutableLinkRefs separates lookup from expansion', () => {
    const refId = 'lr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const found = findExecutableLinkRefs(`x {{botmux_link:${refId}}}`);
    expect(found.refIds).toEqual([refId]);
    expect(found.expand(new Map([[refId, 'https://example.test/p']]))).toBe('x https://example.test/p');
  });
});
