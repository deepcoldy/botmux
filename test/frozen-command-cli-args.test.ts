import { describe, expect, it } from 'vitest';
import { frozenCommandLifecycleFlagValue } from '../src/cli/frozen-command-args.js';

describe('Frozen Command lifecycle CLI arguments', () => {
  it('keeps unknown double-dash tokens inside a reason', () => {
    const args = [
      'rm', '/旧命令',
      '--reason', '清理', '--legacy', '数据',
      '--replacement', '/新命令',
    ];

    expect(frozenCommandLifecycleFlagValue(args, '--reason')).toBe('清理 --legacy 数据');
    expect(frozenCommandLifecycleFlagValue(args, '--replacement')).toBe('/新命令');
  });

  it('stops at any recognized lifecycle flag regardless of flag order', () => {
    const args = [
      'apply', '/日报',
      '--reason', '更新月报口径',
      '--file', '.botmux/frozen-command-drafts/日报.yaml',
    ];

    expect(frozenCommandLifecycleFlagValue(args, '--reason')).toBe('更新月报口径');
    expect(frozenCommandLifecycleFlagValue(args, '--file')).toBe('.botmux/frozen-command-drafts/日报.yaml');
  });
});
