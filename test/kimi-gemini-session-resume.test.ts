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
    expect(adapter.buildArgs({ sessionId: BOTMUX, resume: true, workingDir: work, env })).toEqual(['--auto', '--session', 'session_aaaa']);
    expect(adapter.buildArgs({ sessionId: 'other', resume: true, workingDir: work, env })).toEqual(['--auto']);
    expect(adapter.buildArgs({ sessionId: BOTMUX, resume: false, workingDir: work, env })).toEqual(['--auto']);
  });
});

/** Gemini 0.66 layout: projects.json maps the dir to a short name; chats/session-<t>-<id8>.jsonl. */
const STAMP = '2026-10-30T00:00:00Z';
function geminiSession(gHome: string, workDir: string, id: string, rows: object[]) {
  const g = join(gHome, '.gemini');
  mkdirSync(join(g, 'tmp', 'work', 'chats'), { recursive: true });
  writeFileSync(join(g, 'projects.json'), JSON.stringify({ projects: { [workDir]: 'work' } }));
  // Real 0.66 message rows all carry an id (1574/1574 rows in the host corpus)
  // and the replay indexes by it; $rewindTo / $set / $patch control records
  // carry no id. Stamp plain message rows, leave control records untouched.
  const stamped = rows.map((row, i) => {
    const o = row as Record<string, unknown>;
    return ('id' in o || '$rewindTo' in o || '$set' in o || '$patch' in o)
      ? row
      : { id: `m${i}`, timestamp: STAMP, ...row };
  });
  writeFileSync(join(g, 'tmp', 'work', 'chats', `session-2026-10-30T00-00-${id.slice(0, 8)}.jsonl`),
    [{ sessionId: id, projectHash: 'x', startTime: STAMP, kind: 'main' }, ...stamped].map(r => JSON.stringify(r)).join('\n') + '\n');
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

  it('replays $rewindTo / $set.messages / $patch like the 0.66 accumulator, not physical lines', () => {
    const home = tmp();
    const work = join(home, 'work');
    mkdirSync(work);
    const env = { GEMINI_CLI_HOME: home };
    const probe = () => findGeminiSessionFile(BOTMUX, work, env)?.resumable;
    const user = (text: string) => ({ type: 'user', content: [{ text }] });
    const rewind = (to: string) => ({ $rewindTo: to });
    const setTable = (messages: object[]) => ({ $set: { messages } });
    const patch = (p: object) => ({ $patch: p });

    // 1) Rewind drops the target row itself and everything after it: the only
    //    real prompt is gone even though the physical line is still on disk
    //    (a first turn that failed 401/offline leaves exactly this shape, and
    //    `gemini --resume` exits 42 on it).
    geminiSession(home, work, BOTMUX, [user('hello'), rewind('m0')]);
    expect(probe()).toBe(false);

    // 2) Rewinding an ignored slash-command row keeps the real prompt before it.
    geminiSession(home, work, BOTMUX, [user('hello'), user('/help'), rewind('m1')]);
    expect(probe()).toBe(true);

    // 3) $set.messages REPLACES the whole table, it does not append: after it
    //    holds only the auto context row, the earlier prompt is gone.
    geminiSession(home, work, BOTMUX, [
      user('hello'),
      setTable([{ id: 'm9', type: 'user', content: [{ text: '<session_context>auto' }] }]),
    ]);
    expect(probe()).toBe(false);

    // 4) A $patch that fills content into an existing blank user row is what
    //    makes it resumable; patches never create the row themselves.
    geminiSession(home, work, BOTMUX, [user('   '), patch({ id: 'm0', content: [{ text: 'hello' }] })]);
    expect(probe()).toBe(true);
    geminiSession(home, work, BOTMUX, [patch({ id: 'm9', content: [{ text: 'hello' }] })]);
    expect(probe()).toBe(false);

    // 5) info/error rows still occupy a table index a $rewindTo may target:
    //    rewinding the info row deletes only it, keeping the prompt before it.
    //    Filtering rows to user/gemini when registering would miss-find the id,
    //    clear the whole table, and wrongly report false.
    geminiSession(home, work, BOTMUX, [
      user('keep'),
      { type: 'info', content: 'note' },
      rewind('m1'),
    ]);
    expect(probe()).toBe(true);

    // 6) removeIds drops a live row; an orderIds reorder does not.
    geminiSession(home, work, BOTMUX, [user('hello'), patch({ removeIds: ['m0'] })]);
    expect(probe()).toBe(false);
    geminiSession(home, work, BOTMUX, [user('hello'), patch({ orderIds: ['m0'] })]);
    expect(probe()).toBe(true);

    // 7) orderIds only reorders rows that still exist: rows not named in it
    //    stay as a prefix (upstream prefixIds + orderedIds). A prefix-only
    //    prompt must survive; a naive "rebuild the table as orderIds" drops it
    //    and leaves only the ignored /help row.
    geminiSession(home, work, BOTMUX, [user('hello'), user('/help'), patch({ orderIds: ['m1'] })]);
    expect(probe()).toBe(true);

    // 8) $patch.updates[] is the nested patch form: filling an EXISTING row's
    //    content counts, but naming an unknown id never creates a row.
    geminiSession(home, work, BOTMUX, [user('   '), patch({ updates: [{ id: 'm0', content: [{ text: 'hello' }] }] })]);
    expect(probe()).toBe(true);
    geminiSession(home, work, BOTMUX, [patch({ updates: [{ id: 'm9', content: [{ text: 'hello' }] }] })]);
    expect(probe()).toBe(false);

    // 9) $rewindTo an unknown id clears the whole table (upstream
    //    messageIds.length = 0 + kinds.clear()), it is not ignored.
    geminiSession(home, work, BOTMUX, [user('hello'), rewind('nope')]);
    expect(probe()).toBe(false);
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
