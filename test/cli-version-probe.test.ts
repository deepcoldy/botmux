/**
 * ensureCliVersion：daemon 只探测 bot 级安装，/cli 会话选择与冷恢复的「生效安装」
 * 键缺失时按需补探。这里钉住四条行为：已知值不重探、miss 才探且缓存、失败负缓存
 * 回落 unknown、不同安装键独立；任何失败都不抛错。
 *
 * Run: bun x vitest run --project unit test/cli-version-probe.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, createCliAdapterSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  createCliAdapterSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

vi.mock('../src/adapters/cli/registry.js', () => ({
  createCliAdapterSync: (...args: unknown[]) => createCliAdapterSyncMock(...args),
}));

import {
  ensureCliVersion,
  probeCliVersion,
  resetCliVersionProbeCacheForTest,
} from '../src/core/cli-version-probe.js';
import { runtimeInstallationKey } from '../src/adapters/cli/runtime.js';

const opencodeInput = { cliId: 'opencode' as const };
const opencodeKey = runtimeInstallationKey(opencodeInput);

beforeEach(() => {
  resetCliVersionProbeCacheForTest();
  execFileSyncMock.mockReset();
  createCliAdapterSyncMock.mockReset();
  createCliAdapterSyncMock.mockReturnValue({
    resolvedBin: '/usr/bin/opencode',
    versionCommand: undefined,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ensureCliVersion', () => {
  it('returns the daemon-known version without probing', () => {
    const getKnown = vi.fn(() => '1.19.1');
    expect(ensureCliVersion(opencodeInput, getKnown)).toBe('1.19.1');
    expect(getKnown).toHaveBeenCalledWith(opencodeKey);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('probes on a cache miss, normalizes the raw output, and serves later calls from cache', () => {
    execFileSyncMock.mockReturnValueOnce('opencode version 1.17.12\n');
    const getKnown = vi.fn(() => 'unknown');

    expect(ensureCliVersion(opencodeInput, getKnown)).toBe('1.17.12');
    expect(createCliAdapterSyncMock).toHaveBeenCalledWith('opencode', undefined);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock.mock.calls[0].slice(0, 2)).toEqual(['/usr/bin/opencode', ['--version']]);

    // 第二次：本模块缓存命中，不再 exec，也不再问 daemon 之外的东西。
    expect(ensureCliVersion(opencodeInput, getKnown)).toBe('1.17.12');
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to unknown on a probe failure and negative-caches within the TTL', () => {
    execFileSyncMock.mockImplementation(() => { throw new Error('ENOENT'); });
    const getKnown = vi.fn(() => 'unknown');

    expect(ensureCliVersion(opencodeInput, getKnown)).toBe('unknown');
    expect(ensureCliVersion(opencodeInput, getKnown)).toBe('unknown');
    // 负缓存：失败后 60s 内不再重复阻塞 5s 的探测。
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('never throws when the adapter cannot be constructed', () => {
    createCliAdapterSyncMock.mockImplementation(() => { throw new Error('not found'); });
    expect(ensureCliVersion(opencodeInput, () => 'unknown')).toBe('unknown');
  });

  it('treats an empty cliId as unknown without probing', () => {
    const getKnown = vi.fn();
    expect(ensureCliVersion({ cliId: undefined }, getKnown)).toBe('unknown');
    expect(getKnown).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('keeps a per-installation cache: the /cli selection key probes independently of the bot key', () => {
    // P2 场景：bot 是 claude-code（daemon 只探过它的键），会话 /cli 选了 opencode，
    // 生效键 ["opencode","","",""] 从未被探测 → 必须现场补探而不是沿用 unknown。
    const botClaudeKey = runtimeInstallationKey({ cliId: 'claude-code' });
    const known = new Map<string, string>([[botClaudeKey, '2.1.130']]);
    execFileSyncMock.mockReturnValueOnce('1.19.3');

    const version = ensureCliVersion(opencodeInput, key => known.get(key) ?? 'unknown');
    expect(version).toBe('1.19.3');
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });
});

describe('probeCliVersion', () => {
  it('uses the adapter versionCommand override when present', () => {
    execFileSyncMock.mockReturnValueOnce('v2.1.4');
    const out = probeCliVersion({
      resolvedBin: '/usr/bin/opencode2',
      versionCommand: () => ({ bin: '/usr/bin/opencode2', args: ['version'] }),
    });
    expect(out).toBe('2.1.4');
    expect(execFileSyncMock.mock.calls[0].slice(0, 2)).toEqual(['/usr/bin/opencode2', ['version']]);
  });

  it('maps empty / unknown output to unknown instead of an empty string', () => {
    execFileSyncMock.mockReturnValueOnce('   ');
    expect(probeCliVersion({ resolvedBin: 'x', versionCommand: undefined })).toBe('unknown');
    execFileSyncMock.mockReturnValueOnce('unknown');
    expect(probeCliVersion({ resolvedBin: 'x', versionCommand: undefined })).toBe('unknown');
  });

  it('returns unknown when neither bin nor versionCommand exist', () => {
    expect(probeCliVersion({ resolvedBin: '', versionCommand: undefined })).toBe('unknown');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
