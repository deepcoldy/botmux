import { describe, it, expect } from 'vitest';
import {
  writeRunnerInput,
  chunkAscii,
  encodeRunnerInput,
  RUNNER_INPUT_CHUNK_BYTES,
} from '../src/adapters/cli/runner-input.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

const MARKER = '::botmux-codex-app:';

/** Fake tmux-mode PtyHandle that records sendText/sendSpecialKeys calls.
 *  `failTextAt` drops a specific chunk; `failEnter` makes every Enter report a
 *  dropped keystroke (mirrors TmuxPipeBackend returning false on a pane-alive
 *  send-keys failure). */
function fakeTmuxPty(opts: { failTextAt?: number; failEnter?: boolean } = {}) {
  const textChunks: string[] = [];
  let textCalls = 0;
  let enterCalls = 0;
  const pty: PtyHandle = {
    write() {
      throw new Error('tmux-mode pty should not use write()');
    },
    sendText(text: string) {
      const idx = textCalls++;
      if (opts.failTextAt === idx) return false;
      textChunks.push(text);
      return true;
    },
    sendSpecialKeys() {
      enterCalls++;
      return opts.failEnter ? false : true;
    },
  };
  return { pty, textChunks, enterCount: () => enterCalls };
}

/** Fake raw-PTY handle (no tmux send methods): exercises the write() fallback. */
function fakeRawPty(opts: { throwOnWrite?: boolean } = {}) {
  const writes: string[] = [];
  const pty: PtyHandle = {
    write(data: string) {
      if (opts.throwOnWrite) throw new Error('pty gone');
      writes.push(data);
    },
  };
  return { pty, writes };
}

/** Faithful mirror of codex-app-runner.ts / mira-runner.ts handleInput buffer
 *  logic: accumulate stdin bytes, enqueue (and base64-decode the control line)
 *  only on a newline. Used to prove no cross-message buffer contamination. */
function makeRunnerSim() {
  let buf = '';
  const enqueued: string[] = [];
  const bad: string[] = [];
  return {
    feed(s: string) {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          const t = buf.trim();
          buf = '';
          if (!t) continue; // blank line ignored (enqueueLine early-return)
          if (t.startsWith(MARKER)) {
            try {
              const d = JSON.parse(Buffer.from(t.slice(MARKER.length), 'base64').toString('utf8'));
              if (d?.type === 'message' && typeof d.content === 'string') enqueued.push(d.content);
              else bad.push('shape');
            } catch { bad.push('decode'); }
          } else {
            bad.push('raw:' + t.slice(0, 20));
          }
        } else {
          buf += ch;
        }
      }
    },
    enqueued,
    bad,
    get buf() { return buf; },
  };
}

/** Fake pty that drives a runner sim: text chunks feed the runner unless dropped;
 *  Enter feeds a newline. */
function fakeRunnerPty(runner: ReturnType<typeof makeRunnerSim>, opts: { dropTextAt?: number } = {}) {
  let textCalls = 0;
  const pty: PtyHandle = {
    write() { throw new Error('unused'); },
    sendText(text: string) {
      const idx = textCalls++;
      if (opts.dropTextAt === idx) return false; // dropped: runner never sees these bytes
      runner.feed(text);
      return true;
    },
    sendSpecialKeys() {
      runner.feed('\r');
      return true;
    },
  };
  return pty;
}

describe('chunkAscii', () => {
  it('splits into <=maxBytes pieces and rejoins losslessly', () => {
    const s = 'x'.repeat(2500);
    const chunks = chunkAscii(s, 1024);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].length).toBe(1024);
    expect(chunks[2].length).toBe(452);
    expect(chunks.join('')).toBe(s);
  });

  it('returns a single chunk when under the limit', () => {
    expect(chunkAscii('abc', 1024)).toEqual(['abc']);
  });
});

describe('writeRunnerInput — tmux mode', () => {
  it('chunks a large (>4KB) payload, every chunk within the byte cap, then submits', async () => {
    const big = 'A'.repeat(15_000);
    const { pty, textChunks, enterCount } = fakeTmuxPty();

    const res = await writeRunnerInput(pty, MARKER, big);

    expect(res).toEqual({ submitted: true });
    expect(textChunks.length).toBeGreaterThan(1);
    for (const c of textChunks) expect(c.length).toBeLessThanOrEqual(RUNNER_INPUT_CHUNK_BYTES);
    // pre-flush Enter + submit Enter on the happy path.
    expect(enterCount()).toBe(2);
  });

  it('reassembled chunks decode back to the original content (no corruption, no stray newline)', async () => {
    const original = 'multi\nline\tmessage with 💥 unicode ' + 'z'.repeat(5000);
    const { pty, textChunks } = fakeTmuxPty();

    await writeRunnerInput(pty, MARKER, original);

    const line = textChunks.join('');
    expect(line.startsWith(MARKER)).toBe(true);
    expect(line).not.toContain('\n');
    expect(line).not.toContain('\r');
    const decoded = JSON.parse(Buffer.from(line.slice(MARKER.length), 'base64').toString('utf8'));
    expect(decoded).toEqual({ type: 'message', content: original });
  });

  it('the joined text chunks equal marker + encodeRunnerInput(content)', async () => {
    const content = 'hello world';
    const { pty, textChunks } = fakeTmuxPty();
    await writeRunnerInput(pty, MARKER, content);
    expect(textChunks.join('')).toBe(MARKER + encodeRunnerInput(content));
  });

  it('keeps the legacy JSON shape exact unless a Codex App sidecar is explicitly provided', async () => {
    const legacy = JSON.parse(Buffer.from(encodeRunnerInput('hello'), 'base64').toString('utf8'));
    expect(legacy).toEqual({ type: 'message', content: 'hello' });

    const encoded = encodeRunnerInput('legacy prompt', {
      text: 'clean text',
      additionalContext: { botmux_sender: { kind: 'untrusted', value: 'Alice' } },
      clientUserMessageId: 'om_1',
    });
    expect(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))).toEqual({
      type: 'message',
      content: 'legacy prompt',
      codexAppInput: {
        text: 'clean text',
        additionalContext: { botmux_sender: { kind: 'untrusted', value: 'Alice' } },
        clientUserMessageId: 'om_1',
      },
    });
  });

  it('reports submitted:false and flushes the partial when a chunk is dropped', async () => {
    const big = 'B'.repeat(15_000);
    const { pty, textChunks, enterCount } = fakeTmuxPty({ failTextAt: 2 });

    const res = await writeRunnerInput(pty, MARKER, big);

    expect(res).toEqual({ submitted: false });
    // Chunks 0 and 1 landed; chunk 2 failed and we bailed.
    expect(textChunks).toHaveLength(2);
    // pre-flush Enter + flush-on-failure Enter — the partial line gets terminated.
    expect(enterCount()).toBe(2);
  });

  it('pre-flush gate: when every Enter is dropped, bail submitted:false WITHOUT writing any chunk', async () => {
    const { pty, textChunks } = fakeTmuxPty({ failEnter: true });
    const res = await writeRunnerInput(pty, MARKER, 'short message');
    expect(res).toEqual({ submitted: false });
    // The pre-flush Enter never lands, so we must not write the control line
    // onto a possibly-dirty buffer.
    expect(textChunks).toHaveLength(0);
  });
});

describe('writeRunnerInput — raw PTY fallback', () => {
  it('writes the whole line + CR in one shot and reports submitted:true', async () => {
    const content = 'fallback path';
    const { pty, writes } = fakeRawPty();
    const res = await writeRunnerInput(pty, MARKER, content);
    expect(res).toEqual({ submitted: true });
    expect(writes).toEqual([MARKER + encodeRunnerInput(content) + '\r']);
  });

  it('reports submitted:false when the raw write throws (pane gone)', async () => {
    const { pty } = fakeRawPty({ throwOnWrite: true });
    const res = await writeRunnerInput(pty, MARKER, 'x');
    expect(res).toEqual({ submitted: false });
  });
});

// Codex review 🔴 regression: a partial write must NOT corrupt the next message.
describe('writeRunnerInput — runner buffer hygiene (no cross-message contamination)', () => {
  it('a dropped chunk leaves the runner buffer clean so the NEXT message decodes intact', async () => {
    const runner = makeRunnerSim();

    // Message A: drop chunk 2 mid-stream.
    const big = 'A'.repeat(15_000);
    const resA = await writeRunnerInput(fakeRunnerPty(runner, { dropTextAt: 2 }), MARKER, big);
    expect(resA).toEqual({ submitted: false });
    // A never enqueues intact; its partial got flushed (discarded as bad input),
    // so the runner buffer is empty — nothing left to prepend to the next line.
    expect(runner.enqueued).not.toContain(big);
    expect(runner.buf).toBe('');

    // Message B through the SAME runner: must arrive intact, not merged with A.
    const resB = await writeRunnerInput(fakeRunnerPty(runner), MARKER, 'clean message B');
    expect(resB).toEqual({ submitted: true });
    expect(runner.enqueued).toContain('clean message B');
  });

  it('back-to-back successful messages each enqueue exactly once, in order', async () => {
    const runner = makeRunnerSim();
    await writeRunnerInput(fakeRunnerPty(runner), MARKER, 'first');
    await writeRunnerInput(fakeRunnerPty(runner), MARKER, 'second');
    expect(runner.enqueued).toEqual(['first', 'second']);
    expect(runner.bad).toEqual([]);
    expect(runner.buf).toBe('');
  });

  // Codex re-review 🔴: failure-flush Enter ALSO drops, then the next message's
  // pre-flush Enter ALSO drops. The old code would write the next line onto the
  // dirty buffer and (if its submit Enter landed) falsely report submitted:true
  // while the runner only saw a parse error — a silent message loss. The
  // pre-flush gate must prevent that.
  it('pre-flush gate blocks a write onto a dirty buffer — no false submitted:true, no corruption', async () => {
    const runner = makeRunnerSim();
    // Stateful driver spanning both calls; script global text/enter drop indices.
    let textIdx = 0;
    let enterIdx = 0;
    const dropText = new Set<number>();
    const dropEnter = new Set<number>();
    const pty: PtyHandle = {
      write() { throw new Error('unused'); },
      sendText(t: string) { const i = textIdx++; if (dropText.has(i)) return false; runner.feed(t); return true; },
      sendSpecialKeys() { const i = enterIdx++; if (dropEnter.has(i)) return false; runner.feed('\r'); return true; },
    };

    // Message A: a >=3-chunk payload; drop the last chunk so a partial lingers,
    // and drop ALL of A's failure-flush Enter retries so the partial is NOT
    // flushed. (A pre-flush = enter 0 lands; failure-flush = enters 1,2,3 drop.)
    const aContent = 'A'.repeat(2000);
    const aChunks = chunkAscii(MARKER + encodeRunnerInput(aContent), RUNNER_INPUT_CHUNK_BYTES);
    expect(aChunks.length).toBeGreaterThanOrEqual(3);
    dropText.add(aChunks.length - 1);
    dropEnter.add(1); dropEnter.add(2); dropEnter.add(3);
    const a = await writeRunnerInput(pty, MARKER, aContent);
    expect(a).toEqual({ submitted: false });
    expect(runner.buf).not.toBe('');            // A's partial is stuck in the buffer

    // Message B: drop ALL of B's pre-flush Enter retries (enters 4,5,6). The gate
    // must refuse to write B's chunks and report submitted:false.
    dropEnter.add(4); dropEnter.add(5); dropEnter.add(6);
    const textBefore = textIdx;
    const b = await writeRunnerInput(pty, MARKER, 'message B');
    expect(b).toEqual({ submitted: false });    // NOT a false success
    expect(textIdx).toBe(textBefore);           // zero chunks written for B
    expect(runner.enqueued).not.toContain('message B');
    expect(runner.bad).not.toContain('shape');  // no merged bad line attributed as submitted

    // Recovery: a clean B' (all Enters land) pre-flushes A's stuck partial
    // (discarded as bad), then enqueues intact.
    const cleanRunnerPty = fakeRunnerPty(runner); // fresh counters, no drops
    const bb = await writeRunnerInput(cleanRunnerPty, MARKER, 'message B prime');
    expect(bb).toEqual({ submitted: true });
    expect(runner.enqueued).toContain('message B prime');
    expect(runner.enqueued).not.toContain('message B');
  });
});
