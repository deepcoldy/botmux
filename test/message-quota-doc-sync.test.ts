import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('messageQuota public documentation', () => {
  it('keeps the grantee-only scope and the unmetered-Oncall invariant explicit in both locales', () => {
    const zh = readFileSync(join(repoRoot, 'docs-site/docs/zh/bots-json.md'), 'utf8');
    const en = readFileSync(join(repoRoot, 'docs-site/docs/en/bots-json.md'), 'utf8');

    // 未配置时的授权卡默认值
    expect(zh).toContain('未配置时新授权卡默认每人 3 条');
    expect(en).toContain('when unset they default to 3 messages per person');
    // 本次修复的语义边界：oncall 不读这个值。文案回退成「与 Oncall 共用额度」时这里必须红。
    expect(zh).toContain('Oncall 群恒不设额度、不读此值');
    expect(en).toContain('Oncall groups are always unmetered and never read this value');
    expect(zh).not.toContain('新授权卡与 Oncall 都使用');
    expect(en).not.toContain('new grant cards and Oncall both use');
  });
});
