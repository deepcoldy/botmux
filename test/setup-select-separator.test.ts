/**
 * 选择器的分隔行（`SelectItem.separator`）：只展示、不可选中。
 *
 * TTY：interactiveSelect 在进程内驱动——把 stdin/stdout 撑成 TTY、桩掉 resume/pause/
 * setEncoding/setRawMode（不真去读终端），按键用 stdin 的 'data' 事件送进去，画面从
 * stdout.write 收集。非 TTY：pickChoice 的序号回退，答案来自假 readline。
 *
 * 除了分隔行自身的语义，两组「关系」用例钉住「分隔行只多出它自己那一行」：同一列表带分隔行
 * 与去掉分隔行，画面 / 输出去掉分隔行那一行后逐字节相同（序号、光标、提示都不受影响）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { interactiveSelect, matchesSelectItem, pickChoice, type SelectItem } from '../src/setup/interactive-select.js';
import { t } from '../src/i18n/index.js';

const SECTION = 'SECTION-X';
const ITEMS: SelectItem[] = [
  { label: 'alpha' },
  { label: 'bravo' },
  { label: 'charlie' },
  { label: SECTION, separator: true },
  { label: 'delta', hint: 'd' },
  { label: 'echo' },
];
const WITHOUT_SEPARATOR = ITEMS.filter(item => !item.separator);
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const ENTER = '\r';
const ESC = '\x1b';
const BACKSPACE = '\x7f';

const saved = {
  stdinTTY: process.stdin.isTTY,
  stdoutTTY: process.stdout.isTTY,
  setRawMode: (process.stdin as { setRawMode?: unknown }).setRawMode,
};

afterEach(() => {
  vi.restoreAllMocks();
  (process.stdin as { isTTY?: boolean }).isTTY = saved.stdinTTY;
  (process.stdout as { isTTY?: boolean }).isTTY = saved.stdoutTTY;
  (process.stdin as { setRawMode?: unknown }).setRawMode = saved.setRawMode;
});

/** stdout 上收到的全部字节。 */
function captureStdout(): () => string {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  return () => out;
}

/** 把进程撑成交互终端，但不让选择器真的去读 stdin。 */
function fakeTerminal(): () => string {
  (process.stdin as { isTTY?: boolean }).isTTY = true;
  (process.stdout as { isTTY?: boolean }).isTTY = true;
  (process.stdin as { setRawMode?: unknown }).setRawMode = () => process.stdin;
  vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
  vi.spyOn(process.stdin, 'pause').mockImplementation(() => process.stdin);
  vi.spyOn(process.stdin, 'setEncoding').mockImplementation(() => process.stdin);
  return captureStdout();
}

function press(...keys: string[]): void {
  for (const key of keys) process.stdin.emit('data', key);
}

/** 起一个 TTY 选择器，返回结果 promise 与「是否已结束」的探针。 */
function openSelector(items: ReadonlyArray<SelectItem>) {
  let settled = false;
  const result = interactiveSelect({ title: 'pick', items, footer: 'footer' }).then(value => {
    settled = true;
    return value;
  });
  return { result, settled: () => settled };
}

/** 每次重绘以「光标归位 + 清屏」开头；取最后一帧，去掉离开 alt-screen 的尾巴。 */
function lastFrame(output: string): string {
  const frames = output.split('\x1b[H\x1b[J');
  return frames[frames.length - 1].split('\x1b[?25h\x1b[?1049l')[0];
}

const withoutSectionLines = (text: string) => text.split('\n').filter(line => !line.includes(SECTION)).join('\n');

describe('交互终端：分隔行不可选', () => {
  it('↓ 越过分隔行落到下面的选项，返回它在原始 items 里的下标', async () => {
    fakeTerminal();
    const selector = openSelector(ITEMS);
    press(DOWN, DOWN, DOWN, ENTER);
    expect(await selector.result).toBe(4);
  });

  it('↑ 越过分隔行回到上面的选项', async () => {
    fakeTerminal();
    const selector = openSelector(ITEMS);
    press(DOWN, DOWN, DOWN, UP, ENTER);
    expect(await selector.result).toBe(2);
  });

  it('首尾环绕：第一项 ↑ 到最后一项，最后一项 ↓ 回第一项', async () => {
    fakeTerminal();
    const toLast = openSelector(ITEMS);
    press(UP, ENTER);
    expect(await toLast.result).toBe(5);

    const backToFirst = openSelector(ITEMS);
    press(UP, DOWN, ENTER);
    expect(await backToFirst.result).toBe(0);
  });

  it('列表以分隔行开头时初始光标落在第一个可选项上；环绕也跳过它', async () => {
    fakeTerminal();
    const items: SelectItem[] = [{ label: SECTION, separator: true }, { label: 'alpha' }, { label: 'bravo' }];
    const initial = openSelector(items);
    press(ENTER);
    expect(await initial.result).toBe(1);

    const wrapped = openSelector(items);
    press(DOWN, DOWN, ENTER);
    expect(await wrapped.result).toBe(1);
  });

  it('⏎ 选不中分隔行：只有分隔行的列表回车不结束，Esc 才以取消结束', async () => {
    fakeTerminal();
    const selector = openSelector([{ label: SECTION, separator: true }]);
    press(ENTER, DOWN, ENTER);
    await Promise.resolve();
    expect(selector.settled()).toBe(false);
    press(ESC);
    expect(await selector.result).toBeNull();
  });

  it('输入搜索词后分隔行不显示，结果仍是原始下标；清空搜索词后分隔行回来', async () => {
    const output = fakeTerminal();
    const selector = openSelector(ITEMS);
    press('ech');
    expect(withoutSectionLines(lastFrame(output()))).toBe(lastFrame(output()));
    // 搜索分隔行自己的标题也搜不到它（标题只出现在搜索框那一行）。
    press(BACKSPACE, BACKSPACE, BACKSPACE, ...SECTION);
    expect(lastFrame(output())).toContain(t('setup.select.no_matches'));
    press(ENTER);
    await Promise.resolve();
    expect(selector.settled()).toBe(false);
    press(...Array.from(SECTION, () => BACKSPACE));
    expect(lastFrame(output()).split('\n').filter(line => line.includes(SECTION))).toHaveLength(1);
    press('ech', ENTER);
    expect(await selector.result).toBe(5);
  });

  it('画面里分隔行只多出它自己那一行：去掉它后与不带分隔行的同一列表逐字节相同（初始帧与移动后）', async () => {
    for (const keys of [[], [DOWN, DOWN, DOWN], [UP]]) {
      const withSeparator = fakeTerminal();
      const a = openSelector(ITEMS);
      press(...keys);
      const framed = lastFrame(withSeparator());
      press(ESC);
      await a.result;
      vi.restoreAllMocks();

      const plain = fakeTerminal();
      const b = openSelector(WITHOUT_SEPARATOR);
      press(...keys);
      const expected = lastFrame(plain());
      press(ESC);
      await b.result;
      vi.restoreAllMocks();

      expect(framed).not.toBe(expected);
      expect(withoutSectionLines(framed)).toBe(expected);
    }
  });
});

/** 假 readline：按队列吐答案，记下每次提问。 */
function fakeRl(answers: string[]) {
  const questions: string[] = [];
  return {
    questions,
    rl: {
      question(query: string, callback: (answer: string) => void) {
        questions.push(query);
        callback(answers.shift() ?? '');
      },
    } as unknown as Parameters<typeof pickChoice>[0],
  };
}

const choosePrompt = (max: number, def?: number) =>
  t('setup.select.choose_prompt', { max, default: def === undefined ? '' : ` [${def}]` });

// vitest 的 stdin/stdout 不是 TTY，pickChoice 走序号回退。
describe('非交互终端：序号只数可选项', () => {
  it('分隔行打印成不带序号的一行，序号连续，回答映射回原始下标', async () => {
    const output = captureStdout();
    const { rl, questions } = fakeRl(['4']);

    expect(await pickChoice(rl, { title: 't', items: ITEMS })).toBe(4);

    const lines = output().split('\n');
    const section = lines.filter(line => line.includes(SECTION));
    expect(section).toHaveLength(1);
    expect(section[0]).not.toMatch(/\d+\)/);
    expect(lines.filter(line => /^\s+\d+\) /.test(line)).map(line => line.trim()))
      .toEqual(['1) alpha', '2) bravo', '3) charlie', '4) delta（d）', '5) echo']);
    expect(questions).toEqual([choosePrompt(5)]);
  });

  it('defaultIndex 落在分隔行上时顺延到下一个可选项（提示与留空返回值一致）', async () => {
    captureStdout();
    const { rl, questions } = fakeRl(['']);

    expect(await pickChoice(rl, { title: 't', items: ITEMS, defaultIndex: 3 })).toBe(4);
    expect(questions).toEqual([choosePrompt(5, 4)]);
  });

  it('超过可选项个数的序号无效，重问', async () => {
    const output = captureStdout();
    const { rl, questions } = fakeRl(['6', '5']);

    expect(await pickChoice(rl, { title: 't', items: ITEMS })).toBe(5);
    expect(questions).toHaveLength(2);
    expect(output()).toContain(t('setup.select.invalid_choice', { choice: '6' }));
  });

  it('输出里分隔行只多出它自己那一行：去掉它后与不带分隔行的同一列表逐字节相同', async () => {
    const answers = ['9', '2'];
    const withSeparator = captureStdout();
    const a = fakeRl([...answers]);
    const picked = await pickChoice(a.rl, { title: 't', items: ITEMS, defaultIndex: 1, footer: 'f' });
    const framed = withSeparator();
    vi.restoreAllMocks();

    const plain = captureStdout();
    const b = fakeRl([...answers]);
    const pickedPlain = await pickChoice(b.rl, { title: 't', items: WITHOUT_SEPARATOR, defaultIndex: 1, footer: 'f' });

    expect(ITEMS[picked!]).toBe(WITHOUT_SEPARATOR[pickedPlain!]);
    expect(a.questions).toEqual(b.questions);
    expect(framed).not.toBe(plain());
    expect(withoutSectionLines(framed)).toBe(plain());
  });
});

describe('matchesSelectItem 与分隔行', () => {
  it('分隔行只在没有搜索词时匹配', () => {
    const separator = { label: SECTION, separator: true };
    expect(matchesSelectItem(separator, '')).toBe(true);
    expect(matchesSelectItem(separator, '  ')).toBe(true);
    expect(matchesSelectItem(separator, 'SECTION')).toBe(false);
    expect(matchesSelectItem({ label: SECTION }, 'SECTION')).toBe(true);
  });
});
