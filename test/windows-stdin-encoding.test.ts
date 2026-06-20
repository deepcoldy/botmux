import { describe, expect, it } from 'vitest';
import { looksLikeWindowsStdinMojibake } from '../src/cli/stdin-encoding.js';

describe('looksLikeWindowsStdinMojibake', () => {
  it('detects question-mark replacement on Windows stdin', () => {
    expect(looksLikeWindowsStdinMojibake('????????? Wan-Animate', 'win32')).toBe(true);
    expect(looksLikeWindowsStdinMojibake('??????\n??/?', 'win32')).toBe(true);
  });

  it('does not flag valid Unicode content', () => {
    expect(looksLikeWindowsStdinMojibake('调研结论：中文正常 Wan-Animate', 'win32')).toBe(false);
  });

  it('does not flag non-Windows platforms', () => {
    expect(looksLikeWindowsStdinMojibake('????????? Wan-Animate', 'linux')).toBe(false);
  });

  it('does not flag ordinary short or low-density question marks', () => {
    expect(looksLikeWindowsStdinMojibake('OK?', 'win32')).toBe(false);
    expect(looksLikeWindowsStdinMojibake('Did this work? Yes, it did.', 'win32')).toBe(false);
  });
});
