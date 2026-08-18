import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cursorBaselineOffset,
  drainCursorTranscript,
  cursorChatIdFromStoreDbPath,
  findCursorTranscriptByChatId,
} from '../src/services/cursor-transcript.js';

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

  const turnEnded = { type: 'turn_ended', status: 'success' };

  it('never advances the offset past a trailing turn_ended status footer', () => {
    const messages = line(userMsg('first')) + line(assistantFinal('reply'));
    writeFileSync(path, messages + line(turnEnded));
    const r = drainCursorTranscript(path, 0);
    expect(r.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
    expect(r.newOffset).toBe(Buffer.byteLength(messages, 'utf8'));
    // Re-drain from the held-back offset: the footer re-parses to zero events
    // and the offset stays put — no duplicates, no progress.
    const again = drainCursorTranscript(path, r.newOffset);
    expect(again.events).toEqual([]);
    expect(again.newOffset).toBe(r.newOffset);
  });

  it('holds the offset before a footer left at EOF without a trailing newline', () => {
    const messages = line(userMsg('first')) + line(assistantFinal('reply'));
    writeFileSync(path, messages + JSON.stringify(turnEnded));
    const r = drainCursorTranscript(path, 0);
    expect(r.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
    expect(r.newOffset).toBe(Buffer.byteLength(messages, 'utf8'));
    expect(r.pendingTail).toBe('');
  });

  it('survives cursor\'s footer-truncating rewrite between turns (live regression)', () => {
    // Turn 1 at rest: messages + turn_ended footer. Cursor's NEXT turn
    // truncates the footer and writes the new user/assistant lines starting
    // at the footer's old byte position, re-appending the footer at EOF.
    // A drain that had consumed the footer would commit an offset INSIDE the
    // next turn's user line and permanently miss its user event — observed
    // live on cursor-agent 2026.08.11 (spawned session, turn 2 ghosted).
    const turn1 = line(userMsg('turn one prompt')) + line(assistantFinal('turn one answer'));
    writeFileSync(path, turn1 + line(turnEnded));
    const r1 = drainCursorTranscript(path, 0);
    expect(r1.events).toHaveLength(2);

    const turn2 = line(userMsg('turn two prompt')) + line(assistantFinal('turn two answer'));
    writeFileSync(path, turn1 + turn2 + line(turnEnded));
    const r2 = drainCursorTranscript(path, r1.newOffset);
    expect(r2.events.map(e => ({ kind: e.kind, text: e.text }))).toEqual([
      { kind: 'user', text: 'turn two prompt' },
      { kind: 'assistant_final', text: 'turn two answer' },
    ]);
  });

  it('rewinds through a run of consecutive trailing status lines', () => {
    const messages = line(userMsg('first')) + line(assistantFinal('reply'));
    writeFileSync(path, messages + line(turnEnded) + line({ type: 'other_status' }));
    const r = drainCursorTranscript(path, 0);
    expect(r.newOffset).toBe(Buffer.byteLength(messages, 'utf8'));
  });

  it('a status line followed by message lines is consumed normally', () => {
    writeFileSync(path,
      line(turnEnded) + line(userMsg('after footer')) + line(assistantFinal('answer')));
    const r = drainCursorTranscript(path, 0);
    expect(r.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
    expect(r.newOffset).toBe(statSync(path).size);
  });
});

describe('cursorBaselineOffset', () => {
  const turnEnded = { type: 'turn_ended', status: 'success' };

  it('returns undefined for a missing file', () => {
    expect(cursorBaselineOffset(join(dir, 'nope.jsonl'))).toBeUndefined();
  });

  it('baselines to file size when the transcript ends with a message line', () => {
    writeFileSync(path, line(userMsg('first')) + line(assistantFinal('reply')));
    expect(cursorBaselineOffset(path)).toBe(statSync(path).size);
  });

  it('rewinds before a trailing turn_ended footer (with and without newline)', () => {
    const messages = line(userMsg('first')) + line(assistantFinal('reply'));
    writeFileSync(path, messages + line(turnEnded));
    expect(cursorBaselineOffset(path)).toBe(Buffer.byteLength(messages, 'utf8'));
    writeFileSync(path, messages + JSON.stringify(turnEnded));
    expect(cursorBaselineOffset(path)).toBe(Buffer.byteLength(messages, 'utf8'));
  });

  it('skips a partial message tail like a plain size baseline (old in-flight output)', () => {
    writeFileSync(path, line(userMsg('first')) + '{"role":"assistant","message":{"content"');
    expect(cursorBaselineOffset(path)).toBe(statSync(path).size);
  });

  it('resume flow: baseline then footer-truncating rewrite still yields the next turn', () => {
    const turn1 = line(userMsg('old prompt')) + line(assistantFinal('old answer'));
    writeFileSync(path, turn1 + line(turnEnded));
    const baseline = cursorBaselineOffset(path)!;
    // History stays behind the baseline...
    expect(drainCursorTranscript(path, baseline).events).toEqual([]);
    // ...and the next turn's rewrite from the footer position is fully seen.
    const turn2 = line(userMsg('new prompt')) + line(assistantFinal('new answer'));
    writeFileSync(path, turn1 + turn2 + line(turnEnded));
    const r = drainCursorTranscript(path, baseline);
    expect(r.events.map(e => ({ kind: e.kind, text: e.text }))).toEqual([
      { kind: 'user', text: 'new prompt' },
      { kind: 'assistant_final', text: 'new answer' },
    ]);
  });
});
