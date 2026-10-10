import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { buildCanonicalFinalReplyCard, buildContextualReplyCard, buildImageCardElements, omitReplyCardImages, prepareCardMarkdown } from '../src/im/lark/md-card.js';
import { replyWithImageFallback } from '../src/im/lark/card-image-fallback.js';

const parser = new MarkdownIt();

function imageSources(card: string): string[] {
  const sources: string[] = [];
  function inspectTokens(tokens: Token[]): void {
    for (const token of tokens) {
      if (token.type === 'image') sources.push(token.attrGet('src') ?? '');
      if (token.children) inspectTokens(token.children);
    }
  }
  function inspect(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if ('tag' in value && value.tag === 'markdown' && 'content' in value && typeof value.content === 'string') {
      inspectTokens(parser.parse(value.content, {}));
    }
    if ('tag' in value && value.tag === 'img' && 'img_key' in value && typeof value.img_key === 'string') {
      sources.push(value.img_key);
    }
    for (const child of Object.values(value)) inspect(child);
  }
  inspect(JSON.parse(card));
  return sources;
}

describe('reply cards with unsupported images', () => {
  it('keeps the final answer readable when a Codex reply includes a local screenshot', () => {
    const card = buildCanonicalFinalReplyCard({
      markdown: 'Preview is ready.\n\n![Preview](/Users/alice/work/tmp/island-edgeone-preview-limit.jpg)\n\nDeployment is pending.',
    });
    expect(imageSources(card)).toEqual([]);
    expect(card).toContain('Preview is ready.');
    expect(card).toContain('Preview');
    expect(card).toContain('Deployment is pending.');
    expect(card).toContain('/Users/alice/work/tmp/island-edgeone-preview-limit.jpg');
  });

  it.each([
    '![Preview](../tmp/preview.png)',
    '![Preview](/home/alice/tmp/preview.png)',
    '![Preview](https://example.com/preview.png)',
    '![Preview](file:///tmp/preview.png)',
    '![Preview](</Users/alice/my screenshots/preview(1).png> "Screenshot")',
    '![Preview][screenshot]\n\n[screenshot]: /tmp/preview.png',
    '![Preview][]\n\n[Preview]: /tmp/preview.png',
    '![Preview]\n\n[Preview]: /tmp/preview.png',
    '> ![Preview](/tmp/preview.png)',
    '- ![Preview](/tmp/preview.png)',
    '## ![Preview](/tmp/preview.png)',
    '| Preview |\n| --- |\n| ![Preview](/tmp/preview.png) |',
  ])('downgrades unsupported image syntax: %s', markdown => {
    const card = buildCanonicalFinalReplyCard({ markdown });
    expect(imageSources(card)).toEqual([]);
    expect(card).toContain('[Image omitted]');
    expect(card).toContain('Preview');
  });

  it('preserves uploaded keys and the explicit img:N upload flow', () => {
    const markdown = '![Preview](img_v3_uploaded_key)\n\n![](img_v2_a) ![](img_v2_b)';
    expect(imageSources(buildCanonicalFinalReplyCard({ markdown })))
      .toEqual(['img_v3_uploaded_key', 'img_v2_a', 'img_v2_b']);
    const body = { elements: buildImageCardElements('![Preview](img:0)\n\n![](img:1,2)',
      ['img_v3_uploaded_key', 'img_v2_a', 'img_v2_b']) };
    expect(imageSources(JSON.stringify({ body })))
      .toEqual(['img_v3_uploaded_key', 'img_v2_a', 'img_v2_b']);
  });

  it('preserves img:N placeholders through sandbox relay preparation until upload keys are resolved', () => {
    const prepared = prepareCardMarkdown('Before ![Preview](img:0) after.', undefined, 'disabled');
    const body = { elements: buildImageCardElements(prepared, ['img_v3_uploaded_key']) };
    const card = JSON.stringify({ body });
    expect(prepared).toBe('Before ![Preview](img:0) after.');
    expect(imageSources(card)).toEqual(['img_v3_uploaded_key']);
    expect(card).toContain('Before ![Preview](img_v3_uploaded_key) after.');
  });

  it.each([
    '`![Preview](/tmp/preview.png)`',
    '``![Preview](/tmp/preview.png) `example` ``',
    '```markdown\n![Preview](/tmp/preview.png)\n```',
    '~~~~markdown\n![Preview](/tmp/preview.png)\n~~~~',
    '````markdown\n```\n![Preview](/tmp/preview.png)\n```\n````',
    '    ![Preview](/tmp/preview.png)',
    '\\![Preview](/tmp/preview.png)',
    '> ```markdown\n> ![Preview](/tmp/preview.png)\n> ```',
  ])('preserves image examples in code or escaped syntax: %s', markdown => {
    const card = buildCanonicalFinalReplyCard({ markdown });
    expect(imageSources(card)).toEqual([]);
    expect(card).toContain('![Preview](/tmp/preview.png)');
    expect(card).not.toContain('[Image omitted]');
  });

  it('sanitizes both sides of contextual local-turn and adopt-preamble cards', () => {
    const card = buildContextualReplyCard({
      title: 'Previous turn',
      userText: 'Check ![Input](/tmp/input.png)',
      assistantText: 'Done. ![Preview](/tmp/preview.png)',
      assistantLabel: 'Codex',
    });
    expect(imageSources(card)).toEqual([]);
    expect(card).toContain('Check');
    expect(card).toContain('Input');
    expect(card).toContain('Done.');
  });

  it('removes rejected Markdown and native images while retaining text, code and card controls', () => {
    const card = buildCanonicalFinalReplyCard({ markdown: [
      'Ready.', '![Preview](img_v3_rejected)', '![](img_v2_a) ![](img_v2_b)',
      '`![Example](img_v3_example)`', '```md\n![Example](img_v3_example)\n```',
    ].join('\n\n'), brand: 'Test Bot' });
    const fallback = omitReplyCardImages(card);
    expect(imageSources(fallback)).toEqual([]);
    expect(fallback).toContain('Ready.');
    expect(fallback).toContain('Preview');
    expect(fallback).toContain('Test Bot');
    expect(fallback).toContain('`![Example](img_v3_example)`');
    expect(fallback).toContain('```md\\n![Example](img_v3_example)\\n```');
    expect(omitReplyCardImages(fallback)).toBe(fallback);
  });

  it.each([false, true])('delivers rejected table images as descriptions with body images=%s', async withBodyImage => {
    const card = buildCanonicalFinalReplyCard({ markdown: [
      'Ready.',
      ...(withBodyImage ? ['![Preview](img_v3_rejected_body)'] : []),
      '| Preview | Example |\n| --- | --- |\n| Body ![Preview](img_v3_rejected_table) | `![Example](img_v3_example)` |',
    ].join('\n\n') });
    const sent: string[] = [];
    const result = await replyWithImageFallback(card, 'interactive', async body => {
      sent.push(body);
      if (body.includes('![Preview]')) {
        throw new Error('Failed to reply message: ErrCode: 200570; card contains invalid image keys (code: 230099)');
      }
      return 'om_reply';
    });
    expect(result).toBe('om_reply');
    expect(sent).toHaveLength(2);
    const fallback = sent[1];
    expect(fallback).toContain('"tag":"table"');
    expect(fallback).toContain('Ready.');
    expect(fallback).toContain('Body [Image omitted] [Preview]');
    expect(fallback).toContain('`![Example](img_v3_example)`');
    expect(fallback).not.toContain('![Preview]');
    expect(omitReplyCardImages(fallback)).toBe(fallback);
  });
});
