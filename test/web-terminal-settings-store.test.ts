import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatMobileInputModeOsc,
  getWebTerminalInputMode,
  getWebTerminalQuickCommands,
  MOBILE_INPUT_MODE_OSC_REGEX,
  parseMobileInputModeOsc,
  resolveSettingsOptions,
  saveWebTerminalQuickCommands,
  setWebTerminalInputMode,
  setWebTerminalQuickCommands,
  type WebTerminalSettings,
} from '../src/services/web-terminal-settings-store.js';
import { spawnTsScript } from './helpers/ts-runner.js';

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

  describe('快捷指令', () => {
    const status = { label: '状态', send: '/status', enter: true, hint: '' };
    const effort = { label: '/effort', send: '/effort ', enter: false, hint: '补一个级别' };
    const botA = { botId: 'cli_bot_a', profile: 'default' } as const;
    const botACodex = { botId: 'cli_bot_a', profile: 'codex' } as const;
    const botB = { botId: 'cli_bot_b', profile: 'default' } as const;
    const opts = () => ({ dataDir: tempDir });

    it('没存过时返回 null，由页面用内置默认', () => {
      expect(getWebTerminalQuickCommands(botA, opts())).toBeNull();
    });

    it('同一个 Bot 按 CLI 家族分开保存，互不覆盖', () => {
      setWebTerminalQuickCommands(botA, [status, effort], opts());
      setWebTerminalQuickCommands(botACodex, [status], opts());
      expect(getWebTerminalQuickCommands(botA, opts())).toEqual([status, effort]);
      expect(getWebTerminalQuickCommands(botACodex, opts())).toEqual([status]);
    });

    it('不同 Bot 互不可见：一个 Bot 保存、删光或恢复默认都不动另一个', () => {
      setWebTerminalQuickCommands(botB, [effort], opts());
      setWebTerminalQuickCommands(botA, [status], opts());
      expect(getWebTerminalQuickCommands(botB, opts())).toEqual([effort]);
      setWebTerminalQuickCommands(botA, [], opts());
      expect(getWebTerminalQuickCommands(botB, opts())).toEqual([effort]);
      setWebTerminalQuickCommands(botA, null, opts());
      expect(getWebTerminalQuickCommands(botA, opts())).toBeNull();
      expect(getWebTerminalQuickCommands(botB, opts())).toEqual([effort]);
    });

    it('没有 Bot 标识时不读也不写', () => {
      expect(setWebTerminalQuickCommands(botA, [status], opts())).toBe(true);
      expect(setWebTerminalQuickCommands({ botId: '', profile: 'default' }, [effort], opts())).toBe(false);
      expect(getWebTerminalQuickCommands({ botId: '', profile: 'default' }, opts())).toBeNull();
      expect(getWebTerminalQuickCommands(botA, opts())).toEqual([status]);
      const saved = JSON.parse(readFileSync(join(tempDir, 'web-terminal-settings.json'), 'utf-8')) as {
        quickCommands?: Record<string, unknown>;
      };
      expect(Object.keys(saved.quickCommands ?? {})).toEqual(['cli_bot_a']);
    });

    it('空列表原样保存；传 null 删掉这一套、回到默认', () => {
      setWebTerminalQuickCommands(botA, [], opts());
      expect(getWebTerminalQuickCommands(botA, opts())).toEqual([]);
      setWebTerminalQuickCommands(botA, null, opts());
      expect(getWebTerminalQuickCommands(botA, opts())).toBeNull();
      const saved = JSON.parse(readFileSync(join(tempDir, 'web-terminal-settings.json'), 'utf-8')) as Record<string, unknown>;
      expect(saved.quickCommands).toBeUndefined();
    });

    it('和输入模式共用一个文件，写一边不冲掉另一边', () => {
      setWebTerminalInputMode('live', { sessionId: 'sess-q', dataDir: tempDir });
      setWebTerminalQuickCommands(botA, [status], opts());
      setWebTerminalInputMode('buffer', { sessionId: 'sess-r', dataDir: tempDir });
      expect(getWebTerminalInputMode({ sessionId: 'sess-q', dataDir: tempDir })).toBe('live');
      expect(getWebTerminalQuickCommands(botA, opts())).toEqual([status]);
    });

    it('保存时比对改之前看到的列表：一致才写，不一致回冲突和当前列表、不动文件', () => {
      expect(saveWebTerminalQuickCommands(botA, null, [status], opts())).toEqual({ status: 'ok', commands: [status] });
      // 另一个页面还以为是默认列表。
      expect(saveWebTerminalQuickCommands(botA, null, [effort], opts())).toEqual({ status: 'conflict', commands: [status] });
      expect(getWebTerminalQuickCommands(botA, opts())).toEqual([status]);
      // 拿最新列表重做就能存上。
      expect(saveWebTerminalQuickCommands(botA, [status], [status, effort], opts())).toEqual({ status: 'ok', commands: [status, effort] });
      // 删光（空列表）和默认列表不是一回事。
      expect(saveWebTerminalQuickCommands(botA, [], null, opts()).status).toBe('conflict');
      expect(saveWebTerminalQuickCommands(botA, [status, effort], null, opts())).toEqual({ status: 'ok', commands: null });
      expect(saveWebTerminalQuickCommands(botA, [status, effort], [], opts()).status).toBe('conflict');
      expect(getWebTerminalQuickCommands(botA, opts())).toBeNull();
      // 别的 Bot 的列表不参与比对。
      setWebTerminalQuickCommands(botB, [effort], opts());
      expect(saveWebTerminalQuickCommands(botA, null, [], opts())).toEqual({ status: 'ok', commands: [] });
    });

    it('比对按规整后的内容，不受字段顺序和省略的默认字段影响', () => {
      setWebTerminalQuickCommands(botA, [{ label: '/compact', send: '/compact', enter: true, hint: '' }], opts());
      const base = [{ send: '/compact' }] as unknown as Parameters<typeof saveWebTerminalQuickCommands>[1];
      expect(saveWebTerminalQuickCommands(botA, base, [status], opts()).status).toBe('ok');
    });

    it('写不进去时回 error 和原来的列表，不假装成功', () => {
      expect(saveWebTerminalQuickCommands({ botId: '', profile: 'default' }, null, [status], opts())).toEqual({ status: 'error', commands: null });
      // 设置文件的位置被一个目录占了：读当作没存过，写会失败。
      mkdirSync(join(tempDir, 'web-terminal-settings.json'));
      expect(setWebTerminalQuickCommands(botA, [status], opts())).toBe(false);
      expect(saveWebTerminalQuickCommands(botA, null, [status], opts())).toEqual({ status: 'error', commands: null });
    });

    it('文件被手工改坏时不抛错：整体形状不对当作没存过，单条不合法只丢那一条', () => {
      const filePath = join(tempDir, 'web-terminal-settings.json');
      writeFileSync(filePath, '{ corrupt json');
      expect(getWebTerminalQuickCommands(botA, opts())).toBeNull();
      writeFileSync(filePath, JSON.stringify({ quickCommands: { cli_bot_a: 'nope' } }));
      expect(getWebTerminalQuickCommands(botA, opts())).toBeNull();
      writeFileSync(filePath, JSON.stringify({ quickCommands: { cli_bot_a: { default: 'nope' } } }));
      expect(getWebTerminalQuickCommands(botA, opts())).toBeNull();
      writeFileSync(filePath, JSON.stringify({ quickCommands: { cli_bot_a: { default: [{ send: '' }, status] } } }));
      expect(getWebTerminalQuickCommands(botA, opts())).toEqual([status]);
      // 损坏的文件上也能重新写入。
      writeFileSync(filePath, '[1,2,3]');
      setWebTerminalQuickCommands(botA, [effort], opts());
      expect(getWebTerminalQuickCommands(botA, opts())).toEqual([effort]);
      writeFileSync(filePath, JSON.stringify({ quickCommands: { cli_bot_a: [1], cli_bot_b: { default: [status] } } }));
      setWebTerminalQuickCommands(botA, [effort], opts());
      expect(getWebTerminalQuickCommands(botA, opts())).toEqual([effort]);
      expect(getWebTerminalQuickCommands(botB, opts())).toEqual([status]);
    });

    it('文件读不出来时先留一份原文件副本再覆盖；只是冲突、没写盘时不留也不动', () => {
      const filePath = join(tempDir, 'web-terminal-settings.json');
      const backups = () => readdirSync(tempDir).filter(name => name.startsWith('web-terminal-settings.json.corrupt-')).sort();
      writeFileSync(filePath, '{ corrupt json');
      expect(saveWebTerminalQuickCommands(botA, [status], [effort], opts())).toEqual({ status: 'conflict', commands: null });
      expect(backups()).toEqual([]);
      expect(readFileSync(filePath, 'utf8')).toBe('{ corrupt json');

      expect(saveWebTerminalQuickCommands(botA, null, [effort], opts()).status).toBe('ok');
      expect(backups()).toHaveLength(1);
      expect(readFileSync(join(tempDir, backups()[0]), 'utf8')).toBe('{ corrupt json');
      expect(getWebTerminalQuickCommands(botA, opts())).toEqual([effort]);

      writeFileSync(filePath, '[1,2,3]');
      setWebTerminalInputMode('live', { sessionId: 'sess-1', dataDir: tempDir });
      expect(backups()).toHaveLength(2);
      expect(backups().map(name => readFileSync(join(tempDir, name), 'utf8'))).toContain('[1,2,3]');
      expect(getWebTerminalInputMode({ sessionId: 'sess-1', dataDir: tempDir })).toBe('live');
    });

    it('几个进程同时保存时互不覆盖：每次确认成功的修改都留在文件里', async () => {
      // 每个子进程把列表里的计数加一并报告成功了几次；丢了哪次写入，最后的计数就对不上。
      const script = join(tempDir, 'save-race.mts');
      const storeUrl = pathToFileURL(resolve('src/services/web-terminal-settings-store.ts')).href;
      writeFileSync(script, [
        "import { readdirSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        `import { getWebTerminalQuickCommands, saveWebTerminalQuickCommands } from ${JSON.stringify(storeUrl)};`,
        "const [dataDir, total] = process.argv.slice(2);",
        "const scope = { botId: 'cli_bot_a', profile: 'default' as const };",
        "writeFileSync(join(dataDir, 'ready-' + process.pid), '');",
        "while (readdirSync(dataDir).filter(name => name.startsWith('ready-')).length < Number(total)) await new Promise(r => setTimeout(r, 5));",
        "let ok = 0;",
        "for (let i = 0; i < 200; i++) {",
        "  const current = getWebTerminalQuickCommands(scope, { dataDir });",
        "  const next = [{ label: 'count', send: String(current ? Number(current[0].send) + 1 : 1) }];",
        "  if (saveWebTerminalQuickCommands(scope, current, next, { dataDir }).status === 'ok') ok++;",
        "}",
        "process.stdout.write(String(ok));",
      ].join('\n'));
      const run = () => new Promise<number>((done, fail) => {
        const child = spawnTsScript(script, [tempDir, '2'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout!.on('data', chunk => { out += chunk; });
        child.stderr!.on('data', chunk => { err += chunk; });
        child.on('error', fail);
        child.on('exit', code => (code === 0 ? done(Number(out)) : fail(new Error(`child exited ${code}: ${err}`))));
      });
      const counts = await Promise.all([run(), run()]);
      expect(counts.every(count => count > 0)).toBe(true);
      expect(getWebTerminalQuickCommands(botA, opts())?.[0].send).toBe(String(counts[0] + counts[1]));
    }, 60_000);
  });
});
