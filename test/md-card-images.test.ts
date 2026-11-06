import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { buildCanonicalFinalReplyCard, buildContextualReplyCard, buildImageCardElements, omitReplyCardImages, prepareCardMarkdown, stripCardMarkdownImages } from '../src/im/lark/md-card.js';
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

  describe('stripCardMarkdownImages fixed point', () => {
    // Independent ground truth: a fresh MarkdownIt parser (not the scanner the
    // sanitizer itself uses) must see zero image tokens in the output.
    const groundTruthImages = (text: string): string[] => {
      const out: string[] = [];
      const walk = (tokens: Token[]): void => {
        for (const token of tokens) {
          if (token.type === 'image') out.push(token.attrGet('src') ?? '');
          if (token.children) walk(token.children);
        }
      };
      const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
      md.validateLink = () => true;
      walk(md.parse(text, {}));
      return out;
    };

    it('strips reference-style (full and shortcut) image definitions', () => {
      expect(groundTruthImages(stripCardMarkdownImages('见 ![图][r1]\n\n[r1]: img_v3_02k_aaa'))).toEqual([]);
      expect(groundTruthImages(stripCardMarkdownImages('![ref]\n\n[ref]: /tmp/x.png'))).toEqual([]);
    });

    it('reaches a fixed point when a replacement resyncs an inert image out of a link destination', () => {
      // The first replacement inserts "[Image omitted] [", adding bracket text
      // inside the outer link's text. That re-forms the parse and promotes the
      // image nested in the link DESTINATION into a live token. A single pass
      // leaks it; iterating to the fixed point must leave zero image tokens.
      // 600k randomized nested-link inputs found carriers needing up to 3
      // passes; assert the concrete shapes for both key and non-key sources.
      const carriers = [
        'x[![y](/tmp/y.png)!](![z](img_v3_02k_alien_key))',
        '[![](img_v3_02k_a)![x](/tmp/p.png)文![](img_v3_02k_b)](img_v3_02k_c)))',
        '](![![](img_v3_02k_d)](![y](https://e.com/y))文',
        '![\\![e](img:0)](![a](img:0)) ![a](img:0)[',
      ];
      for (const input of carriers) {
        const stripped = stripCardMarkdownImages(input);
        expect(groundTruthImages(stripped)).toEqual([]);
        // Fixed point: a second call changes nothing (no hidden multi-pass
        // requirement left for callers).
        expect(stripCardMarkdownImages(stripped)).toBe(stripped);
      }
    });

    it('leaves fences, inline code, escapes and ordinary links intact', () => {
      const text = '```\n![fenced](img:0)\n```\n~~~\n![](tilde)\n~~~\n`![inline](x)` \\![e](img:0) [l](https://e.com/a?img:0)';
      const stripped = stripCardMarkdownImages(text);
      expect(stripped).toBe(text);
      expect(groundTruthImages(stripped)).toEqual([]);
    });

    it('fixed-point sanitizes nested-link carriers inside the whole-card fallback too', () => {
      // The fallback is the last line before resend: its own per-field
      // sanitization must not leave a re-synced image token that rejects the
      // retried (and persisted) card as well.
      const carrier = 'x[![y](/tmp/y.png)!](![z](img_v3_02k_alien_key))';
      const card = JSON.stringify({
        schema: '2.0', body: { elements: [
          { tag: 'markdown', content: `过程\n${carrier}` },
          { tag: 'markdown', content: '正文图 ![](img_v3_body)' },
        ] },
      });
      const fallback = omitReplyCardImages(card);
      expect(imageSources(fallback)).toEqual([]);
      expect(omitReplyCardImages(fallback)).toBe(fallback);
    });
  });
});
