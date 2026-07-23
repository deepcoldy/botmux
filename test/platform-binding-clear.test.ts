// test/platform-binding-clear.test.ts
// 解绑：clearPlatformBinding 删本地绑定文件 ~/.botmux/platform.json，存在才删、不存在 no-op、删失败不抛。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const unlinkSecureHostFileSync = vi.fn();
vi.mock('../src/platform/secure-host-file.js', () => ({
  readSecureHostFileSync: vi.fn(),
  writeSecureHostFileSync: vi.fn(),
  unlinkSecureHostFileSync: (...a: unknown[]) => unlinkSecureHostFileSync(...a),
}));

import { clearPlatformBinding, PLATFORM_BINDING_PATH } from '../src/platform/binding.js';

describe('clearPlatformBinding', () => {
  beforeEach(() => {
    unlinkSecureHostFileSync.mockReset();
  });

  it('文件存在时删除 platform.json', () => {
    unlinkSecureHostFileSync.mockReturnValue(true);
    clearPlatformBinding();
    expect(unlinkSecureHostFileSync).toHaveBeenCalledWith(PLATFORM_BINDING_PATH);
  });

  it('文件不存在时不调用 rmSync', () => {
    unlinkSecureHostFileSync.mockReturnValue(false);
    clearPlatformBinding();
    expect(unlinkSecureHostFileSync).toHaveBeenCalledWith(PLATFORM_BINDING_PATH);
  });

  it('删除报错被吞掉，绝不抛出', () => {
    unlinkSecureHostFileSync.mockImplementation(() => {
      throw new Error('EPERM');
    });
    expect(() => clearPlatformBinding()).not.toThrow();
  });
});
