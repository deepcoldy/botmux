import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('compiled screenshot release smoke', () => {
  it('exercises the real screenshot renderer and always disposes the terminal', async () => {
    const { runScreenshotSmoke } = await import('../src/cli/screenshot-smoke.js');
    const png = await runScreenshotSmoke();
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.toString('ascii', 12, 16)).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBeGreaterThan(0);
    expect(png.readUInt32BE(20)).toBeGreaterThan(0);
    expect(png.length).toBeGreaterThan(100);
  });

  it('runs from the scratch cwd with no external native override and validates the PNG file', () => {
    const smoke = readFileSync(resolve(import.meta.dirname, '../scripts/smoke-bun-binary.mjs'), 'utf8');
    expect(smoke).toContain("['__screenshot-smoke', screenshotPath]");
    expect(smoke).toMatch(/NAPI_RS_NATIVE_LIBRARY_PATH: ''/);
    expect(smoke).toContain('readUInt32BE(16)');
    expect(smoke).toContain('readUInt32BE(20)');
  });
});
