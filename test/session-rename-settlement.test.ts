import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decideSessionRenameSettlement, sessionRenameWriteFailureAction } from '../src/core/session-rename-settlement.js';
import { traexSessionRenameSurface } from '../src/adapters/cli/traex-footer.js';
import { codexNativeComposerState, codexSessionRenameSurface, codexNativeFooterRows } from '../src/services/codex-terminal-session.js';
import { detectCodexChoiceModal } from '../src/utils/codex-choice-modal.js';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { watchNativeSessionIndex } from '../src/services/native-session-index.js';
import { composerTextKey } from '../src/utils/composer-text-key.js';

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
const NATIVE_ID = '01a2';

describe('decideSessionRenameSettlement', () => {
  const decide = (over: Partial<Parameters<typeof decideSessionRenameSettlement>[0]>) =>
    decideSessionRenameSettlement({ surface: 'unknown', recorded: false, resubmitted: false, fromPrompt: false, ...over });

  it('keeps the bounded fail-open for a CLI that cannot judge its composer', () => {
    expect(decide({ surface: undefined })).toBe('release');
    expect(decide({ surface: undefined, fromPrompt: true })).toBe('release');
  });

  it('requires this rename\'s durable receipt on both an empty and an unknown surface', () => {
    expect(decide({ surface: 'settled' })).toBe('hold');
    expect(decide({ surface: 'settled', fromPrompt: true })).toBe('hold');
    expect(decide({ surface: 'unknown' })).toBe('hold');
    expect(decide({ surface: 'settled', recorded: true })).toBe('release');
    expect(decide({ surface: 'unknown', recorded: true })).toBe('release');
  });

  it('never lets a receipt override a currently occupied input surface', () => {
    expect(decide({ surface: 'occupied', recorded: false })).toBe('hold');
    expect(decide({ surface: 'occupied', recorded: true })).toBe('hold');
    expect(decide({ surface: 'occupied', recorded: true, fromPrompt: true })).toBe('hold');
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

  it('fails open after the hold cap on every surface except a visible rename command', () => {
    expect(decide({ surface: 'settled', holdExpired: true })).toBe('release_unconfirmed');
    expect(decide({ surface: 'settled', recorded: true, holdExpired: true })).toBe('release');
    expect(decide({ surface: 'occupied', recorded: true, holdExpired: true })).toBe('release');
    expect(decide({ surface: 'unknown', holdExpired: true })).toBe('release_unconfirmed');
    expect(decide({ surface: 'occupied', holdExpired: true })).toBe('release_unconfirmed');
  });

  it('never releases an explicit dialog, draft or paste chip, even at the cap with a receipt', () => {
    expect(decide({ surface: 'blocked' })).toBe('hold');
    expect(decide({ surface: 'blocked', recorded: true })).toBe('hold');
    expect(decide({ surface: 'blocked', recorded: true, holdExpired: true })).toBe('hold');
  });

  it('never turns the hold cap into a late automatic Enter or release of a visible rename command', () => {
    expect(decide({ surface: 'unsubmitted', holdExpired: true })).toBe('hold');
    expect(decide({ surface: 'unsubmitted', recorded: true, holdExpired: true })).toBe('hold');
    expect(decide({ surface: 'unsubmitted', resubmitted: true, holdExpired: true })).toBe('hold');
  });
});

describe('sessionRenameWriteFailureAction', () => {
  it('retries only a structurally proven pre-write refusal', () => {
    expect(sessionRenameWriteFailureAction({ submissionStarted: false })).toBe('retry');
    expect(sessionRenameWriteFailureAction({ submissionStarted: false, recoveryFailureReason: 'web_terminal_input_wire_dirty' })).toBe('retry');
    expect(sessionRenameWriteFailureAction({ submissionStarted: true })).toBe('hold');
    expect(sessionRenameWriteFailureAction(new Error('text or Enter rejected'))).toBe('hold');
    expect(sessionRenameWriteFailureAction(null)).toBe('hold');
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
    expect(traexSessionRenameSurface(screen, '/rename another title')).toBe('blocked');
  });

  it('matches its command when tmux draws the recorded warning emoji as blank cells', () => {
    const screen = fixture('traex-0.216.0-rename-left-in-composer-emoji.txt');
    const command = createTraexAdapter().buildSessionRenameCommand!('[BotMux·Lark] ⚠️ 线上告警 👨‍💻 处理');
    expect(traexSessionRenameSurface(screen, command)).toBe('unsubmitted');
    expect(traexSessionRenameSurface(screen, '/rename [BotMux·Lark] ⚠️ 线上故障 👨‍💻 处理')).toBe('blocked');
  });

  it('does not equate visibly different emoji-only edits', () => {
    expect(composerTextKey('/rename 😀')).not.toBe(composerTextKey('/rename 😎'));
    expect(composerTextKey('/rename 👍🏽')).not.toBe(composerTextKey('/rename 👍🏻'));
    expect(composerTextKey('/rename 👨‍💻')).not.toBe(composerTextKey('/rename 👨💻'));
    const edited = fixture('traex-0.216.0-rename-left-in-composer.txt')
      .replace(`❯ ${COMMAND}`, '❯ /rename 😎');
    expect(traexSessionRenameSurface(edited, '/rename 😀')).toBe('blocked');
  });

  it('does not claim an unrelated collapsed paste from its character count', () => {
    const chip = `[Pasted Content ${Array.from(COMMAND).length} chars]`;
    const foreignDraft = fixture('traex-0.216.0-rename-left-in-composer.txt')
      .replace(`❯ ${COMMAND}`, `❯ ${chip}`);
    expect(traexSessionRenameSurface(foreignDraft, COMMAND)).toBe('blocked');
  });

  it('lets drafts and exact commands outrank busy chrome', () => {
    const busyDraft = fixture('traex-0.216.0-renamed-while-busy.txt')
      .replace('❯ Run /review on my current changes', `❯ ${COMMAND}`);
    expect(traexSessionRenameSurface(busyDraft, COMMAND)).toBe('unsubmitted');
    expect(traexSessionRenameSurface(busyDraft, '/rename another title')).toBe('blocked');
  });

  it('treats model pickers and native question pages as hard input owners', () => {
    const picker = ['─'.repeat(80), '', '  Select Model and Effort', '',
      '❯  7. GPT-5.6-Sol / Standard', '  2. Other option', '', '  enter confirm  |  esc go back'].join('\n');
    expect(traexSessionRenameSurface(picker, COMMAND)).toBe('blocked');
    const question = readFileSync(new URL('./fixtures/traex-question/traex-0.214.1-submit-confirm-160x50.txt', import.meta.url), 'utf8');
    expect(traexSessionRenameSurface(question, COMMAND)).toBe('blocked');
    // Sanitized viewport shape from the real approval-15s recording.
    const approval = [
      '  Would you like to run the following command?',
      '  Environment: local',
      '  $ touch /tmp/work/approved-marker',
      '› 1. Yes, proceed (y)',
      '  2. Yes, and do not ask again for this command',
      '  3. No, and tell Codex what to do differently',
      'Press enter to confirm or esc to cancel',
    ].join('\n');
    expect(traexSessionRenameSurface(approval, COMMAND)).toBe('blocked');
  });

  it('keeps the rename dialog and a busy turn occupied even with a receipt', () => {
    const dialog = traexSessionRenameSurface(fixture('traex-0.216.0-rename-dialog.txt'), COMMAND);
    const busy = traexSessionRenameSurface(fixture('traex-0.216.0-renamed-while-busy.txt'), '/rename 修复登录页报错');
    expect(dialog).toBe('blocked');
    expect(busy).toBe('occupied');
    expect(decideSessionRenameSettlement({ surface: dialog, recorded: true, resubmitted: false, fromPrompt: false })).toBe('hold');
    expect(decideSessionRenameSettlement({ surface: busy, recorded: true, resubmitted: false, fromPrompt: false })).toBe('hold');
  });

  it('keeps an unrecognised empty footer eligible for the receipt fallback', () => {
    const unknown = fixture('traex-0.216.0-rename-resubmitted.txt').replace(
      /  fake-model ·[^\n]+\n  ☢ Full Access[^\n]+/,
      '  fake-model · a status cell from a newer release',
    );
    const surface = traexSessionRenameSurface(unknown, COMMAND);
    expect(surface).toBe('unknown');
    expect(decideSessionRenameSettlement({ surface, recorded: true, resubmitted: false, fromPrompt: false })).toBe('release');
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
    expect(codexSessionRenameSurface({ viewport: left }, '/rename another title')).toBe('blocked');
  });

  it('keeps busy and native rename-dialog surfaces distinct', () => {
    const busy = done.replace('› Ask Codex to do anything', '  Working… (2s • esc to interrupt)\n\n› Ask Codex to do anything');
    const dialog = ['>_ OpenAI Codex', '', '  Rename thread', '', '› title', '', 'enter submit  |  esc back'].join('\n');
    expect(codexSessionRenameSurface({ viewport: busy }, COMMAND)).toBe('occupied');
    expect(codexSessionRenameSurface({ viewport: dialog }, COMMAND)).toBe('blocked');
  });

  it('accepts a native 0.146.1 hint for the first input box', () => {
    const state = {
      viewport: 'Previous conversation\n› Implement {feature}\n\n  gpt-5.6-sol default · ~/data',
      cursor: { x: 2, y: 1 },
    };
    expect(createCodexAdapter().inputBoxReady!(state)).toBe(true);
  });

  it('settles a recorded rename on a native 0.146.1 hint', () => {
    const state = {
      viewport: 'Previous conversation\n› Implement {feature}\n\n  gpt-5.6-sol default · ~/data',
      cursor: { x: 2, y: 1 },
    };
    expect(codexNativeComposerState(state)).toBe('unknown');
    expect(codexNativeComposerState(state, { allowCodex0146Hints: true })).toBe('empty');
    expect(codexSessionRenameSurface(state, COMMAND)).toBe('settled');
  });

  it('lets exact commands and drafts outrank busy chrome', () => {
    const exact = done.replace('› Ask Codex to do anything', '  Working… (2s • esc to interrupt)\n\n› /rename [BotMux·Lark] 修复登录页报错');
    expect(codexSessionRenameSurface({ viewport: exact }, COMMAND)).toBe('unsubmitted');
    const other = done.replace('› Ask Codex to do anything', '  Working… (2s • esc to interrupt)\n\n› a human draft');
    expect(codexSessionRenameSurface({ viewport: other }, COMMAND)).toBe('blocked');
  });

  it('keeps a pasted TRAE draft blocked even on the provisional resume footer', () => {
    const pasted = readFileSync(new URL('./fixtures/traex-cold-resume/0.216.0-resume-provisional-pasted.txt', import.meta.url), 'utf8');
    expect(traexSessionRenameSurface(pasted, COMMAND)).toBe('blocked');
  });

  it('lets Codex hints and unfamiliar chrome degrade to unknown instead of permanent blocked', () => {
    for (const viewport of [
      '› Implement {feature}\nQueued for capacity\nmodel · /tmp',
      '› Implement\n {feature}\nmodel · /tmp',
      '›\nunknown\nother · weird',
    ]) {
      expect(codexSessionRenameSurface({ viewport, cursor: { x: 2, y: 0 } }, COMMAND), JSON.stringify(viewport)).toBe('unknown');
    }
  });

  it('classifies a footerless non-empty draft as blocked rather than occupied', () => {
    expect(codexSessionRenameSurface({ viewport: '› a human draft', cursor: { x: 13, y: 0 } }, COMMAND)).toBe('blocked');
  });

  it('accepts a bare native prompt with a valid footer and keeps an unfamiliar footer unknown', () => {
    expect(codexSessionRenameSurface({ viewport: '›\nmodel · /tmp', cursor: { x: 2, y: 0 } }, COMMAND)).toBe('settled');
    expect(codexSessionRenameSurface({ viewport: '›\nunknown footer', cursor: { x: 2, y: 0 } }, COMMAND)).toBe('unknown');
    expect(codexNativeFooterRows(['enter to submit / esc to cancel'])).toBeUndefined();
    for (const valid of ['  100% context left', '01a20bdb-47c4-7702-8188-21c3628071d2', '⚠️ 3']) {
      expect(codexNativeFooterRows([valid])).toBe(valid.trim());
    }
  });

  it('rejects a manually typed 0.146.1 hint when the cursor is past Home', () => {
    const state = {
      viewport: 'Previous conversation\n› Implement {feature}\n\n  gpt-5.6-sol default · ~/data',
      cursor: { x: 20, y: 1 },
    };
    expect(createCodexAdapter().inputBoxReady!(state)).toBe(false);
    expect(codexSessionRenameSurface(state, COMMAND)).not.toBe('settled');
  });

  it('detects a choice modal in a tall viewport with hint-only backdrop rows', () => {
    const modal = readFileSync(new URL('./fixtures/codex-choice-modal/tmux-pane-tool-approval-160x30.txt', import.meta.url), 'utf8');
    const tall = `${'context\n'.repeat(40)}${modal}\n? for shortcuts`;
    expect(detectCodexChoiceModal(tall)).toBeDefined();
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
  const record = (name: string, id = NATIVE_ID) => `${JSON.stringify({ id, thread_name: name, updated_at: '2026-11-23T08:50:37Z' })}\n`;

  it('only counts the exact thread and title appended after it was armed', () => {
    const path = index();
    writeFileSync(path, record(TITLE));
    const recorded = watchNativeSessionIndex(path, TITLE, () => NATIVE_ID);
    expect(recorded()).toBe(false);
    appendFileSync(path, record(`${TITLE}\n这是追问内容`));
    appendFileSync(path, '{"thread_name": "partial');
    expect(recorded()).toBe(false);
    appendFileSync(path, `\n${record(TITLE)}`);
    expect(recorded()).toBe(true);
  });

  it('rejects another thread\'s same-title receipt', () => {
    const path = index();
    const recorded = watchNativeSessionIndex(path, TITLE, () => NATIVE_ID);
    appendFileSync(path, record(TITLE, 'another-thread'));
    expect(recorded()).toBe(false);
    appendFileSync(path, record(TITLE));
    expect(recorded()).toBe(true);
  });

  it('fails closed when the current native thread id is not known', () => {
    const path = index();
    const recorded = watchNativeSessionIndex(path, TITLE, () => undefined);
    appendFileSync(path, record(TITLE));
    expect(recorded()).toBe(false);
  });

  it('accepts a receipt written before native identity became proven on reattach', () => {
    const path = index();
    let nativeId: string | undefined;
    const recorded = watchNativeSessionIndex(path, TITLE, () => nativeId);
    appendFileSync(path, record(TITLE));
    expect(recorded()).toBe(false);
    nativeId = NATIVE_ID;
    expect(recorded()).toBe(true);
  });

  it('matches UUID thread ids case-insensitively', () => {
    const path = index();
    const lower = '01a20bdb-47c4-7702-8188-21c3628071d2';
    const recorded = watchNativeSessionIndex(path, TITLE, () => lower.toUpperCase());
    appendFileSync(path, record(TITLE, lower));
    expect(recorded()).toBe(true);
  });

  it('treats an index created after arming as new records', () => {
    const path = index();
    const recorded = watchNativeSessionIndex(path, TITLE, () => NATIVE_ID);
    expect(recorded()).toBe(false);
    writeFileSync(path, record(TITLE));
    expect(recorded()).toBe(true);
  });
});
