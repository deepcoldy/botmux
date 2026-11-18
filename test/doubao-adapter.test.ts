import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type ExecFileOpts = {
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  windowsHide?: boolean;
};
type ExecFileCall = { file: string; args: string[]; opts: ExecFileOpts };
type ExecFileHandler = (
  file: string,
  args: string[],
  opts: ExecFileOpts,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

const execFileCalls: ExecFileCall[] = [];
let execFileHandler: ExecFileHandler | null = null;

vi.mock('node:child_process', () => {
  const actual = require('node:child_process') as typeof import('node:child_process');
  return {
    ...actual,
    execFile: (...rawArgs: unknown[]) => {
      if (!execFileHandler) {
        return (actual.execFile as (...args: unknown[]) => unknown)(...rawArgs);
      }
      const [file, args, opts, cb] = rawArgs as [
        string,
        string[],
        ExecFileOpts,
        (err: Error | null, stdout: string, stderr: string) => void,
      ];
      execFileCalls.push({ file, args, opts });
      execFileHandler(file, args, opts, cb);
      return undefined;
    },
  };
});

import {
  DOUBAO_BUSY_FOOTER,
  DOUBAO_READY_PATTERN,
  createDoubaoAdapter,
  doubaoContentWithCaptureId,
  doubaoDataRoot,
  doubaoSessionExists,
  doubaoSessionMarkerFromContent,
  doubaoSessionRoots,
  findDoubaoSessionForSubmit as findDoubaoSessionForSubmitContent,
  parseDoubaoAvailableModels,
  parseDoubaoModelListJson,
  parseDoubaoVersion,
  pollDoubaoSessionForSubmit,
  DOUBAO_SUBMIT_CAPTURE_BUDGET_MS,
} from '../src/adapters/cli/doubao.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';
import { resolveDispatchLaunchSpec } from '../src/core/dispatch-launch-spec.js';
import { STRUCTURED_SUBMIT_VERIFICATION_GRACE_MS } from '../src/services/codex-bridge-queue.js';

const SID = '38450922917357570';
const OTHER_SID = '38450174181084930';

const tempDirs: string[] = [];
afterEach(() => {
  execFileCalls.length = 0;
  execFileHandler = null;
  vi.unstubAllEnvs();
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

function makeSessionsRootFromEnv(): string {
  const home = mkdtempSync(join(tmpdir(), 'doubao-home-'));
  tempDirs.push(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_DATA_HOME', join(home, '.local', 'share'));
  vi.stubEnv('LOCALAPPDATA', join(home, 'AppData', 'Local'));
  const dataRoot = doubaoDataRoot(process.env, process.platform)!;
  const root = join(dataRoot, 'agent_mode', '100', 'workspace', '.sessions');
  mkdirSync(root, { recursive: true });
  return root;
}

function correlateForTest(content: string): string {
  if (/^botmux_input_id: [0-9a-f]{32}[\t ]*\r?$/m.test(content)) return content;
  const marker = doubaoSessionMarkerFromContent(content);
  if (!marker) return content;
  const captureId = createHash('sha256').update(marker).digest('hex').slice(0, 32);
  return doubaoContentWithCaptureId(content, captureId);
}

function findDoubaoSessionForSubmit(
  content: string,
  sinceMs: number,
  roots?: readonly string[],
  windowBytes?: number,
): string | undefined {
  return findDoubaoSessionForSubmitContent(correlateForTest(content), sinceMs, roots, windowBytes);
}

/** Write an assignment.md the way doubao 2.31 appends a TUI turn. */
function writeAssignment(root: string, sid: string, prompt: string, mtimeMs = Date.now()): string {
  prompt = correlateForTest(prompt);
  const dir = join(root, sid, 'agents', 'm_test', 'system');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'assignment.md');
  writeFileSync(file, `# Assignment\n- Role: main\n\n## [2026-11-02T03:51:28Z] 需求\n${prompt}\n`);
  utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

function appendAssignment(root: string, sid: string, prompt: string, mtimeMs = Date.now()): string {
  prompt = correlateForTest(prompt);
  const dir = join(root, sid, 'agents', 'm_test', 'system');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'assignment.md');
  appendFileSync(file, `## [2026-11-02T03:52:28Z] 需求\n${prompt}\n`);
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

  it('adds a capture id only to enveloped submissions', () => {
    const captureId = 'a'.repeat(32);
    expect(doubaoContentWithCaptureId('plain zero-injection input', captureId)).toBe('plain zero-injection input');
    const envelope = '<session_id>bmx-first</session_id>\n<user_message>request</user_message>';
    const correlated = doubaoContentWithCaptureId(envelope, captureId);
    expect(doubaoSessionMarkerFromContent(correlated)).toBe('bmx-first');
    expect(correlated).toBe(`${envelope}\n\n<botmux_routing>\nbotmux_input_id: ${captureId}\n</botmux_routing>`);
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

  it('captures a correlated submission in a later assignment turn', () => {
    const root = makeSessionsRoot();
    const since = Date.now() - 1000;
    const envelope = '<session_id>bmx-first</session_id>\n<user_message>request</user_message>';
    writeAssignment(root, OTHER_SID, `desktop request\n## [2026-11-16] 需求\n${envelope}`, since + 100);
    // Launch-scoped correlation, unlike initial-head ownership, also covers
    // delayed recovery on a native assignment that already has earlier turns.
    expect(findDoubaoSessionForSubmit(envelope, since, [root])).toBe(OTHER_SID);
  });

  it('retains the largest launch read window for delayed recovery', () => {
    const root = makeSessionsRoot();
    const since = Date.now() - 1000;
    const captureId = 'c'.repeat(32);
    const first = doubaoContentWithCaptureId(
      `<botmux_routing>${'x'.repeat(9000)}</botmux_routing>\n<session_id>bmx-first</session_id>\n<user_message>first</user_message>`,
      captureId,
    );
    writeAssignment(root, SID, first, since + 100);
    const laterInput = doubaoContentWithCaptureId('<session_id>bmx-first</session_id>\n<user_message>short</user_message>', captureId);
    const launchWindow = Buffer.byteLength(first, 'utf-8') * 2 + 4096;

    expect(findDoubaoSessionForSubmitContent(laterInput, since, [root], launchWindow)).toBe(SID);
  });

  it('recovers an earlier delayed turn using the same launch capture id', () => {
    const root = makeSessionsRoot();
    const since = Date.now() - 1000;
    const captureId = 'b'.repeat(32);
    const first = doubaoContentWithCaptureId('<session_id>bmx-first</session_id>\n<user_message>first</user_message>', captureId);
    writeAssignment(root, SID, first, since + 100);
    const laterInput = doubaoContentWithCaptureId('<session_id>bmx-first</session_id>\n<user_message>second</user_message>', captureId);

    expect(findDoubaoSessionForSubmitContent(laterInput, since, [root])).toBe(SID);
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

  it('treats plain files in the account and session trees as absent, not as an incomplete inventory', () => {
    // Finder leaves `.DS_Store` in folders a user browses (docs point users at
    // this tree). A file where a directory belongs holds no session; it must
    // not make every future capture — in any session, however old — fail.
    const root = makeSessionsRoot();
    const dataRoot = join(root, '..', '..', '..', '..');
    const since = Date.now() - 1000;
    const envelope = '<session_id>bmx-first</session_id>\n<user_message>request</user_message>';
    writeAssignment(root, OTHER_SID, 'old desktop task', since - 86_400_000);
    writeAssignment(root, SID, envelope, since + 100);
    writeFileSync(join(dataRoot, 'agent_mode', '.DS_Store'), 'x');
    writeFileSync(join(root, OTHER_SID, 'agents', '.DS_Store'), 'x');
    writeFileSync(join(root, '38450922917350001'), 'x');

    const roots = doubaoSessionRoots(dataRoot);
    expect(roots).toEqual([root]);
    expect(findDoubaoSessionForSubmit(envelope, since, roots)).toBe(SID);
    expect(findDoubaoSessionForSubmit('request', since, roots)).toBe(SID);
    // Each site on its own: the account-level file reaches the scan only if
    // the root filter keeps it.
    expect(findDoubaoSessionForSubmit(envelope, since, [...roots, join(dataRoot, 'agent_mode', '.DS_Store', 'workspace', '.sessions')]))
      .toBe(SID);
  });

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

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps an unreadable session root indeterminate so a valid resume is not demoted',
    () => {
      const root = makeSessionsRoot();
      writeAssignment(root, SID, 'x');
      // Direct three-state contract: EACCES on the root means "cannot tell".
      chmodSync(root, 0);
      try {
        expect(doubaoSessionExists(SID, [root])).toBeUndefined();
      } finally {
        chmodSync(root, 0o700);
      }
      // A confirmed directory on any readable root still wins outright.
      const peer = makeSessionsRoot();
      writeAssignment(peer, SID, 'x');
      chmodSync(root, 0);
      try {
        expect(doubaoSessionExists(SID, [root, peer])).toBe(true);
        // Indeterminate must beat a definite miss on another root.
        expect(doubaoSessionExists(OTHER_SID, [root, peer])).toBeUndefined();
      } finally {
        chmodSync(root, 0o700);
      }
      // End-to-end through doubaoSessionRoots: an unreadable workspace keeps
      // the candidate root, and the resume probe stays indeterminate.
      const dataRoot = join(root, '..', '..', '..', '..');
      const workspace = join(dataRoot, 'agent_mode', '100', 'workspace');
      chmodSync(workspace, 0);
      try {
        const roots = doubaoSessionRoots(dataRoot);
        expect(roots).toHaveLength(1);
        expect(doubaoSessionExists(SID, roots)).toBeUndefined();
      } finally {
        chmodSync(workspace, 0o700);
      }
    },
  );
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
  it.each([false, true])('does not capture an unchanged generation for an identical replay (predicted reattach=%s)', async (reattach) => {
    const root = makeSessionsRootFromEnv();
    const envelope = '<session_id>bmx-first</session_id>\n<user_message>retry</user_message>\n</botmux_skills_refresh>';
    writeAssignment(root, SID, envelope);
    const adapter = createDoubaoAdapter('/bin/doubao');
    adapter.buildArgs({ sessionId: 'bmx-first', resume: false, reattach });
    const pty = fakeTmuxPty();

    const landed = new Promise<void>((resolve) => {
      setTimeout(() => {
        writeAssignment(root, OTHER_SID, pty.log[0]!.slice('paste:'.length));
        resolve();
      }, 500);
    });
    const result = await adapter.writeInput(pty, envelope);
    await landed;
    expect(result).toEqual({ submitted: true, cliSessionId: OTHER_SID });
  });

  it('rotates the capture id when another CLI generation starts', async () => {
    const root = makeSessionsRootFromEnv();
    const envelope = '<session_id>bmx-first</session_id>\n<user_message>identical replay</user_message>';
    const adapter = createDoubaoAdapter('/bin/doubao');
    const captureIds: string[] = [];

    for (const sid of [SID, OTHER_SID]) {
      adapter.buildArgs({ sessionId: 'bmx-first', resume: false });
      const pty = fakeTmuxPty();
      const landed = new Promise<void>((resolve) => {
        setTimeout(() => {
          writeAssignment(root, sid, pty.log[0]!.slice('paste:'.length));
          resolve();
        }, 500);
      });
      expect(await adapter.writeInput(pty, envelope)).toEqual({ submitted: true, cliSessionId: sid });
      await landed;
      captureIds.push(/^botmux_input_id: ([0-9a-f]{32})$/m.exec(pty.log[0]!)?.[1]!);
    }
    expect(captureIds[0]).not.toBe(captureIds[1]);
  });


  it('keeps the replacement launch armed when an older poll finishes', async () => {
    const root = makeSessionsRootFromEnv();
    const envelope = '<session_id>bmx-first</session_id>\n<user_message>identical replay</user_message>';
    const adapter = createDoubaoAdapter('/bin/doubao');
    adapter.buildArgs({ sessionId: 'bmx-first', resume: false });
    const ptyA = fakeTmuxPty();
    const landedA = new Promise<void>((resolve) => {
      setTimeout(() => {
        writeAssignment(root, SID, ptyA.log[0]!.slice('paste:'.length));
        resolve();
      }, 500);
    });
    const resultA = adapter.writeInput(ptyA, envelope);
    // Replace the launch while A is still awaiting its assignment/poll.
    adapter.buildArgs({ sessionId: 'bmx-first', resume: false });
    expect(await resultA).toEqual({ submitted: true, cliSessionId: SID });
    await landedA;

    const ptyB = fakeTmuxPty();
    const landedB = new Promise<void>((resolve) => {
      setTimeout(() => {
        writeAssignment(root, OTHER_SID, ptyB.log[0]!.slice('paste:'.length));
        resolve();
      }, 500);
    });
    expect(await adapter.writeInput(ptyB, envelope)).toEqual({ submitted: true, cliSessionId: OTHER_SID });
    await landedB;
    const idOf = (log: string[]) => /^botmux_input_id: ([0-9a-f]{32})$/m.exec(log[0]!)?.[1];
    expect(idOf(ptyB.log)).toBeDefined();
    expect(idOf(ptyB.log)).not.toBe(idOf(ptyA.log));
  });

  it('rejects a delayed old-generation append seen before the current assignment', async () => {
    const root = makeSessionsRootFromEnv();
    const envelope = '<session_id>bmx-first</session_id>\n<user_message>identical replay</user_message>';
    writeAssignment(root, SID, 'old history');
    const adapter = createDoubaoAdapter('/bin/doubao');
    adapter.buildArgs({ sessionId: 'bmx-first', resume: false });
    const pty = fakeTmuxPty();
    const oldLanded = new Promise<void>((resolve) => {
      setTimeout(() => {
        appendAssignment(root, SID, envelope);
        resolve();
      }, 400);
    });
    const currentLanded = new Promise<void>((resolve) => {
      setTimeout(() => {
        writeAssignment(root, OTHER_SID, pty.log[0]!.slice('paste:'.length));
        resolve();
      }, 700);
    });

    const result = await adapter.writeInput(pty, envelope);
    await Promise.all([oldLanded, currentLanded]);
    expect(result).toEqual({ submitted: true, cliSessionId: OTHER_SID });
  });

  it('captures an appended reattach turn without reviving an unchanged generation', async () => {
    const root = makeSessionsRootFromEnv();
    const stale = '<session_id>bmx-first</session_id>\n<user_message>first attempt</user_message>';
    const current = '<session_id>bmx-first</session_id>\n<user_message>different retry</user_message>';
    writeAssignment(root, SID, stale);
    writeAssignment(root, OTHER_SID, 'desktop history without an ownership marker');
    const adapter = createDoubaoAdapter('/bin/doubao');
    adapter.buildArgs({ sessionId: 'bmx-first', resume: false, reattach: true });
    const pty = fakeTmuxPty();

    const landed = new Promise<void>((resolve) => {
      setTimeout(() => {
        appendAssignment(root, OTHER_SID, pty.log[0]!.slice('paste:'.length));
        resolve();
      }, 500);
    });
    const result = await adapter.writeInput(pty, current);
    await landed;
    expect(result).toEqual({ submitted: true, cliSessionId: OTHER_SID });
  });

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

  it('parses semver triples from doubao --version output', () => {
    expect(parseDoubaoVersion('doubao 2.37.1\n')).toEqual([2, 37, 1]);
    expect(parseDoubaoVersion('doubao 2.36.2')).toEqual([2, 36, 2]);
    expect(parseDoubaoVersion('\u001b[32mv2.37.1\u001b[0m')).toEqual([2, 37, 1]);
    expect(parseDoubaoVersion('doubao 2.37.1-rc.1')).toEqual([2, 37, 1]);
    expect(parseDoubaoVersion('')).toBeNull();
    expect(parseDoubaoVersion('doubao unknown')).toBeNull();
    expect(parseDoubaoVersion('doubao 1.2.3.4')).toBeNull();
  });

  it('parses doubao model list --json output, preferring model IDs and deduplicating in order', () => {
    const payload = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: {
        type: 'model_list',
        models: [
          { id: ' 9 ', name: ' Auto ', is_default: false },
          { id: 'seed-lite-7b', name: '豆包 2.1 Lite', is_default: false },
          { id: '  ', name: 'UniqueFallback' },
          { id: '9', name: 'Auto duplicate id' },
          { id: '5262373378', name: 'GPT 6.1 Sol' },
        ],
      },
    });
    expect(parseDoubaoModelListJson(payload)).toEqual(['9', 'seed-lite-7b', 'UniqueFallback', '5262373378']);
    expect(parseDoubaoModelListJson(JSON.stringify({
      is_error: false,
      result: {
        models: [
          { name: 'Shared name' },
          { name: 'Shared name' },
        ],
      },
    }))).toBeNull();
    expect(parseDoubaoModelListJson(JSON.stringify({
      is_error: false,
      result: {
        models: [
          { name: 'Shared name' },
          { id: 'model-b', name: 'Shared name' },
        ],
      },
    }))).toEqual(['model-b']);
    expect(parseDoubaoModelListJson(JSON.stringify({
      is_error: false,
      result: {
        models: [
          { name: 'model-b' },
          { id: 'model-b', name: 'Other' },
        ],
      },
    }))).toEqual(['model-b']);
    expect(parseDoubaoModelListJson('not json')).toBeNull();
    expect(parseDoubaoModelListJson(JSON.stringify({ is_error: true, result: { models: [{ id: '9', name: 'Auto' }] } }))).toBeNull();
    expect(parseDoubaoModelListJson(JSON.stringify({ is_error: false, result: {} }))).toBeNull();
    expect(parseDoubaoModelListJson(JSON.stringify({ is_error: false, result: { models: [] } }))).toBeNull();
    expect(parseDoubaoModelListJson(JSON.stringify({ is_error: false, result: { models: [{ name: '  ' }, { id: '   ', name: '' }] } }))).toBeNull();
  });

  it('keeps distinct model IDs launchable when multiple entries share the same display name', async () => {
    execFileHandler = (_file, args, _opts, cb) => {
      if (args[0] === '--version') {
        cb(null, 'doubao 2.37.1\n', '');
        return;
      }
      cb(null, JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: {
          type: 'model_list',
          models: [
            { id: 'model-a', name: 'Shared name' },
            { id: 'model-b', name: 'Shared name' },
          ],
        },
      }), '');
    };
    const adapter = createDoubaoAdapter('/bin/doubao');
    const models = await adapter.detectModels!();
    expect(models).toEqual(['model-a', 'model-b']);
    expect(models!.map(model => adapter.buildArgs({ sessionId: 's', resume: false, disableCliBypass: true, model }))).toEqual([
      ['--model', 'model-a'],
      ['--model', 'model-b'],
    ]);
    await expect(resolveDispatchLaunchSpec({
      requested: { model: 'model-a' },
      target: { cliId: 'doubao' },
      detectModels: () => adapter.detectModels!(),
    })).resolves.toEqual({
      ok: true,
      requested: { model: 'model-a' },
      effective: { model: 'model-a' },
    });
    await expect(resolveDispatchLaunchSpec({
      requested: { model: 'model-b' },
      target: { cliId: 'doubao' },
      detectModels: () => adapter.detectModels!(),
    })).resolves.toEqual({
      ok: true,
      requested: { model: 'model-b' },
      effective: { model: 'model-b' },
    });
    await expect(resolveDispatchLaunchSpec({
      requested: { model: 'Shared name' },
      target: { cliId: 'doubao' },
      detectModels: () => adapter.detectModels!(),
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('实时 model catalog') });
  });

  it('does not spawn a subprocess on adapter construction or buildArgs', () => {
    execFileHandler = (_file, _args, _opts, cb) => cb(null, '', '');
    const adapter = createDoubaoAdapter('/bin/doubao');
    adapter.buildArgs({ sessionId: 's', resume: false });
    expect(execFileCalls).toEqual([]);
  });

  it('uses `model list --json` on doubao >= 2.37.1, ignoring stderr logs and preserving env/order', async () => {
    const catalogJson = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: {
        type: 'model_list',
        models: [
          { id: '9', name: 'Auto', is_default: false },
          { id: 'seed-lite-7b', name: '豆包 2.1 Lite', is_default: false },
          { id: '5', name: 'Doubao 2.1 Pro', is_default: false },
          { id: '5', name: 'Doubao 2.1 Pro', is_default: false },
        ],
      },
    });
    execFileHandler = (_file, args, _opts, cb) => {
      if (args[0] === '--version') {
        cb(null, 'doubao 2.37.1\n', '');
        return;
      }
      cb(
        null,
        `${catalogJson}\n`,
        '[cli-chat] {"level":"info","eventName":"cli_task_started"}\n',
      );
    };

    const customEnv = Object.freeze({ PATH: '/usr/bin', DOUBAO_CLI_NO_UPDATE_CHECK: '0' });
    let fakeNow = 10_000;
    const { detectModels } = createDoubaoAdapter('/bin/doubao', { now: () => fakeNow });
    await expect(detectModels!({ env: customEnv })).resolves.toEqual([
      '9',
      'seed-lite-7b',
      '5',
    ]);
    expect(execFileCalls.map(c => ({ file: c.file, args: c.args }))).toEqual([
      { file: '/bin/doubao', args: ['--version'] },
      { file: '/bin/doubao', args: ['model', 'list', '--json'] },
    ]);
    for (const call of execFileCalls) {
      expect(call.opts.timeout).toBe(10_000);
      expect(call.opts.env?.DOUBAO_CLI_NO_UPDATE_CHECK).toBe('1');
    }
    expect(customEnv.DOUBAO_CLI_NO_UPDATE_CHECK).toBe('0');
  });

  it('shares a single 10s deadline across --version and the follow-up probe', async () => {
    let fakeNow = 1_000;
    execFileHandler = (_file, args, _opts, cb) => {
      if (args[0] === '--version') {
        fakeNow += 6_000;
        cb(null, 'doubao 2.37.1\n', '');
        return;
      }
      cb(null, JSON.stringify({ is_error: false, result: { models: [{ id: 'model-a', name: 'Auto' }] } }), '');
    };
    const modern = createDoubaoAdapter('/bin/doubao', { now: () => fakeNow });
    await expect(modern.detectModels!()).resolves.toEqual(['model-a']);
    expect(execFileCalls.map(c => c.opts.timeout)).toEqual([10_000, 4_000]);

    execFileCalls.length = 0;
    fakeNow = 5_000;
    execFileHandler = (_file, args, _opts, cb) => {
      if (args[0] === '--version') {
        fakeNow += 6_500;
        cb(null, 'doubao 2.36.2\n', '');
        return;
      }
      cb(
        new Error('Command failed with exit code 1'),
        '',
        'Error: Unsupported --model value. Available models: Auto, Doubao 2.1 Pro. Start doubao without --model and use /model to view available models.',
      );
    };
    const legacy = createDoubaoAdapter('/bin/doubao', { now: () => fakeNow });
    await expect(legacy.detectModels!()).resolves.toEqual(['Auto', 'Doubao 2.1 Pro']);
    expect(execFileCalls.map(c => c.opts.timeout)).toEqual([10_000, 3_500]);

    execFileCalls.length = 0;
    fakeNow = 20_000;
    execFileHandler = (_file, args, _opts, cb) => {
      if (args[0] === '--version') {
        fakeNow += 10_000;
        cb(null, 'doubao 2.37.1\n', '');
        return;
      }
      cb(null, JSON.stringify({ is_error: false, result: { models: [{ id: 'model-a', name: 'Auto' }] } }), '');
    };
    const exhausted = createDoubaoAdapter('/bin/doubao', { now: () => fakeNow });
    await expect(exhausted.detectModels!()).resolves.toBeNull();
    expect(execFileCalls.map(c => c.args)).toEqual([['--version']]);
  });

  it.each(['doubao 2.38.0', 'doubao 3.0.0'])('routes newer %s to `model list --json`', async (versionLine) => {
    execFileHandler = (_file, args, _opts, cb) => {
      if (args[0] === '--version') {
        cb(null, versionLine, '');
        return;
      }
      cb(null, JSON.stringify({ is_error: false, result: { models: [{ id: '9', name: 'Auto' }] } }), '');
    };
    const adapter = createDoubaoAdapter('/bin/doubao');
    await expect(adapter.detectModels!()).resolves.toEqual(['9']);
    expect(execFileCalls.map(c => c.args)).toEqual([['--version'], ['model', 'list', '--json']]);
  });

  it.each(['doubao 2.36.2', 'doubao 2.37.0'])('keeps the legacy --model probe on %s (< 2.37.1)', async (versionLine) => {
    execFileHandler = (_file, args, _opts, cb) => {
      if (args[0] === '--version') {
        cb(null, `${versionLine}\n`, '');
        return;
      }
      cb(
        new Error('Command failed with exit code 1'),
        '',
        'Error: Unsupported --model value. Available models: Auto, Doubao 2.1 Pro. Start doubao without --model and use /model to view available models.',
      );
    };
    const adapter = createDoubaoAdapter('/bin/doubao');
    await expect(adapter.detectModels!()).resolves.toEqual(['Auto', 'Doubao 2.1 Pro']);
    expect(execFileCalls.map(c => c.args)).toEqual([
      ['--version'],
      ['--model', '__botmux_model_probe__', '-p', 'probe'],
    ]);
    expect(execFileCalls[1]!.opts.timeout).toBeGreaterThan(0);
    expect(execFileCalls[1]!.opts.timeout).toBeLessThanOrEqual(10_000);
    expect(execFileCalls[1]!.opts.env?.DOUBAO_CLI_NO_UPDATE_CHECK).toBe('1');
  });

  it('returns null when legacy < 2.37.1 probe prints an unparseable error', async () => {
    execFileHandler = (_file, args, _opts, cb) => {
      if (args[0] === '--version') cb(null, 'doubao 2.36.2', '');
      else cb(new Error('exit 1'), '', 'Error: not logged in');
    };
    const adapter = createDoubaoAdapter('/bin/doubao');
    await expect(adapter.detectModels!()).resolves.toBeNull();
  });

  it('returns null without running model discovery when --version fails or is unparseable', async () => {
    execFileHandler = (_file, _args, _opts, cb) => cb(new Error('spawn ENOENT'), '', '');
    const adapter = createDoubaoAdapter('/bin/doubao');
    await expect(adapter.detectModels!()).resolves.toBeNull();
    expect(execFileCalls).toHaveLength(1);

    execFileCalls.length = 0;
    execFileHandler = () => { throw new Error('sync exec error'); };
    await expect(adapter.detectModels!()).resolves.toBeNull();
    expect(execFileCalls).toHaveLength(1);

    execFileCalls.length = 0;
    execFileHandler = (_file, _args, _opts, cb) => cb(null, 'doubao unknown version', '');
    await expect(adapter.detectModels!()).resolves.toBeNull();
    expect(execFileCalls).toHaveLength(1);
  });

  it.each([
    ['command error', new Error('exit 2'), JSON.stringify({ is_error: false, result: { models: [{ id: '9', name: 'Auto' }] } })],
    ['malformed JSON', null, '{not-json'],
    ['is_error envelope', null, JSON.stringify({ is_error: true, result: { models: [{ id: '9', name: 'Auto' }] } })],
    ['empty models list', null, JSON.stringify({ is_error: false, result: { models: [] } })],
  ])('returns null on 2.37.1 `model list --json` failure (%s)', async (_label, listErr, listStdout) => {
    execFileHandler = (_file, args, _opts, cb) => {
      if (args[0] === '--version') cb(null, 'doubao 2.37.1', '');
      else cb(listErr, listStdout, '');
    };
    const adapter = createDoubaoAdapter('/bin/doubao');
    await expect(adapter.detectModels!()).resolves.toBeNull();
  });
});
