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
    readTurn: () => undefined,
  } as unknown as LinkRefLedger;
  return resolveOutboundLinkRefs(ledger, key, { text }, responseKind);
}

describe('registered-source final link integrity', () => {
  it('accepts the exact byte-identical URL in a final', () => {
    expect(resolve(`问题详情：${fullUrl}`, 'final').text).toBe(`问题详情：${fullUrl}`);
  });

  it.each(['**', '*', '__', '_'])('accepts an exact source URL in a link wrapped by %s', (markup) => {
    const text = `${markup}[问题标题](${fullUrl})${markup}`;
    expect(resolve(text, 'final').text).toBe(text);
  });

  it('still rejects a changed URL inside a bold link', () => {
    expect(() => resolve(`**[问题标题](${fullUrl.replace('problemId=14067', 'problemId=14068')})**`, 'final'))
      .toThrowError(expect.objectContaining({ code: 'link_ref_final_url_mismatch' }));
  });

  it('preserves literal asterisks in the URL while excluding bold link delimiters', () => {
    const sourceUrl = `${fullUrl}&wild=**`;
    const text = `**[问题标题](${sourceUrl})**`;
    expect(resolve(text, 'final', [sourceUrl]).text).toBe(text);
    expect(() => resolve(`**[问题标题](${fullUrl})**`, 'final', [sourceUrl]))
      .toThrowError(expect.objectContaining({ code: 'link_ref_final_url_mismatch' }));
  });

  it.each([
    `](${fullUrl})&changed=1`,
    String.raw`\[问题](${fullUrl})&changed=1`,
    `\`[问题](${fullUrl})&changed=1\``,
    ['```text', `[问题](${fullUrl})&changed=1`, '```'].join('\n'),
    `    [问题](${fullUrl})&changed=1`,
    `[问题\n\n](${fullUrl})&changed=1`,
    `[问题](\n\n${fullUrl})&changed=1`,
    `[问题\n---\n](${fullUrl})&changed=1`,
  ])('does not shorten a changed visible URL outside an executable Markdown link: %s', (text) => {
    expect(() => resolve(text, 'final'))
      .toThrowError(expect.objectContaining({ code: 'link_ref_final_url_mismatch' }));
  });

  it('does not let a link parsed inside image alt text shorten a separate URL', () => {
    const sourceUrl = 'https://detail.example.test/p?x=1';
    const altUrl = 'https://other.test/' + 'x'.repeat(sourceUrl.length - 'https://other.test/'.length);
    const text = `see ${sourceUrl})&changed=1 ![[x](${altUrl})](https://image.test/p)`;
    expect(() => resolve(text, 'final', [sourceUrl]))
      .toThrowError(expect.objectContaining({ code: 'link_ref_final_url_mismatch' }));
  });

  it('checks a changed destination even when the label and following text contain URLs', () => {
    const changed = fullUrl.replace('problemId=14067', 'problemId=14068');
    expect(() => resolve(`[https://other.test/p](${changed})https://next.test/p`, 'final'))
      .toThrowError(expect.objectContaining({ code: 'link_ref_final_url_mismatch' }));
  });

  it('checks bold links and changed targets inside a Markdown table', () => {
    const text = `| **[问题](${fullUrl})** |\n| --- |`;
    expect(resolve(text, 'final').text).toBe(text);
    expect(() => resolve(`| [https://other.test/p](${fullUrl.replace('problemId=14067', 'problemId=14068')}) |\n| --- |`, 'final'))
      .toThrowError(expect.objectContaining({ code: 'link_ref_final_url_mismatch' }));
  });

  it('preserves escaped pipes in table destinations and rejects a changed target', () => {
    const sourceUrl = String.raw`https://detail.example.test/p?x=1&q=a\|b`;
    const text = `| **[问题](${sourceUrl})** |\n| --- |`;
    expect(resolve(text, 'final', [sourceUrl]).text).toBe(text);
    expect(() => resolve(`| [https://other.test/p](${sourceUrl.replace('x=1', 'x=2')}) |\n| --- |`, 'final', [sourceUrl]))
      .toThrowError(expect.objectContaining({ code: 'link_ref_final_url_mismatch' }));
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

  it.each([
    ['ordered-list fence', [
      '1. 改成这样：', '', '    ```js', '    observers[name](', '      value,', '    );', '    ```',
    ].join('\n')],
    ['bullet-list fence', [
      '- 改成这样：', '', '    ```js', '    a](', '    ```',
    ].join('\n')],
    ['blockquote fence', [
      '> 示例：', '>', '> ```js', '> observers[name](', '>   value,', '> );', '> ```',
    ].join('\n')],
    ['nested-blockquote fence', [
      '> > 说明：', '> >', '> > ```js', '> > a](', '> > ```',
    ].join('\n')],
  ])('does not interpret ]( inside a closed %s as Markdown link syntax', (_label, text) => {
    expect(resolve(text, 'final', []).text).toBe(text);
  });

  it('still reports malformed Markdown after an unclosed fence with the exact reason', () => {
    const text = ['```js', 'const sample = true;', `[查看问题](${fullUrl}`].join('\n');

    expect(() => resolve(text, 'final'))
      .toThrowError(expect.objectContaining({ code: 'link_ref_malformed_markdown' }));
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
      readTurn: () => undefined,
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
