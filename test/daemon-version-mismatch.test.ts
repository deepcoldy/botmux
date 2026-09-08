import { describe, expect, it } from 'vitest';
import { detectDaemonVersionMismatch, type OnlineDaemonInfo } from '../src/utils/daemon-discovery.js';

function daemon(version?: string): OnlineDaemonInfo {
  return {
    larkAppId: 'cli_test',
    ipcPort: 1,
    ...(version === undefined ? {} : { version }),
  };
}

describe('detectDaemonVersionMismatch', () => {
  it('returns null when every daemon advertises the same version as the CLI', () => {
    expect(detectDaemonVersionMismatch('1.2.3', [daemon('1.2.3'), daemon('1.2.3')])).toBeNull();
  });

  it('returns the mismatching daemon version when a daemon runs older code', () => {
    expect(detectDaemonVersionMismatch('1.2.3', [daemon('1.2.3'), daemon('1.1.0')])).toBe('1.1.0');
  });

  it('skips daemons without a version field (old daemons, backward compat)', () => {
    expect(detectDaemonVersionMismatch('1.2.3', [daemon(), daemon(undefined)])).toBeNull();
  });

  it('skips the check entirely when the CLI runs from a source checkout (0.0.0)', () => {
    expect(detectDaemonVersionMismatch('0.0.0', [daemon('1.2.3')])).toBeNull();
    expect(detectDaemonVersionMismatch('', [daemon('1.2.3')])).toBeNull();
  });

  it('treats a source-checkout daemon (0.0.0) against a published CLI as a mismatch', () => {
    expect(detectDaemonVersionMismatch('1.2.3', [daemon('0.0.0')])).toBe('0.0.0');
  });

  it('returns null when no daemons are online', () => {
    expect(detectDaemonVersionMismatch('1.2.3', [])).toBeNull();
  });

  it('ignores blank version strings', () => {
    expect(detectDaemonVersionMismatch('1.2.3', [daemon('   ')])).toBeNull();
  });
});
