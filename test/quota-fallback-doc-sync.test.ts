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
    expect(zh).toContain('跳过环路中的 Bot，但仍启动 Dashboard 和无关 Bot');
    expect(en).toContain('skips Bots in that cycle while still starting the Dashboard and unrelated Bots');
    expect(zh).toContain('高级 → 额度耗尽交接');
    expect(en).toContain('Advanced → Quota-limit handoff');
  });
});
