/**
 * Unit tests for the dsh runner argv parser. The key contract pinned here:
 * without an explicit --turn-timeout-ms the runner arms NO watchdog. The
 * process-level test (test/dsh-runner.test.ts) only observes 750ms, so it
 * cannot catch a regression that restores the old 600_000ms default — a pure
 * assertion on the parsed args can.
 */
import { describe, it, expect } from 'vitest';
import { parseArgs, MAX_TURN_TIMEOUT_MS } from '../src/dsh-runner-args.js';

const REQUIRED = ['--session-id', 's1', '--dsh-bin', '/usr/bin/dsh'];

describe('dsh-runner parseArgs', () => {
  it('leaves turnTimeoutMs undefined (no watchdog) when the flag is absent', () => {
    const args = parseArgs([...REQUIRED]);
    expect(args.turnTimeoutMs).toBeUndefined();
  });

  it('parses an explicit positive integer as the idle watchdog', () => {
    const args = parseArgs([...REQUIRED, '--turn-timeout-ms', '300000']);
    expect(args.turnTimeoutMs).toBe(300_000);
  });

  it.each([
    ['0', 0],
    ['-1', -1],
    ['1.5', 1.5],
    ['not-a-number', Number.NaN],
    [String(MAX_TURN_TIMEOUT_MS + 1), MAX_TURN_TIMEOUT_MS + 1],
  ])('ignores invalid timeout value %s (watchdog stays disabled)', (raw) => {
    const args = parseArgs([...REQUIRED, '--turn-timeout-ms', raw]);
    expect(args.turnTimeoutMs).toBeUndefined();
  });

  it('accepts the arm-able upper bound itself', () => {
    const args = parseArgs([...REQUIRED, '--turn-timeout-ms', String(MAX_TURN_TIMEOUT_MS)]);
    expect(args.turnTimeoutMs).toBe(MAX_TURN_TIMEOUT_MS);
  });

  it('requires session id and dsh bin', () => {
    expect(() => parseArgs(['--dsh-bin', '/usr/bin/dsh'])).toThrow('--session-id is required');
    expect(() => parseArgs(['--session-id', 's1'])).toThrow('--dsh-bin is required');
  });
});
