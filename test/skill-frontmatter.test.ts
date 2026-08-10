import { describe, expect, it } from 'vitest';
import { readSkillFrontmatter } from '../src/core/skills/frontmatter.js';

/** The installed-skill card renders `description`; when the frontmatter reader
 *  returned nothing the card degraded to just a source link with no text. These
 *  are the shapes real SKILL.md files use that the single-line-only reader
 *  could not handle. */
describe('skill frontmatter reader', () => {
  it('reads a plain single-line description (github.com/mattpocock/skills shape)', () => {
    const text = [
      '---',
      'name: grill-me',
      'description: Interview the user relentlessly about a plan. Use when user mentions "grill me".',
      '---',
      '',
      'body',
    ].join('\n');
    expect(readSkillFrontmatter(text)).toMatchObject({
      name: 'grill-me',
      description: expect.stringContaining('Interview the user'),
    });
  });

  describe('YAML block scalars (previously stored the literal ">-" as the description)', () => {
    it('folds >- and > into a single spaced line', () => {
      expect(readSkillFrontmatter('---\nname: x\ndescription: >-\n  line one\n  line two\n---\n').description)
        .toBe('line one line two');
      expect(readSkillFrontmatter('---\nname: x\ndescription: >\n  a\n  b\n---\n').description).toBe('a b');
    });

    it('keeps newlines for | and |-', () => {
      expect(readSkillFrontmatter('---\nname: x\ndescription: |\n  line one\n  line two\n---\n').description)
        .toBe('line one\nline two');
      expect(readSkillFrontmatter('---\nname: x\ndescription: |-\n  only\n---\n').description).toBe('only');
    });

    it('stops at the next key instead of swallowing it', () => {
      const fm = readSkillFrontmatter('---\nname: x\ndescription: >-\n  one\n  two\nversion: 1.2.3\n---\n');
      expect(fm.description).toBe('one two');
      expect(fm.version).toBe('1.2.3');
    });
  });

  describe('leading bytes that used to make the whole block unreadable', () => {
    it('tolerates a UTF-8 BOM', () => {
      expect(readSkillFrontmatter('﻿---\nname: x\ndescription: hi\n---\n')).toMatchObject({ name: 'x', description: 'hi' });
    });

    it('tolerates blank lines before the opening fence', () => {
      expect(readSkillFrontmatter('\n\n---\nname: x\ndescription: hi\n---\n')).toMatchObject({ name: 'x', description: 'hi' });
    });
  });

  describe('unchanged behaviour', () => {
    it('handles CRLF, quotes and tag arrays', () => {
      expect(readSkillFrontmatter('---\nname: x\ndescription: hi\r\n---\r\n').description).toBe('hi');
      expect(readSkillFrontmatter('---\nname: "quoted"\n---\n').name).toBe('quoted');
      expect(readSkillFrontmatter('---\nname: x\ntags: [a, b]\n---\n').tags).toEqual(['a', 'b']);
    });

    it('returns {} for missing or unterminated frontmatter, and skips empty values', () => {
      expect(readSkillFrontmatter('no frontmatter')).toEqual({});
      expect(readSkillFrontmatter('---\nname: x\n')).toEqual({});
      expect(readSkillFrontmatter('---\nname: x\ndescription:\n---\n').description).toBeUndefined();
    });
  });
});
