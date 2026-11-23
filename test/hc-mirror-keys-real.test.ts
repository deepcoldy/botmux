import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeTmuxKeys } from '../src/adapters/backend/hc/keys.js';
import { ScreenMirror } from '../src/adapters/backend/hc/screen-mirror.js';

const hcBin = process.env.BOTMUX_HC_BIN ?? 'hc';

function hc(args: string[], timeout = 30_000): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(hcBin, args, { encoding: 'utf8', timeout, env: process.env });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The fence shim exits 127 when no real binary is configured. */
const hcAvailable = process.platform === 'linux' && !!process.env.BOTMUX_HC_TEST_BIN && hc(['--version'], 10_000).status === 0;

async function waitFor(check: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** tmux key name, and the name hc's `keys` command takes for the same key. */
const KEY_PAIRS: Array<[string, string]> = [
  ['Up', 'up'], ['Down', 'down'], ['Left', 'left'], ['Right', 'right'], ['Home', 'home'], ['End', 'end'],
  ['PPage', 'pageup'], ['NPage', 'pagedown'], ['IC', 'insert'], ['DC', 'delete'],
  ['F1', 'f1'], ['F4', 'f4'], ['F5', 'f5'], ['F12', 'f12'], ['BTab', 'shift+tab'],
  ['Enter', 'enter'], ['Tab', 'tab'], ['Escape', 'esc'], ['BSpace', 'backspace'], ['Space', 'space'],
  ['M-Enter', 'alt+enter'], ['C-c', 'ctrl+c'], ['C-j', 'ctrl+j'], ['C-a', 'ctrl+a'], ['C-z', 'ctrl+z'],
  ['C-Up', 'ctrl+up'], ['S-Up', 'shift+up'], ['M-Up', 'alt+up'], ['C-S-Up', 'ctrl+shift+up'], ['C-M-Up', 'ctrl+alt+up'],
  ['C-Home', 'ctrl+home'], ['S-End', 'shift+end'], ['C-PPage', 'ctrl+pageup'], ['S-F1', 'shift+f1'], ['S-F5', 'shift+f5'],
  ['M-F5', 'alt+f5'], ['C-F1', 'ctrl+f1'], ['M-Home', 'alt+home'], ['S-DC', 'shift+delete'], ['C-M-DC', 'ctrl+alt+delete'],
  ['C-BSpace', 'ctrl+backspace'], ['M-BSpace', 'alt+backspace'], ['C-M-BSpace', 'ctrl+alt+backspace'],
  ['C-Space', 'ctrl+space'], ['M-Space', 'alt+space'], ['C-M-Space', 'ctrl+alt+space'],
  ['M-x', 'alt+x'], ['M-7', 'alt+7'], ['C-M-a', 'ctrl+alt+a'], ['S-a', 'shift+a'],
  ['C-Enter', 'ctrl+enter'], ['S-Enter', 'shift+enter'], ['C-M-Enter', 'ctrl+alt+enter'], ['M-S-Enter', 'alt+shift+enter'],
  ['M-Tab', 'alt+tab'], ['C-Tab', 'ctrl+tab'], ['C-S-Tab', 'ctrl+shift+tab'], ['M-BTab', 'alt+shift+tab'],
  ['M-Escape', 'alt+esc'], ['C-Escape', 'ctrl+esc'], ['S-Escape', 'shift+esc'],
  ['C-2', 'ctrl+2'], ['C-1', 'ctrl+1'], ['C-]', 'ctrl+]'], ['C-/', 'ctrl+/'], ['C-\\', 'ctrl+backslash'],
  ['a', 'a'], ['7', '7'],
];

const SCREEN_FIXTURE = [
  '\x1b[1;31mbold red\x1b[0m plain \x1b[38;5;208m256\x1b[0m \x1b[38;2;1;2;3;48;2;200;200;0mrgb\x1b[0m',
  '中文 漢字 가 Ａ 😀 ✅ ⭐ 🇨🇳 é ± ──',
  'tab\tstop\tend',
  'overwrite me\rOVER',
  'erase this\x1b[6D\x1b[K',
  'abcdef\x1b[3D\x1b[2@XY\x1b[1P',
  '\x1b[5;20Hplaced 宽字',
  '\x1b[7;1Hinsert line below\x1b[8;1H\x1b[Lshifted',
  '\x1b[10;1H\x1b[2;3H\x1b[1Jcleared-above',
  '\x1b[12;1HEND-OF-FIXTURE',
].join('\r\n');

describe.skipIf(!hcAvailable)('screen mirror and key encoder against the real hc', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'bm-hc-mk-'));
  });

  afterAll(() => {
    hc(['server', 'stop']);
    rmSync(root, { recursive: true, force: true });
  });

  it.each([false, true])('hc keys deliver what encodeTmuxKeys produces (DECCKM %s)', async (appCursor) => {
    const name = appCursor ? 'keys-app' : 'keys-normal';
    const out = join(root, `${name}.out`);
    const ready = join(root, `${name}.ready`);
    const script = `${appCursor ? "printf '\\033[?1h'; " : ''}stty raw -echo && : > ${shellQuote(ready)} && exec cat > ${shellQuote(out)}`;
    const run = hc(['run', '--bg', '--name', name, '--', 'sh', '-c', script]);
    expect(run.status, run.stderr).toBe(0);
    await waitFor(() => existsSync(ready), 'the key recorder');

    const sent = hc(['keys', name, ...KEY_PAIRS.map(([, hcName]) => hcName)], 60_000);
    expect(sent.status, sent.stderr).toBe(0);
    const expected = Buffer.from(encodeTmuxKeys(KEY_PAIRS.map(([tmuxName]) => tmuxName), { applicationCursorKeys: appCursor }));
    await waitFor(() => existsSync(out) && statSync(out).size >= expected.length, 'the recorded keys');
    expect(readFileSync(out).toString('latin1')).toBe(expected.toString('latin1'));
  }, 90_000);

  it('a mirror fed the program output shows the same screen text as hc', async () => {
    const fixture = join(root, 'screen.bin');
    writeFileSync(fixture, SCREEN_FIXTURE);
    const run = hc(['run', '--bg', '--name', 'screen', '--', 'sh', '-c', `stty -onlcr; cat ${shellQuote(fixture)}; exec sleep 600`]);
    expect(run.status, run.stderr).toBe(0);
    let text = '';
    await waitFor(() => {
      const r = hc(['read', '--json', 'screen']);
      text = r.status === 0 ? (JSON.parse(r.stdout) as { text: string }).text : '';
      return text.includes('END-OF-FIXTURE');
    }, 'the fixture on screen');
    const info = JSON.parse(hc(['get', '--json', 'screen']).stdout) as { cols: number; rows: number };

    const mirror = new ScreenMirror({ cols: info.cols, rows: info.rows });
    mirror.write(readFileSync(fixture));
    const normalise = (s: string): string => s.split('\n').map(row => row.replace(/ +$/, '')).join('\n').replace(/\n+$/, '');
    expect(normalise(mirror.viewportText())).toBe(normalise(text));
    mirror.dispose();
  }, 60_000);
});
