import { describe, expect, it } from 'vitest';
import { normalizeDoubaoReplyImages } from '../src/services/doubao-rich-media.js';
import { cardMarkdownImageReferences } from '../src/im/lark/card-markdown-image-references.js';
import { spawnSync } from 'node:child_process';
import { tsEvalArgs, tsRunnerPrefix } from './helpers/ts-runner.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveReplyImages } from '../src/im/lark/reply-images.js';

const block = (refs: unknown, close = 'RichMediaCard') => `<RichMediaCard>${JSON.stringify({ refs })}</${close}>`;

describe('Doubao native image blocks', () => {
  it('converts all twelve screenshots in the observed four-gallery reply, including its mismatched closing tag', () => {
    const groups = [[0, 1, 2, 3], [4, 5], [6, 7, 8], [9, 10, 11]];
    const input = groups.map((group, index) => `说明 ${index}\n\n${block(group.map(n => `/tmp/repo-shots/${n}.png`), index === 3 ? 'MediaCard' : undefined)}`).join('\n\n');
    const output = normalizeDoubaoReplyImages(input);
    expect(cardMarkdownImageReferences(output).map(ref => ref.source)).toEqual(Array.from({ length: 12 }, (_, n) => `/tmp/repo-shots/${n}.png`));
    expect(output).toContain('说明 3');
    expect(output).not.toContain('MediaCard>');
    expect(normalizeDoubaoReplyImages(output)).toBe(output);
  });

  it.each(['\n', '\r\n'])('preserves surrounding text with consecutive and multiline blocks (%j)', newline => {
    const input = ['Before', '', block(['one.png']), block(['two.png']), '', '<MediaCard>', '{"refs":["three.png"]}', '</MediaCard>', '', 'After'].join(newline);
    const output = normalizeDoubaoReplyImages(input);
    expect(output.startsWith(`Before${newline}${newline}`)).toBe(true);
    expect(output.endsWith(`${newline}${newline}After`)).toBe(true);
    expect(cardMarkdownImageReferences(output).map(ref => ref.source)).toEqual(['one.png', 'two.png', 'three.png']);
  });

  it('escapes path punctuation without changing an already escaped file URL', () => {
    const output = normalizeDoubaoReplyImages(block(['/tmp/a (1)#?.png', 'file:///tmp/a%20b).png', 'file:///tmp/a(.png']));
    expect(cardMarkdownImageReferences(output).map(ref => ref.source)).toEqual(['/tmp/a%20%281%29%23%3F.png', 'file:///tmp/a%20b%29.png', 'file:///tmp/a%28.png']);
  });

  it.each([
    { fileUrl: false, neighbor: false }, { fileUrl: true, neighbor: false },
    { fileUrl: false, neighbor: true }, { fileUrl: true, neighbor: true },
  ])('uploads the exact entity-shaped filename ($fileUrl, neighbor=$neighbor)', async ({ fileUrl, neighbor }) => {
    const dir = mkdtempSync(join(tmpdir(), 'doubao-entity-image-'));
    try {
      const source = join(dir, 'shot&amp;compare.png');
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
      writeFileSync(source, png);
      if (neighbor) writeFileSync(join(dir, 'shot&compare.png'), Buffer.concat([png, Buffer.from('different image')]));
      const uploads: Buffer[] = [];
      const output = await resolveReplyImages(normalizeDoubaoReplyImages(block([fileUrl ? pathToFileURL(source).href : source])), {
        workingDir: dir, state: { omitImages: false }, owns: () => true,
        upload: async bytes => { uploads.push(bytes); return 'img_v3_exact_source'; },
      });
      expect(uploads).toEqual([png]);
      expect(output).toContain('![图片 1](img_v3_exact_source)');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not mistake unrelated inline code in the preceding prose for a quoted gallery', () => {
    const input = `Images saved in \`/tmp\`\n${block(['/tmp/real.png'])}`;
    const output = normalizeDoubaoReplyImages(input);
    expect(output).toContain('Images saved in `/tmp`');
    expect(cardMarkdownImageReferences(output).map(ref => ref.source)).toEqual(['/tmp/real.png']);
  });

  it('does not consume a valid gallery after an unfinished native block', () => {
    const input = `<RichMediaCard>unfinished\n${block(['real.png'])}`;
    const output = normalizeDoubaoReplyImages(input);
    expect(output).toContain('<RichMediaCard>unfinished');
    expect(cardMarkdownImageReferences(output).map(ref => ref.source)).toEqual(['real.png']);
  });

  it('bounds an unterminated whitespace block without stalling the daemon', () => {
    // Run in a killable subprocess: a regression must fail within five seconds
    // instead of hanging the entire runner in synchronous regex backtracking.
    const { command, prefixArgs } = tsRunnerPrefix();
    const { args } = tsEvalArgs(`import { normalizeDoubaoReplyImages } from './src/services/doubao-rich-media.js';
      const input = '<RichMediaCard>' + ' '.repeat(16000);
      if (normalizeDoubaoReplyImages(input) !== input) process.exit(1);
      const collision = 'bmxDoubaoMediaMarker' + 'x'.repeat(256000)
        + '\\n<RichMediaCard>{"refs":["a.png"]}</RichMediaCard>';
      if (!normalizeDoubaoReplyImages(collision).includes('![图片 1](a.png)')) process.exit(1);`);
    const result = spawnSync(command, [...prefixArgs, ...args], { timeout: 5000, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  }, 10000);

  it.each([
    (native: string) => `\`\`\`json\n${native}\n\`\`\``,
    (native: string) => `~~~\n${native}\n~~~`,
    (native: string) => `\\\`\\\`\\\`json\n${native}\n\\\`\\\`\\\``,
    (native: string) => `    ${native}`,
    (native: string) => `\`${native}\``,
    (native: string) => `\`\n${native}\n\``,
    (native: string) => `\\${native}`,
  ])('never turns a code or escaped example into an image', wrap => {
    const input = wrap(block(['/tmp/example.png']));
    expect(normalizeDoubaoReplyImages(input)).toBe(input);
  });

  it.each([
    '<RichMediaCard>not json</RichMediaCard>', '<RichMediaCard>{"refs":null}</RichMediaCard>',
    block([]), block([42]), block(['']), block(['/tmp/a\n.png']), block(['x'.repeat(4097)]),
    block(Array.from({ length: 17 }, () => 'a.png')),
  ])('preserves malformed and oversized blocks as text: %s', input => {
    expect(normalizeDoubaoReplyImages(input)).toBe(input);
  });
});
