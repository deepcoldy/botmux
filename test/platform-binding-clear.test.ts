// test/platform-binding-clear.test.ts
// 解绑：clearPlatformBinding 删本地绑定文件 ~/.botmux/platform.json，存在才删、不存在 no-op、删失败不抛。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const existsSync = vi.fn();
const rmSync = vi.fn();
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  existsSync: (...a: unknown[]) => existsSync(...a),
  rmSync: (...a: unknown[]) => rmSync(...a),
}));
// binding.ts 顶层 import 了它（仅 writePlatformBinding 用到），给个空实现避免真实写盘。
vi.mock('../src/utils/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }));

import { clearPlatformBinding, PLATFORM_BINDING_PATH } from '../src/platform/binding.js';

describe('clearPlatformBinding', () => {
  beforeEach(() => {
    existsSync.mockReset();
    rmSync.mockReset();
  });

  it('文件存在时删除 platform.json', () => {
    existsSync.mockReturnValue(true);
    clearPlatformBinding();
    expect(rmSync).toHaveBeenCalledWith(PLATFORM_BINDING_PATH);
  });

  it('文件不存在时不调用 rmSync', () => {
    existsSync.mockReturnValue(false);
    clearPlatformBinding();
    expect(rmSync).not.toHaveBeenCalled();
  });

  it('删除报错被吞掉，绝不抛出', () => {
    existsSync.mockReturnValue(true);
    rmSync.mockImplementation(() => {
      throw new Error('EPERM');
    });
    expect(() => clearPlatformBinding()).not.toThrow();
  });
});
