import * as pty from 'node-pty';
import xtermHeadless from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { createServer } from 'node:http';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { tsRunnerPrefix } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const { Terminal } = xtermHeadless;
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(TEST_DIR, '..', 'src', 'cli.ts');
const tempDirs: string[] = [];
const children: pty.IPty[] = [];

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch { /* already exited */ }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Build the xterm buffer the same way the project's own web terminal does
// (src/worker.ts loads Unicode11Addon + activeVersion='11'). A bare xterm scores
// emoji as one cell and would NOT reproduce emoji wrapping — this addon makes the
// headless terminal count 🤖/🎉/你 as two cells, exactly as a real terminal paints.
//
// `modern: true` also registers a provider that widens Emoji_Presentation code
// points to two cells, modelling a current local/SSH terminal where 🫠/🩷/🛘 render
// two wide — code points xterm-11 still scores as one. The predicate unions the
// runtime \p{Emoji_Presentation} with an explicit Unicode-17 set, so the modelled
// terminal is "newer" even than the test-runner's Node (Node 22 only knows Unicode
// 16 and would otherwise not treat the U17 code points as emoji at all). The parser
// lays cells out from charProperties' width BITS (not wcwidth), so we patch those
// directly: `(raw & ~6) | 4` forces width 2 so such emoji genuinely occupy two
// buffer cells and the PTY test can observe wrapping if the picker under-counts them.
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
// Code points a modern terminal paints two wide but that Node 22's bundled Unicode 16
// (and xterm-11) do not: Unicode 17 Emoji_Presentation additions, plus the trigram
// block U+2630..U+2637 (East_Asian_Width=Wide since Unicode 16, non-emoji).
const U17_EMOJI = new Set([0x1F6D8, 0x1FA8A, 0x1FA8E, 0x1FAC8, 0x1FACD, 0x1FAEA, 0x1FAEF]);
const rendersTwoWide = (cp: number): boolean =>
  U17_EMOJI.has(cp)
  || (cp >= 0x2630 && cp <= 0x2637)
  || EMOJI_PRESENTATION.test(String.fromCodePoint(cp));
function makeTerminal(cols: number, modern = false): InstanceType<typeof Terminal> {
  const terminal = new Terminal({ cols, rows: 24, allowProposedApi: true });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  if (modern) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc: any = (terminal as any)._core?._inputHandler?._unicodeService
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ?? (terminal as any)._core?.unicodeService;
    const base = svc._providers['11'];
    terminal.unicode.register({
      version: 'modern-test',
      wcwidth(cp: number): number {
        if (cp === 0xfe0f) return 2; // VS16: emoji-presentation selector, painted wide
        const w = base.wcwidth(cp);
        return w === 1 && rendersTwoWide(cp) ? 2 : w;
      },
      charProperties(cp: number, preceding: number): number {
        const raw = base.charProperties(cp, preceding);
        // Force the width bits to 2 (clear with ~6, set 2 with |4) so the parser
        // lays these two cells wide. VS16 is included: it promotes the preceding
        // glyph to emoji presentation, and forcing its width to 2 makes the joined
        // grapheme (e.g. ❤+VS16 = ❤️) occupy two buffer cells, as a grapheme-aware
        // terminal renders it.
        return rendersTwoWide(cp) || cp === 0xfe0f ? (raw & ~6) | 4 : raw;
      },
    });
    terminal.unicode.activeVersion = 'modern-test';
  }
  return terminal;
}

function makeFixture(
  multiBot: boolean,
  titleFor?: (index: number) => string,
  adoptTmuxTarget?: string,
  dormantTmux = false,
  wakeDaemonPort?: number,
): { root: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'botmux-picker-responsive-'));
  tempDirs.push(root);
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });

  if (multiBot) {
    const configDir = join(root, '.botmux');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'bots.json'), JSON.stringify([
      { larkAppId: 'cli_test_a', cliId: 'codex' },
      { larkAppId: 'cli_test_b', cliId: 'claude-code' },
    ]));
  }

  const sessions: Record<string, object> = {};
  for (let i = 0; i < 48; i++) {
    const n = String(i + 1).padStart(2, '0');
    const sessionId = `${n}000000-1111-2222-3333-444444444444`;
    sessions[sessionId] = {
      sessionId,
      chatId: 'oc_picker_test',
      rootMessageId: `om_${n}`,
      title: titleFor ? titleFor(i) : `session-${n}`,
      workingDir: '/workspace/botmux',
      status: 'active',
      createdAt: new Date(Date.UTC(2026, 7, 6, 0, 0, i)).toISOString(),
      cliId: 'codex',
      backendType: 'pty',
      pid: process.pid,
    };
  }
  if (adoptTmuxTarget !== undefined) {
    // The picker sorts newest-first, so the last-created session (index 47,
    // id 48000000) is the one selected at cursor 0. Make IT the adopted tmux
    // session whose attacker-controlled target string lands in the footer hint.
    const selectedId = `48000000-1111-2222-3333-444444444444`;
    (sessions[selectedId] as Record<string, unknown>).adoptedFrom = {
      source: 'tmux',
      tmuxTarget: adoptTmuxTarget,
      originalCliPid: process.pid,
    };
  }
  if (dormantTmux) {
    const selectedId = `48000000-1111-2222-3333-444444444444`;
    const selected = sessions[selectedId] as Record<string, unknown>;
    selected.backendType = 'tmux';
    delete selected.pid;
    selected.lastCliInput = 'resume this conversation';
    if (wakeDaemonPort !== undefined) {
      selected.larkAppId = 'cli_test_wake';
      const daemonDir = join(dataDir, 'dashboard-daemons');
      mkdirSync(daemonDir, { recursive: true });
      writeFileSync(join(daemonDir, 'cli_test_wake.json'), JSON.stringify({
        larkAppId: 'cli_test_wake',
        ipcPort: wakeDaemonPort,
        lastHeartbeat: Date.now(),
      }));
      const configDir = join(root, '.botmux');
      mkdirSync(configDir, { recursive: true });
      const secretPath = join(configDir, '.dashboard-secret');
      writeFileSync(secretPath, 'picker-wake-test-secret');
      // The host credential loader (secure-host-file) fail-closes unless the
      // secret is EXACTLY 0600; writeFileSync's mode is umask-masked, so set it
      // explicitly or fetchDaemonIpc can't sign and the wake never leaves the CLI.
      chmodSync(secretPath, 0o600);
    }
  }
  // The picker (`botmux list`) reads the SQLite session store; these rows carry
  // no larkAppId, so they belong in the flat legacy store `<dataDir>/sessions.db`.
  seedPersistedSessionRows(dataDir, undefined, sessions);
  return { root, dataDir };
}

async function spawnPicker(
  cols: number,
  multiBot: boolean,
  titleFor?: (index: number) => string,
  modern = false,
  adoptTmuxTarget?: string,
  dormantTmux = false,
  wakeDaemonPort?: number,
): Promise<{
  child: pty.IPty;
  terminal: InstanceType<typeof Terminal>;
  renderCount: () => number;
  waitForRender: (minimum: number) => Promise<void>;
}> {
  const fixture = makeFixture(
    multiBot,
    titleFor,
    adoptTmuxTarget,
    dormantTmux,
    wakeDaemonPort,
  );
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: fixture.root,
    SESSION_DATA_DIR: fixture.dataDir,
    TERM: 'xterm-256color',
  };
  for (const key of [
    'BOTMUX_SESSION_ID',
    'BOTMUX_LARK_APP_ID',
    'BOTMUX_SEND_RELAY',
    'BOTMUX_DAEMON_IPC_PORT',
  ]) delete env[key];

  // node-pty takes command and args separately, so build the runtime-aware
  // prefix by hand instead of going through the spawnTsScript wrapper.
  const { command, prefixArgs } = tsRunnerPrefix();
  const child = pty.spawn(command, [...prefixArgs, CLI_PATH, 'list'], {
    cwd: join(TEST_DIR, '..'),
    env,
    cols,
    rows: 24,
    name: 'xterm-256color',
  });
  children.push(child);
  const terminal = makeTerminal(cols, modern);
  let raw = '';
  let writes = Promise.resolve();
  child.onData(data => {
    raw += data;
    writes = writes.then(() => new Promise<void>(resolve => terminal.write(data, resolve)));
  });

  const renderCount = () => raw.split('botmux sessions').length - 1;
  const waitForRender = async (minimum: number): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (renderCount() < minimum && Date.now() < deadline) await delay(20);
    expect(renderCount()).toBeGreaterThanOrEqual(minimum);
    await delay(60);
    await writes;
  };
  await waitForRender(1);
  return { child, terminal, renderCount, waitForRender };
}

function inspectScreen(terminal: InstanceType<typeof Terminal>): {
  lines: string[];
  wrappedRows: number[];
} {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  const wrappedRows: number[] = [];
  for (let y = 0; y < terminal.rows; y++) {
    const line = buffer.getLine(y);
    lines.push((line?.translateToString(true) ?? '').trimEnd());
    if (line?.isWrapped) wrappedRows.push(y);
  }
  return { lines, wrappedRows };
}

async function closePicker(child: pty.IPty, terminal: InstanceType<typeof Terminal>): Promise<void> {
  child.write('q');
  await delay(50);
  terminal.dispose();
  const idx = children.indexOf(child);
  if (idx >= 0) children.splice(idx, 1);
}

describe('session picker real terminal responsiveness', () => {
  it('rebuilds horizontal layout when a wide terminal shrinks', async () => {
    const picker = await spawnPicker(180, false);
    const beforeResize = picker.renderCount();
    picker.terminal.resize(100, 24);
    picker.child.resize(100, 24);
    await picker.waitForRender(beforeResize + 1);

    const screen = inspectScreen(picker.terminal);
    expect(screen.lines[0]).toContain('botmux sessions  (1/48)');
    expect(screen.lines.some(line => line.includes('❯') && line.includes('48000000'))).toBe(true);
    expect(screen.lines).toContainEqual(expect.stringContaining('↓ 37 更多'));
    expect(screen.wrappedRows).toEqual([]);
    await closePicker(picker.child, picker.terminal);
  });

  it('keeps the title pinned when a single-bot picker starts at 99 columns', async () => {
    const picker = await spawnPicker(99, false);
    const screen = inspectScreen(picker.terminal);
    expect(screen.lines[0]).toContain('botmux sessions  (1/48)');
    expect(screen.lines.some(line => line.includes('❯') && line.includes('48000000'))).toBe(true);
    expect(screen.wrappedRows).toEqual([]);
    await closePicker(picker.child, picker.terminal);
  });

  it('keeps the title pinned when a multi-bot picker starts at 120 columns', async () => {
    const picker = await spawnPicker(120, true);
    const screen = inspectScreen(picker.terminal);
    expect(screen.lines[0]).toContain('botmux sessions  (1/48)');
    expect(screen.lines.some(line => line.includes('❯') && line.includes('48000000'))).toBe(true);
    expect(screen.wrappedRows).toEqual([]);
    await closePicker(picker.child, picker.terminal);
  });

  it('does not wrap when every session title is emoji-heavy', async () => {
    // Regression for the Unicode-width gap: Lark topic titles routinely carry
    // emoji, and the project's Unicode11 web terminal (and real terminals) paint
    // each two cells wide. With an xterm-11-only width table that scored them as
    // one, the row overflowed, wrapped, and the pinned title scrolled off.
    const picker = await spawnPicker(99, false, i => `🤖🎉🚀 session ${i + 1} 部署✅ 🔥🔥🔥`);
    const screen = inspectScreen(picker.terminal);
    expect(screen.lines[0]).toContain('botmux sessions  (1/48)');
    expect(screen.lines.some(line => line.includes('❯'))).toBe(true);
    expect(screen.wrappedRows).toEqual([]);
    await closePicker(picker.child, picker.terminal);
  });

  it('does not wrap on modern (Unicode 14+/17) emoji a current terminal paints two wide', async () => {
    // 🫠🩷🫨 (Unicode 14/15) and 🛘🪊🫯 (Unicode 17) are width 1 under xterm-11 but
    // two cells on modern local/SSH terminals — exactly what an xterm-11-only (or a
    // Unicode-16-pinned) width table under-counted. The `modern` terminal forces
    // Emoji_Presentation code points two wide in the buffer (see makeTerminal), and
    // the titles are built ENTIRELY from them so they fill the truncated title cell:
    // an under-count truncates at ~1x while the terminal paints ~2x, overflowing the
    // row, wrapping it, and pushing the title off screen. Including U17 code points
    // is what catches a table pinned to an older Unicode version.
    const modern = ['🫠', '🩷', '🫨', '🛘', '🪊', '🫯'];
    const picker = await spawnPicker(
      99,
      false,
      i => Array.from({ length: 24 }, (_, k) => modern[(i + k) % modern.length]).join(''),
      true,
    );
    const screen = inspectScreen(picker.terminal);
    expect(screen.lines[0]).toContain('botmux sessions  (1/48)');
    expect(screen.lines.some(line => line.includes('❯'))).toBe(true);
    expect(screen.wrappedRows).toEqual([]);
    await closePicker(picker.child, picker.terminal);
  });

  it('does not wrap on non-emoji code points later Unicode widened (East_Asian_Width)', async () => {
    // The trigram block ☰..☷ (U+2630..U+2637) is East_Asian_Width=Wide since Unicode
    // 16 but xterm-11 scores it 1. A modern terminal paints it two cells wide; if the
    // width table only unions emoji (not current EAW), an all-☰ title under-counts,
    // overflows the row, wraps, and pushes the pinned title off screen.
    const trigrams = ['☰', '☱', '☲', '☳', '☴', '☵', '☶', '☷'];
    const picker = await spawnPicker(
      99,
      false,
      i => Array.from({ length: 24 }, (_, k) => trigrams[(i + k) % trigrams.length]).join(''),
      true,
    );
    const screen = inspectScreen(picker.terminal);
    expect(screen.lines[0]).toContain('botmux sessions  (1/48)');
    expect(screen.lines.some(line => line.includes('❯'))).toBe(true);
    expect(screen.wrappedRows).toEqual([]);
    await closePicker(picker.child, picker.terminal);
  });

  it('does not wrap on emoji formed by a base char + VS16 (emoji variation selector)', async () => {
    // ❤️ is ❤ (U+2764, default-text width 1) + VS16 (U+FE0F). A grapheme-aware
    // terminal paints the joined grapheme two cells wide. Per-code-point summing
    // that treats VS16 as zero-width under-counts (1+0=1) → an all-❤️ title
    // overflows the row, wraps, and pushes the title off screen. The width table
    // budgets 1 for VS16 so base(1)+VS16(1)=2, matching the terminal.
    const picker = await spawnPicker(
      99,
      false,
      i => Array.from({ length: 20 }, () => '❤️').join('') + ` ${i + 1}`,
      true,
    );
    const screen = inspectScreen(picker.terminal);
    expect(screen.lines[0]).toContain('botmux sessions  (1/48)');
    expect(screen.lines.some(line => line.includes('❯'))).toBe(true);
    expect(screen.wrappedRows).toEqual([]);
    await closePicker(picker.child, picker.terminal);
  });

  it('does not wrap when titles contain tabs and other control characters', async () => {
    // A raw Tab is a parser action (jump to the next tab stop), not a zero-width
    // glyph, so it cannot be handled by the width table — the picker must strip
    // it (and ESC/C0/C1) out of dynamic text before printing. Without that, a
    // tab in a title advances the cursor past the column budget, wraps the row
    // and hides the title.
    const picker = await spawnPicker(99, false, i => `session\t${i + 1}\tbuild\x1b[31m done\x07`);
    const screen = inspectScreen(picker.terminal);
    expect(screen.lines[0]).toContain('botmux sessions  (1/48)');
    expect(screen.lines.some(line => line.includes('❯'))).toBe(true);
    expect(screen.wrappedRows).toEqual([]);
    await closePicker(picker.child, picker.terminal);
  });

  it('does not let a malicious adopt target label inject control sequences into the footer', async () => {
    // The footer shows the selected session's target label. An adopted session's
    // tmux target is attacker-controllable; a raw ESC[2J there would clear the
    // whole alt-screen (title included) if the footer emitted the label without
    // sanitizing. The label must be scrubbed before the whitelist SGR is applied.
    const picker = await spawnPicker(99, false, undefined, false, 'evil\x1b[2Jinjected\x1b]0;pwned\x07\ttab');
    const screen = inspectScreen(picker.terminal);
    // Screen not cleared: title still on line 0, rows still present.
    expect(screen.lines[0]).toContain('botmux sessions  (1/48)');
    expect(screen.lines.some(line => line.includes('❯'))).toBe(true);
    expect(screen.wrappedRows).toEqual([]);
    // The visible (printable) part of the payload still shows — only the control
    // bytes were stripped, so the label is not silently dropped.
    expect(screen.lines.some(line => line.includes('evil') && line.includes('injected'))).toBe(true);
    await closePicker(picker.child, picker.terminal);
  });

  it('offers recovery when the selected managed tmux backend is missing', async () => {
    const picker = await spawnPicker(120, false, undefined, false, undefined, true);
    const screen = inspectScreen(picker.terminal);
    expect(screen.lines.some(line => line.includes('tmux: bmx-48000000') && line.includes('Enter 恢复并连接'))).toBe(true);
    expect(screen.lines.some(line => line.includes('⏎ 恢复'))).toBe(true);
    await closePicker(picker.child, picker.terminal);
  });

  it('lets q abort a never-resolving wake and exits raw mode promptly', async () => {
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>(resolve => { markRequestStarted = resolve; });
    const server = createServer(() => { markRequestStarted(); });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test daemon did not bind a TCP port');

    try {
      const picker = await spawnPicker(120, false, undefined, false, undefined, true, address.port);
      const exited = new Promise<void>(resolve => picker.child.onExit(() => resolve()));
      const beforeWake = picker.renderCount();
      picker.child.write('\r');
      await picker.waitForRender(beforeWake + 1);
      expect(inspectScreen(picker.terminal).lines.some(line => line.includes('正在恢复 tmux'))).toBe(true);
      await Promise.race([
        requestStarted,
        delay(2_000).then(() => { throw new Error('wake request did not reach test daemon'); }),
      ]);

      picker.child.write('q');
      await Promise.race([
        exited,
        delay(1_000).then(() => { throw new Error('picker did not exit after q'); }),
      ]);
      picker.terminal.dispose();
      const idx = children.indexOf(picker.child);
      if (idx >= 0) children.splice(idx, 1);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
