import { describe, it, expect, vi, beforeEach } from 'vitest';

// getBot is the only runtime dependency of the predicate module; the command
// tables come from the leaf passthrough-commands module (not mocked — the whole
// point of these tests is that the REAL reserved tables gate the whitelist).
const mockGetBot = vi.fn();
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...a: any[]) => mockGetBot(...a),
}));

const { isCommandTriggerChat, matchCommandTrigger, reservedCommandKind, commandTriggerArgs, renderCommandTriggerPrompt } =
  await import('../src/services/command-trigger.js');
const { normalizeCommandTriggers, normalizeTriggerCommand, normalizeTriggerEntry, MAX_COMMAND_TRIGGER_PROMPT_BYTES } =
  await import('../src/services/command-trigger-normalize.js');
const { DAEMON_COMMANDS, PASSTHROUGH_COMMANDS } =
  await import('../src/core/passthrough-commands.js');

// 生产里 getBot() 返回的永远是 bot-registry 归一化过的配置，所以这里也走同一个
// normalize —— 既保证断言面与运行期一致，也顺带覆盖了字符串简写那条输入路径。
function botWith(commandTriggers: any) {
  return { config: { commandTriggers: commandTriggers ? normalizeCommandTriggers(commandTriggers) : undefined } };
}

beforeEach(() => {
  mockGetBot.mockReset();
});

describe('reserved command tables', () => {
  // 子集不变量（SESSIONLESS / EXISTING_SESSION_ONLY ⊂ DAEMON_COMMANDS）钉在
  // test/command-trigger-reserved-commands.test.ts —— 那条断言要 import
  // command-handler，会把整个 daemon 模块图拉进来；本文件把 bot-registry 整个
  // 替换成只有 getBot 的假模块，图里任何一处静态具名 import 在 bun 腿的 ESM
  // 链接期就会 SyntaxError（vitest 容忍、bun 不容忍）。故拆到无 mock 的文件里。

  it('classifies daemon / passthrough / force-topic / free commands', () => {
    expect(reservedCommandKind('/close')).toBe('daemon');
    expect(reservedCommandKind('/rename')).toBe('daemon');
    expect(reservedCommandKind('/clear')).toBe('passthrough');
    expect(reservedCommandKind('/t')).toBe('force-topic');
    expect(reservedCommandKind('/topic')).toBe('force-topic');
    expect(reservedCommandKind('/solve')).toBe(null);
  });

  it('honours the per-CLI passthrough set passed by the caller', () => {
    expect(reservedCommandKind('/goal')).toBe(null);
    expect(reservedCommandKind('/goal', new Set(['/goal']))).toBe('passthrough');
  });

  it('is case-insensitive', () => {
    expect(reservedCommandKind('/CLOSE')).toBe('daemon');
    expect(PASSTHROUGH_COMMANDS.has('/clear')).toBe(true);
  });
});

describe('normalizeTriggerCommand', () => {
  it('accepts bare slash words, lowercased', () => {
    expect(normalizeTriggerCommand(' /Solve ')).toBe('/solve');
    expect(normalizeTriggerCommand('/code-review')).toBe('/code-review');
    expect(normalizeTriggerCommand('/myplugin:review')).toBe('/myplugin:review');
  });

  it('rejects anything that is not a bare command token', () => {
    expect(normalizeTriggerCommand('solve')).toBeUndefined();
    expect(normalizeTriggerCommand('/solve <arg>')).toBeUndefined();
    expect(normalizeTriggerCommand('/solve bug')).toBeUndefined();
    expect(normalizeTriggerCommand('/')).toBeUndefined();
    expect(normalizeTriggerCommand('')).toBeUndefined();
    expect(normalizeTriggerCommand(42)).toBeUndefined();
  });
});

describe('normalizeCommandTriggers', () => {
  it('keeps a disabled config with commands as a draft', () => {
    expect(normalizeCommandTriggers({ enabled: false, commands: ['/solve'] }))
      .toEqual({ enabled: false, commands: [{ cmd: '/solve' }] });
  });

  it('drops a config with no usable command', () => {
    expect(normalizeCommandTriggers({ enabled: true, commands: [] })).toBeUndefined();
    expect(normalizeCommandTriggers({ enabled: true, commands: ['nope'] })).toBeUndefined();
    expect(normalizeCommandTriggers(null)).toBeUndefined();
  });

  it('dedupes commands and chat lists, drops empty scopes', () => {
    expect(normalizeCommandTriggers({
      enabled: true,
      commands: ['/solve', '/Solve', '/triage'],
      chats: ['oc_a', ' oc_a ', 'oc_b'],
      excludedChats: [],
    })).toEqual({ enabled: true, commands: [{ cmd: '/solve' }, { cmd: '/triage' }], chats: ['oc_a', 'oc_b'] });
  });
});

describe('isCommandTriggerChat', () => {
  it('treats an empty allow-list as every group', () => {
    expect(isCommandTriggerChat({}, 'oc_any')).toBe(true);
    expect(isCommandTriggerChat({ chats: [] }, 'oc_any')).toBe(true);
  });

  it('restricts to the allow-list when non-empty', () => {
    expect(isCommandTriggerChat({ chats: ['oc_a'] }, 'oc_a')).toBe(true);
    expect(isCommandTriggerChat({ chats: ['oc_a'] }, 'oc_b')).toBe(false);
  });

  it('lets the block-list win over the allow-list', () => {
    expect(isCommandTriggerChat({ chats: ['oc_a'], excludedChats: ['oc_a'] }, 'oc_a')).toBe(false);
    expect(isCommandTriggerChat({ excludedChats: ['oc_a'] }, 'oc_a')).toBe(false);
  });

  it('fails closed without a chat id', () => {
    expect(isCommandTriggerChat({}, undefined)).toBe(false);
  });
});

describe('matchCommandTrigger', () => {
  it('fires for a whitelisted command in an in-scope chat', () => {
    mockGetBot.mockReturnValue(botWith({ enabled: true, commands: ['/solve'] }));
    expect(matchCommandTrigger('app', 'oc_a', '/solve')).toBeDefined();
    expect(matchCommandTrigger('app', 'oc_a', '/SOLVE')).toBeDefined();
  });

  it('stays quiet for a command outside the whitelist', () => {
    mockGetBot.mockReturnValue(botWith({ enabled: true, commands: ['/solve'] }));
    expect(matchCommandTrigger('app', 'oc_a', '/deploy')).toBeUndefined();
  });

  it('stays quiet when disabled, unconfigured, or the bot is unknown', () => {
    mockGetBot.mockReturnValue(botWith({ enabled: false, commands: ['/solve'] }));
    expect(matchCommandTrigger('app', 'oc_a', '/solve')).toBeUndefined();
    mockGetBot.mockReturnValue(botWith(undefined));
    expect(matchCommandTrigger('app', 'oc_a', '/solve')).toBeUndefined();
    mockGetBot.mockImplementation(() => { throw new Error('unknown bot'); });
    expect(matchCommandTrigger('app', 'oc_a', '/solve')).toBeUndefined();
  });

  it('respects the chat scope', () => {
    mockGetBot.mockReturnValue(botWith({ enabled: true, commands: ['/solve'], chats: ['oc_a'] }));
    expect(matchCommandTrigger('app', 'oc_a', '/solve')).toBeDefined();
    expect(matchCommandTrigger('app', 'oc_b', '/solve')).toBeUndefined();
    mockGetBot.mockReturnValue(botWith({ enabled: true, commands: ['/solve'], excludedChats: ['oc_a'] }));
    expect(matchCommandTrigger('app', 'oc_a', '/solve')).toBeUndefined();
    expect(matchCommandTrigger('app', 'oc_b', '/solve')).toBeDefined();
  });

  // 危险命令必须 @：即使有人手改 bots.json 把它们塞进白名单也不生效。
  it('fails closed on reserved commands smuggled into the whitelist', () => {
    mockGetBot.mockReturnValue(botWith({
      enabled: true,
      commands: ['/close', '/clear', '/t', '/solve'],
    }));
    expect(matchCommandTrigger('app', 'oc_a', '/close')).toBeUndefined();
    expect(matchCommandTrigger('app', 'oc_a', '/clear')).toBeUndefined();
    expect(matchCommandTrigger('app', 'oc_a', '/t')).toBeUndefined();
    expect(matchCommandTrigger('app', 'oc_a', '/solve')).toBeDefined();
  });

  it('fails closed on a CLI-specific passthrough command', () => {
    mockGetBot.mockReturnValue(botWith({ enabled: true, commands: ['/goal'] }));
    expect(matchCommandTrigger('app', 'oc_a', '/goal')).toBeDefined();
    expect(matchCommandTrigger('app', 'oc_a', '/goal', new Set(['/goal']))).toBeUndefined();
  });

  it('needs a parsed command', () => {
    mockGetBot.mockReturnValue(botWith({ enabled: true, commands: ['/solve'] }));
    expect(matchCommandTrigger('app', 'oc_a', undefined)).toBeUndefined();
  });
});

describe('normalizeTriggerEntry — 命令 + 行为模板', () => {
  it('accepts the string shorthand and canonicalizes it to the object form', () => {
    expect(normalizeTriggerEntry('/Solve')).toEqual({ cmd: '/solve' });
  });

  it('keeps a prompt template', () => {
    expect(normalizeTriggerEntry({ cmd: '/solve', prompt: '  先复现再改：{args}  ' }))
      .toEqual({ cmd: '/solve', prompt: '先复现再改：{args}' });
  });

  it('drops a blank template rather than storing an empty string', () => {
    expect(normalizeTriggerEntry({ cmd: '/solve', prompt: '   ' })).toEqual({ cmd: '/solve' });
  });

  it('rejects an entry without a usable command', () => {
    expect(normalizeTriggerEntry({ prompt: 'x' })).toBeUndefined();
    expect(normalizeTriggerEntry({ cmd: 'solve' })).toBeUndefined();
  });

  it('truncates an oversized template instead of storing it whole', () => {
    const huge = 'x'.repeat(MAX_COMMAND_TRIGGER_PROMPT_BYTES + 100);
    const out = normalizeTriggerEntry({ cmd: '/solve', prompt: huge });
    expect(Buffer.byteLength(out!.prompt!, 'utf-8')).toBeLessThanOrEqual(MAX_COMMAND_TRIGGER_PROMPT_BYTES);
  });

  it('keeps the first definition when a command repeats', () => {
    expect(normalizeCommandTriggers({
      enabled: true,
      commands: [{ cmd: '/solve', prompt: 'first' }, { cmd: '/solve', prompt: 'second' }],
    })).toEqual({ enabled: true, commands: [{ cmd: '/solve', prompt: 'first' }] });
  });
});

describe('commandTriggerArgs', () => {
  it('strips the leading command word, keeping the rest verbatim', () => {
    expect(commandTriggerArgs('/solve 修一下登录超时')).toBe('修一下登录超时');
    expect(commandTriggerArgs('/Solve  多  空格')).toBe('多  空格');
    expect(commandTriggerArgs('/solve')).toBe('');
    expect(commandTriggerArgs('/solve\n第二行')).toBe('第二行');
  });
});

describe('renderCommandTriggerPrompt', () => {
  it('returns undefined without a template so the caller keeps the raw text', () => {
    expect(renderCommandTriggerPrompt({ cmd: '/solve', args: 'x' })).toBeUndefined();
  });

  it('substitutes every {args} occurrence', () => {
    expect(renderCommandTriggerPrompt({ cmd: '/solve', prompt: '先看 {args}，再修 {args}', args: '登录' }))
      .toBe('先看 登录，再修 登录');
  });

  // 用户敲进去的参数不能静默消失。
  it('appends the arguments when the template has no placeholder', () => {
    expect(renderCommandTriggerPrompt({ cmd: '/solve', prompt: '按规范排查', args: '登录超时' }))
      .toBe('按规范排查\n\n登录超时');
  });

  it('leaves a placeholder-less template alone when there are no arguments', () => {
    expect(renderCommandTriggerPrompt({ cmd: '/solve', prompt: '按规范排查', args: '' }))
      .toBe('按规范排查');
  });

  it('empties the placeholder when the command carried no arguments', () => {
    expect(renderCommandTriggerPrompt({ cmd: '/solve', prompt: '处理：{args}', args: '' }))
      .toBe('处理：');
  });
});

describe('matchCommandTrigger — 返回命中的条目', () => {
  it('hands back the configured template', () => {
    mockGetBot.mockReturnValue(botWith({
      enabled: true,
      commands: [{ cmd: '/solve', prompt: '先复现再改：{args}' }],
    }));
    expect(matchCommandTrigger('app', 'oc_a', '/solve'))
      .toEqual({ cmd: '/solve', prompt: '先复现再改：{args}' });
  });
});
