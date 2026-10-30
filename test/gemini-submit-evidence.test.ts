import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  snapGeminiSubmitBaseline,
  findGeminiPromptSubmission,
} from '../src/adapters/cli/gemini-session.js';

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
const tmp = () => (root = mkdtempSync(join(tmpdir(), 'gemini-submit-')));

/** Build a .gemini tmp project with one chat session file (live-table jsonl). */
function geminiHome(home: string, project = 'proj') {
  const chats = join(home, '.gemini', 'tmp', project, 'chats');
  mkdirSync(chats, { recursive: true });
  writeFileSync(join(home, '.gemini', 'projects.json'), JSON.stringify({ projects: {} }));
  return { home, chats };
}

const SID = '11111111-2222-3333-4444-555555555555';
const MARKER = 'ACK-e2e-gemini-1793300000001';
const PROMPT = `<routing>做这件事</routing>请立刻调用 botmux send 回复 "${MARKER}"，原样复制。`;

/** A jsonl whose LIVE table ends with the given user record (a real row). */
function sessionWithUser(text: string, type = 'user'): string {
  const rows = [
    { sessionId: SID },
    { id: 'r1', type, content: text },
  ];
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

const setOld = (p: string) => utimesSync(p, (Date.now() / 1000) - 1000, (Date.now() / 1000) - 1000);

describe('gemini first-prompt submit evidence', () => {
  it('baseline is null when .gemini is unreadable, 0 when empty', () => {
    const { home } = geminiHome(tmp());
    expect(snapGeminiSubmitBaseline({ GEMINI_CLI_HOME: join(home, "missing") })).toBeNull();
    expect(snapGeminiSubmitBaseline({ GEMINI_CLI_HOME: home })).toBe(0);
  });

  it('finds a submitted resumable user row matching the ACK marker, returns the gemini session id', () => {
    const { home, chats } = geminiHome(tmp());
    const baseline = snapGeminiSubmitBaseline({ GEMINI_CLI_HOME: home });
    const file = join(chats, `session-1700000000000-${SID.slice(0, 8)}.jsonl`);
    writeFileSync(file, sessionWithUser(PROMPT));
    const result = findGeminiPromptSubmission(baseline, PROMPT, { GEMINI_CLI_HOME: home });
    expect(result.submitted).toBe(true);
    expect(result.cliSessionId).toBe(SID);
    expect(result.unreadable).toBeUndefined();
  });

  it('matches on the ACK marker even when the stored text is a substring of the envelope', () => {
    const { home, chats } = geminiHome(tmp());
    const baseline = snapGeminiSubmitBaseline({ GEMINI_CLI_HOME: home });
    writeFileSync(join(chats, `session-x-${SID.slice(0, 8)}.jsonl`), sessionWithUser(`前缀 ${MARKER} 后缀`));
    expect(findGeminiPromptSubmission(baseline, PROMPT, { GEMINI_CLI_HOME: home }).submitted).toBe(true);
  });

  it('does not match ignored/empty user content or model rows (not resumable-as-user)', () => {
    const { home, chats } = geminiHome(tmp());
    const baseline = snapGeminiSubmitBaseline({ GEMINI_CLI_HOME: home });
    writeFileSync(join(chats, `session-x-${SID.slice(0, 8)}.jsonl`),
      sessionWithUser('<session_context>x</session_context>'));
    expect(findGeminiPromptSubmission(baseline, PROMPT, { GEMINI_CLI_HOME: home }).submitted).toBe(false);
  });

  it('ignores files older than the baseline (avoids matching a previous turn)', () => {
    const { home, chats } = geminiHome(tmp());
    const file = join(chats, `session-x-${SID.slice(0, 8)}.jsonl`);
    writeFileSync(file, sessionWithUser(PROMPT));
    setOld(file);
    const baseline = Date.now();
    expect(findGeminiPromptSubmission(baseline, PROMPT, { GEMINI_CLI_HOME: home }).submitted).toBe(false);
  });

  it('returns unreadable=true when nothing newer than baseline exists yet (store not flushed)', () => {
    const { home } = geminiHome(tmp());
    const baseline = snapGeminiSubmitBaseline({ GEMINI_CLI_HOME: home });
    const result = findGeminiPromptSubmission(baseline, PROMPT, { GEMINI_CLI_HOME: home });
    expect(result.submitted).toBe(false);
    expect(result.unreadable).toBe(true);
  });

  it('authoritatively reports absent when a newer readable file has no matching row', () => {
    const { home, chats } = geminiHome(tmp());
    const baseline = snapGeminiSubmitBaseline({ GEMINI_CLI_HOME: home });
    // Newer file, but with an unrelated prompt → readable and checked, no match.
    writeFileSync(join(chats, `session-x-${SID.slice(0, 8)}.jsonl`),
      sessionWithUser('some completely different message without the marker'));
    const result = findGeminiPromptSubmission(baseline, PROMPT, { GEMINI_CLI_HOME: home });
    expect(result.submitted).toBe(false);
    expect(result.unreadable).toBeUndefined();
  });
});
