import { describe, expect, it } from 'vitest';
import { assertPngIcon } from '../src/setup/open-platform-automation.js';

describe('custom app icon', () => {
  it('accepts a PNG and rejects other files before uploading', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expect(assertPngIcon(png, 'a.png')).toBe(png);
    expect(() => assertPngIcon(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'a.jpg')).toThrow(/PNG/);
    expect(() => assertPngIcon(Buffer.alloc(0), 'empty.png')).toThrow(/PNG/);
  });
});
