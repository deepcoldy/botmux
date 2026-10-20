import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCodexAdapter } from '../src/adapters/cli/codex.js';

// `codex resume` maps a botmux session id to Codex's own id through
// history.jsonl. The resume path used to slurp the whole file; it now shares the
// bounded, hardened tail scan in codex-transcript. These pin the behaviour the
// old whole-file reader had so the swap stays invisible.

let home: string;
let prev: string | undefined;
const adapter = createCodexAdapter('codex');

beforeEach(() => {
  prev = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), 'bmx-codex-resume-'));
  process.env.CODEX_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

const entry = (sid: string | undefined, text: string) =>
  JSON.stringify(sid === undefined ? { text } : { session_id: sid, text });
const resumeFor = (botmuxSid: string) => adapter.buildResumeCommand!({ sessionId: botmuxSid } as never);

describe('codex resume: history.jsonl lookup by botmux session id', () => {
  it('returns the newest mapping and prefers a persisted cliSessionId', () => {
    writeFileSync(join(home, 'history.jsonl'), [
      entry('codex-old', 'a <session_id>bm-1</session_id>'),
      entry('codex-other', 'unrelated'),
      entry('codex-new', 'b <session_id>bm-1</session_id>'),
    ].join('\n') + '\n');
    expect(resumeFor('bm-1')).toBe('codex resume codex-new');
    expect(adapter.buildResumeCommand!({ sessionId: 'bm-1', cliSessionId: 'persisted' } as never))
      .toBe('codex resume persisted');
  });

  it('finds a mapping far older than the 4 MiB tail window (resume has no cap)', () => {
    const filler = entry('pad', 'x'.repeat(1000));
    const padding = Array.from({ length: 4600 }, () => filler).join('\n'); // ~4.6 MB
    writeFileSync(join(home, 'history.jsonl'), `${entry('codex-ancient', '<session_id>bm-old</session_id>')}\n${padding}\n`);
    expect(resumeFor('bm-old')).toBe('codex resume codex-ancient');
  });

  it('falls through a mention that has no session_id to an older one', () => {
    writeFileSync(join(home, 'history.jsonl'), [
      entry('codex-mapped', '<session_id>bm-2</session_id>'),
      entry(undefined, 'orphan <session_id>bm-2</session_id>'),
    ].join('\n') + '\n');
    expect(resumeFor('bm-2')).toBe('codex resume codex-mapped');
  });

  it('skips non-JSON lines and entries whose text only echoes the marker in another field', () => {
    writeFileSync(join(home, 'history.jsonl'), [
      entry('codex-real', '<session_id>bm-3</session_id>'),
      'not json but mentions bm-3',
      JSON.stringify({ session_id: 'codex-decoy', text: 'nothing', note: 'bm-3' }),
      '',
    ].join('\n'));
    expect(resumeFor('bm-3')).toBe('codex resume codex-real');
  });

  it('matches ids that need JSON escaping and a final line without a trailing newline', () => {
    const odd = 'bm"quote\\slash';
    writeFileSync(join(home, 'history.jsonl'), `${entry('codex-odd', `x ${odd} y`)}`);
    expect(resumeFor(odd)).toBe('codex resume codex-odd');
  });

  it('returns null for an unknown id, an empty file and a missing file', () => {
    expect(resumeFor('bm-none')).toBeNull();
    writeFileSync(join(home, 'history.jsonl'), '');
    expect(resumeFor('bm-none')).toBeNull();
    writeFileSync(join(home, 'history.jsonl'), `${entry('c', 'other')}\n`);
    expect(resumeFor('bm-none')).toBeNull();
  });

  it('follows a symlinked history.jsonl (user-managed CODEX_HOME, no noFollow)', () => {
    const real = join(home, 'real-history.jsonl');
    writeFileSync(real, `${entry('codex-linked', '<session_id>bm-4</session_id>')}\n`);
    symlinkSync(real, join(home, 'history.jsonl'));
    expect(resumeFor('bm-4')).toBe('codex resume codex-linked');
  });
});
