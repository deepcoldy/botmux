import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('quotaFallbackBot public documentation', () => {
  it('keeps the opt-in, identity, dedup, and loop boundaries explicit in both locales', () => {
    const zh = readFileSync(join(repoRoot, 'docs-site/docs/zh/bots-json.md'), 'utf8');
    const en = readFileSync(join(repoRoot, 'docs-site/docs/en/bots-json.md'), 'utf8');

    for (const doc of [zh, en]) {
      expect(doc).toContain('quotaFallbackBot');
      expect(doc).toContain('targetAppId');
      expect(doc).toContain('usage');
      expect(doc).toContain('rate');
      expect(doc).toContain('1000');
    }
    expect(zh).toContain('不要配置或复制 `ou_xxx`');
    expect(en).toContain('Never configure or copy an `ou_xxx`');
    expect(zh).toContain('同一个限额 episode 最多尝试一次');
    expect(en).toContain('A limit episode is attempted at most once');
    expect(zh).toContain('不会继续级联');
    expect(en).toContain('cannot cascade');
  });
});
