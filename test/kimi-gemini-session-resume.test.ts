import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findKimiSessionForBotmuxSession } from '../src/adapters/cli/kimi-session.js';
import { findGeminiSessionFile } from '../src/adapters/cli/gemini-session.js';
import { createKimiAdapter } from '../src/adapters/cli/kimi.js';
import { createGeminiAdapter } from '../src/adapters/cli/gemini.js';

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
const tmp = () => (root = mkdtempSync(join(tmpdir(), 'resume-probe-')));

const BOTMUX = '4c0a8f9e-1b2d-4e3f-8a5b-6c7d8e9f0a1b';

/** Kimi 0.31 layout: session_index.jsonl + sessions/<wd_…>/<id>/agents/main/wire.jsonl. */
function kimiSession(home: string, id: string, workDir: string, wireText: string) {
  const dir = join(home, 'sessions', 'wd_work_0123456789ab', id);
  mkdirSync(join(dir, 'agents', 'main'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'main', 'wire.jsonl'),
    JSON.stringify({ type: 'metadata', protocol_version: '1.4' }) + '\n'
    + JSON.stringify({ type: 'user', content: wireText }) + '\n');
  writeFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ sessionId: id, sessionDir: dir, workDir }) + '\n', { flag: 'a' });
}

describe('Kimi: the Kimi session of a botmux session', () => {
  it('is the newest session in this working dir whose prompt carries the botmux session id', () => {
    const home = tmp();
    const work = join(home, 'work');
    mkdirSync(work);
    const env = { KIMI_CODE_HOME: home };
    kimiSession(home, 'session_aaaa', work, `<session_id>${BOTMUX}</session_id>\nfirst`);
    kimiSession(home, 'session_bbbb', work, '<session_id>someone-else</session_id>\nsibling');
    kimiSession(home, 'session_cccc', work, `<session_id>${BOTMUX}</session_id>\nafter a fresh restart`);
    kimiSession(home, 'session_dddd', join(home, 'elsewhere'), `<session_id>${BOTMUX}</session_id>\nother dir`);
    expect(findKimiSessionForBotmuxSession(BOTMUX, work, env)).toBe('session_cccc');
    // A sibling session is never picked, however recent.
    expect(findKimiSessionForBotmuxSession('someone-else', work, env)).toBe('session_bbbb');
    expect(findKimiSessionForBotmuxSession('nobody', work, env)).toBeUndefined();
  });

  it('skips deleted sessions and index entries pointing outside Kimi\'s sessions dir', () => {
    const home = tmp();
    const work = join(home, 'work');
    mkdirSync(work);
    const env = { KIMI_CODE_HOME: home };
    kimiSession(home, 'session_aaaa', work, `<session_id>${BOTMUX}</session_id>`);
    writeFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ sessionId: 'session_aaaa', deleted: true }) + '\n', { flag: 'a' });
    expect(findKimiSessionForBotmuxSession(BOTMUX, work, env)).toBeUndefined();
    const outside = join(home, 'outside', 'session_eeee');
    mkdirSync(join(outside, 'agents', 'main'), { recursive: true });
    writeFileSync(join(outside, 'agents', 'main', 'wire.jsonl'), `<session_id>${BOTMUX}</session_id>`);
    writeFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ sessionId: 'session_eeee', sessionDir: outside, workDir: work }) + '\n', { flag: 'a' });
    expect(findKimiSessionForBotmuxSession(BOTMUX, work, env)).toBeUndefined();
  });

  it('the adapter resumes it with --session and starts fresh when there is none', () => {
    const home = tmp();
    const work = join(home, 'work');
    mkdirSync(work);
    kimiSession(home, 'session_aaaa', work, `<session_id>${BOTMUX}</session_id>`);
    const adapter = createKimiAdapter('/usr/bin/kimi');
    const env = { KIMI_CODE_HOME: home };
    expect(adapter.buildArgs({ sessionId: BOTMUX, resume: true, workingDir: work, env })).toEqual(['--yolo', '--session', 'session_aaaa']);
    expect(adapter.buildArgs({ sessionId: 'other', resume: true, workingDir: work, env })).toEqual(['--yolo']);
    expect(adapter.buildArgs({ sessionId: BOTMUX, resume: false, workingDir: work, env })).toEqual(['--yolo']);
  });
});

/** Gemini 0.66 layout: projects.json maps the dir to a short name; chats/session-<t>-<id8>.jsonl. */
function geminiSession(gHome: string, workDir: string, id: string, rows: object[]) {
  const g = join(gHome, '.gemini');
  mkdirSync(join(g, 'tmp', 'work', 'chats'), { recursive: true });
  writeFileSync(join(g, 'projects.json'), JSON.stringify({ projects: { [workDir]: 'work' } }));
  writeFileSync(join(g, 'tmp', 'work', 'chats', `session-2026-10-30T00-00-${id.slice(0, 8)}.jsonl`),
    [{ sessionId: id, projectHash: 'x', startTime: '2026-10-30T00:00:00Z', kind: 'main' }, ...rows].map(r => JSON.stringify(r)).join('\n') + '\n');
}

describe('Gemini: resume by the botmux session id', () => {
  it('finds the session file only for its own project, and only resumable with a user message', () => {
    const home = tmp();
    const work = join(home, 'work');
    mkdirSync(work);
    const env = { GEMINI_CLI_HOME: home };
    geminiSession(home, work, BOTMUX, [{ type: 'info', content: 'MCP issues detected' }]);
    expect(findGeminiSessionFile(BOTMUX, work, env)).toMatchObject({ resumable: false });
    // What Gemini writes before the first prompt lands, and what it ignores
    // when deciding a session is resumable (0.66 isIgnoredUserContent).
    for (const text of ['<session_context>\nThis is the Gemini CLI.', '<hook_context>x', '/help', '?', '   ']) {
      geminiSession(home, work, BOTMUX, [{ type: 'user', content: [{ text }] }]);
      expect(findGeminiSessionFile(BOTMUX, work, env), text).toMatchObject({ resumable: false });
    }
    geminiSession(home, work, BOTMUX, [{ type: 'user', content: [{ text: '<session_context>x' }] }, { type: 'gemini', content: '', toolCalls: [{ id: 't' }] }]);
    expect(findGeminiSessionFile(BOTMUX, work, env)).toMatchObject({ resumable: true });
    geminiSession(home, work, BOTMUX, [{ type: 'user', content: [{ text: 'hello' }] }]);
    expect(findGeminiSessionFile(BOTMUX, work, env)).toMatchObject({ resumable: true });
    expect(findGeminiSessionFile(BOTMUX, join(home, 'elsewhere'), env)).toBeUndefined();
    expect(findGeminiSessionFile('4c0a8f9e-0000-4000-8000-000000000000', work, env)).toBeUndefined();
  });

  it('the adapter names a new session, resumes a resumable one, and never passes an id Gemini would reject', () => {
    const home = tmp();
    const work = join(home, 'work');
    mkdirSync(work);
    const adapter = createGeminiAdapter('/usr/bin/gemini');
    const env = { GEMINI_CLI_HOME: home };
    const args = (resume: boolean) => adapter.buildArgs({ sessionId: BOTMUX, resume, workingDir: work, env });
    // No file yet: the session is started under the botmux id.
    expect(args(false)).toEqual(['--yolo', '--session-id', BOTMUX]);
    expect(args(true)).toEqual(['--yolo', '--session-id', BOTMUX]);
    // A file without a user message: neither flag (--session-id would exit 42 "already exists").
    geminiSession(home, work, BOTMUX, [{ type: 'info', content: 'x' }]);
    expect(args(true)).toEqual(['--yolo']);
    // Resumable: --resume on restart; a fresh spawn of the same id still avoids --session-id.
    geminiSession(home, work, BOTMUX, [{ type: 'user', content: [{ text: 'hello' }] }]);
    expect(args(true)).toEqual(['--yolo', '--resume', BOTMUX]);
    expect(args(false)).toEqual(['--yolo']);
    // The pre-resume probe reads the same per-bot home the CLI will use.
    expect(adapter.checkResumeTargetExists?.({ sessionId: BOTMUX, workingDir: work, env })).toBe(true);
    expect(createKimiAdapter('/usr/bin/kimi').checkResumeTargetExists?.({ sessionId: BOTMUX, workingDir: work, env: { KIMI_CODE_HOME: join(home, 'none') } })).toBe(false);
    // Not a UUID (Gemini only accepts UUIDs): untouched.
    expect(adapter.buildArgs({ sessionId: 'not-a-uuid', resume: true, workingDir: work, env })).toEqual(['--yolo']);
  });
});
