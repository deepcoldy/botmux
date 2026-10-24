import { describe, expect, it } from 'vitest';
import { LinkRefLedger } from '../src/services/link-ref-ledger.js';
import { resolveOutboundLinkRefs } from '../src/services/link-ref-resolver.js';
import type { LinkRefTurnKey } from '../src/services/link-ref-types.js';

const key: LinkRefTurnKey = {
  appId: 'app-integrity',
  sessionId: 'session-integrity',
  turnId: 'turn-integrity',
  dispatchAttempt: 1,
};
const baseUrl = 'https://detail.example.test/preview_platform/problem';
const fullUrl = `${baseUrl}?problemBelong=0&previewId=218&problemId=14067&region=0#evidence`;

function resolve(
  text: string,
  responseKind: 'final' | 'auxiliary',
  registeredUrls: readonly string[] = [fullUrl],
) {
  const registered = registeredUrls.map((originalUrl, index) => ({
    refId: `lr_${String(index + 1).padStart(32, '0')}` as `lr_${string}`,
    originalUrl,
    sourceType: 'history' as const,
  }));
  const ledger = {
    resolveBatch: () => new Map(),
    listRegistered: () => registered,
  } as unknown as LinkRefLedger;
  return resolveOutboundLinkRefs(ledger, key, { text }, responseKind);
}

describe('registered-source final link integrity', () => {
  it('accepts the exact byte-identical URL in a final', () => {
    expect(resolve(`问题详情：${fullUrl}`, 'final').text).toBe(`问题详情：${fullUrl}`);
  });

  it.each([
    ['query removed', baseUrl],
    ['query reordered', `${baseUrl}?problemId=14067&previewId=218&problemBelong=0&region=0#evidence`],
    ['query changed', fullUrl.replace('problemId=14067', 'problemId=14068')],
    ['fragment removed', fullUrl.slice(0, fullUrl.indexOf('#'))],
  ])('rejects a same-endpoint final whose source bytes were %s', (_label, candidate) => {
    expect(() => resolve(`问题详情：${candidate}`, 'final'))
      .toThrowError(expect.objectContaining({ code: 'link_ref_final_url_mismatch' }));
  });

  it('rejects an unclosed Markdown inline-link destination', () => {
    expect(() => resolve(`[查看问题](${fullUrl}`, 'final'))
      .toThrowError(expect.objectContaining({ code: 'link_ref_malformed_markdown' }));
  });

  it('rejects a later unclosed Markdown link after an earlier valid link', () => {
    expect(() => resolve(`[完整](${fullUrl})\n[截断](${baseUrl}`, 'final'))
      .toThrowError(expect.objectContaining({ code: 'link_ref_malformed_markdown' }));
  });

  it('rejects malformed final Markdown even before a source URL has been registered', () => {
    expect(() => resolve(`[查看问题](${fullUrl}`, 'final', []))
      .toThrowError(expect.objectContaining({ code: 'link_ref_malformed_markdown' }));
  });

  it.each([
    ['fenced code', ['```js', 'const x = observers[name](', '  arg,', ');', '```'].join('\n')],
    ['inline code', 'Markdown 的未闭合链接标记是 `](`。'],
    ['indented code', '    用 ]( 这个写法'],
  ])('does not interpret ]( inside %s as Markdown link syntax', (_label, text) => {
    expect(resolve(text, 'final', []).text).toBe(text);
  });

  it('still validates visible URLs inside code literals byte-for-byte', () => {
    expect(() => resolve(['```text', baseUrl, '```'].join('\n'), 'final'))
      .toThrowError(expect.objectContaining({ code: 'link_ref_final_url_mismatch' }));
  });

  it('does not mistake an indented paragraph continuation for a code block', () => {
    expect(() => resolve('正文继续\n    [示例](', 'final', []))
      .toThrowError(expect.objectContaining({ code: 'link_ref_malformed_markdown' }));
  });

  it('resumes inline literal detection immediately after an indented code block', () => {
    const text = '    code block\n`Markdown 的未闭合链接标记是 ](`';
    expect(resolve(text, 'final', []).text).toBe(text);
  });

  it.each([
    `[一](${fullUrl})\n[二](${fullUrl})`,
    `[括号](https://other.example.test/problem(foo))`,
    String.raw`[转义](https://other.example.test/problem\))`,
  ])('accepts a closed Markdown destination: %s', (text) => {
    expect(resolve(text, 'final').text).toBe(text);
  });

  it('rejects an inline-link destination interrupted by a newline', () => {
    expect(() => resolve(`[查看问题](${fullUrl}\n后续正文`, 'final'))
      .toThrowError(expect.objectContaining({ code: 'link_ref_malformed_markdown' }));
  });

  it.each([
    '[相对地址](docs/problem',
    '[空目标](',
  ])('rejects any unclosed inline-link destination: %s', (text) => {
    expect(() => resolve(text, 'final', []))
      .toThrowError(expect.objectContaining({ code: 'link_ref_malformed_markdown' }));
  });

  it('validates the visible custom-card strings instead of hidden fallback text', () => {
    const registered = [{
      refId: 'lr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const,
      originalUrl: fullUrl,
      sourceType: 'history' as const,
    }];
    const ledger = {
      resolveBatch: () => new Map(),
      listRegistered: () => registered,
    } as unknown as LinkRefLedger;
    expect(() => resolveOutboundLinkRefs(ledger, key, {
      text: `隐藏回退：${fullUrl}`,
      preparedText: `预渲染：${fullUrl}`,
      card: { elements: [{ text: `可见卡片：${baseUrl}` }] },
    }, 'final')).toThrowError(expect.objectContaining({ code: 'link_ref_final_url_mismatch' }));
  });

  it('keeps intentional auxiliary base-URL messages compatible', () => {
    expect(resolve(`入口：${baseUrl}`, 'auxiliary').text).toBe(`入口：${baseUrl}`);
  });
});
