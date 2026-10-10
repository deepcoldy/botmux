import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatMobileInputModeOsc,
  getWebTerminalInputMode,
  MOBILE_INPUT_MODE_OSC_REGEX,
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

  it('选项解析器清晰无歧义：字符串恒为 sessionId，对象形式支持自定义 dataDir', () => {
    expect(resolveSettingsOptions('session-123')).toEqual({ sessionId: 'session-123' });
    expect(resolveSettingsOptions({ dataDir: tempDir })).toEqual({ dataDir: tempDir });
    expect(resolveSettingsOptions({ sessionId: 'sess-a', dataDir: tempDir })).toEqual({ sessionId: 'sess-a', dataDir: tempDir });
    expect(resolveSettingsOptions()).toEqual({});
  });

  it('默认为 buffer 模式（上屏）', () => {
    expect(getWebTerminalInputMode({ dataDir: tempDir })).toBe('buffer');
    expect(getWebTerminalInputMode({ sessionId: 'session-1', dataDir: tempDir })).toBe('buffer');
  });

  it('设置 live 模式后读取为 live', () => {
    setWebTerminalInputMode('live', { dataDir: tempDir });
    expect(getWebTerminalInputMode({ dataDir: tempDir })).toBe('live');
  });

  it('切换回 buffer 模式后读取为 buffer', () => {
    setWebTerminalInputMode('live', { dataDir: tempDir });
    expect(getWebTerminalInputMode({ dataDir: tempDir })).toBe('live');
    setWebTerminalInputMode('buffer', { dataDir: tempDir });
    expect(getWebTerminalInputMode({ dataDir: tempDir })).toBe('buffer');
  });

  it('会话级隔离：不同会话独立保存状态，互不串味', () => {
    // 会话 A 设置为 live
    setWebTerminalInputMode('live', { sessionId: 'session-A', dataDir: tempDir });
    expect(getWebTerminalInputMode({ sessionId: 'session-A', dataDir: tempDir })).toBe('live');

    // 会话 B 设置为 buffer
    setWebTerminalInputMode('buffer', { sessionId: 'session-B', dataDir: tempDir });
    expect(getWebTerminalInputMode({ sessionId: 'session-B', dataDir: tempDir })).toBe('buffer');

    // 再次确认会话 A 依然保持 live，未被会话 B 串改
    expect(getWebTerminalInputMode({ sessionId: 'session-A', dataDir: tempDir })).toBe('live');
  });

  it('记住沿用上一次设置：新会话默认沿用最近一次的选择', () => {
    // 用户在 session-A 切换到了 live
    setWebTerminalInputMode('live', { sessionId: 'session-A', dataDir: tempDir });

    // 用户新开了一个未曾设置过的 session-C，自动继承上一次的选择 live
    expect(getWebTerminalInputMode({ sessionId: 'session-C', dataDir: tempDir })).toBe('live');

    // 用户在 session-C 切换回 buffer
    setWebTerminalInputMode('buffer', { sessionId: 'session-C', dataDir: tempDir });

    // 新开的 session-D 继承最新的 buffer
    expect(getWebTerminalInputMode({ sessionId: 'session-D', dataDir: tempDir })).toBe('buffer');
    // 但 session-A 仍然保持自己的 live
    expect(getWebTerminalInputMode({ sessionId: 'session-A', dataDir: tempDir })).toBe('live');
  });

  it('遇到损坏或异常 JSON 文件安全回退到 buffer 模式', () => {
    const filePath = join(tempDir, 'web-terminal-settings.json');
    writeFileSync(filePath, '{ corrupt json');
    expect(getWebTerminalInputMode({ dataDir: tempDir })).toBe('buffer');
    expect(getWebTerminalInputMode({ sessionId: 'session-X', dataDir: tempDir })).toBe('buffer');
  });

  it('跨读取实例保持多设备一致（从文件系统持久化中读取）', () => {
    setWebTerminalInputMode('live', { sessionId: 'session-multi-device', dataDir: tempDir });
    // 模拟另一台设备/另一个进程读取该目录
    const deviceBReading = getWebTerminalInputMode({ sessionId: 'session-multi-device', dataDir: tempDir });
    expect(deviceBReading).toBe('live');
  });

  it('LRU 淘汰顺序：超出 500 个会话时淘汰最久未访问的会话，活跃会话得到保留', () => {
    // 写入 500 个初始会话：sess-0 到 sess-499
    for (let i = 0; i < 500; i++) {
      setWebTerminalInputMode('live', { sessionId: `sess-${i}`, dataDir: tempDir });
    }
    // 重新活跃 sess-0（置为 buffer）
    setWebTerminalInputMode('buffer', { sessionId: 'sess-0', dataDir: tempDir });

    // 再插入一个新会话 sess-500，此时总数达到 501，触发淘汰 1 个
    setWebTerminalInputMode('live', { sessionId: 'sess-500', dataDir: tempDir });

    const filePath = join(tempDir, 'web-terminal-settings.json');
    const content = JSON.parse(readFileSync(filePath, 'utf-8')) as WebTerminalSettings;
    const sessionKeys = Object.keys(content.sessions ?? {});
    expect(sessionKeys.length).toBe(500);

    // sess-0 最近被更新过，未被淘汰
    expect(content.sessions?.['sess-0']).toBe('buffer');
    // sess-500 最新插入，未被淘汰
    expect(content.sessions?.['sess-500']).toBe('live');
    // 最久未活跃的 sess-1 被淘汰
    expect(content.sessions?.['sess-1']).toBeUndefined();
  });

  it('共享正则与线协议：MOBILE_INPUT_MODE_OSC_REGEX 是单一权威匹配源', () => {
    const liveOsc = formatMobileInputModeOsc('live');
    expect(liveOsc).toBe('\x1b]1989;mobile_input_mode;live\x07');

    const bufferOsc = formatMobileInputModeOsc('buffer');
    expect(bufferOsc).toBe('\x1b]1989;mobile_input_mode;buffer\x07');

    // 验证正则实例匹配
    expect(MOBILE_INPUT_MODE_OSC_REGEX.test(liveOsc)).toBe(true);
    expect(MOBILE_INPUT_MODE_OSC_REGEX.test(bufferOsc)).toBe(true);
    expect(MOBILE_INPUT_MODE_OSC_REGEX.test('invalid')).toBe(false);

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
