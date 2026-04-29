/**
 * Tests for the JSONL transcript reader used by adopt-bridge mode.
 *
 *   - drainTranscript handles missing files, half-written tail lines,
 *     truncation, and malformed lines without throwing.
 *   - pickAssistantTextEvents filters out user / sidechain / tool-only events.
 *   - extractAssistantText / joinAssistantText concatenate multi-block text.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, openSync, writeSync, closeSync, ftruncateSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  drainTranscript,
  pickAssistantTextEvents,
  extractAssistantText,
  joinAssistantText,
  findLatestJsonl,
  findJsonlContainingFingerprint,
  type TranscriptEvent,
} from '../src/services/claude-transcript.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bmx-tx-'));
  path = join(dir, 'session.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function appendLine(obj: unknown): void {
  appendFileSync(path, JSON.stringify(obj) + '\n', 'utf8');
}

describe('drainTranscript', () => {
  it('returns empty result when file does not exist', () => {
    const r = drainTranscript('/no/such/file.jsonl', 0);
    expect(r.events).toEqual([]);
    expect(r.newOffset).toBe(0);
  });

  it('reads complete lines, leaves trailing partial line for next drain', () => {
    appendLine({ type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } });
    // half line at the end (no \n yet)
    appendFileSync(path, '{"type":"assistant","uuid":"u2"', 'utf8');
    const r = drainTranscript(path, 0);
    expect(r.events.length).toBe(1);
    expect(r.events[0].uuid).toBe('u1');
    expect(r.pendingTail).toContain('"u2"');
    // newOffset must point at end of complete line, not the partial tail
    expect(r.newOffset).toBeLessThan(JSON.stringify({ type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }).length + 50);
  });

  it('continues from newOffset on subsequent drains', () => {
    appendLine({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'one' } });
    const r1 = drainTranscript(path, 0);
    expect(r1.events.length).toBe(1);
    appendLine({ type: 'assistant', uuid: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } });
    const r2 = drainTranscript(path, r1.newOffset);
    expect(r2.events.length).toBe(1);
    expect(r2.events[0].uuid).toBe('u2');
  });

  it('skips malformed JSON lines silently', () => {
    appendFileSync(path, 'not-json\n', 'utf8');
    appendLine({ type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
    const r = drainTranscript(path, 0);
    expect(r.events.length).toBe(1);
    expect(r.events[0].uuid).toBe('u1');
  });

  it('detects shrinkage (size < lastOffset) and re-reads from 0', () => {
    // We don't claim to handle full file rotation (rare in practice — Claude
    // Code keeps one JSONL per session and never truncates), but we DO need
    // to recover when the file's current size is smaller than the offset we
    // held — otherwise the next drain would read garbage from a stale offset.
    appendLine({ type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'this-is-quite-a-long-payload-here-for-bytes' }] } });
    const r1 = drainTranscript(path, 0);
    const fd = openSync(path, 'r+');
    try { ftruncateSync(fd, 0); } finally { closeSync(fd); }
    appendLine({ type: 'assistant', uuid: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: 'short' }] } });
    const r2 = drainTranscript(path, r1.newOffset);
    expect(r2.events.find(e => e.uuid === 'u2')).toBeDefined();
  });
});

describe('pickAssistantTextEvents', () => {
  it('keeps assistant text events with uuid', () => {
    const events: TranscriptEvent[] = [
      { type: 'assistant', uuid: 'a', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    ];
    expect(pickAssistantTextEvents(events).map(e => e.uuid)).toEqual(['a']);
  });

  it('drops user events', () => {
    const events: TranscriptEvent[] = [
      { type: 'user', uuid: 'u', message: { role: 'user', content: 'hi' } },
    ];
    expect(pickAssistantTextEvents(events)).toEqual([]);
  });

  it('drops sidechain (sub-agent) events', () => {
    const events: TranscriptEvent[] = [
      { type: 'assistant', uuid: 's', message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] }, ...({ isSidechain: true } as any) },
    ];
    expect(pickAssistantTextEvents(events)).toEqual([]);
  });

  it('drops tool_use-only events (no text block)', () => {
    const events: TranscriptEvent[] = [
      { type: 'assistant', uuid: 't', message: { role: 'assistant', content: [{ type: 'tool_use', text: undefined } as any] } },
    ];
    expect(pickAssistantTextEvents(events)).toEqual([]);
  });

  it('drops events without uuid', () => {
    const events: TranscriptEvent[] = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'no-uuid' }] } },
    ];
    expect(pickAssistantTextEvents(events)).toEqual([]);
  });
});

describe('extractAssistantText / joinAssistantText', () => {
  it('joins multiple text blocks of one event with blank lines', () => {
    const ev: TranscriptEvent = {
      type: 'assistant',
      uuid: 'a',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'part-one' },
          { type: 'tool_use' } as any,
          { type: 'text', text: 'part-two' },
        ],
      },
    };
    expect(extractAssistantText(ev)).toBe('part-one\n\npart-two');
  });

  it('handles bare-string content (legacy schema)', () => {
    const ev: TranscriptEvent = {
      type: 'assistant',
      uuid: 'a',
      message: { role: 'assistant', content: 'hi-from-old-schema' as any },
    };
    expect(extractAssistantText(ev)).toBe('hi-from-old-schema');
  });

  it('joinAssistantText filters then concatenates multiple events', () => {
    const events: TranscriptEvent[] = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'q' } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } },
      { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } },
    ];
    expect(joinAssistantText(events)).toBe('first\n\nsecond');
  });

  it('returns empty string for empty input', () => {
    expect(joinAssistantText([])).toBe('');
  });
});

describe('findLatestJsonl', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'bmx-latest-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeJsonl(name: string, mtimeSec: number): string {
    const full = join(projectDir, name);
    writeFileSync(full, '');
    utimesSync(full, mtimeSec, mtimeSec);
    return full;
  }

  it('returns null when the directory does not exist', () => {
    expect(findLatestJsonl('/no/such/dir')).toBeNull();
  });

  it('returns null when the directory has no jsonl files', () => {
    writeFileSync(join(projectDir, 'README.md'), '');
    writeFileSync(join(projectDir, 'something.txt'), '');
    expect(findLatestJsonl(projectDir)).toBeNull();
  });

  it('picks the most recently modified jsonl', () => {
    writeJsonl('old.jsonl', 1_000_000);
    const newer = writeJsonl('new.jsonl', 2_000_000);
    writeJsonl('older.jsonl', 500_000);
    expect(findLatestJsonl(projectDir)).toBe(newer);
  });

  it('detects /clear scenario: a new jsonl appears, latest result follows it', () => {
    const original = writeJsonl('aaa.jsonl', 1_000_000);
    expect(findLatestJsonl(projectDir)).toBe(original);
    // user runs /clear → Claude Code creates a brand-new sessionId.jsonl
    const fresh = writeJsonl('bbb.jsonl', 2_000_000);
    expect(findLatestJsonl(projectDir)).toBe(fresh);
    expect(findLatestJsonl(projectDir)).not.toBe(original);
  });

  it('ignores non-.jsonl files even when they are newer', () => {
    writeJsonl('session.jsonl', 1_000_000);
    const txt = join(projectDir, 'note.txt');
    writeFileSync(txt, '');
    utimesSync(txt, 5_000_000, 5_000_000);
    expect(findLatestJsonl(projectDir)).toBe(join(projectDir, 'session.jsonl'));
  });
});

describe('findJsonlContainingFingerprint', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'bmx-fp-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeJsonl(name: string, body: string, mtimeSec = 1_000_000): string {
    const full = join(projectDir, name);
    writeFileSync(full, body);
    utimesSync(full, mtimeSec, mtimeSec);
    return full;
  }

  it('returns null when nothing contains the fingerprint', () => {
    writeJsonl('a.jsonl', '{"type":"user","message":{"role":"user","content":"hello world"}}\n');
    expect(findJsonlContainingFingerprint(projectDir, 'lark-specific-string')).toBeNull();
  });

  it('finds the file whose payload includes the fingerprint', () => {
    writeJsonl('a.jsonl', '{"type":"user","message":{"role":"user","content":"random chatter"}}\n');
    const target = writeJsonl('b.jsonl', '{"type":"user","message":{"role":"user","content":"please review the new patch"}}\n');
    expect(findJsonlContainingFingerprint(projectDir, 'please review the new patch')).toBe(target);
  });

  it('skips the excluded path (the current watcher target)', () => {
    const userEv = '{"type":"user","message":{"role":"user","content":"please review the new patch"}}\n';
    const current = writeJsonl('current.jsonl', userEv, 1_000_000);
    const newer = writeJsonl('newer.jsonl', userEv, 2_000_000);
    expect(findJsonlContainingFingerprint(projectDir, 'please review the new patch', current)).toBe(newer);
  });

  it('prefers the newer jsonl when multiple contain the fingerprint', () => {
    const userEv = '{"type":"user","message":{"role":"user","content":"hello world"}}\n';
    writeJsonl('older.jsonl', userEv, 1_000_000);
    const newer = writeJsonl('newer.jsonl', userEv, 5_000_000);
    expect(findJsonlContainingFingerprint(projectDir, 'hello world')).toBe(newer);
  });

  it('returns null when the directory does not exist', () => {
    expect(findJsonlContainingFingerprint('/no/such/dir', 'anything')).toBeNull();
  });

  it('returns null on empty fingerprint (defensive — would otherwise match every file)', () => {
    writeJsonl('a.jsonl', 'whatever');
    expect(findJsonlContainingFingerprint(projectDir, '')).toBeNull();
  });

  it('matches across JSON-escaped newlines (multi-line Lark message)', () => {
    // Lark message has real newlines: "please\nreview\nthe patch"
    // makeFingerprint() collapses → "please review the patch"
    // Claude jsonl writes content as a JSON-encoded string, so newlines are
    // serialized as \n on disk. Raw includes() would miss; parse + normalise
    // must succeed.
    const fp = 'please review the patch';
    const writer = (path: string) => {
      const ev = { type: 'user', uuid: 'u1', message: { role: 'user', content: 'please\nreview\nthe patch — extra context appended' } };
      writeFileSync(path, JSON.stringify(ev) + '\n');
    };
    const target = join(projectDir, 'multiline.jsonl');
    writer(target);
    utimesSync(target, 1_000_000, 1_000_000);
    expect(findJsonlContainingFingerprint(projectDir, fp)).toBe(target);
  });

  it('matches user content stored as an array of blocks', () => {
    // Some user events use the array-of-blocks form: content: [{type:'text',text:'...'}]
    // stringifyUserContent must extract text from the blocks before compare.
    const fp = 'review my patch';
    const ev = {
      type: 'user',
      uuid: 'u2',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'review my patch please' },
          { type: 'image', source: { type: 'base64', data: '...' } },
        ],
      },
    };
    const target = join(projectDir, 'array-content.jsonl');
    writeFileSync(target, JSON.stringify(ev) + '\n');
    utimesSync(target, 1_000_000, 1_000_000);
    expect(findJsonlContainingFingerprint(projectDir, fp)).toBe(target);
  });

  it('does NOT match fingerprint that only appears in non-user events', () => {
    // A jsonl where the fingerprint string appears in an assistant or
    // system event but never in a user event must not be selected — we
    // only key off user input to identify the active session.
    const fp = 'spurious-fingerprint';
    const target = join(projectDir, 'red-herring.jsonl');
    writeFileSync(
      target,
      JSON.stringify({ type: 'user', uuid: 'u', message: { role: 'user', content: 'completely different' } }) + '\n' +
      JSON.stringify({ type: 'assistant', uuid: 'a', message: { role: 'assistant', content: [{ type: 'text', text: 'spurious-fingerprint mentioned in reply' }] } }) + '\n',
    );
    utimesSync(target, 1_000_000, 1_000_000);
    expect(findJsonlContainingFingerprint(projectDir, fp)).toBeNull();
  });

  it('matches queue-operation enqueue content only when explicitly enabled', () => {
    const fp = 'queued follow-up';
    const target = join(projectDir, 'queued.jsonl');
    writeFileSync(
      target,
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'queued follow-up for Claude' }) + '\n',
    );
    utimesSync(target, 1_000_000, 1_000_000);

    expect(findJsonlContainingFingerprint(projectDir, fp)).toBeNull();
    expect(findJsonlContainingFingerprint(projectDir, fp, { includeQueueOperations: true })).toBe(target);
  });

  it('can ignore stale jsonl files by mtime', () => {
    writeJsonl(
      'old.jsonl',
      '{"type":"user","message":{"role":"user","content":"repeatable short prompt"}}\n',
      1_000_000,
    );
    const fresh = writeJsonl(
      'fresh.jsonl',
      '{"type":"user","message":{"role":"user","content":"repeatable short prompt"}}\n',
      2_000_000,
    );

    expect(findJsonlContainingFingerprint(projectDir, 'repeatable short prompt', {
      minMtimeMs: 1_500_000_000,
    })).toBe(fresh);
  });

  it('skips malformed jsonl lines gracefully', () => {
    // A half-flushed line at the head + a real user event after it.
    const fp = 'real fingerprint';
    const target = join(projectDir, 'mixed.jsonl');
    writeFileSync(
      target,
      'this-is-not-json-at-all\n' +
      JSON.stringify({ type: 'user', uuid: 'u', message: { role: 'user', content: 'real fingerprint here' } }) + '\n',
    );
    utimesSync(target, 1_000_000, 1_000_000);
    expect(findJsonlContainingFingerprint(projectDir, fp)).toBe(target);
  });

  it('does not hijack on sibling pane traffic in the same cwd', () => {
    const userPane = writeJsonl(
      'user-session.jsonl',
      '{"type":"user","message":{"role":"user","content":"please run the bridge tests"}}\n',
      2_000_000,
    );
    writeJsonl(
      'sibling-pane.jsonl',
      '{"type":"user","message":{"role":"user","content":"refactor the UI components"}}\n'.repeat(50),
      3_000_000,
    );
    expect(findJsonlContainingFingerprint(projectDir, 'please run the bridge tests')).toBe(userPane);
  });
});

// ─── Bridge rotation integration ───────────────────────────────────────────
//
// Reproduces the P1 case from review of 0926f3d: when sessionId rotation
// switches the watched jsonl mid-flight, any unread bytes on the OLD path
// must still drive an emit. The fix is two-part:
//   1. drainPathInto(oldPath) before switching — pulls trailing events into
//      the queue so they participate in attribution.
//   2. BridgePendingTurn.sourceJsonlPath stamped at start-time — lets emit-
//      time uuid → text resolution read from the original transcript even
//      after the global current path has moved.
// The test exercises both via the real filesystem (no fs.watch / IPC).
import { BridgeTurnQueue } from '../src/services/bridge-turn-queue.js';

describe('bridge rotation: drain + emit before switch', () => {
  it('does not lose an in-flight reply when pid resolver switches paths', () => {
    const oldPath = join(dir, 'old-session.jsonl');
    const newPath = join(dir, 'new-session.jsonl');
    writeFileSync(oldPath, '');
    writeFileSync(newPath, '');

    const queue = new BridgeTurnQueue();
    queue.mark('t1', 'hello bridge');

    // Claude writes the user event AND the assistant reply to the OLD jsonl.
    // The fallback poller hasn't seen the assistant yet — only the user
    // event has been ingested. Then a sessionId rotation flips the pid
    // file, the resolver wants to switch to newPath, and the assistant
    // line is "still" on oldPath.
    appendFileSync(
      oldPath,
      JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello bridge — please reply' } }) + '\n',
      'utf8',
    );
    let oldOffset = 0;
    {
      const r = drainTranscript(oldPath, oldOffset);
      queue.ingest(r.events, oldPath);
      oldOffset = r.newOffset;
    }
    // Turn should be started but text not yet known.
    const startedTurn = queue.peek().find(t => t.turnId === 't1');
    expect(startedTurn?.started).toBe(true);
    expect(startedTurn?.sourceJsonlPath).toBe(oldPath);
    expect(startedTurn?.assistantUuids).toEqual([]);

    // Now Claude appends the assistant text to oldPath — fs.watch missed
    // it (best-effort). The pid resolver fires before the fallback poll.
    appendFileSync(
      oldPath,
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'reply text from rotated jsonl' }] } }) + '\n',
      'utf8',
    );

    // Pre-switch protocol: drain remaining bytes on oldPath one last time.
    {
      const r = drainTranscript(oldPath, oldOffset);
      queue.ingest(r.events, oldPath);
    }

    // Switch to newPath: future ingests stamp newPath, but emits for
    // turns started on oldPath must still resolve there.
    const ready = queue.drainEmittable();
    expect(ready).toHaveLength(1);
    expect(ready[0].sourceJsonlPath).toBe(oldPath);
    expect(ready[0].assistantUuids).toEqual(['a1']);

    // Emit-time text resolution: read the source path of each turn, NOT
    // the global current path. Without sourceJsonlPath, draining newPath
    // here would return zero events and the reply would be lost.
    const drainedFromSource = drainTranscript(ready[0].sourceJsonlPath!, 0);
    const matched = drainedFromSource.events.filter(e => e.uuid && ready[0].assistantUuids.includes(e.uuid));
    expect(joinAssistantText(matched)).toBe('reply text from rotated jsonl');
  });

  it('rotation drain+switch does NOT emit ready turns; only idle path emits', () => {
    // Codex review of 4036fcc P1.1: drainEmittable's contract is "has visible
    // text", not "model finished". If the rotation helper invoked emit
    // during a non-idle fs.watch / poll tick, half-finished assistant text
    // would be flushed to Lark prematurely. The rotation helpers must only
    // ingest into the queue; emit is reserved for idle-driven ticks.
    const oldPath = join(dir, 'old-session.jsonl');
    writeFileSync(oldPath, '');

    const queue = new BridgeTurnQueue();
    queue.mark('t1', 'hello bridge');

    // Mid-turn snapshot: user landed + a *partial* assistant text block.
    // (Claude often emits multiple assistant events within one turn —
    // drainEmittable can't distinguish "finished" from "still streaming".)
    appendFileSync(
      oldPath,
      JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello bridge — please reply' } }) + '\n' +
      JSON.stringify({ type: 'assistant', uuid: 'a-partial', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking...' }] } }) + '\n',
      'utf8',
    );

    // Simulate the rotation-helper code path: drain into queue, do NOT
    // call drainEmittable. The original-design "emit only at idle" rule
    // means publication is gated on the idle handler.
    const r = drainTranscript(oldPath, 0);
    queue.ingest(r.events, oldPath);

    // Until idle fires, the turn must remain in the queue (not be popped
    // and emitted by the rotation tick).
    expect(queue.peek()).toHaveLength(1);
    expect(queue.peek()[0].started).toBe(true);
    expect(queue.peek()[0].assistantUuids).toEqual(['a-partial']);
  });

  it('keeps polling old path until in-flight turn arrives, then emits', () => {
    // Codex P1.2: after rotation switches the primary path away, an
    // in-flight turn whose assistant text hasn't landed yet must still
    // get its append picked up. Modeled here as the secondary-path
    // polling loop the worker uses: drain each retained path on every
    // tick, queue ingests with that path as the source stamp.
    const oldPath = join(dir, 'old-session.jsonl');
    const newPath = join(dir, 'new-session.jsonl');
    writeFileSync(oldPath, '');
    writeFileSync(newPath, '');

    const queue = new BridgeTurnQueue();
    queue.mark('t1', 'hello bridge');

    // tick 1 — user lands on old path; turn starts there.
    appendFileSync(
      oldPath,
      JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello bridge — please reply' } }) + '\n',
      'utf8',
    );
    let oldOffset = 0;
    {
      const r = drainTranscript(oldPath, oldOffset);
      queue.ingest(r.events, oldPath);
      oldOffset = r.newOffset;
    }
    // Rotation: pid file now points at newPath. We drain old once more
    // (still no assistant) and retain it as a secondary path because the
    // turn started there.
    {
      const r = drainTranscript(oldPath, oldOffset);
      queue.ingest(r.events, oldPath);
      oldOffset = r.newOffset;
    }
    const secondaryPaths = new Map<string, number>();
    if (queue.peek().some(t => t.sourceJsonlPath === oldPath)) {
      secondaryPaths.set(oldPath, oldOffset);
    }
    expect(secondaryPaths.has(oldPath)).toBe(true);

    // tick 2 — assistant finally lands on old path (Claude finished
    // mid-rotation). The secondary-path drain picks it up.
    appendFileSync(
      oldPath,
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'late but valid reply' }] } }) + '\n',
      'utf8',
    );
    for (const [path, off] of secondaryPaths) {
      const r = drainTranscript(path, off);
      queue.ingest(r.events, path);
      secondaryPaths.set(path, r.newOffset);
    }

    // Idle tick: emit. Turn resolves text from oldPath via sourceJsonlPath.
    const ready = queue.drainEmittable();
    expect(ready).toHaveLength(1);
    expect(ready[0].sourceJsonlPath).toBe(oldPath);
    const drained = drainTranscript(ready[0].sourceJsonlPath!, 0);
    const matched = drained.events.filter(e => e.uuid && ready[0].assistantUuids.includes(e.uuid));
    expect(joinAssistantText(matched)).toBe('late but valid reply');
  });
});
