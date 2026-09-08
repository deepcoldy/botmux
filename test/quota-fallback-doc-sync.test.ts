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
    expect(zh).toContain('跨部署 / 团队目录目标暂不支持');
    expect(en).toContain('Cross-deployment/team-directory targets are not supported yet');
    expect(zh).toContain('A → B → C → A');
    expect(en).toContain('A → B → C → A');
    expect(zh).toContain('5 分钟去重');
    expect(en).toContain('five minutes');
    expect(zh).toContain('只关闭环路相关 Bot 的交接功能');
    expect(en).toContain('disables handoff only for Bots in that cycle');
    expect(zh).toContain('Bot 配置 → 高级');
    expect(en).toContain('Bot Configuration → Advanced');
  });
});
