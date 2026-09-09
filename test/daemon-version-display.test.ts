import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INSTALL_RESTART_HINT,
  daemonVersionDiffersFromDisk,
  formatDaemonVersionRestartHint,
  formatRunningDaemonsRestartSummary,
  groupDaemonVersions,
  isComparableBotmuxVersion,
} from '../src/utils/daemon-version-display.js';

describe('daemon version display', () => {
  it('treats 0.0.0 and missing as incomparable', () => {
    expect(isComparableBotmuxVersion('0.0.0')).toBe(false);
    expect(isComparableBotmuxVersion('')).toBe(false);
    expect(isComparableBotmuxVersion(undefined)).toBe(false);
    expect(isComparableBotmuxVersion('3.20.0')).toBe(true);
  });

  it('compares equality only, never size', () => {
    expect(daemonVersionDiffersFromDisk('3.19.3', '3.20.0')).toBe(true);
    expect(daemonVersionDiffersFromDisk('3.20.0', '3.20.0')).toBe(false);
    expect(daemonVersionDiffersFromDisk('3.21.0-canary.1', '3.20.0')).toBe(true);
    expect(daemonVersionDiffersFromDisk('0.0.0', '3.20.0')).toBe(false);
    expect(daemonVersionDiffersFromDisk('3.19.3', '0.0.0')).toBe(false);
    expect(daemonVersionDiffersFromDisk(undefined, '3.20.0')).toBe(false);
  });

  it('shares one operator sentence for the history hint and the version card', () => {
    expect(formatDaemonVersionRestartHint('3.19.3', '3.20.0'))
      .toBe('运行中的 daemon v3.19.3 与磁盘 v3.20.0 不一致，运行 botmux restart 应用');
    expect(formatRunningDaemonsRestartSummary(['3.19.3', '3.19.3', '3.18.12', '0.0.0'], '3.20.0'))
      .toBe('运行中的 daemon：1 个 v3.18.12 / 2 个 v3.19.3（磁盘 v3.20.0），运行 botmux restart 应用');
    expect(formatRunningDaemonsRestartSummary(['3.20.0', '0.0.0'], '3.20.0')).toBeUndefined();
    expect(formatRunningDaemonsRestartSummary(['3.19.3'], '0.0.0')).toBeUndefined();
    expect(groupDaemonVersions(['3.19.3', undefined])).toEqual([
      { version: '0.0.0', count: 1 },
      { version: '3.19.3', count: 1 },
    ]);
  });
});

describe('install / postinstall restart hint', () => {
  it('is printed unconditionally by postinstall-bin and install.sh', () => {
    const postinstall = readFileSync(resolve('scripts/postinstall-bin.mjs'), 'utf8');
    const installSh = readFileSync(resolve('install.sh'), 'utf8');
    expect(postinstall).toContain(INSTALL_RESTART_HINT);
    expect(installSh).toContain(INSTALL_RESTART_HINT);
  });
});
