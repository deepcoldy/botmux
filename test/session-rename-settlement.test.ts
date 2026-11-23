import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decideSessionRenameSettlement } from '../src/core/session-rename-settlement.js';
import { traexSessionRenameSurface } from '../src/adapters/cli/traex-footer.js';
import { codexSessionRenameSurface } from '../src/services/codex-terminal-session.js';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { watchNativeSessionIndex } from '../src/services/native-session-index.js';

// Real viewports captured from traecli 0.216.0 and codex-cli 0.167.0 in a
// private tmux pane (paths and the binary location sanitized).
const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/session-rename/${name}`, import.meta.url), 'utf8');
const cursorOf = (name: string): { x: number; y: number } => {
  const [x, y] = fixture(name).trim().split(',').map(Number);
  return { x: x!, y: y! };
};
const TITLE = '[BotMux·Lark] 修复登录页报错';
const COMMAND = `/rename ${TITLE}`;

describe('decideSessionRenameSettlement', () => {
  const decide = (over: Partial<Parameters<typeof decideSessionRenameSettlement>[0]>) =>
    decideSessionRenameSettlement({ surface: 'pending', recorded: false, consumed: true, resubmitted: false, fromPrompt: false, ...over });

  it('keeps the bounded fail-open for a CLI that cannot judge its composer', () => {
    expect(decide({ surface: undefined })).toBe('release');
    expect(decide({ surface: undefined, fromPrompt: true })).toBe('release');
    expect(decide({ surface: undefined, consumed: false })).toBe('release');
  });

  it('releases queued input only on a settled composer or a recorded rename', () => {
    expect(decide({ surface: 'settled' })).toBe('release');
    expect(decide({ surface: 'pending' })).toBe('hold');
    expect(decide({ surface: 'pending', recorded: true })).toBe('release');
  });

  it('does not take an empty composer the TUI has not redrawn since the command for a finished rename', () => {
    // A stalled TUI still shows the composer as it was before the command.
    expect(decide({ surface: 'settled', consumed: false })).toBe('hold');
    expect(decide({ surface: 'settled', consumed: false, fromPrompt: true })).toBe('hold');
    expect(decide({ surface: 'settled', consumed: false, recorded: true })).toBe('release');
  });

  it('submits a command left in the composer once, from the bounded wait only', () => {
    expect(decide({ surface: 'unsubmitted' })).toBe('resubmit');
    expect(decide({ surface: 'unsubmitted', fromPrompt: true })).toBe('hold');
    expect(decide({ surface: 'unsubmitted', resubmitted: true })).toBe('hold');
  });

  it('never lets a durable record override a command still visible in the composer', () => {
    expect(decide({ surface: 'unsubmitted', recorded: true })).toBe('resubmit');
    expect(decide({ surface: 'unsubmitted', recorded: true, resubmitted: true })).toBe('hold');
  });
});

describe('TRAE native rename surface (0.216.0)', () => {
  it('reads a finished rename as settled', () => {
    expect(traexSessionRenameSurface(fixture('traex-0.216.0-renamed.txt'), '/rename 修复登录页报错')).toBe('settled');
    expect(traexSessionRenameSurface(fixture('traex-0.216.0-rename-resubmitted.txt'), COMMAND)).toBe('settled');
  });

  it('recognises only its own command left in the composer as unsubmitted', () => {
    const screen = fixture('traex-0.216.0-rename-left-in-composer.txt');
    expect(traexSessionRenameSurface(screen, COMMAND)).toBe('unsubmitted');
    // A different draft is a human's: neither settled nor ours to submit.
    expect(traexSessionRenameSurface(screen, '/rename another title')).toBe('pending');
  });

  it('matches its command when tmux draws an emoji of the title as blank cells', () => {
    // `⚠️` (with VS16) is drawn as blanks; the ZWJ sequence survives.
    const screen = fixture('traex-0.216.0-rename-left-in-composer-emoji.txt');
    const command = createTraexAdapter().buildSessionRenameCommand!('[BotMux·Lark] ⚠️ 线上告警 👨‍💻 处理');
    expect(traexSessionRenameSurface(screen, command)).toBe('unsubmitted');
    expect(traexSessionRenameSurface(screen, '/rename [BotMux·Lark] ⚠️ 线上故障 👨‍💻 处理')).toBe('pending');
  });

  it('keeps the rename dialog and a busy turn pending', () => {
    expect(traexSessionRenameSurface(fixture('traex-0.216.0-rename-dialog.txt'), COMMAND)).toBe('pending');
    expect(traexSessionRenameSurface(fixture('traex-0.216.0-renamed-while-busy.txt'), '/rename 修复登录页报错')).toBe('pending');
  });

  it('judges the exact command the adapter types', () => {
    const adapter = createTraexAdapter();
    const command = adapter.buildSessionRenameCommand!(TITLE);
    const left = fixture('traex-0.216.0-rename-left-in-composer.txt');
    expect(adapter.sessionRenameSurface!({ viewport: left }, command)).toBe('unsubmitted');
    expect(adapter.sessionRenameSurface!({ viewport: fixture('traex-0.216.0-rename-resubmitted.txt') }, command)).toBe('settled');
  });
});

describe('Codex native rename surface (0.167.0)', () => {
  const left = fixture('codex-0.167.0-rename-left-in-composer.txt');
  const done = fixture('codex-0.167.0-rename-resubmitted.txt');

  it('judges the composer with the reported cursor', () => {
    expect(codexSessionRenameSurface({ viewport: left, cursor: cursorOf('codex-0.167.0-rename-left-in-composer.cursor') }, COMMAND)).toBe('unsubmitted');
    expect(codexSessionRenameSurface({ viewport: done, cursor: cursorOf('codex-0.167.0-rename-resubmitted.cursor') }, COMMAND)).toBe('settled');
  });

  it('falls back to the live prompt row without a cursor', () => {
    expect(codexSessionRenameSurface({ viewport: left }, COMMAND)).toBe('unsubmitted');
    expect(codexSessionRenameSurface({ viewport: done }, COMMAND)).toBe('settled');
    expect(codexSessionRenameSurface({ viewport: left }, '/rename another title')).toBe('pending');
  });

  it('is the judge the Codex adapter declares', () => {
    const adapter = createCodexAdapter();
    expect(adapter.sessionRenameSurface!({ viewport: left }, adapter.buildSessionRenameCommand!(TITLE))).toBe('unsubmitted');
  });
});

describe('watchNativeSessionIndex', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const index = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-session-index-'));
    dirs.push(dir);
    return join(dir, 'session_index.jsonl');
  };
  const record = (name: string) => `${JSON.stringify({ id: '01a2', thread_name: name, updated_at: '2026-11-23T08:50:37Z' })}\n`;

  it('only counts a record of the exact title appended after it was armed', () => {
    const path = index();
    writeFileSync(path, record(TITLE));
    const recorded = watchNativeSessionIndex(path, TITLE);
    expect(recorded()).toBe(false);
    appendFileSync(path, record(`${TITLE}\n这是追问内容`));
    appendFileSync(path, '{"thread_name": "partial');
    expect(recorded()).toBe(false);
    appendFileSync(path, `\n${record(TITLE)}`);
    expect(recorded()).toBe(true);
  });

  it('treats an index created after arming as new records', () => {
    const path = index();
    const recorded = watchNativeSessionIndex(path, TITLE);
    expect(recorded()).toBe(false);
    writeFileSync(path, record(TITLE));
    expect(recorded()).toBe(true);
  });
});
