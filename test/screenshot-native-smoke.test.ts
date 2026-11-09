import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import xtermHeadless from '@xterm/headless';

describe('compiled screenshot release smoke', () => {
  it('exercises the real screenshot renderer and always disposes the terminal', async () => {
    const disposeSpy = vi.spyOn(xtermHeadless.Terminal.prototype, 'dispose');
    try {
      const { runScreenshotSmoke } = await import('../src/cli/screenshot-smoke.js');
      const png = await runScreenshotSmoke();
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.toString('ascii', 12, 16)).toBe('IHDR');
      expect(png.readUInt32BE(16)).toBeGreaterThan(0);
      expect(png.readUInt32BE(20)).toBeGreaterThan(0);
      expect(png.length).toBeGreaterThan(100);
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      disposeSpy.mockRestore();
    }
  });

  it('runs from the scratch cwd with no external native override and validates the PNG file', () => {
    // 共享 smoke 只在编译后的单文件二进制上可执行，单测环境无法跑二进制，
    // 这里钉的是脚本里的调用形状本身（K4 机器可校验一致性）；宽高断言精确匹配
    // if 条件，避免被成功日志里的同名 readUInt32BE 调用保活。
    const smoke = readFileSync(resolve(import.meta.dirname, '../scripts/smoke-bun-binary.mjs'), 'utf8');
    expect(smoke).toContain("['__screenshot-smoke', screenshotPath]");
    expect(smoke).toMatch(/NAPI_RS_NATIVE_LIBRARY_PATH: ''/);
    expect(smoke).toMatch(/png\.toString\('ascii', 12, 16\) !== 'IHDR'/);
    expect(smoke).toMatch(/png\.readUInt32BE\(16\) === 0/);
    expect(smoke).toMatch(/png\.readUInt32BE\(20\) === 0/);
  });
});
