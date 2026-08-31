import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGrokAdapter } from '../src/adapters/cli/grok.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

// Grok submit delivery + verification.
//
// Root cause this file guards (verified on grok 1.0.5): a multi-KB body sent
// per-byte via `send-keys -l` takes the TUI seconds to ingest, and an Enter
// sent 200ms later is consumed as a soft newline INSIDE the burst instead of
// submitting — the composer sits idle holding the full un-submitted text.
// The worker's flush retry then re-ran writeInput, which RE-PASTED the whole
// body each time; a later manual Enter submitted one giant prompt with the
// message stacked N times.
//
// The fix under test: deliver via bracketed pasteText so the body lands
// atomically (idle 12/12 and mid-turn 6/6 on real 1.0.5, zero swallowed
// Enters). There is deliberately NO Enter-only retry path: `submitted:false`
// does not prove the body is parked in the composer — every mid-turn submit
// parks in grok's OWN queue and appends prompt_history only at dequeue, so
// an Enter-only retry would fire a bare Enter at an empty composer. On real
// 1.0.5 a bare Enter with a queued follow-up is send-now (cancels the
// running turn), and an Enter-only "retry" for an identical resend would
// swallow the new message entirely. The mock composer below is honest about
// both: mid-turn submits queue and append only on flushQueue(), and a bare
// Enter on an empty composer with a non-empty queue counts a send-now
// cancellation instead of pretending to be a no-op.

const SID = '00000000-0000-7000-8000-00000000aaaa';
const CWD = '/fake/grok-project';

let grokHome: string;
let previousGrokHome: string | undefined;
let previousScale: string | undefined;

function historyPath(): string {
  return join(grokHome, 'sessions', encodeURIComponent(CWD), 'prompt_history.jsonl');
}

function appendPrompt(sid: string, prompt: string): void {
  mkdirSync(join(grokHome, 'sessions', encodeURIComponent(CWD)), { recursive: true });
  appendFileSync(
    historyPath(),
    `${JSON.stringify({ timestamp: '2026-08-28T00:00:00Z', session_id: sid, prompt, is_bash: false })}\n`,
  );
}

/** A pty whose composer behaves like grok 1.0.5: pasted text accumulates; a
 *  "swallowed" Enter becomes a soft newline in the composer (the legacy
 *  send-keys failure mode); a committing Enter either records the WHOLE
 *  composer content in prompt_history.jsonl (idle) or — with `midTurn` —
 *  parks it in grok's own queue, appending only when flushQueue() models the
 *  previous turn completing (dequeue-time append, measured on 1.0.5). A bare
 *  Enter on an empty composer while the queue is non-empty is send-now: it
 *  cancels the running turn (measured; NOT a no-op). */
function makePty(opts: { cwd?: string; sid?: string; swallowEnters?: number; midTurn?: boolean } = {}): PtyHandle & {
  pasteText: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
  sendSpecialKeys: ReturnType<typeof vi.fn>;
  composer(): string;
  sendNowCancels(): number;
  flushQueue(): void;
} {
  let composer = '';
  let swallowLeft = opts.swallowEnters ?? 0;
  const queued: string[] = [];
  let sendNowCancels = 0;
  return {
    write: vi.fn(),
    cliCwd: opts.cwd ?? CWD,
    composer: () => composer,
    sendNowCancels: () => sendNowCancels,
    flushQueue: () => {
      for (const body of queued.splice(0)) appendPrompt(opts.sid ?? SID, body);
    },
    pasteText: vi.fn((text: string) => { composer += text; }),
    sendText: vi.fn(),
    sendSpecialKeys: vi.fn((key: string) => {
      if (key !== 'Enter') return;
      if (swallowLeft > 0) {
        swallowLeft -= 1;
        composer += '\n'; // the swallowed Enter lands as a soft newline
        return;
      }
      if (!composer) {
        // Real 1.0.5: with a queued follow-up the bottom bar reads
        // `Enter:send now` — a bare Enter CANCELS the running turn.
        if (queued.length > 0) sendNowCancels += 1;
        return;
      }
      if (opts.midTurn) {
        queued.push(composer); // Enter:queue — appends only at dequeue
        composer = '';
        return;
      }
      appendPrompt(opts.sid ?? SID, composer);
      composer = '';
    }),
  };
}

describe.sequential('grok adapter submit delivery (prompt_history.jsonl)', () => {
  beforeEach(() => {
    previousGrokHome = process.env.GROK_HOME;
    previousScale = process.env.BOTMUX_TIME_SCALE;
    grokHome = mkdtempSync(join(tmpdir(), 'grok-adapter-'));
    process.env.GROK_HOME = grokHome;
    process.env.BOTMUX_TIME_SCALE = '0.01';
  });

  afterEach(() => {
    if (previousGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousGrokHome;
    if (previousScale === undefined) delete process.env.BOTMUX_TIME_SCALE;
    else process.env.BOTMUX_TIME_SCALE = previousScale;
    rmSync(grokHome, { recursive: true, force: true });
  });

  it('delivers the body via bracketed pasteText (never send-keys -l) and confirms with the owning sid', async () => {
    const adapter = createGrokAdapter('/bin/grok');
    const pty = makePty();

    const result = await adapter.writeInput(pty, '第一条多行消息\n第二行');

    expect(result).toEqual({ submitted: true, cliSessionId: SID });
    expect(pty.pasteText).toHaveBeenCalledTimes(1);
    expect(pty.pasteText).toHaveBeenCalledWith('第一条多行消息\n第二行');
    expect(pty.sendText).not.toHaveBeenCalled();
  });

  it('confirms the very first submit of a lazy-created bucket (history file did not exist yet)', async () => {
    // baseByte snapshots 0 for a missing file; the probe re-stats base as 0
    // when the file appears mid-poll.
    const adapter = createGrokAdapter('/bin/grok');
    const pty = makePty();

    const result = await adapter.writeInput(pty, 'fresh bucket prompt');

    expect(result).toMatchObject({ submitted: true });
  });

  it('returns submitted:false + recheck when the Enter is swallowed; a later submit flips the recheck', async () => {
    const adapter = createGrokAdapter('/bin/grok');
    const pty = makePty({ swallowEnters: Infinity as unknown as number });

    const result = await adapter.writeInput(pty, 'stuck in composer');

    expect(result).toMatchObject({ submitted: false });
    expect(typeof (result as any).recheck).toBe('function');
    // The human (or a later flush retry) eventually submits the parked text —
    // with the soft newline the swallowed Enter left behind.
    appendPrompt(SID, 'stuck in composer\n');
    expect(await (result as any).recheck()).toEqual({ submitted: true, cliSessionId: SID });
  });

  it('REGRESSION: a resend after a mid-turn verify miss re-pastes the body — never a bare Enter (send-now cancel)', async () => {
    // Mid-turn a submit parks in grok's own queue: the composer is EMPTY and
    // prompt_history appends only at dequeue, so verify misses (measured 6/6
    // on 1.0.5) and the caller is told「提交未确认」. If the adapter kept an
    // Enter-only memory for the "unconfirmed" body, the user's manual resend
    // of the same text would fire a bare Enter at `Enter:send now` — grok
    // cancels the running turn AND the resent message is never delivered.
    const adapter = createGrokAdapter('/bin/grok');
    const pty = makePty({ midTurn: true });
    const body = '[卡片: critical 报警]\n多行正文 padding';

    const first = await adapter.writeInput(pty, body);
    expect(first).toMatchObject({ submitted: false });
    expect(pty.composer()).toBe(''); // body left the composer — it is queued in grok

    const resend = await adapter.writeInput(pty, body);
    expect(resend).toMatchObject({ submitted: false });
    expect(pty.pasteText).toHaveBeenCalledTimes(2); // full re-paste, no Enter-only shortcut
    expect(pty.sendNowCancels()).toBe(0); // and no bare Enter cancelled the running turn

    // Previous turn completes → queued submits dequeue and append; the
    // deferred recheck (worker's 20s path) then confirms.
    pty.flushQueue();
    expect(await (first as any).recheck()).toEqual({ submitted: true, cliSessionId: SID });
  });

  it('an identical new message always re-pastes — no Enter-only shortcut on the confirmed path either', async () => {
    const adapter = createGrokAdapter('/bin/grok');
    const pty = makePty();

    const first = await adapter.writeInput(pty, '合并部署');
    expect(first).toMatchObject({ submitted: true });

    // The user sends the exact same text again tomorrow: the composer is
    // empty, so this MUST paste — an Enter-only shortcut would silently no-op.
    const again = await adapter.writeInput(pty, '合并部署');
    expect(again).toMatchObject({ submitted: true });
    expect(pty.pasteText).toHaveBeenCalledTimes(2);
    expect(pty.sendNowCancels()).toBe(0);
  });

  it('fails closed without cliCwd but still delivers via bracketed paste', async () => {
    const adapter = createGrokAdapter('/bin/grok');
    const pty = makePty({ cwd: undefined });
    (pty as any).cliCwd = undefined;

    const result = await adapter.writeInput(pty, 'no cwd body');

    expect(result).toEqual({ submitted: false });
    expect(pty.pasteText).toHaveBeenCalledWith('no cwd body');
    expect(pty.sendSpecialKeys).toHaveBeenCalledWith('Enter');
  });
});
