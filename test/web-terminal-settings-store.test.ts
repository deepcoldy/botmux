import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getWebTerminalInputMode,
  setWebTerminalInputMode,
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

  it('默认为 buffer 模式（上屏）', () => {
    expect(getWebTerminalInputMode(tempDir)).toBe('buffer');
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

  it('遇到损坏或异常 JSON 文件安全回退到 buffer 模式', () => {
    const filePath = join(tempDir, 'web-terminal-settings.json');
    writeFileSync(filePath, '{ corrupt json');
    expect(getWebTerminalInputMode(tempDir)).toBe('buffer');
  });

  it('跨读取实例保持多设备一致（从文件系统持久化中读取）', () => {
    setWebTerminalInputMode('live', tempDir);
    // 模拟另一台设备/另一个进程读取该目录
    const deviceBReading = getWebTerminalInputMode(tempDir);
    expect(deviceBReading).toBe('live');
  });
});
