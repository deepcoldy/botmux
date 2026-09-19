import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync, mkdirSync, unlinkSync, truncateSync, readSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  drainCursorTranscript,
  cursorChatIdFromStoreDbPath,
  findCursorTranscriptByChatId,
  classifyCursorPendingTail,
  isCursorFallbackDisabled,
  type CursorDrainDeps,
} from '../src/services/cursor-transcript.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';

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

// Regression: the resume/reattach baseline reuses drainCursorTranscript(path,
// 0).newOffset as the safe frontier (cursorBridgeAttach). A >64KiB multibyte
// transcript must still rewind that frontier exactly to the footer start — a
// tail-window probe that decoded mid-char would drift the byte arithmetic past
// it and ghost the next turn's user event. The drain reads from byte 0 (a char
// boundary), so it has no window; this locks in that the frontier stays exact
// at scale for CJK (3-byte) and emoji (4-byte) content.
describe('drainCursorTranscript >64KiB multibyte frontier', () => {
  const turnEnded = { type: 'turn_ended', status: 'success' };

  for (const [label, ch] of [['CJK', '量'], ['emoji', '😀']] as const) {
    it(`${label}: frontier holds at the footer start and the next turn survives a footer-truncating rewrite`, () => {
      const giant = line(userMsg(ch.repeat(30000)));
      writeFileSync(path, giant + line(turnEnded));
      expect(statSync(path).size).toBeGreaterThan(65536);
      const frontier = drainCursorTranscript(path, 0).newOffset;
      expect(frontier).toBe(Buffer.byteLength(giant, 'utf8'));
      // Resume: the next turn truncates the footer and rewrites from its byte
      // position. The drain from the committed frontier must see BOTH events.
      const turn2 = line(userMsg('resume 后还能归因吗？')) + line(assistantFinal('能。'));
      writeFileSync(path, giant + turn2 + line(turnEnded));
      const r = drainCursorTranscript(path, frontier);
      expect(r.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
    });
  }
});

// ── Option 3: three-way pending-tail classification ──────────────────────
// The attach baseline depends on what the partial tail IS: a message tail is
// skipped (readEndOffset), a footer tail is held (newOffset), and a tail too
// short to classify defers the attach. The classifier is a conservative
// prefix matcher — only a COMPLETE known discriminator classifies; anything
// else defers (wait a tick rather than guess, because cursor's internal schema
// is not promised stable and a wrong guess reopens the stale-replay / ghost
// hole).
describe('classifyCursorPendingTail', () => {
  it('classifies a complete role discriminator as message', () => {
    expect(classifyCursorPendingTail('{"role":"user"')).toBe('message');
    expect(classifyCursorPendingTail('{"role":"assistant"')).toBe('message');
    expect(classifyCursorPendingTail('{"role":"user","message":{"content"')).toBe('message');
    expect(classifyCursorPendingTail('{"role":"assistant","message"')).toBe('message');
  });

  it('classifies a complete turn_ended discriminator as footer', () => {
    expect(classifyCursorPendingTail('{"type":"turn_ended"')).toBe('footer');
    expect(classifyCursorPendingTail('{"type":"turn_ended","status":"success"')).toBe('footer');
  });

  it('defers on a half-written discriminator value', () => {
    expect(classifyCursorPendingTail('{"role":"use')).toBe('defer');
    expect(classifyCursorPendingTail('{"role":"assistan')).toBe('defer');
    expect(classifyCursorPendingTail('{"type":"turn_')).toBe('defer');
    expect(classifyCursorPendingTail('{"type":"turn_ended"')).toBe('footer'); // complete → footer
  });

  it('defers on an unknown type value (schema not promised stable)', () => {
    expect(classifyCursorPendingTail('{"type":"unknown"')).toBe('defer');
    expect(classifyCursorPendingTail('{"type":"message"')).toBe('defer');
    expect(classifyCursorPendingTail('{"type":"turn_started"')).toBe('defer');
  });

  it('defers on too-short prefixes (cannot see the full discriminator)', () => {
    expect(classifyCursorPendingTail('')).toBe('defer');
    expect(classifyCursorPendingTail('{')).toBe('defer');
    expect(classifyCursorPendingTail('{"')).toBe('defer');
    expect(classifyCursorPendingTail('{"r')).toBe('defer');
    expect(classifyCursorPendingTail('{"t')).toBe('defer');
    expect(classifyCursorPendingTail('{"role')).toBe('defer');
    expect(classifyCursorPendingTail('{"role":')).toBe('defer');
    expect(classifyCursorPendingTail('{"type')).toBe('defer');
  });

  it('defers on non-{ start or unexpected whitespace', () => {
    expect(classifyCursorPendingTail('not json')).toBe('defer');
    expect(classifyCursorPendingTail(' {"role":"user"')).toBe('defer'); // leading space
    expect(classifyCursorPendingTail('{ "role":"user"')).toBe('defer'); // space after {
    expect(classifyCursorPendingTail('{"role": "user"')).toBe('defer'); // space after :
  });

  it('defers when the role value is not user|assistant', () => {
    expect(classifyCursorPendingTail('{"role":"system"')).toBe('defer');
    expect(classifyCursorPendingTail('{"role":"tool"')).toBe('defer');
    expect(classifyCursorPendingTail('{"role":"量')).toBe('defer'); // multibyte value, not user/assistant
  });
});

// ── isCursorFallbackDisabled (fail-safe mark gate) ───────────────────────
// The 30s fail-safe must disable BOTH polling and mark attribution. This
// pure function is the mark gate: cursor+disabled → false (no mark), other
// CLIs unaffected. Reverse-mutation target: if the gate is removed, the
// wiring test (codexBridgeFallbackActive checks cursorBridgeDisabled) still
// passes but this test goes red — proving the behavioral claim is pinned.
describe('isCursorFallbackDisabled', () => {
  it('returns true only for cursor+disabled', () => {
    expect(isCursorFallbackDisabled('cursor', true)).toBe(true);
    expect(isCursorFallbackDisabled('cursor', false)).toBe(false);
    expect(isCursorFallbackDisabled('codex', true)).toBe(false);
    expect(isCursorFallbackDisabled('codex', false)).toBe(false);
    expect(isCursorFallbackDisabled('claude-code', true)).toBe(false);
    expect(isCursorFallbackDisabled(undefined, true)).toBe(false);
    expect(isCursorFallbackDisabled(undefined, false)).toBe(false);
  });
});

// ── Option 3: drain-level partial-tail baseline regression ───────────────
// These tests simulate what cursorBridgeAttach does: drain from 0, classify
// the pending tail, pick the baseline (message → readEndOffset, footer →
// newOffset, none → newOffset), then verify the next turn survives.
describe('drainCursorTranscript partial-tail baseline (option 3)', () => {
  const turnEnded = { type: 'turn_ended', status: 'success' };

  it('readEndOffset is the snapshot EOF (same snapshot, no second stat)', () => {
    writeFileSync(path, line(userMsg('first')) + line(assistantFinal('reply')));
    const r = drainCursorTranscript(path, 0);
    expect(r.readEndOffset).toBe(statSync(path).size);
    expect(r.newOffset).toBe(statSync(path).size); // no footer → frontier = EOF
  });

  it('group 1: partial message tail → baseline at readEndOffset skips it, next turn intact', () => {
    // Turn 1 at rest (no footer — the previous turn was interrupted or the
    // footer was already truncated for the next write). A partial assistant
    // line is being written: old in-flight output that must be skipped.
    const turn1 = line(userMsg('turn one')) + line(assistantFinal('answer one'));
    const partial = '{"role":"assistant","message":{"content":[{"type":"text","text":"OLD in-flight';
    writeFileSync(path, turn1 + partial);
    const full = drainCursorTranscript(path, 0);
    expect(full.pendingTail).toBe(partial);
    expect(classifyCursorPendingTail(full.pendingTail)).toBe('message');
    // cursorBridgeAttach would baseline at readEndOffset (skip the partial).
    const baseline = full.readEndOffset;
    expect(baseline).toBe(statSync(path).size);

    // The partial completes + footer is written.
    const completed = partial + ' answer"}]}' + '\n';
    writeFileSync(path, turn1 + completed + line(turnEnded));
    // Drain from the baseline: the completed old line's tail is a fragment
    // (fails JSON.parse, skipped); the footer is held. No stale assistant_final.
    const r2 = drainCursorTranscript(path, baseline);
    expect(r2.events.map(e => e.kind)).not.toContain('assistant_final');
    expect(r2.events.map(e => e.text)).not.toContain('OLD in-flight answer');
    // The frontier advanced to the footer's start (past the skipped fragment).
    const footerStart = Buffer.byteLength(turn1 + completed, 'utf8');
    expect(r2.newOffset).toBe(footerStart);

    // Turn 2: footer-truncating rewrite from the footer's byte position.
    const turn2 = line(userMsg('turn two')) + line(assistantFinal('answer two'));
    writeFileSync(path, turn1 + completed + turn2 + line(turnEnded));
    const r3 = drainCursorTranscript(path, r2.newOffset);
    expect(r3.events.map(e => ({ kind: e.kind, text: e.text }))).toEqual([
      { kind: 'user', text: 'turn two' },
      { kind: 'assistant_final', text: 'answer two' },
    ]);
  });

  it('group 2: partial footer tail → baseline at newOffset (footer line start), next turn not ghosted', () => {
    // Turn 1 at rest, but the footer is only partially written.
    const turn1 = line(userMsg('turn one')) + line(assistantFinal('answer one'));
    const partialFooter = '{"type":"turn_ended","status":"succ';
    writeFileSync(path, turn1 + partialFooter);
    const full = drainCursorTranscript(path, 0);
    expect(full.pendingTail).toBe(partialFooter);
    expect(classifyCursorPendingTail(full.pendingTail)).toBe('footer');
    // cursorBridgeAttach would baseline at newOffset (the footer's line start).
    const baseline = full.newOffset;
    expect(baseline).toBe(Buffer.byteLength(turn1, 'utf8'));

    // The footer completes.
    writeFileSync(path, turn1 + line(turnEnded));
    const r2 = drainCursorTranscript(path, baseline);
    expect(r2.events).toEqual([]); // footer re-parses to zero events
    expect(r2.newOffset).toBe(baseline); // held at the footer's start

    // Turn 2: footer-truncating rewrite. The new user line starts at the
    // footer's old position (= baseline). It must NOT be ghosted.
    const turn2 = line(userMsg('turn two')) + line(assistantFinal('answer two'));
    writeFileSync(path, turn1 + turn2 + line(turnEnded));
    const r3 = drainCursorTranscript(path, baseline);
    expect(r3.events.map(e => ({ kind: e.kind, text: e.text }))).toEqual([
      { kind: 'user', text: 'turn two' },
      { kind: 'assistant_final', text: 'answer two' },
    ]);
  });

  it('group 3: partial footer overwritten by new user before completing', () => {
    // Turn 1 at rest, footer partially written.
    const turn1 = line(userMsg('turn one')) + line(assistantFinal('answer one'));
    const partialFooter = '{"type":"turn_ended","status":"succ';
    writeFileSync(path, turn1 + partialFooter);
    const full = drainCursorTranscript(path, 0);
    expect(classifyCursorPendingTail(full.pendingTail)).toBe('footer');
    const baseline = full.newOffset; // hold at footer line start

    // Before the footer completes, turn 2 truncates it and writes the new
    // user line starting at the footer's old position.
    const turn2 = line(userMsg('turn two')) + line(assistantFinal('answer two'));
    writeFileSync(path, turn1 + turn2 + line(turnEnded));
    const r = drainCursorTranscript(path, baseline);
    // The partial footer is gone; the new user/final are read from the
    // footer's old position. No ghost, no stale footer.
    expect(r.events.map(e => ({ kind: e.kind, text: e.text }))).toEqual([
      { kind: 'user', text: 'turn two' },
      { kind: 'assistant_final', text: 'answer two' },
    ]);
  });

  for (const [label, ch] of [['CJK', '量'], ['emoji', '😀']] as const) {
    it(`group 4: ${label} — drain from a mid-char baseline does not drift (raw 0x0a index)`, () => {
      // A giant multibyte assistant line, then a partial tail that ends
      // mid-char. The snapshot EOF (readEndOffset) is mid-multibyte-char.
      const turn1 = line(userMsg('q')) + line(assistantFinal(ch.repeat(30000)));
      // Append a partial user line cut mid-char (3-byte CJK: E9 87 8F; cut
      // after 2 bytes so the decoded tail has a U+FFFD).
      const partialPrefix = '{"role":"user","message":{"content":[{"type":"text","text":"';
      const partialBytes = Buffer.from(partialPrefix + ch, 'utf8');
      const cutLen = partialBytes.length - 1; // drop the last byte → mid-char
      const buf = Buffer.concat([Buffer.from(turn1, 'utf8'), partialBytes.subarray(0, cutLen)]);
      writeFileSync(path, buf);
      expect(statSync(path).size).toBeGreaterThan(65536);

      const full = drainCursorTranscript(path, 0);
      // The partial tail decodes with a U+FFFD (mid-char cut).
      expect(full.pendingTail).toContain('\uFFFD');
      // readEndOffset is the snapshot EOF (mid-char).
      const baseline = full.readEndOffset;
      expect(baseline).toBe(statSync(path).size);

      // The partial completes (full char + closing JSON + newline).
      const completed = partialPrefix + ch + '"}]}' + '\n';
      writeFileSync(path, Buffer.concat([Buffer.from(turn1, 'utf8'), Buffer.from(completed, 'utf8')]));
      // Drain from the mid-char baseline. The first segment decodes with a
      // U+FFFD prefix, fails JSON.parse, and is skipped by the raw 0x0a index
      // — no drift past the true line boundary, no false events.
      const r = drainCursorTranscript(path, baseline);
      expect(r.events).toEqual([]); // fragment skipped, no false parse
      // The frontier advanced to the completed line's end (a line boundary).
      expect(r.newOffset).toBe(statSync(path).size);
    });
  }

  it('group 5: partial line with no newline across ticks — offset does not advance, no false parse', () => {
    const turn1 = line(userMsg('turn one')) + line(assistantFinal('answer one'));
    const partial = '{"role":"assistant","message":{"content":[{"type":"text","text":"still writing';
    writeFileSync(path, turn1 + partial);
    const r1 = drainCursorTranscript(path, 0);
    expect(r1.pendingTail).toBe(partial);
    expect(r1.newOffset).toBe(Buffer.byteLength(turn1, 'utf8')); // held at partial line start

    // Tick 2: the partial grows but still has no newline.
    const partial2 = partial + ' more text';
    writeFileSync(path, turn1 + partial2);
    const r2 = drainCursorTranscript(path, r1.newOffset);
    expect(r2.pendingTail).toBe(partial2);
    expect(r2.newOffset).toBe(r1.newOffset); // still held, no advance
    expect(r2.events).toEqual([]); // no false parse

    // Tick 3: still no newline, no growth (no-op).
    const r3 = drainCursorTranscript(path, r2.newOffset);
    expect(r3.newOffset).toBe(r2.newOffset);
    expect(r3.events).toEqual([]);
  });

  it('group 6a: defer (tail too short) → next tick footer completes → baseline at footer start, turn 2 not lost', () => {
    // A very short partial tail — too short to classify (could be role or
    // type). cursorBridgeAttach would defer: no baseline committed, poller
    // retries next tick.
    const turn1 = line(userMsg('turn one')) + line(assistantFinal('answer one'));
    writeFileSync(path, turn1 + '{"ty');
    const full1 = drainCursorTranscript(path, 0);
    expect(full1.pendingTail).toBe('{"ty');
    expect(classifyCursorPendingTail(full1.pendingTail)).toBe('defer');

    // Next tick: the tail grows to a complete turn_ended footer.
    writeFileSync(path, turn1 + line(turnEnded));
    const full2 = drainCursorTranscript(path, 0);
    expect(full2.pendingTail).toBe(''); // footer complete, held
    // No tail → baseline = newOffset (footer start).
    const baseline = full2.newOffset;
    expect(baseline).toBe(Buffer.byteLength(turn1, 'utf8'));

    // Turn 2: footer-truncating rewrite. First turn not lost.
    const turn2 = line(userMsg('turn two')) + line(assistantFinal('answer two'));
    writeFileSync(path, turn1 + turn2 + line(turnEnded));
    const r = drainCursorTranscript(path, baseline);
    expect(r.events.map(e => ({ kind: e.kind, text: e.text }))).toEqual([
      { kind: 'user', text: 'turn two' },
      { kind: 'assistant_final', text: 'answer two' },
    ]);
  });

  it('group 6b: defer (short tail) → grows to message discriminator → baseline at readEndOffset (skip)', () => {
    const turn1 = line(userMsg('turn one')) + line(assistantFinal('answer one'));
    writeFileSync(path, turn1 + '{"ro');
    expect(classifyCursorPendingTail(drainCursorTranscript(path, 0).pendingTail)).toBe('defer');

    // Grows to a complete message discriminator.
    const partial = '{"role":"assistant","message":{"content":[{"type":"text","text":"OLD in-flight';
    writeFileSync(path, turn1 + partial);
    const full2 = drainCursorTranscript(path, 0);
    expect(classifyCursorPendingTail(full2.pendingTail)).toBe('message');
    // Baseline = readEndOffset (skip the old in-flight line).
    expect(full2.readEndOffset).toBe(statSync(path).size);
    expect(full2.newOffset).toBe(Buffer.byteLength(turn1, 'utf8')); // footer-aware frontier
  });
});

// ── Option 3 group 8: short-read TOCTOU + snapshotComplete ───────────────
// If Cursor truncates the mirror between statSync and readSync, readSync
// returns fewer bytes than len. The drain must report snapshotComplete=false
// and readEndOffset=actual bytesRead (not the stale stat size), so the caller
// defers instead of committing a baseline past the real data.
describe('drainCursorTranscript short-read (group 8)', () => {
  const turnEnded = { type: 'turn_ended', status: 'success' };

  it('snapshotComplete=false for a missing file', () => {
    const r = drainCursorTranscript(join(dir, 'missing.jsonl'), 0);
    expect(r.snapshotComplete).toBe(false);
    expect(r.readEndOffset).toBe(0);
  });

  it('snapshotComplete=true for an empty file', () => {
    writeFileSync(path, '');
    const r = drainCursorTranscript(path, 0);
    expect(r.snapshotComplete).toBe(true);
    expect(r.readEndOffset).toBe(0);
  });

  it('snapshotComplete=true for a normal complete read', () => {
    writeFileSync(path, line(userMsg('first')) + line(assistantFinal('reply')));
    const r = drainCursorTranscript(path, 0);
    expect(r.snapshotComplete).toBe(true);
    expect(r.readEndOffset).toBe(statSync(path).size);
  });

  it('short-read (truncate between stat and read) → snapshotComplete=false, readEndOffset=actual bytesRead', () => {
    const turn1 = line(userMsg('turn one')) + line(assistantFinal('answer one'));
    writeFileSync(path, turn1 + line(turnEnded));
    const originalSize = statSync(path).size;
    // Inject a read stub that truncates the file AFTER stat but BEFORE read,
    // deterministically reproducing the stat→read truncation race.
    const deps: CursorDrainDeps = {
      read: (fd: number, buf: Buffer, offset: number, length: number, position: number) => {
        truncateSync(path, 14); // simulate Cursor truncating mid-read
        return readSync(fd, buf, offset, length, position);
      },
    };
    const r = drainCursorTranscript(path, 0, deps);
    expect(r.snapshotComplete).toBe(false);
    expect(r.readEndOffset).toBe(14); // actual bytesRead, NOT originalSize
    expect(r.readEndOffset).toBeLessThan(originalSize);
    // The caller (cursorBridgeAttach) must defer on !snapshotComplete — it
    // must NOT feed these partial events to preamble or commit a baseline.
  });

  it('short-read with a message tail → caller defers (does not commit baseline past real data)', () => {
    // Simulate the attach scenario: file has history + a partial message
    // tail, then is truncated between stat and read.
    const turn1 = line(userMsg('turn one')) + line(assistantFinal('answer one'));
    const partial = '{"role":"assistant","message":{"content":[{"type":"text","text":"OLD';
    writeFileSync(path, turn1 + partial);
    const deps: CursorDrainDeps = {
      read: (fd: number, buf: Buffer, offset: number, length: number, position: number) => {
        truncateSync(path, 20); // truncate to 20 bytes (mid history)
        return readSync(fd, buf, offset, length, position);
      },
    };
    const r = drainCursorTranscript(path, 0, deps);
    expect(r.snapshotComplete).toBe(false);
    // The caller checks snapshotComplete and defers — it never reaches the
    // classify/commit path. This test pins the contract: a short read must
    // not produce a committable frontier.
    expect(r.readEndOffset).toBe(20);
  });
});

// ── Option 3: queue-level stale-partial regression ───────────────────────
// When a spawn/resume attach skips an old in-flight message line (baseline at
// readEndOffset), the line's later completion must NOT produce a stale
// assistant_final that fingerprint-matches a newly-marked turn. The drain
// reads the completion as a fragment (skipped), so the queue never sees it.
describe('cursor transcript + queue: stale partial completion does not replay', () => {
  const turnEnded = { type: 'turn_ended', status: 'success' };

  it('old in-flight assistant completes after skip → no stale final; new turn matches cleanly', () => {
    const turn1 = line(userMsg('turn one')) + line(assistantFinal('answer one'));
    const partial = '{"role":"assistant","message":{"content":[{"type":"text","text":"OLD in-flight';
    writeFileSync(path, turn1 + partial);

    // Attach: drain from 0, classify as message, baseline at readEndOffset.
    const full = drainCursorTranscript(path, 0);
    expect(classifyCursorPendingTail(full.pendingTail)).toBe('message');
    const baseline = full.readEndOffset;

    // The old history (turn1 events) is NOT absorbed into the queue (the
    // bridge only emits the adopt preamble from them). Mark a NEW turn.
    const queue = new CodexBridgeQueue();
    queue.mark('turn-2', 'turn two prompt');

    // The old partial completes + footer. Drain from the baseline: the
    // completion is a fragment (skipped), so no stale assistant_final is
    // ingested into the queue.
    const completed = partial + ' answer"}]}' + '\n';
    writeFileSync(path, turn1 + completed + line(turnEnded));
    const r2 = drainCursorTranscript(path, baseline);
    queue.ingest(r2.events);
    // No stale final matched the new mark.
    const pending = (queue as any).queue as any[];
    expect(pending[0]?.started).toBeFalsy();

    // Turn 2's user line is appended (after the footer-truncating rewrite).
    const turn2 = line(userMsg('turn two prompt')) + line(assistantFinal('answer two'));
    writeFileSync(path, turn1 + completed + turn2 + line(turnEnded));
    const r3 = drainCursorTranscript(path, r2.newOffset);
    queue.ingest(r3.events);
    // The new user event fingerprint-matched the mark → the turn started.
    expect(pending[0]?.started).toBe(true);
  });
});
