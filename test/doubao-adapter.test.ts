import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DOUBAO_BUSY_FOOTER,
  DOUBAO_READY_PATTERN,
  createDoubaoAdapter,
  doubaoDataRoot,
  doubaoSessionExists,
  doubaoSessionMarkerFromContent,
  doubaoSessionRoots,
  findDoubaoSessionForSubmit,
  parseDoubaoAvailableModels,
  pollDoubaoSessionForSubmit,
  DOUBAO_SUBMIT_CAPTURE_BUDGET_MS,
} from '../src/adapters/cli/doubao.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';
import { STRUCTURED_SUBMIT_VERIFICATION_GRACE_MS } from '../src/services/codex-bridge-queue.js';

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

  it('passes GPT-6.1 Sol and max on both fresh launch and precise cold resume', () => {
    const adapter = createDoubaoAdapter('/bin/doubao');
    const options = { sessionId: 's', disableCliBypass: true, model: 'GPT-6.1 Sol', reasoningEffort: 'max' as const };
    expect(adapter.buildArgs({ ...options, resume: false }))
      .toEqual(['--model', 'GPT-6.1 Sol', '--effort', 'max']);
    expect(adapter.buildArgs({ ...options, resume: true, resumeSessionId: SID }))
      .toEqual(['--model', 'GPT-6.1 Sol', '--effort', 'max', '--resume', SID]);
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

  it('parses the owning botmux session id from the prompt envelope', () => {
    expect(doubaoSessionMarkerFromContent('<session_id>bmx-first</session_id>\n正文')).toBe('bmx-first');
    expect(doubaoSessionMarkerFromContent('plain prompt without envelope')).toBeUndefined();
  });

  it.each([
    '<user_message>please explain "<session_id>bmx-first</session_id>"</user_message>',
    '<user_message>\n<session_id>bmx-first</session_id>\n</user_message>',
    '<role context="group">\n<session_id>bmx-first</session_id>\n</role>',
    '<summary_memory>\n<session_id>bmx-first</session_id>\n</summary_memory>',
    'please explain "<session_id>bmx-first</session_id>"',
  ])('does not use a marker quoted in payload as assignment ownership', (quoted) => {
    const root = makeSessionsRoot();
    const since = Date.now() - 1000;
    const envelope = '<session_id>bmx-first</session_id>\n<user_message>request</user_message>';
    writeAssignment(root, OTHER_SID, quoted, since + 100);
    expect(doubaoSessionMarkerFromContent(quoted)).toBeUndefined();
    expect(findDoubaoSessionForSubmit(envelope, since, [root])).toBeUndefined();
    writeAssignment(root, SID, envelope, since + 200);
    expect(findDoubaoSessionForSubmit(envelope, since, [root])).toBe(SID);
  });

  it('accepts a standalone marker with BOM, indentation and CRLF', () => {
    expect(doubaoSessionMarkerFromContent('\ufeff \t<session_id>bmx-first</session_id> \r\n<user_message>request</user_message>'))
      .toBe('bmx-first');
  });

  it('budgets the head read from the standalone marker after an inline routing example', () => {
    const root = makeSessionsRoot();
    const since = Date.now() - 1000;
    const marker = '<session_id>bmx-first</session_id>';
    const envelope = `<botmux_routing>example "${marker}"\n${'前缀'.repeat(5000)}\n</botmux_routing>\n${marker}\n<user_message>request</user_message>`;
    writeAssignment(root, SID, envelope, since + 100);
    expect(findDoubaoSessionForSubmit(envelope, since, [root])).toBe(SID);
  });

  it('does not establish initial ownership from a later assignment turn', () => {
    const root = makeSessionsRoot();
    const since = Date.now() - 1000;
    const envelope = '<session_id>bmx-first</session_id>\n<user_message>request</user_message>';
    writeAssignment(root, OTHER_SID, `desktop request\n## [2026-11-16] 需求\n${envelope}`, since + 100);
    expect(findDoubaoSessionForSubmit(envelope, since, [root])).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps an inaccessible account root visible so capture cannot guess ownership',
    () => {
      const root = makeSessionsRoot();
      const dataRoot = join(root, '..', '..', '..', '..');
      const peer = join(dataRoot, 'agent_mode', '200', 'workspace', '.sessions');
      const since = Date.now() - 1000;
      const envelope = '<session_id>bmx-first</session_id>\n<user_message>request</user_message>';
      writeAssignment(root, SID, envelope, since + 100);
      writeAssignment(peer, OTHER_SID, envelope, since + 200);
      const workspace = join(peer, '..');
      chmodSync(workspace, 0);
      try {
        expect(findDoubaoSessionForSubmit(envelope, since, doubaoSessionRoots(dataRoot))).toBeUndefined();
      } finally {
        chmodSync(workspace, 0o700);
      }
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses capture when a fresh peer assignment cannot be read',
    () => {
      const root = makeSessionsRoot();
      const since = Date.now() - 1000;
      const envelope = '<session_id>bmx-first</session_id>\n<user_message>request</user_message>';
      writeAssignment(root, SID, envelope, since + 100);
      const peer = writeAssignment(root, OTHER_SID, envelope, since + 200);
      chmodSync(peer, 0);
      try {
        expect(findDoubaoSessionForSubmit(envelope, since, [root])).toBeUndefined();
        expect(findDoubaoSessionForSubmit('request', since, [root])).toBeUndefined();
      } finally {
        chmodSync(peer, 0o600);
      }
    },
  );

  it('splits concurrent cold starts by session marker even when fingerprints collide', () => {
    // Two botmux sessions submit in the same poll window. Their envelopes share
    // a fixed routing suffix, so the legacy last-line fingerprint is identical;
    // only the embedded <session_id> tells the two native sessions apart.
    const root = makeSessionsRoot();
    const since = Date.now() - 1000;
    const envelopeA = ['<botmux_routing>', '<session_id>bmx-first</session_id>', '</botmux_routing>', '执行技能预检', '</botmux_skills_refresh>'].join('\n');
    const envelopeB = ['<botmux_routing>', '<session_id>bmx-second</session_id>', '</botmux_routing>', '执行技能预检', '</botmux_skills_refresh>'].join('\n');
    writeAssignment(root, SID, envelopeA, since + 100);
    writeAssignment(root, OTHER_SID, envelopeB, since + 200);
    expect(findDoubaoSessionForSubmit(envelopeA, since, [root])).toBe(SID);
    expect(findDoubaoSessionForSubmit(envelopeB, since, [root])).toBe(OTHER_SID);
  });

  it.each(['x'.repeat(9000), '前置说明'.repeat(1000)])(
    'captures concurrent sessions when a long routing prefix places the marker beyond 8 KiB',
    (prefix) => {
      const root = makeSessionsRoot();
      const since = Date.now() - 1000;
      const envelope = (id: string) => [
        `<botmux_routing>${prefix}</botmux_routing>`,
        `<session_id>${id}</session_id>`,
        '<user_message>执行技能预检</user_message>',
        '</botmux_skills_refresh>',
      ].join('\n');
      const envelopeA = envelope('bmx-first');
      const envelopeB = envelope('bmx-second');
      writeAssignment(root, SID, envelopeA, since + 100);
      writeAssignment(root, OTHER_SID, envelopeB, since + 200);

      expect(findDoubaoSessionForSubmit(envelopeA, since, [root])).toBe(SID);
      expect(findDoubaoSessionForSubmit(envelopeB, since, [root])).toBe(OTHER_SID);
    },
  );

  it('keeps a long-prefix marker discoverable at the head of a large resumed assignment', () => {
    const root = makeSessionsRoot();
    const since = Date.now() - 1000;
    const envelope = `<botmux_routing>${'说明'.repeat(2000)}</botmux_routing>\n<session_id>bmx-first</session_id>\n<user_message>执行技能预检</user_message>`;
    writeAssignment(root, SID, `${envelope}\n${'later history\n'.repeat(10_000)}`, since + 100);

    expect(findDoubaoSessionForSubmit(envelope, since, [root])).toBe(SID);
  });

  it('refuses ambiguous long-prefix markers rather than choosing a matching suffix', () => {
    const root = makeSessionsRoot();
    const since = Date.now() - 1000;
    const envelope = `<botmux_routing>${'x'.repeat(9000)}</botmux_routing>\n<session_id>bmx-first</session_id>\n<user_message>执行技能预检</user_message>`;
    writeAssignment(root, SID, envelope, since + 100);
    writeAssignment(root, OTHER_SID, envelope, since + 200);

    expect(findDoubaoSessionForSubmit(envelope, since, [root])).toBeUndefined();
  });

  it('does not capture a sibling whose long-prefix user payload quotes the requested marker', () => {
    const root = makeSessionsRoot();
    const since = Date.now() - 1000;
    const prefix = `<botmux_routing>${'x'.repeat(9000)}</botmux_routing>`;
    const envelope = `${prefix}\n<session_id>bmx-first</session_id>\n<user_message>执行技能预检</user_message>`;
    const sibling = `${prefix}\n<session_id>bmx-second</session_id>\n<user_message>引用：<session_id>bmx-first</session_id></user_message>`;
    writeAssignment(root, OTHER_SID, sibling, since + 100);

    expect(findDoubaoSessionForSubmit(envelope, since, [root])).toBeUndefined();
    writeAssignment(root, SID, envelope, since + 200);
    expect(findDoubaoSessionForSubmit(envelope, since, [root])).toBe(SID);
  });

  it('returns undefined while the matching assignment has not landed yet', () => {
    const root = makeSessionsRoot();
    const since = Date.now() - 1000;
    const envelopeA = '<session_id>bmx-first</session_id>\n</botmux_skills_refresh>';
    const envelopeB = '<session_id>bmx-second</session_id>\n</botmux_skills_refresh>';
    writeAssignment(root, SID, envelopeA, since + 100);
    writeAssignment(root, OTHER_SID, envelopeB, since + 100);
    // A third botmux session's native dir does not exist yet: fail closed and
    // let the poll retry rather than bind to a sibling conversation.
    expect(findDoubaoSessionForSubmit('<session_id>bmx-zzzz</session_id>\n</botmux_skills_refresh>', since, [root])).toBeUndefined();
  });

  it('does not match a marker on an assignment written before the submit', () => {
    const root = makeSessionsRoot();
    const now = Date.now();
    const envelope = '<session_id>bmx-first</session_id>\n</botmux_skills_refresh>';
    writeAssignment(root, SID, envelope, now - 60_000);
    expect(findDoubaoSessionForSubmit(envelope, now - 2000, [root])).toBeUndefined();
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

describe('doubao submit capture polling', () => {
  /** Fake clock: each sleep advances time; `find` sees the current time. */
  function fakeClock() {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => { t += ms; },
    };
  }

  it('still captures an id that appears 8s after submit (cold service start)', async () => {
    const clock = fakeClock();
    const sid = await pollDoubaoSessionForSubmit(
      () => (clock.now() >= 8_000 ? SID : undefined),
      clock,
    );
    expect(sid).toBe(SID);
  });

  it('returns immediately once the id is found instead of waiting out the budget', async () => {
    const clock = fakeClock();
    let calls = 0;
    const sid = await pollDoubaoSessionForSubmit(() => (++calls >= 3 ? SID : undefined), clock);
    expect(sid).toBe(SID);
    expect(clock.now()).toBeLessThan(1_000);
  });

  it('gives up after the budget so a turn without a record does not block forever', async () => {
    const clock = fakeClock();
    const sid = await pollDoubaoSessionForSubmit(() => undefined, clock);
    expect(sid).toBeUndefined();
    expect(clock.now()).toBeGreaterThanOrEqual(DOUBAO_SUBMIT_CAPTURE_BUDGET_MS);
    expect(clock.now()).toBeLessThan(DOUBAO_SUBMIT_CAPTURE_BUDGET_MS + 1_000);
  });

  it('finishes inside the bridge verification grace so a late id still binds the turn', () => {
    // The structured queue prunes the head once this grace lapses; the in-band
    // poll (plus the paste/Enter delay) has to end before that.
    expect(DOUBAO_SUBMIT_CAPTURE_BUDGET_MS + 1_000).toBeLessThan(STRUCTURED_SUBMIT_VERIFICATION_GRACE_MS);
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
