import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DOUBAO_BUSY_FOOTER,
  DOUBAO_READY_PATTERN,
  createDoubaoAdapter,
  doubaoDataRoot,
  doubaoSessionExists,
  doubaoSessionRoots,
  findDoubaoSessionForSubmit,
  parseDoubaoAvailableModels,
} from '../src/adapters/cli/doubao.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

const SID = '38450922917357570';
const OTHER_SID = '38450174181084930';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Fake `<dataRoot>/agent_mode/<uid>/workspace/.sessions` tree. */
function makeSessionsRoot(): string {
  const dataRoot = mkdtempSync(join(tmpdir(), 'doubao-data-'));
  tempDirs.push(dataRoot);
  const root = join(dataRoot, 'agent_mode', '100', 'workspace', '.sessions');
  mkdirSync(root, { recursive: true });
  return root;
}

/** Write an assignment.md the way doubao 2.31 appends a TUI turn. */
function writeAssignment(root: string, sid: string, prompt: string, mtimeMs = Date.now()): string {
  const dir = join(root, sid, 'agents', 'm_test', 'system');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'assignment.md');
  writeFileSync(file, `# Assignment\n- Role: main\n\n## [2026-11-02T03:51:28Z] 需求\n${prompt}\n`);
  utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

function fakeTmuxPty(): PtyHandle & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    write(data: string) { log.push(`write:${data}`); },
    pasteText(text: string) { log.push(`paste:${text}`); },
    sendText(text: string) { log.push(`text:${text}`); },
    sendSpecialKeys(...keys: string[]) { log.push(`keys:${keys.join(',')}`); },
  };
}

describe('doubao buildArgs', () => {
  it('runs without per-tool approval unless bypass is disabled', () => {
    const adapter = createDoubaoAdapter('/bin/doubao');
    expect(adapter.buildArgs({ sessionId: 's', resume: false })).toEqual(['--permission-mode', 'always_allow']);
    expect(adapter.buildArgs({ sessionId: 's', resume: false, disableCliBypass: true })).toEqual([]);
  });

  it('passes model and only doubao-accepted effort values', () => {
    const adapter = createDoubaoAdapter('/bin/doubao');
    expect(adapter.buildArgs({ sessionId: 's', resume: false, disableCliBypass: true, model: ' Doubao 2.1 Pro ', reasoningEffort: 'xhigh' }))
      .toEqual(['--model', 'Doubao 2.1 Pro', '--effort', 'xhigh']);
    // `ultra` is botmux-only; doubao rejects it with exit 1, so it is dropped.
    expect(adapter.buildArgs({ sessionId: 's', resume: false, disableCliBypass: true, reasoningEffort: 'ultra' })).toEqual([]);
  });

  it('resumes only a precise native session id', () => {
    const adapter = createDoubaoAdapter('/bin/doubao');
    expect(adapter.buildArgs({ sessionId: 's', resume: true, resumeSessionId: SID, disableCliBypass: true }))
      .toEqual(['--resume', SID]);
    // No id / a non-snowflake id never turns into an implicit or failing resume.
    expect(adapter.buildArgs({ sessionId: 's', resume: true, disableCliBypass: true })).toEqual([]);
    expect(adapter.buildArgs({ sessionId: 's', resume: true, resumeSessionId: 'not-a-number', disableCliBypass: true })).toEqual([]);
    expect(adapter.resumeRequiresCliSessionId).toBe(true);
  });

  it('prints a local resume command only for a native id', () => {
    const adapter = createDoubaoAdapter('/bin/doubao');
    expect(adapter.buildResumeCommand?.({ sessionId: 's', cliSessionId: SID })).toBe(`doubao --resume ${SID}`);
    expect(adapter.buildResumeCommand?.({ sessionId: 's' })).toBeNull();
    expect(adapter.buildResumeCommand?.({ sessionId: 's', cliSessionId: 'x; rm -rf /' })).toBeNull();
  });

  it('disables the launcher update prompt that would swallow the first message', () => {
    expect(createDoubaoAdapter('/bin/doubao').spawnEnv).toEqual({ DOUBAO_CLI_NO_UPDATE_CHECK: '1' });
  });
});

describe('doubao screen patterns (captured from doubao 2.31.0)', () => {
  const idleScreen = [
    '◆ DONE-42',
    '─'.repeat(40),
    '❯  Ask Doubao to do anything',
    '─'.repeat(40),
    '  Enter send · Ctrl+J newline · / commands',
  ].join('\n');
  const busyScreen = [
    '● 正在执行代码 sleep 8 && echo DBTEST-OK · Running',
    '◈ Running tool… (8s • esc to interrupt)',
    '─'.repeat(40),
    '❯  Ask Doubao to do anything',
    '─'.repeat(40),
    '  Enter send · Ctrl+J newline · / commands',
  ].join('\n');

  it('recognizes the composer and the busy footer', () => {
    expect(DOUBAO_READY_PATTERN.test(idleScreen)).toBe(true);
    expect(DOUBAO_BUSY_FOOTER.test(idleScreen)).toBe(false);
    expect(DOUBAO_BUSY_FOOTER.test(busyScreen)).toBe(true);
    expect(DOUBAO_BUSY_FOOTER.test('✦ Responding… (3s • esc to interrupt)')).toBe(true);
  });

  it('does not treat the login / startup banner as ready', () => {
    expect(DOUBAO_READY_PATTERN.test('Good morning\nmodel: GPT-6.1 Sol · High /model to change')).toBe(false);
  });
});

describe('doubao session capture', () => {
  it('derives the data root like the npm launcher', () => {
    expect(doubaoDataRoot({ HOME: '/Users/u' }, 'darwin')).toBe('/Users/u/Library/Application Support/doubao_cli');
    expect(doubaoDataRoot({ HOME: '/home/u' }, 'linux')).toBe('/home/u/.local/share/doubao_cli');
    expect(doubaoDataRoot({ HOME: '/home/u', XDG_DATA_HOME: '/data' }, 'linux')).toBe('/data/doubao_cli');
  });

  it('lists every account session root under the data root', () => {
    const root = makeSessionsRoot();
    const dataRoot = join(root, '..', '..', '..', '..');
    expect(doubaoSessionRoots(dataRoot)).toEqual([root]);
    expect(doubaoSessionRoots(join(dataRoot, 'missing'))).toEqual([]);
  });

  it('finds the session whose latest turn carries this prompt', () => {
    const root = makeSessionsRoot();
    const since = Date.now() - 1000;
    writeAssignment(root, OTHER_SID, 'unrelated desktop task', since + 500);
    writeAssignment(root, SID, '<botmux_routing>\n- hint\n</botmux_routing>\n用户消息：只回复 DONE-42', since + 500);
    expect(findDoubaoSessionForSubmit('<botmux_routing>\n- hint\n</botmux_routing>\n用户消息：只回复 DONE-42', since, [root])).toBe(SID);
  });

  it('ignores sessions last written before the submit', () => {
    const root = makeSessionsRoot();
    const now = Date.now();
    writeAssignment(root, SID, '只回复 DONE-42', now - 60_000);
    expect(findDoubaoSessionForSubmit('只回复 DONE-42', now - 2000, [root])).toBeUndefined();
  });

  it('refuses to guess when two sessions received the same prompt', () => {
    const root = makeSessionsRoot();
    const since = Date.now() - 1000;
    writeAssignment(root, SID, '只回复 OK', since + 100);
    writeAssignment(root, OTHER_SID, '只回复 OK', since + 100);
    expect(findDoubaoSessionForSubmit('只回复 OK', since, [root])).toBeUndefined();
  });

  it('checks resume targets against the local session store', () => {
    const root = makeSessionsRoot();
    writeAssignment(root, SID, 'x');
    expect(doubaoSessionExists(SID, [root])).toBe(true);
    expect(doubaoSessionExists(OTHER_SID, [root])).toBe(false);
    expect(doubaoSessionExists(SID, [])).toBeUndefined();
    expect(createDoubaoAdapter('/bin/doubao').checkResumeTargetExists?.({ sessionId: 's', cliSessionId: 'bad id' })).toBe(false);
  });
});

describe('doubao writeInput', () => {
  it('pastes the whole prompt once and submits with a single Enter', async () => {
    const adapter = createDoubaoAdapter('/bin/doubao');
    // A precise resume disarms id capture, so writeInput returns right after Enter.
    adapter.buildArgs({ sessionId: 's', resume: true, resumeSessionId: SID });
    const pty = fakeTmuxPty();
    await adapter.writeInput(pty, 'line one\nline two');
    expect(pty.log).toEqual(['paste:line one\nline two', 'keys:Enter']);
  });

  it('wraps raw PTY input in bracketed paste so newlines do not submit', async () => {
    const adapter = createDoubaoAdapter('/bin/doubao');
    adapter.buildArgs({ sessionId: 's', resume: true, resumeSessionId: SID });
    const log: string[] = [];
    await adapter.writeInput({ write: (d: string) => { log.push(d); } }, 'a\nb');
    expect(log).toEqual(['\x1b[200~a\nb\x1b[201~', '\r']);
  });

  it('reports an unconfirmed Enter as not submitted', async () => {
    const adapter = createDoubaoAdapter('/bin/doubao');
    adapter.buildArgs({ sessionId: 's', resume: true, resumeSessionId: SID });
    const pty = { ...fakeTmuxPty(), sendSpecialKeys: () => false };
    expect(await adapter.writeInput(pty, 'hi')).toEqual({ submitted: false });
  });
});

describe('doubao model discovery', () => {
  it('parses the list doubao prints for an unsupported --model', () => {
    const out = 'Error: Unsupported --model value. Available models: Auto, Doubao 2.1 Lite, Doubao 2.1 Pro, GPT-6.1 Sol. Start doubao without --model and use /model to view available models.';
    expect(parseDoubaoAvailableModels(out)).toEqual(['Auto', 'Doubao 2.1 Lite', 'Doubao 2.1 Pro', 'GPT-6.1 Sol']);
    expect(parseDoubaoAvailableModels('Error: not logged in')).toBeNull();
  });
});
