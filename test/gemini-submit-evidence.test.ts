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
const FILE = (chats: string) => join(chats, `session-1700000000000-${SID.slice(0, 8)}.jsonl`);

/** jsonl with given live rows (each [type, content]). */
function session(rows: Array<[string, string]>): string {
  const lines: unknown[] = [{ sessionId: SID }];
  rows.forEach(([type, content], i) => lines.push({ id: `r${i + 1}`, type, content }));
  return lines.map((r) => JSON.stringify(r)).join('\n') + '\n';
}
/** Metadata-only start file (what `gemini --session-id` writes before the turn). */
const metaOnly = () => session([]);
const userRow = (text: string) => session([['user', text]]);
const modelThenUser = (modelText: string, userText: string) =>
  session([['gemini', modelText], ['user', userText]]);

const setOld = (p: string) => utimesSync(p, (Date.now() / 1000) - 1000, (Date.now() / 1000) - 1000);
const envFor = (home: string) => ({ GEMINI_CLI_HOME: home });

describe('gemini first-prompt submit evidence', () => {
  it('baseline is null when .gemini/tmp is unreadable, 0 when empty', () => {
    const { home } = geminiHome(tmp());
    expect(snapGeminiSubmitBaseline({ GEMINI_CLI_HOME: join(home, 'missing') })).toBeNull();
    expect(snapGeminiSubmitBaseline(envFor(home))).toBe(0);
  });

  it('finds a submitted resumable user row matching the ACK marker, returns the gemini session id', () => {
    const { home, chats } = geminiHome(tmp());
    const baseline = snapGeminiSubmitBaseline(envFor(home));
    writeFileSync(FILE(chats), userRow(PROMPT));
    const result = findGeminiPromptSubmission(baseline, PROMPT, envFor(home));
    expect(result).toMatchObject({ submitted: true, cliSessionId: SID });
    expect(result.unreadable).toBeUndefined();
  });

  it('matches the ACK marker even when the stored row carries a prefix/suffix', () => {
    const { home, chats } = geminiHome(tmp());
    const baseline = snapGeminiSubmitBaseline(envFor(home));
    writeFileSync(FILE(chats), userRow(`前缀 ${MARKER} 后缀`));
    expect(findGeminiPromptSubmission(baseline, PROMPT, envFor(home)).submitted).toBe(true);
  });

  it('P1-A: a short OLD user row contained in the new prompt is NOT a submit (resume false positive)', () => {
    // Resumed session already has "继续"; new prompt contains that substring but
    // never landed. With only a model row present, absence must be authoritative
    // — but here the stale short row is itself the user row and carries no marker.
    const { home, chats } = geminiHome(tmp());
    const baseline = snapGeminiSubmitBaseline(envFor(home));
    // Old short user row + a fresh model row (the turn ran on something else).
    writeFileSync(FILE(chats), modelThenUser('回复了', '继续'));
    const result = findGeminiPromptSubmission(
      baseline,
      `继续之前的任务 请立刻调用 botmux send 回复 "${MARKER}"`,
      envFor(home),
    );
    expect(result.submitted).toBe(false); // not "true" via expected.includes("继续")
  });

  it('P1-A: a prompt without an ACK marker yields unreadable (never guess)', () => {
    const { home, chats } = geminiHome(tmp());
    const baseline = snapGeminiSubmitBaseline(envFor(home));
    writeFileSync(FILE(chats), userRow('好的'));
    expect(findGeminiPromptSubmission(baseline, '好的', envFor(home)).unreadable).toBe(true);
  });

  it('P1-B: a metadata-only start file is NOT authoritative absence (user row may still flush)', () => {
    const { home, chats } = geminiHome(tmp());
    const baseline = snapGeminiSubmitBaseline(envFor(home));
    writeFileSync(FILE(chats), metaOnly());
    const result = findGeminiPromptSubmission(baseline, PROMPT, envFor(home));
    expect(result.submitted).toBe(false);
    expect(result.unreadable).toBe(true);
  });

  it('P1-B: a resumable MODEL row without the matching user row IS authoritative absence', () => {
    const { home, chats } = geminiHome(tmp());
    const baseline = snapGeminiSubmitBaseline(envFor(home));
    // Turn ran (model output present) but our prompt is absent from the table.
    writeFileSync(FILE(chats), modelThenUser('已完成其它任务', '其它消息'));
    const result = findGeminiPromptSubmission(baseline, PROMPT, envFor(home));
    expect(result.submitted).toBe(false);
    expect(result.unreadable).toBeUndefined();
  });

  it('ignored/empty user content does not count as the submitted prompt', () => {
    const { home, chats } = geminiHome(tmp());
    const baseline = snapGeminiSubmitBaseline(envFor(home));
    writeFileSync(FILE(chats), userRow('<session_context>x</session_context>'));
    expect(findGeminiPromptSubmission(baseline, PROMPT, envFor(home)).unreadable).toBe(true);
  });

  it('ignores files older than the baseline (a previous turn)', () => {
    const { home, chats } = geminiHome(tmp());
    const file = FILE(chats);
    writeFileSync(file, userRow(PROMPT));
    setOld(file);
    const baseline = Date.now();
    expect(findGeminiPromptSubmission(baseline, PROMPT, envFor(home)).unreadable).toBe(true);
  });

  it('returns unreadable when no file newer than baseline exists yet (store not flushed)', () => {
    const { home } = geminiHome(tmp());
    const baseline = snapGeminiSubmitBaseline(envFor(home));
    const result = findGeminiPromptSubmission(baseline, PROMPT, envFor(home));
    expect(result.submitted).toBe(false);
    expect(result.unreadable).toBe(true);
  });
});
