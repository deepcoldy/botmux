import { describe, expect, it } from 'vitest';
import {
  decodeQuickCommandsReply,
  decodeQuickCommandsReplySource,
  defaultQuickCommands,
  defaultQuickCommandsSource,
  formatQuickCommandsReply,
  normalizeQuickCommands,
  normalizeQuickCommandsSource,
  parseQuickCommandsMessage,
  quickCommandProfile,
  quickCommandProfileSource,
  quickCommandSequence,
  quickCommandSequenceSource,
  unsubmittedLineLength,
  unsubmittedLineLengthSource,
} from '../src/core/web-terminal-quick-commands.js';

const NONCE = '0123456789abcdef0123456789abcdef';
const cmd = (send: string) => ({ label: send, send, enter: true, hint: '' });

describe('快捷指令默认列表', () => {
  it('Claude Code 等 CLI 默认带上常用的 /rewind /compact /status /effort', () => {
    const sends = defaultQuickCommands(quickCommandProfile('claude-code')).map(cmd => cmd.send);
    expect(sends).toEqual(expect.arrayContaining(['/rewind', '/compact', '/status', '/effort']));
  });

  it('Codex 家族单独一套，不带它没有的命令', () => {
    expect(quickCommandProfile('codex')).toBe('codex');
    expect(quickCommandProfile('codex-app')).toBe('codex');
    // coco / traex 跑同一套 traecli/codex-rs TUI，命令面与 codex 一致。
    expect(quickCommandProfile('coco')).toBe('codex');
    expect(quickCommandProfile('traex')).toBe('codex');
    expect(quickCommandProfile('claude-code')).toBe('default');
    expect(quickCommandProfile(undefined)).toBe('default');
    const sends = defaultQuickCommands('codex').map(cmd => cmd.send);
    expect(sends).toContain('/status');
    expect(sends).not.toContain('/rewind');
  });

  it('默认列表本身就是合法列表，每次调用返回新数组', () => {
    for (const profile of ['default', 'codex'] as const) {
      const list = defaultQuickCommands(profile);
      expect(normalizeQuickCommands(list)).toEqual(list);
      expect(defaultQuickCommands(profile)).not.toBe(list);
    }
  });
});

describe('normalizeQuickCommands', () => {
  it('整体不是数组时返回 null，由调用方退回默认', () => {
    expect(normalizeQuickCommands(null)).toBeNull();
    expect(normalizeQuickCommands({ send: '/status' })).toBeNull();
    expect(normalizeQuickCommands('/status')).toBeNull();
  });

  it('空数组是合法结果：用户删光了就是空，不变回默认', () => {
    expect(normalizeQuickCommands([])).toEqual([]);
  });

  it('只丢不合法的那一条，其余规整后保留', () => {
    const result = normalizeQuickCommands([
      null,
      'oops',
      { send: '   ' },
      { send: 'x'.repeat(501) },
      { send: '/model ', label: '  ', hint: 42 },
      { send: '/effort ', label: '强度', enter: false, hint: '  选一个  ' },
    ]);
    expect(result).toEqual([
      { label: '/model', send: '/model ', enter: true, hint: '' },
      { label: '强度', send: '/effort ', enter: false, hint: '选一个' },
    ]);
  });

  it('名称、说明过长时截断，条数有上限', () => {
    const [one] = normalizeQuickCommands([{ send: '/x', label: 'L'.repeat(100), hint: 'H'.repeat(100) }])!;
    expect(one.label.length).toBeLessThan(100);
    expect(one.hint.length).toBeLessThan(100);

    const many = Array.from({ length: 100 }, (_, i) => ({ send: `/cmd${i}` }));
    const kept = normalizeQuickCommands(many)!;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(100);
    expect(kept[0].send).toBe('/cmd0');
  });

  it('开头堆满垃圾的超长数组不会被一直扫下去', () => {
    const junk: unknown[] = Array.from({ length: 100_000 }, () => null);
    junk.push({ send: '/status' });
    expect(normalizeQuickCommands(junk)).toEqual([]);
  });
});

describe('quickCommandSequence', () => {
  it('普通文本原样发送', () => {
    expect(quickCommandSequence('/compact')).toBe('/compact');
    expect(quickCommandSequence('echo a > b')).toBe('echo a > b');
  });

  it('把按键记法换成终端字节，不区分大小写', () => {
    expect(quickCommandSequence('<Esc><esc>')).toBe('\x1b\x1b');
    expect(quickCommandSequence('y<Enter>')).toBe('y\r');
    expect(quickCommandSequence('<Tab><S-Tab>')).toBe('\t\x1b[Z');
    expect(quickCommandSequence('<Up><Down><Left><Right>')).toBe('\x1b[A\x1b[B\x1b[D\x1b[C');
    expect(quickCommandSequence('<C-c><c-D>')).toBe('\x03\x04');
    expect(quickCommandSequence('<BS><Space>')).toBe('\x7f ');
  });

  it('认不出的尖括号原样保留，且不会吞掉后面的记法', () => {
    expect(quickCommandSequence('a <b> c')).toBe('a <b> c');
    expect(quickCommandSequence('<a <Esc>')).toBe('<a \x1b');
    expect(quickCommandSequence('1 < 2')).toBe('1 < 2');
    expect(quickCommandSequence('<lt>Esc>')).toBe('<Esc>');
  });
});

describe('parseQuickCommandsMessage', () => {
  const frame = (rec: Record<string, unknown>) => JSON.stringify({ type: 'quick_commands', ...rec });

  it('解析读取请求', () => {
    expect(parseQuickCommandsMessage(frame({ op: 'get', nonce: NONCE }))).toEqual({ op: 'get', nonce: NONCE });
  });

  it('解析保存请求，新列表和改之前看到的列表都规整过', () => {
    const raw = frame({ op: 'save', nonce: NONCE, base: [{ send: '/a' }], commands: [{ send: '/status' }, { send: '' }] });
    expect(parseQuickCommandsMessage(raw)).toEqual({ op: 'save', nonce: NONCE, base: [cmd('/a')], commands: [cmd('/status')] });
  });

  it('base 为 null 表示改之前用的是默认列表，reset 表示恢复默认', () => {
    expect(parseQuickCommandsMessage(frame({ op: 'save', nonce: NONCE, base: null, reset: true }))).toEqual({
      op: 'save', nonce: NONCE, base: null, commands: null,
    });
    expect(parseQuickCommandsMessage(frame({ op: 'save', nonce: NONCE, base: null, commands: [] }))).toEqual({
      op: 'save', nonce: NONCE, base: null, commands: [],
    });
  });

  it('没有合法随机数、说不清改之前看到什么的请求一律忽略', () => {
    for (const nonce of [undefined, '', 'abc', NONCE.toUpperCase(), NONCE + '0', 42]) {
      expect(parseQuickCommandsMessage(frame({ op: 'get', nonce }))).toBeNull();
    }
    expect(parseQuickCommandsMessage(frame({ op: 'save', nonce: NONCE, commands: [{ send: '/x' }] }))).toBeNull();
    expect(parseQuickCommandsMessage(frame({ op: 'save', nonce: NONCE, base: 'x', commands: [{ send: '/x' }] }))).toBeNull();
    expect(parseQuickCommandsMessage(frame({ op: 'save', nonce: NONCE, base: null, commands: 'nope' }))).toBeNull();
  });

  it('同一条连接上的其它帧、形状不对或过大的帧一律忽略', () => {
    expect(parseQuickCommandsMessage(JSON.stringify({ type: 'input', data: 'quick_commands' }))).toBeNull();
    expect(parseQuickCommandsMessage(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }))).toBeNull();
    expect(parseQuickCommandsMessage(JSON.stringify({ type: 'input', data: '"quick_commands"' }))).toBeNull();
    expect(parseQuickCommandsMessage('{"type":"quick_commands"')).toBeNull();
    expect(parseQuickCommandsMessage(Buffer.from(frame({ op: 'get', nonce: NONCE })))).toBeNull();
    const huge = frame({ op: 'save', nonce: NONCE, base: null, commands: [{ send: '/x' }], pad: 'x'.repeat(600_000) });
    expect(parseQuickCommandsMessage(huge)).toBeNull();
  });
});

describe('应答帧', () => {
  it('编码后能原样解回来', () => {
    const list = defaultQuickCommands('default');
    const frame = formatQuickCommandsReply(NONCE, 'ok', list);
    expect(frame.startsWith('\x1b]1989;quick_commands;')).toBe(true);
    expect(decodeQuickCommandsReply(frame, NONCE)).toEqual({ status: 'ok', commands: list });
    expect(decodeQuickCommandsReply(formatQuickCommandsReply(NONCE, 'conflict', null), NONCE)).toEqual({ status: 'conflict', commands: null });
    expect(decodeQuickCommandsReply(formatQuickCommandsReply(NONCE, 'error', []), NONCE)).toEqual({ status: 'error', commands: [] });
  });

  it('发送内容里有 BEL、ESC 时帧也不会提前结束', () => {
    const list = [{ label: 'x', send: '\x07\x1b]0;t\x07', enter: true, hint: '' }];
    const frame = formatQuickCommandsReply(NONCE, 'ok', list);
    expect(frame.indexOf('\x07')).toBe(frame.length - 1);
    expect(decodeQuickCommandsReply(frame, NONCE)?.commands).toEqual(list);
  });

  it('随机数不对、不是整帧、状态不认识的一律不认', () => {
    const frame = formatQuickCommandsReply(NONCE, 'ok', []);
    expect(decodeQuickCommandsReply(frame, 'f'.repeat(32))).toBeNull();
    expect(decodeQuickCommandsReply(frame, '')).toBeNull();
    expect(decodeQuickCommandsReply(frame, undefined)).toBeNull();
    expect(decodeQuickCommandsReply('x' + frame, NONCE)).toBeNull();
    expect(decodeQuickCommandsReply(frame + 'tail', NONCE)).toBeNull();
    expect(decodeQuickCommandsReply(frame.slice(0, -1), NONCE)).toBeNull();
    expect(decodeQuickCommandsReply(frame.replace(';ok;', ';done;'), NONCE)).toBeNull();
    expect(decodeQuickCommandsReply(frame.replace(';ok;[]', ';ok;[oops'), NONCE)).toBeNull();
    expect(decodeQuickCommandsReply(new Uint8Array(4), NONCE)).toBeNull();
  });
});

describe('unsubmittedLineLength', () => {
  it('打字累加，回车、换行、Ctrl-C、Ctrl-U 清零', () => {
    expect(unsubmittedLineLength(0, 'hello')).toBe(5);
    expect(unsubmittedLineLength(5, '\r')).toBe(0);
    expect(unsubmittedLineLength(0, 'ab\rcd')).toBe(2);
    for (const clear of ['\n', '\x03', '\x15']) expect(unsubmittedLineLength(3, clear)).toBe(0);
  });

  it('退格减一，不会减到负数', () => {
    expect(unsubmittedLineLength(3, '\b')).toBe(2);
    expect(unsubmittedLineLength(2, '\x7f\x7f\x7f')).toBe(0);
    expect(unsubmittedLineLength(0, '\x7fa')).toBe(1);
  });

  it('方向键、鼠标上报、焦点事件等转义序列不计', () => {
    expect(unsubmittedLineLength(4, '\x1b[D\x1b[C')).toBe(4);
    expect(unsubmittedLineLength(0, '\x1bOC')).toBe(0);
    expect(unsubmittedLineLength(0, '\x1b[<0;10;5M\x1b[<0;10;5m')).toBe(0);
    expect(unsubmittedLineLength(0, '\x1b[I')).toBe(0);
    expect(unsubmittedLineLength(2, '\x1b')).toBe(2);
  });

  it('终端自动发回的 OSC/DCS 应答整段不计，不管以 BEL 还是 ST 结尾', () => {
    // tmux 接入时查询前景、背景色，终端的回答。
    expect(unsubmittedLineLength(0, '\x1b]11;rgb:1a1a/1b1b/2626\x1b\\')).toBe(0);
    expect(unsubmittedLineLength(0, '\x1b]10;rgb:a9a9/b1b1/d6d6\x07')).toBe(0);
    // DECRQSS 和 XTVERSION 的回答是 DCS。
    expect(unsubmittedLineLength(0, '\x1bP1$r0m\x1b\\')).toBe(0);
    expect(unsubmittedLineLength(3, '\x1bP>|xterm.js(5.5.0)\x1b\\')).toBe(3);
    // 8 位的 C1 形式。
    expect(unsubmittedLineLength(0, '\x9d11;rgb:0/0/0\x9c')).toBe(0);
    // 应答前后的字照常计。
    expect(unsubmittedLineLength(0, 'ab\x1b]11;rgb:0/0/0\x07cd')).toBe(4);
    expect(unsubmittedLineLength(0, '\x1b]11;rgb:0/0/0\x1b\\cd')).toBe(2);
  });

  it('↑/↓ 翻历史后当作输入行可能有字，回车后又清零', () => {
    expect(unsubmittedLineLength(0, '\x1b[A')).toBeGreaterThan(0);
    expect(unsubmittedLineLength(0, '\x1bOB')).toBeGreaterThan(0);
    expect(unsubmittedLineLength(5, '\x1b[A')).toBe(5);
    expect(unsubmittedLineLength(0, '\x1b[A\r')).toBe(0);
  });

  it('实时输入的改写序列按净变化计', () => {
    // helo → hello：左移一格插入 l，再右移回去。
    expect(unsubmittedLineLength(4, '\x1b[Dl\x1b[C')).toBe(5);
    // hello → he：退格三次。
    expect(unsubmittedLineLength(5, '\x7f\x7f\x7f')).toBe(2);
  });

  it('括号粘贴里的换行不算提交', () => {
    expect(unsubmittedLineLength(0, '\x1b[200~a\nb\x1b[201~')).toBe(3);
    expect(unsubmittedLineLength(0, '\x1b[200~x\x1b[201~\r')).toBe(0);
  });

  it('中文按字计；非字符串输入和负数起点都不出错', () => {
    expect(unsubmittedLineLength(0, '你好')).toBe(2);
    expect(unsubmittedLineLength(3, undefined)).toBe(3);
    expect(unsubmittedLineLength(-1, '')).toBe(0);
  });
});

describe('嵌进终端页的源码', () => {
  it('每个函数自给自足，重建后行为一致', () => {
    const sources = [
      quickCommandProfileSource,
      defaultQuickCommandsSource,
      normalizeQuickCommandsSource,
      quickCommandSequenceSource,
      decodeQuickCommandsReplySource,
      unsubmittedLineLengthSource,
    ];
    for (const source of sources) {
      expect(source).not.toContain('`');
      expect(source).not.toContain('${');
    }
    // eslint-disable-next-line no-new-func
    const rebuild = <T>(source: string): T => new Function(`return (${source})`)() as T;
    const profile = rebuild<typeof quickCommandProfile>(quickCommandProfileSource);
    const defaults = rebuild<typeof defaultQuickCommands>(defaultQuickCommandsSource);
    const normalize = rebuild<typeof normalizeQuickCommands>(normalizeQuickCommandsSource);
    const sequence = rebuild<typeof quickCommandSequence>(quickCommandSequenceSource);
    expect(profile('codex-app')).toBe(quickCommandProfile('codex-app'));
    expect(defaults('default')).toEqual(defaultQuickCommands('default'));
    const input = [{ send: '/effort ', enter: false }, { send: '' }, 7];
    expect(normalize(input)).toEqual(normalizeQuickCommands(input));
    expect(sequence('<a <Esc>x<C-c>')).toBe(quickCommandSequence('<a <Esc>x<C-c>'));
    const decode = rebuild<typeof decodeQuickCommandsReply>(decodeQuickCommandsReplySource);
    const frame = formatQuickCommandsReply(NONCE, 'conflict', [cmd('/x')]);
    expect(decode(frame, NONCE)).toEqual(decodeQuickCommandsReply(frame, NONCE));
    expect(decode(frame, 'f'.repeat(32))).toBeNull();
    const lineLength = rebuild<typeof unsubmittedLineLength>(unsubmittedLineLengthSource);
    const typed = 'ab\x1b[D\x7fc\x1b[200~d\ne\x1b[201~';
    expect(lineLength(1, typed)).toBe(unsubmittedLineLength(1, typed));
  });
});
