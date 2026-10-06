import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatMobileInputModeOsc,
  getWebTerminalInputMode,
  parseMobileInputModeOsc,
  resolveSettingsOptions,
  setWebTerminalInputMode,
  type WebTerminalSettings,
} from '../src/services/web-terminal-settings-store.js';

describe('web-terminal-settings-store', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wt-settings-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('选项解析器兼容路径字符串、会话 ID 和对象形式', () => {
    expect(resolveSettingsOptions(tempDir)).toEqual({ dataDir: tempDir });
    expect(resolveSettingsOptions('session-123')).toEqual({ sessionId: 'session-123' });
    expect(resolveSettingsOptions('session-123', tempDir)).toEqual({ sessionId: 'session-123', dataDir: tempDir });
    expect(resolveSettingsOptions({ sessionId: 'sess-a', dataDir: tempDir })).toEqual({ sessionId: 'sess-a', dataDir: tempDir });
    expect(resolveSettingsOptions()).toEqual({});
  });

  it('默认为 buffer 模式（上屏）', () => {
    expect(getWebTerminalInputMode(tempDir)).toBe('buffer');
    expect(getWebTerminalInputMode('session-1', tempDir)).toBe('buffer');
  });

  it('设置 live 模式后读取为 live', () => {
    setWebTerminalInputMode('live', tempDir);
    expect(getWebTerminalInputMode(tempDir)).toBe('live');
  });

  it('切换回 buffer 模式后读取为 buffer', () => {
    setWebTerminalInputMode('live', tempDir);
    expect(getWebTerminalInputMode(tempDir)).toBe('live');
    setWebTerminalInputMode('buffer', tempDir);
    expect(getWebTerminalInputMode(tempDir)).toBe('buffer');
  });

  it('会话级隔离：不同会话独立保存状态，互不串味', () => {
    // 会话 A 设置为 live
    setWebTerminalInputMode('live', 'session-A', tempDir);
    expect(getWebTerminalInputMode('session-A', tempDir)).toBe('live');

    // 会话 B 设置为 buffer
    setWebTerminalInputMode('buffer', 'session-B', tempDir);
    expect(getWebTerminalInputMode('session-B', tempDir)).toBe('buffer');

    // 再次确认会话 A 依然保持 live，未被会话 B 串改
    expect(getWebTerminalInputMode('session-A', tempDir)).toBe('live');
  });

  it('记住沿用上一次设置：新会话默认沿用最近一次的选择', () => {
    // 用户在 session-A 切换到了 live
    setWebTerminalInputMode('live', 'session-A', tempDir);

    // 用户新开了一个未曾设置过的 session-C，自动继承上一次的选择 live
    expect(getWebTerminalInputMode('session-C', tempDir)).toBe('live');

    // 用户在 session-C 切换回 buffer
    setWebTerminalInputMode('buffer', 'session-C', tempDir);

    // 新开的 session-D 继承最新的 buffer
    expect(getWebTerminalInputMode('session-D', tempDir)).toBe('buffer');
    // 但 session-A 仍然保持自己的 live
    expect(getWebTerminalInputMode('session-A', tempDir)).toBe('live');
  });

  it('遇到损坏或异常 JSON 文件安全回退到 buffer 模式', () => {
    const filePath = join(tempDir, 'web-terminal-settings.json');
    writeFileSync(filePath, '{ corrupt json');
    expect(getWebTerminalInputMode(tempDir)).toBe('buffer');
    expect(getWebTerminalInputMode('session-X', tempDir)).toBe('buffer');
  });

  it('跨读取实例保持多设备一致（从文件系统持久化中读取）', () => {
    setWebTerminalInputMode('live', 'session-multi-device', tempDir);
    // 模拟另一台设备/另一个进程读取该目录
    const deviceBReading = getWebTerminalInputMode('session-multi-device', tempDir);
    expect(deviceBReading).toBe('live');
  });

  it('会话记录数超上限时自动截断老记录，防止文件无限膨胀', () => {
    for (let i = 0; i < 505; i++) {
      setWebTerminalInputMode('live', `sess-${i}`, tempDir);
    }
    const filePath = join(tempDir, 'web-terminal-settings.json');
    const content = JSON.parse(readFileSync(filePath, 'utf-8')) as WebTerminalSettings;
    expect(Object.keys(content.sessions ?? {}).length).toBeLessThanOrEqual(500);
    // 最新的记录保留
    expect(content.sessions?.['sess-504']).toBe('live');
  });

  it('线协议辅助函数：正确格式化与解析 OSC 1989 控制帧', () => {
    const liveOsc = formatMobileInputModeOsc('live');
    expect(liveOsc).toBe('\x1b]1989;mobile_input_mode;live\x07');

    const bufferOsc = formatMobileInputModeOsc('buffer');
    expect(bufferOsc).toBe('\x1b]1989;mobile_input_mode;buffer\x07');

    const parsedLive = parseMobileInputModeOsc(`prefix${liveOsc}suffix`);
    expect(parsedLive).not.toBeNull();
    expect(parsedLive?.mode).toBe('live');
    expect(parsedLive?.cleaned).toBe('prefixsuffix');

    const parsedBuffer = parseMobileInputModeOsc(bufferOsc);
    expect(parsedBuffer?.mode).toBe('buffer');
    expect(parsedBuffer?.cleaned).toBe('');

    expect(parseMobileInputModeOsc('normal terminal output')).toBeNull();
  });
});
