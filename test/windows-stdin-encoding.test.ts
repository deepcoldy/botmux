import { describe, expect, it } from 'vitest';
import { looksLikeWindowsStdinMojibake, decodeStdinBytes } from '../src/cli/stdin-encoding.js';

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

describe('decodeStdinBytes', () => {
  it('preserves valid UTF-8 Chinese on Windows', () => {
    const raw = Buffer.from('测试\n第一项 配置机器人', 'utf-8');
    expect(decodeStdinBytes(raw, 'win32')).toBe('测试\n第一项 配置机器人');
  });

  it('preserves valid UTF-8 emoji and non-Chinese content on Windows', () => {
    expect(decodeStdinBytes(Buffer.from('hello 😀 done', 'utf-8'), 'win32')).toBe('hello 😀 done');
    expect(decodeStdinBytes(Buffer.from('完成 ✅ 第二项', 'utf-8'), 'win32')).toBe('完成 ✅ 第二项');
  });

  it('decodes GBK (CP936) bytes from PowerShell 5.1 on Windows', () => {
    // "测试" encoded as GBK/CP936 is 0xB2 0xE2 0xCA 0xD4 -- not valid UTF-8,
    // so strict UTF-8 throws and we fall back to GBK.
    expect(decodeStdinBytes(Buffer.from([0xb2, 0xe2, 0xca, 0xd4]), 'win32')).toBe('测试');
  });

  it('passes bytes through as UTF-8 on non-Windows platforms', () => {
    const raw = Buffer.from('测试 😀', 'utf-8');
    expect(decodeStdinBytes(raw, 'linux')).toBe('测试 😀');
  });

  it('preserves ASCII on every platform', () => {
    expect(decodeStdinBytes(Buffer.from('hello world', 'utf-8'), 'win32')).toBe('hello world');
    expect(decodeStdinBytes(Buffer.from('hello world', 'utf-8'), 'linux')).toBe('hello world');
  });
});
