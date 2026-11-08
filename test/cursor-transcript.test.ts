import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync, mkdirSync, unlinkSync, readFileSync, truncateSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  baselineCursorTranscript,
  drainCursorTranscript,
  cursorChatIdFromStoreDbPath,
  findCursorTranscriptByChatId,
} from '../src/services/cursor-transcript.js';
import { baselineJsonlCursor } from '../src/services/jsonl-cursor.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';

let dir: string;
let path: string;

function line(obj: any): string {
  return JSON.stringify(obj) + '\n';
}

function userMsg(text: string) {
  return { role: 'user', message: { content: [{ type: 'text', text }] } };
}

/** An intermediate assistant step: narration text paired with a tool call. */
function assistantStep(text: string, tool = 'Shell') {
  return {
    role: 'assistant',
    message: { content: [{ type: 'text', text }, { type: 'tool_use', name: tool, input: {} }] },
  };
}

/** A terminal assistant turn: text only, no tool_use. */
function assistantFinal(text: string) {
  return { role: 'assistant', message: { content: [{ type: 'text', text }] } };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cursor-transcript-'));
  path = join(dir, 'chat.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cursorChatIdFromStoreDbPath', () => {
  const chatId = 'c8c78608-0eef-4930-8007-c41ba71ba05d';

  it('extracts the chatId from a canonical store.db path', () => {
    expect(cursorChatIdFromStoreDbPath(
      `/home/u/.cursor/chats/410dba680c6b451fb276f0d01c358e81/${chatId}/store.db`,
    )).toBe(chatId);
  });

  it('matches the -wal / -shm sidecar files SQLite keeps open', () => {
    expect(cursorChatIdFromStoreDbPath(
      `/home/u/.cursor/chats/hash/${chatId}/store.db-wal`,
    )).toBe(chatId);
    expect(cursorChatIdFromStoreDbPath(
      `/home/u/.cursor/chats/hash/${chatId}/store.db-shm`,
    )).toBe(chatId);
  });

  it('returns undefined for unrelated paths', () => {
    expect(cursorChatIdFromStoreDbPath('/var/log/syslog')).toBeUndefined();
    expect(cursorChatIdFromStoreDbPath('/home/u/.cursor/projects/foo/repo.json')).toBeUndefined();
    // Right shape but not under .cursor/chats — reject to avoid false positives.
    expect(cursorChatIdFromStoreDbPath(`/tmp/chats/h/${chatId}/store.db`)).toBeUndefined();
  });
});

describe('findCursorTranscriptByChatId', () => {
  it('locates <slug>/agent-transcripts/<chatId>/<chatId>.jsonl under projects root', () => {
    const chatId = 'c8c78608-0eef-4930-8007-c41ba71ba05d';
    const projectsRoot = join(dir, 'projects');
    const slugDir = join(projectsRoot, 'data00-home-u-code-proj', 'agent-transcripts', chatId);
    mkdirSync(slugDir, { recursive: true });
    const jsonl = join(slugDir, `${chatId}.jsonl`);
    writeFileSync(jsonl, '');
    expect(findCursorTranscriptByChatId(chatId, projectsRoot)).toBe(jsonl);
  });

  it('returns undefined when the chatId has no transcript', () => {
    const projectsRoot = join(dir, 'projects');
    mkdirSync(projectsRoot, { recursive: true });
    expect(findCursorTranscriptByChatId('00000000-0000-0000-0000-000000000000', projectsRoot)).toBeUndefined();
  });

  it('returns undefined when the projects root is missing', () => {
    expect(findCursorTranscriptByChatId('x', join(dir, 'nope'))).toBeUndefined();
  });
});

describe('drainCursorTranscript', () => {
  it('returns empty for a missing file', () => {
    const r = drainCursorTranscript(join(dir, 'missing.jsonl'), 0);
    expect(r.events).toEqual([]);
    expect(r.newOffset).toBe(0);
  });

  it('keeps the offset when an existing mirror briefly disappears', () => {
    writeFileSync(path, line(userMsg('first')));
    const r1 = drainCursorTranscript(path, 0);
    unlinkSync(path);
    const r2 = drainCursorTranscript(path, r1.newOffset);
    expect(r2.events).toEqual([]);
    expect(r2.newOffset).toBe(r1.newOffset);
  });

  it('extracts user prompt + text-only assistant final', () => {
    writeFileSync(path, line(userMsg('say hi')) + line(assistantFinal('Hi! 👋')));
    const r = drainCursorTranscript(path, 0);
    expect(r.events).toHaveLength(2);
    expect(r.events[0]).toMatchObject({ kind: 'user', text: 'say hi' });
    expect(r.events[1]).toMatchObject({ kind: 'assistant_final', text: 'Hi! 👋' });
  });

  it('skips intermediate assistant steps that carry a tool_use block', () => {
    writeFileSync(path,
      line(userMsg('do work')) +
      line(assistantStep('let me look', 'Grep')) +
      line(assistantStep('now read', 'Read')) +
      line(assistantFinal('done')));
    const r = drainCursorTranscript(path, 0);
    expect(r.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
    expect(r.events[1].text).toBe('done');
  });

  it('distills a multi-turn conversation to discrete user/assistant_final pairs', () => {
    // Two full turns, each: user → several tool steps → one text-only final.
    // The bridge must see exactly the Codex-shaped 2-events-per-turn sequence.
    writeFileSync(path,
      line(userMsg('turn one')) +
      line(assistantStep('looking', 'Grep')) +
      line(assistantStep('reading', 'Read')) +
      line(assistantFinal('answer one')) +
      line(userMsg('turn two')) +
      line(assistantStep('digging', 'Shell')) +
      line(assistantFinal('answer two')));
    const r = drainCursorTranscript(path, 0);
    expect(r.events.map(e => ({ kind: e.kind, text: e.text }))).toEqual([
      { kind: 'user', text: 'turn one' },
      { kind: 'assistant_final', text: 'answer one' },
      { kind: 'user', text: 'turn two' },
      { kind: 'assistant_final', text: 'answer two' },
    ]);
  });

  it('emits nothing for an interrupted turn that never reached a text-only final', () => {
    // User asked, model ran a tool, then the process died — no terminator.
    writeFileSync(path, line(userMsg('do it')) + line(assistantStep('working', 'Shell')));
    const r = drainCursorTranscript(path, 0);
    expect(r.events.map(e => e.kind)).toEqual(['user']);
  });

  it('joins multiple text blocks of a final reply', () => {
    writeFileSync(path, line({
      role: 'assistant',
      message: { content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }] },
    }));
    const r = drainCursorTranscript(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].text).toBe('part one\npart two');
  });

  it('strips Cursor reasoning text appended to a text-only final reply', () => {
    writeFileSync(path, line(assistantFinal([
      'Hi, received.',
      '',
      '**Considering user response**',
      '',
      'This paragraph is internal reasoning from the Cursor transcript mirror.',
    ].join('\n'))));
    const r = drainCursorTranscript(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].text).toBe('Hi, received.');
  });

  it('skips assistant lines with no visible text (tool_use only)', () => {
    writeFileSync(path, line({
      role: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Shell', input: {} }] },
    }) + line(assistantFinal('reply')));
    const r = drainCursorTranscript(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].text).toBe('reply');
  });

  it('ignores malformed JSON lines', () => {
    writeFileSync(path, 'not json\n' + line(userMsg('after bad line')));
    const r = drainCursorTranscript(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].text).toBe('after bad line');
  });

  it('byte-offset stable: re-drain from newOffset returns no events', () => {
    writeFileSync(path, line(userMsg('first')) + line(assistantFinal('reply')));
    const first = drainCursorTranscript(path, 0);
    const second = drainCursorTranscript(path, first.newOffset);
    expect(second.events).toEqual([]);
    expect(second.newOffset).toBe(first.newOffset);
  });

  it('appended events drain incrementally', () => {
    writeFileSync(path, line(userMsg('first')));
    const r1 = drainCursorTranscript(path, 0);
    expect(r1.events).toHaveLength(1);
    appendFileSync(path, line(assistantFinal('reply')));
    const r2 = drainCursorTranscript(path, r1.newOffset);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0].kind).toBe('assistant_final');
  });

  it('holds back a partial trailing line as pendingTail', () => {
    writeFileSync(path, line(userMsg('complete')) + '{"role":"assistant","message":{"content"');
    const r = drainCursorTranscript(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.pendingTail).toContain('content');
    expect(r.newOffset).toBeLessThan(statSync(path).size);
  });

  it('parses a complete trailing JSON object without a newline', () => {
    writeFileSync(path, line(userMsg('complete')) + JSON.stringify(assistantFinal('reply without newline')));
    const r = drainCursorTranscript(path, 0);
    expect(r.events.map(e => ({ kind: e.kind, text: e.text }))).toEqual([
      { kind: 'user', text: 'complete' },
      { kind: 'assistant_final', text: 'reply without newline' },
    ]);
    expect(r.pendingTail).toBe('');
    expect(r.newOffset).toBe(statSync(path).size);
  });

  it('uuid encodes path:byteStart and is stable across re-drains', () => {
    writeFileSync(path, line(userMsg('uuid-one')) + line(userMsg('uuid-two')));
    const r = drainCursorTranscript(path, 0);
    expect(r.events).toHaveLength(2);
    expect(r.events[0].uuid).toMatch(/\.jsonl:0$/);
    expect(r.events[1].uuid).not.toBe(r.events[0].uuid);
    const r2 = drainCursorTranscript(path, 0);
    expect(r2.events.map(e => e.uuid)).toEqual(r.events.map(e => e.uuid));
  });

  it('keeps the offset when Cursor temporarily rewrites the mirror smaller', () => {
    writeFileSync(path,
      line(userMsg('original message long enough to advance the byte offset')) +
      line(assistantFinal('a reasonably long original answer to take up bytes')));
    const r1 = drainCursorTranscript(path, 0);
    writeFileSync(path, line(userMsg('s')));
    const r2 = drainCursorTranscript(path, r1.newOffset);
    expect(r2.events).toEqual([]);
    expect(r2.newOffset).toBe(r1.newOffset);
  });
});

// ---------------------------------------------------------------------------
// cursor-agent's `turn_ended` status footer is NOT append-only: every turn ends
// by appending it at EOF, and the next turn truncates it away and writes its
// lines from the footer's old byte position (the footer moves to the new EOF).
// Shapes below are the ones observed in real ~/.cursor agent-transcripts.
// ---------------------------------------------------------------------------

const FOOTER_OK = line({ type: 'turn_ended', status: 'success' });
const FOOTER_ERROR = line({
  type: 'turn_ended',
  status: 'error',
  error: '[aborted] Client network socket disconnected before secure TLS connection was established',
});
const FOOTER_ABORTED = line({ type: 'turn_ended', status: 'aborted', error: 'User aborted/interrupted the request' });

/** Real cursor user lines wrap the prompt in <user_query>. */
function cursorUser(text: string) {
  return userMsg(`<user_query>\n${text}\n</user_query>`);
}

/** Byte start of the file's trailing role-less footer line (with or without
 *  its newline), or the size when it does not end with one. */
function trailingFooterStart(p: string): number {
  if (!existsSync(p)) return 0;
  const buf = readFileSync(p);
  if (buf.length === 0) return 0;
  const end = buf[buf.length - 1] === 0x0a ? buf.length - 1 : buf.length;
  const start = buf.lastIndexOf(0x0a, end - 1) + 1;
  try {
    const obj = JSON.parse(buf.subarray(start, end).toString('utf8'));
    if (obj && typeof obj === 'object' && obj.role === undefined) return start;
  } catch { /* not a footer */ }
  return buf.length;
}

/** What cursor-agent does per turn: truncate the trailing footer, write the
 *  turn from its old byte position, re-append a footer at the new EOF.
 *  Returns the byte offset the turn's first line starts at. */
function writeCursorTurn(p: string, body: string, footer = FOOTER_OK): number {
  const at = trailingFooterStart(p);
  if (existsSync(p)) truncateSync(p, at);
  appendFileSync(p, body + footer);
  return at;
}

function turnBody(user: string, final: string): string {
  return line(cursorUser(user)) + line(assistantStep('先看一下仓库结构', 'Grep')) + line(assistantFinal(final));
}

function kinds(events: { kind: string; text: string }[]): string[] {
  return events.map(e => `${e.kind}:${e.text.replace(/<\/?user_query>/g, '').trim()}`);
}

describe('drainCursorTranscript — turn_ended footer truncate-rewrite', () => {
  it('parks newOffset at the trailing footer start; re-draining it yields nothing', () => {
    writeCursorTurn(path, turnBody('turn one', 'answer one'));
    const footerAt = trailingFooterStart(path);
    expect(footerAt).toBeLessThan(statSync(path).size);
    const r1 = drainCursorTranscript(path, 0);
    expect(kinds(r1.events)).toEqual(['user:turn one', 'assistant_final:answer one']);
    expect(r1.newOffset).toBe(footerAt);
    expect(r1.pendingTail).toBe('');
    const r2 = drainCursorTranscript(path, r1.newOffset);
    expect(r2.events).toEqual([]);
    expect(r2.newOffset).toBe(footerAt);
  });

  it('ingests every later turn after cursor truncates the footer and rewrites from its start', () => {
    // Regression: the offset used to sit past the footer, so turn 2+ user
    // lines began behind it and were only ever read as a mid-line fragment
    // (the turn never fingerprint-matched; the send-less fallback went silent).
    let offset = 0;
    const seen: string[] = [];
    const uuids = new Set<string>();
    const turns: Array<[string, string, string]> = [
      ['turn one', 'answer one', FOOTER_OK],
      ['第二轮：请总结一下这个仓库的结构', '仓库分为 daemon / worker / adapters 三层', FOOTER_ERROR],
      ['turn three after an error footer', 'answer three', FOOTER_ABORTED],
      ['第四轮', '好的', FOOTER_OK],
    ];
    for (const [user, final, footer] of turns) {
      const startedAt = writeCursorTurn(path, turnBody(user, final), footer);
      // The committed offset is exactly where cursor resumed writing.
      expect(offset).toBe(startedAt);
      const r = drainCursorTranscript(path, offset);
      expect(kinds(r.events)).toEqual([`user:${user}`, `assistant_final:${final}`]);
      for (const ev of r.events) {
        expect(uuids.has(ev.uuid)).toBe(false);
        uuids.add(ev.uuid);
      }
      seen.push(...kinds(r.events));
      offset = r.newOffset;
    }
    expect(seen).toHaveLength(8);
    // A from-scratch drain sees the same conversation (footers never emit).
    expect(kinds(drainCursorTranscript(path, 0).events)).toEqual(seen);
  });

  it('holds before a complete footer left at EOF without its newline', () => {
    writeFileSync(path, turnBody('q', 'a') + JSON.stringify({ type: 'turn_ended', status: 'success' }));
    const footerAt = Buffer.byteLength(turnBody('q', 'a'));
    const r = drainCursorTranscript(path, 0);
    expect(kinds(r.events)).toEqual(['user:q', 'assistant_final:a']);
    expect(r.newOffset).toBe(footerAt);
    expect(r.pendingTail).toBe('');
  });

  it('a half-written line after the footer is never committed past the footer', () => {
    writeFileSync(path, turnBody('q', 'a') + FOOTER_OK + '{"role":"user","message":{"cont');
    const footerAt = Buffer.byteLength(turnBody('q', 'a'));
    const r = drainCursorTranscript(path, 0);
    expect(r.newOffset).toBe(footerAt);
  });

  it('a message after the footer ends the run, so the frontier moves forward', () => {
    writeFileSync(path, turnBody('q', 'a') + FOOTER_OK + line(cursorUser('appended without truncation')));
    const r = drainCursorTranscript(path, 0);
    expect(kinds(r.events)).toEqual(['user:q', 'assistant_final:a', 'user:appended without truncation']);
    expect(r.newOffset).toBe(statSync(path).size);
  });

  it('a stale offset inside a multi-byte character cannot drift the frontier', () => {
    // A stale offset (e.g. an EOF baseline taken before cursor rewrote a long
    // error footer) can land inside a CJK character of the rewritten user
    // line. Re-encoding the decoded text there turns each orphaned
    // continuation byte into a 3-byte U+FFFD, pushing every later offset — and
    // the committed frontier — past the real line boundaries (even past EOF).
    const userLine = line(cursorUser('中文中文中文中文'));
    const body = userLine + line(assistantFinal('answer two'));
    writeFileSync(path, body + FOOTER_OK);
    const firstCjk = Buffer.from(userLine).indexOf(Buffer.from('中'));
    const stale = firstCjk + 1;
    expect(readFileSync(path)[stale] & 0xc0).toBe(0x80); // continuation byte
    const r = drainCursorTranscript(path, stale);
    expect(kinds(r.events)).toEqual(['assistant_final:answer two']);
    expect(r.newOffset).toBe(Buffer.byteLength(body));
    // Self-heals: the next turn rewrites from that exact footer start.
    writeCursorTurn(path, turnBody('第三轮', 'answer three'));
    const r2 = drainCursorTranscript(path, r.newOffset);
    expect(kinds(r2.events)).toEqual(['user:第三轮', 'assistant_final:answer three']);
  });
});

describe('baselineCursorTranscript', () => {
  it('returns undefined for a missing file and 0 for an empty one', () => {
    expect(baselineCursorTranscript(join(dir, 'missing.jsonl'))).toBeUndefined();
    writeFileSync(path, '');
    expect(baselineCursorTranscript(path)).toEqual({ newOffset: 0, pendingTail: '' });
    expect(baselineCursorTranscript(path, { skipTail: true })).toEqual({ newOffset: 0, pendingTail: '' });
  });

  it('rewinds before a trailing footer in both modes so the next turn is ingested whole', () => {
    // Regression: adopt (EOF baseline) and zero-prompt resume
    // (baselineJsonlCursor) both baselined past the footer.
    writeCursorTurn(path, turnBody('history', 'old answer'));
    writeCursorTurn(path, turnBody('更多历史', 'old answer 2'), FOOTER_ERROR);
    const footerAt = trailingFooterStart(path);
    expect(baselineJsonlCursor(path).newOffset).toBe(statSync(path).size); // the old, wrong baseline
    for (const skipTail of [true, false]) {
      expect(baselineCursorTranscript(path, { skipTail })).toEqual({ newOffset: footerAt, pendingTail: '' });
    }
    const base = baselineCursorTranscript(path, { skipTail: true })!.newOffset;
    expect(writeCursorTurn(path, turnBody('live turn', 'live answer'))).toBe(base);
    const r = drainCursorTranscript(path, base);
    expect(kinds(r.events)).toEqual(['user:live turn', 'assistant_final:live answer']);
  });

  it('stays exact when the 64 KiB tail probe starts inside a multi-byte character', () => {
    // Decoding the probe and re-encoding lines to count bytes drifts here:
    // the probe's leading orphaned continuation bytes each become a 3-byte
    // U+FFFD. Seen on real transcripts larger than 64 KiB.
    for (let pad = 0; pad < 3; pad++) {
      writeFileSync(path, line(cursorUser('x'.repeat(pad) + '中'.repeat(25_000))) + line(assistantFinal('done')));
      writeCursorTurn(path, turnBody('上一轮', 'previous answer'));
      const size = statSync(path).size;
      const probeStart = size - 64 * 1024;
      if ((readFileSync(path)[probeStart] & 0xc0) === 0x80) break;
    }
    const size = statSync(path).size;
    expect(size).toBeGreaterThan(64 * 1024);
    expect(readFileSync(path)[size - 64 * 1024] & 0xc0).toBe(0x80);
    const footerAt = trailingFooterStart(path);
    for (const skipTail of [true, false]) {
      expect(baselineCursorTranscript(path, { skipTail })?.newOffset).toBe(footerAt);
    }
    writeCursorTurn(path, turnBody('第二轮', 'answer two'));
    const r = drainCursorTranscript(path, footerAt);
    expect(kinds(r.events)).toEqual(['user:第二轮', 'assistant_final:answer two']);
  });

  it('stays exact when the probe start lands inside the trailing user line', () => {
    // Whole trailing turn bigger than the probe: the first probe segment is
    // the back half of a line and must not be mistaken for a line start.
    writeCursorTurn(path, line(cursorUser('长'.repeat(30_000))) + line(assistantFinal('ok')));
    expect(baselineCursorTranscript(path, { skipTail: true })?.newOffset).toBe(trailingFooterStart(path));
  });

  it('skipTail skips an in-flight message tail; without skipTail it stays pending (baselineJsonlCursor parity)', () => {
    const complete = turnBody('q', 'a');
    const partial = '{"role":"assistant","message":{"content":[{"type":"text","text":"half';
    writeFileSync(path, complete + partial);
    expect(baselineCursorTranscript(path, { skipTail: true })).toEqual({ newOffset: statSync(path).size, pendingTail: '' });
    expect(baselineCursorTranscript(path)).toEqual(baselineJsonlCursor(path));
    expect(baselineCursorTranscript(path)).toEqual({ newOffset: Buffer.byteLength(complete), pendingTail: partial });
  });

  it('treats a complete message tail without newline as history in both modes', () => {
    const complete = turnBody('q', 'a');
    writeFileSync(path, complete + JSON.stringify(assistantFinal('old final, no newline')));
    for (const skipTail of [true, false]) {
      expect(baselineCursorTranscript(path, { skipTail })).toEqual({ newOffset: statSync(path).size, pendingTail: '' });
    }
  });

  describe('zero-prompt resume over a transcript whose last record lacks its newline', () => {
    // Regression: the resume baseline (skipTail: false) used to leave a
    // complete last record pending — at offset 0 for a single-record file,
    // where baselineJsonlCursor gave EOF. The cursor drain consumes a
    // parseable EOF object, so that old prompt was re-emitted with a fresh
    // timestamp: a phantom local turn, or a bogus match for a queued
    // same-fingerprint retry, without any new input.
    function expectNoReplay(): number {
      const base = baselineCursorTranscript(path)!;
      expect(base).toEqual({ newOffset: statSync(path).size, pendingTail: '' });
      expect(drainCursorTranscript(path, base.newOffset).events).toEqual([]);
      return base.newOffset;
    }

    it('single user record without newline', () => {
      writeFileSync(path, JSON.stringify(cursorUser('唯一一条历史提问')));
      expect(baselineJsonlCursor(path).newOffset).toBe(statSync(path).size);
      const base = expectNoReplay();
      // The next live turn (cursor terminates the old line first) still lands.
      appendFileSync(path, '\n' + turnBody('new prompt', 'new answer') + FOOTER_OK);
      expect(kinds(drainCursorTranscript(path, base).events)).toEqual(['user:new prompt', 'assistant_final:new answer']);
    });

    it('several records, the last one without newline', () => {
      writeFileSync(path, turnBody('old', 'old answer') + JSON.stringify(cursorUser('最后一条无换行')));
      const pendingOnly = baselineJsonlCursor(path);
      expect(pendingOnly.newOffset).toBeLessThan(statSync(path).size); // plain baseline would replay it
      expectNoReplay();
    });

    it('single footer without newline still rewinds to its start', () => {
      writeFileSync(path, JSON.stringify({ type: 'turn_ended', status: 'success' }));
      for (const skipTail of [true, false]) {
        expect(baselineCursorTranscript(path, { skipTail })).toEqual({ newOffset: 0, pendingTail: '' });
      }
      writeCursorTurn(path, turnBody('第一轮', 'first answer'));
      expect(kinds(drainCursorTranscript(path, 0).events)).toEqual(['user:第一轮', 'assistant_final:first answer']);
    });

    it('a single unfinished fragment without any newline is skipped like baselineJsonlCursor', () => {
      writeFileSync(path, '{"role":"user","message":{"content":[{"type":"text","text":"half');
      expect(baselineCursorTranscript(path)).toEqual(baselineJsonlCursor(path));
      expect(baselineCursorTranscript(path)).toEqual({ newOffset: statSync(path).size, pendingTail: '' });
    });
  });

  it('does not skip a footer tail, complete or still being written', () => {
    const complete = turnBody('q', 'a');
    for (const tail of [
      JSON.stringify({ type: 'turn_ended', status: 'success' }),
      '{"type":"turn_ended","sta',
    ]) {
      writeFileSync(path, complete + tail);
      for (const skipTail of [true, false]) {
        expect(baselineCursorTranscript(path, { skipTail })).toEqual({ newOffset: Buffer.byteLength(complete), pendingTail: '' });
      }
    }
  });

  it('matches the plain baselines when the transcript has no footer', () => {
    writeFileSync(path, turnBody('q', 'a') + line(cursorUser('最后一行')));
    expect(baselineCursorTranscript(path)).toEqual(baselineJsonlCursor(path));
    expect(baselineCursorTranscript(path, { skipTail: true })).toEqual({ newOffset: statSync(path).size, pendingTail: '' });
  });
});

describe('cursor bridge attribution across footer rewrites (drain + CodexBridgeQueue)', () => {
  function emittedFinals(q: CodexBridgeQueue): string[] {
    return q.drainEmittable().map(t => `${t.turnId}:${t.finalText}`);
  }

  it('zero-prompt fresh spawn: every turn starts and closes, not just the first', () => {
    const q = new CodexBridgeQueue();
    let offset = 0; // fresh-empty attach
    const turns: Array<[string, string, string]> = [
      ['t1', '请帮我看一下 README', 'README 已阅'],
      ['t2', '第二个问题：worker 是做什么的', 'worker 管理 CLI 子进程'],
      ['t3', 'third question', 'third answer'],
    ];
    for (const [turnId, prompt, final] of turns) {
      q.mark(turnId, prompt);
      writeCursorTurn(path, turnBody(prompt, final));
      const r = drainCursorTranscript(path, offset);
      offset = r.newOffset;
      q.ingest(r.events);
      expect(emittedFinals(q)).toEqual([`${turnId}:${final}`]);
    }
  });

  it('adopt baseline: history is not replayed and the first live turn is attributed', () => {
    writeCursorTurn(path, turnBody('历史问题', 'history answer'));
    const q = new CodexBridgeQueue();
    const base = baselineCursorTranscript(path, { skipTail: true })!;
    q.mark('live', '飞书里的新问题');
    writeCursorTurn(path, turnBody('飞书里的新问题', '新回答'));
    const r = drainCursorTranscript(path, base.newOffset);
    q.ingest(r.events);
    expect(emittedFinals(q)).toEqual(['live:新回答']);
  });
});

describe('non-regular transcript paths never block the worker', () => {
  it('reports a directory as empty', () => {
    const sub = join(dir, 'not-a-file.jsonl');
    mkdirSync(sub);
    for (const skipTail of [true, false]) {
      expect(baselineCursorTranscript(sub, { skipTail })).toEqual({ newOffset: 0, pendingTail: '' });
    }
    expect(drainCursorTranscript(sub, 0)).toEqual({ events: [], newOffset: 0, pendingTail: '' });
    expect(drainCursorTranscript(sub, 7)).toEqual({ events: [], newOffset: 7, pendingTail: '' });
  });

  // A FIFO with no writer makes a blocking open(2) wait forever, freezing the
  // synchronous attach / drain. Probe it in a child so a regression fails on
  // the timeout instead of hanging the test runner.
  it.skipIf(process.platform === 'win32')('opens a FIFO without blocking and treats it as empty', () => {
    const fifo = join(dir, 'fifo.jsonl');
    const mk = spawnSync('mkfifo', [fifo]);
    expect(mk.status, String(mk.stderr)).toBe(0);
    const mod = pathToFileURL(resolve('src/services/cursor-transcript.ts')).href;
    const snippet = `
      const { baselineCursorTranscript, drainCursorTranscript } = await import(${JSON.stringify(mod)});
      const p = ${JSON.stringify(fifo)};
      console.log(JSON.stringify({
        adopt: baselineCursorTranscript(p, { skipTail: true }),
        resume: baselineCursorTranscript(p),
        drain0: drainCursorTranscript(p, 0),
        drain7: drainCursorTranscript(p, 7),
      }));
    `;
    const res = spawnSyncTsEvalWithRepoImports(snippet, { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
    expect(res.signal, `child blocked on the FIFO; stderr=${res.stderr}`).toBeNull();
    expect(res.status, String(res.stderr)).toBe(0);
    const out = JSON.parse(String(res.stdout).trim().split('\n').pop()!);
    expect(out).toEqual({
      adopt: { newOffset: 0, pendingTail: '' },
      resume: { newOffset: 0, pendingTail: '' },
      drain0: { events: [], newOffset: 0, pendingTail: '' },
      drain7: { events: [], newOffset: 7, pendingTail: '' },
    });
  }, 90_000);
});
