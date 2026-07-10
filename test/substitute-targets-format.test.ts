import { describe, it, expect } from 'vitest';
import { parseSubstituteTargets, formatSubstituteTargets } from '../src/dashboard/web/substitute-targets.js';

describe('parseSubstituteTargets', () => {
  it('classifies email / ou_ / on_ lines', () => {
    const { targets, invalid } = parseSubstituteTargets('alice@example.com\nou_123\non_456');
    expect(invalid).toEqual([]);
    expect(targets).toEqual([
      { email: 'alice@example.com' },
      { openId: 'ou_123' },
      { unionId: 'on_456' },
    ]);
  });

  it('keeps a trailing "# name" comment as the name fallback', () => {
    const { targets } = parseSubstituteTargets('ou_123  # 申晗\nbob@x.com # Bob');
    expect(targets).toEqual([
      { openId: 'ou_123', name: '申晗' },
      { email: 'bob@x.com', name: 'Bob' },
    ]);
  });

  it('flags unclassifiable lines (bare names) as invalid', () => {
    const { targets, invalid } = parseSubstituteTargets('张三\nou_ok');
    expect(targets).toEqual([{ openId: 'ou_ok' }]);
    expect(invalid).toEqual(['张三']);
  });

  it('ignores blank lines and surrounding whitespace', () => {
    const { targets, invalid } = parseSubstituteTargets('\n  ou_a  \n\n  b@c.io \n');
    expect(invalid).toEqual([]);
    expect(targets).toEqual([{ openId: 'ou_a' }, { email: 'b@c.io' }]);
  });

  it('still accepts the legacy JSON-array format', () => {
    const { targets, invalid } = parseSubstituteTargets('[{"openId":"ou_x","name":"N"},{"email":"e@f.g"}]');
    expect(invalid).toEqual([]);
    expect(targets).toEqual([{ openId: 'ou_x', name: 'N' }, { email: 'e@f.g' }]);
  });

  it('returns empty for empty input', () => {
    expect(parseSubstituteTargets('   ')).toEqual({ targets: [], invalid: [] });
  });
});

describe('formatSubstituteTargets', () => {
  it('renders one entry per line, preferring email and annotating the name', () => {
    expect(formatSubstituteTargets({ targets: [
      { openId: 'ou_x', name: '申晗' },
      { email: 'a@b.com', openId: 'ou_y', name: 'Alice' },
    ] })).toBe('ou_x  # 申晗\na@b.com  # Alice');
  });

  it('omits the comment when the name equals the id and tolerates array input', () => {
    expect(formatSubstituteTargets([{ openId: 'ou_x', name: 'ou_x' }])).toBe('ou_x');
  });

  it('round-trips through parse', () => {
    const text = formatSubstituteTargets({ targets: [{ openId: 'ou_x', name: '申晗' }, { email: 'a@b.com', name: 'Alice' }] });
    const { targets } = parseSubstituteTargets(text);
    expect(targets).toEqual([{ openId: 'ou_x', name: '申晗' }, { email: 'a@b.com', name: 'Alice' }]);
  });
});
