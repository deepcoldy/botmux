/**
 * Unit tests for cli argv helpers. Currently covers firstPositional, used by
 * `botmux quoted` so `--session-id <uuid> om_xxx` doesn't mistake the uuid
 * for the message_id positional.
 *
 * Run:  pnpm vitest run test/cli-arg-utils.test.ts
 */
import { describe, it, expect } from 'vitest';
import { firstPositional, hasFlagOrEq } from '../src/cli/arg-utils.js';

describe('firstPositional', () => {
  it('returns the first non-flag token in a plain positional list', () => {
    expect(firstPositional(['om_123'], ['--session-id'])).toBe('om_123');
  });

  it('skips a value-taking flag and its value when they precede the positional', () => {
    expect(firstPositional(['--session-id', 'uuid-1', 'om_123'], ['--session-id'])).toBe('om_123');
  });

  it('also skips --flag=value form', () => {
    expect(firstPositional(['--session-id=uuid-1', 'om_123'], ['--session-id'])).toBe('om_123');
  });

  it('still works when the positional comes before the flag', () => {
    expect(firstPositional(['om_123', '--session-id', 'uuid-1'], ['--session-id'])).toBe('om_123');
  });

  it('skips unknown flags too (treated as boolean flags with no value)', () => {
    expect(firstPositional(['--verbose', 'om_123'], ['--session-id'])).toBe('om_123');
  });

  it('returns undefined when no positional is present', () => {
    expect(firstPositional(['--session-id', 'uuid-1'], ['--session-id'])).toBeUndefined();
    expect(firstPositional([], ['--session-id'])).toBeUndefined();
  });
});

describe('hasFlagOrEq', () => {
  // Guards create-group's team-mode routing: `--team=t1` must trigger it, not
  // just bare `--team`. A plain args.includes() misses the `=` spelling and the
  // command wrongly falls through to local-group creation (pi review P2).
  it('matches the bare flag form', () => {
    expect(hasFlagOrEq(['--team', 't1', '--agent', 'cli_a'], '--team')).toBe(true);
    expect(hasFlagOrEq(['--agent', 'cli_a'], '--agent')).toBe(true);
  });

  it('matches the =value form', () => {
    expect(hasFlagOrEq(['--team=t1', '--agent=cli_a'], '--team')).toBe(true);
    expect(hasFlagOrEq(['--team=t1', '--agent=cli_a'], '--agent')).toBe(true);
    expect(hasFlagOrEq(['--chat=oc_1'], '--chat')).toBe(true);
  });

  it('is false when the flag is absent', () => {
    expect(hasFlagOrEq(['--bot', 'x', '--name', 'g'], '--team')).toBe(false);
    expect(hasFlagOrEq([], '--team')).toBe(false);
  });

  it('does not match a different flag that shares a prefix', () => {
    // `--teammate` must not satisfy a `--team` check.
    expect(hasFlagOrEq(['--teammate', 'x'], '--team')).toBe(false);
    expect(hasFlagOrEq(['--teammate=x'], '--team')).toBe(false);
  });
});
