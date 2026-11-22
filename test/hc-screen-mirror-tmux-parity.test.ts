import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeTmuxKeys } from '../src/adapters/backend/hc/keys.js';
import { ScreenMirror } from '../src/adapters/backend/hc/screen-mirror.js';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { makeTerminal, visibleState, writeAll } from './helpers/xterm-cells.js';

const tmuxAvailable = process.platform === 'linux' && spawnSync('tmux', ['-V'], { timeout: 3000 }).status === 0;

const COLS = 40;
const ROWS = 10;

const numbered = (from: number, to: number, fmt: (i: number) => string): string =>
  Array.from({ length: to - from + 1 }, (_, i) => fmt(from + i)).join('\r\n');

const FIXTURES: Array<[string, string]> = [
  ['colours and attributes', [
    '\x1b[31mred\x1b[0m \x1b[92mbright\x1b[0m \x1b[38;5;208m256\x1b[0m \x1b[38;2;1;2;3mrgb\x1b[0m',
    '\x1b[44mbg\x1b[0m \x1b[103mbright bg\x1b[0m \x1b[48;5;22m256 bg\x1b[0m \x1b[48;2;9;8;7mrgb bg\x1b[0m',
    '\x1b[1mbold\x1b[0m \x1b[2mdim\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munder\x1b[0m \x1b[5mblink\x1b[0m',
    '\x1b[7minverse\x1b[0m \x1b[8mhidden\x1b[0m \x1b[9mstrike\x1b[0m \x1b[1;4;31;43mall\x1b[22mless\x1b[0m',
    '   leading spaces and trailing ones   ',
  ].join('\r\n')],
  ['wide characters', [
    '中文字符测试 mixed 漢字 가나다 ＡＢ',
    `${'x'.repeat(COLS - 1)}中文 wraps at the margin`,
    '\x1b[32m绿色\x1b[0m中\x1b[45m紫\x1b[0m end',
  ].join('\r\n')],
  ['soft-wrapped lines', `${'abcdefghij'.repeat(9)}\r\nshort\r\n\x1b[36m${'0123456789'.repeat(5)}\x1b[0m`],
  ['history', numbered(0, 299, i => `\x1b[3${i % 8}mline ${i}\x1b[0m ${'#'.repeat(i % 23)}`)],
  ['a clear pushing the screen into history', `${numbered(0, 14, i => `before ${i}`)}\x1b[H\x1b[2Jafter 1\r\nafter 2`],
  ['the alternate screen', `${numbered(0, 24, i => `main ${i}`)}\r\n\x1b[?1049h\x1b[H\x1b[1;35malt top\x1b[0m\x1b[5;10H中文 alt\x1b[3;4H`],
  ['input modes', 'modes on\x1b[?1h\x1b=\x1b[?1002h\x1b[?1006h\x1b[?25l'],
  ['all mouse and a hidden cursor', 'x\x1b[?1003h\x1b[?25l'],
  ['a cursor waiting to wrap', `${numbered(0, 3, i => `row ${i}`)}\x1b[${ROWS};1H${'w'.repeat(COLS)}`],
  ['erased rows with a background', `top\r\n\x1b[44m\x1b[2K\x1b[0m\r\nmid\r\n\x1b[41m\x1b[K\x1b[0mtext after\r\nend`],
];

const stripSgr = (s: string): string => s.replace(/\x1b\[[0-9;:]*m/g, '');

async function replayed(cols: number, rows: number, data: string): Promise<ReturnType<typeof visibleState>> {
  const term = makeTerminal(cols, rows);
  await writeAll(term, data);
  return visibleState(term);
}

async function waitFor(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

describe.skipIf(!tmuxAvailable)('ScreenMirror against TmuxPipeBackend on a private tmux', () => {
  const socket = `bmx-hcmirror-${process.pid}`;
  let root: string;
  let env: NodeJS.ProcessEnv;
  let savedTmpdir: string | undefined;
  let sessions = 0;
  const tmux = (...args: string[]): string => execFileSync('tmux', ['-L', socket, ...args], { env, encoding: 'utf8', timeout: 10_000 });

  /** A detached pane of the given size running `script`, with tmux's history limit set as botmux sets it. */
  function newPane(script: string, cols = COLS, rows = ROWS): string {
    const name = `mx${++sessions}`;
    tmux('-f', join(root, 'tmux.conf'), 'new-session', '-d', '-s', name, '-x', String(cols), '-y', String(rows), 'sh', '-c', script);
    return name;
  }

  beforeAll(() => {
    // Unix socket paths are capped at 107 bytes; keep tmux's out of a long TMPDIR.
    root = mkdtempSync('/tmp/bmhcmx-');
    savedTmpdir = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = root;
    env = privateTmuxEnv(root, { LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' });
    writeFileSync(join(root, 'tmux.conf'), 'set -g history-limit 50000\nset -g status off\n');
  });

  afterAll(() => {
    spawnSync('tmux', ['-L', socket, 'kill-server'], { env, stdio: 'ignore', timeout: 5000 });
    if (savedTmpdir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = savedTmpdir;
    rmSync(root, { recursive: true, force: true });
  });

  it.each(FIXTURES)('every capture matches tmux for %s', async (_name, fixture) => {
    const file = join(root, `fixture-${sessions + 1}.bin`);
    writeFileSync(file, fixture);
    const pane = newPane(`stty -onlcr; cat ${shellQuote(file)}; printf '\\033]2;fixture-done\\033\\\\'; exec sleep 600`);
    await waitFor(() => tmux('display-message', '-p', '-t', pane, '#{pane_title}').trim() === 'fixture-done', 'the fixture');

    const backend = new TmuxPipeBackend(pane, { socketName: socket });
    const mirror = new ScreenMirror({ cols: COLS, rows: ROWS });
    mirror.write(readFileSync(file));

    expect(mirror.size()).toEqual(backend.getPaneSize());
    expect(mirror.captureInputState()).toEqual(backend.captureInputState());
    expect(mirror.viewportText()).toBe(await backend.captureViewportAsync());
    expect(mirror.capturePaneInputModes()).toBe(backend.capturePaneInputModes());

    const tmuxScreen = backend.captureCurrentScreen();
    const tmuxViewport = backend.captureViewport();
    expect(stripSgr(mirror.captureCurrentScreen())).toBe(stripSgr(tmuxScreen));
    expect(stripSgr(mirror.captureViewport())).toBe(stripSgr(tmuxViewport));
    expect(await replayed(COLS, ROWS, mirror.captureCurrentScreen())).toEqual(await replayed(COLS, ROWS, tmuxScreen));
    expect(await replayed(COLS, ROWS, mirror.captureViewport())).toEqual(await replayed(COLS, ROWS, tmuxViewport));
    mirror.dispose();
  });

  /** Every key name botmux hands to sendSpecialKeys, plus the editing keys tmux and hc encode alike. */
  const SHARED_KEYS = [
    'Enter', 'M-Enter', 'C-c', 'C-j', 'Escape', 'Tab', 'Space', 'Up', 'Down', 'Left', 'Right', 'PPage', 'NPage',
    't', 's', '1', 'IC', 'DC', 'F1', 'F4', 'F5', 'F12', 'BTab', 'BSpace', 'C-Up', 'S-Up', 'M-Up', 'C-Space', 'M-x', 'C-a',
  ];

  it.each([false, true])('send-keys delivers what encodeTmuxKeys produces (DECCKM %s)', async (appCursor) => {
    const out = join(root, `keys-${appCursor}.out`);
    const ready = join(root, `keys-${appCursor}.ready`);
    const pane = newPane(`${appCursor ? "printf '\\033[?1h'; " : ''}stty raw -echo && : > ${shellQuote(ready)} && exec cat > ${shellQuote(out)}`, 80, 24);
    await waitFor(() => existsSync(ready), 'the key recorder');
    tmux('send-keys', '-t', pane, ...SHARED_KEYS);
    const expected = Buffer.from(encodeTmuxKeys(SHARED_KEYS, { applicationCursorKeys: appCursor }));
    await waitFor(() => existsSync(out) && statSync(out).size >= expected.length, 'the recorded keys');
    expect(readFileSync(out).toString('latin1')).toBe(expected.toString('latin1'));
  });
});
