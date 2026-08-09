import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('messageQuota public documentation', () => {
  it('keeps the unset grant-card and Oncall defaults explicit in both locales', () => {
    const zh = readFileSync(join(repoRoot, 'docs-site/docs/zh/bots-json.md'), 'utf8');
    const en = readFileSync(join(repoRoot, 'docs-site/docs/en/bots-json.md'), 'utf8');

    expect(zh).toContain('未配置时，新授权卡默认每人 3 条，Oncall 不设额度');
    expect(en).toContain('When unset, new grant cards default to 3 messages per person while Oncall remains unlimited');
  });
});
