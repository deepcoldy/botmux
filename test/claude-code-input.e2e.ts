/**
 * E2E test: Claude Code first-input submission.
 *
 * Bug: claude-code adapter had NO readyPattern, so IdleDetector used pure
 * quiescence (2s silence). During startup, plugin/extension init can
 * produce a quiet gap — idle fires prematurely before the input prompt
 * (❯) is rendered, causing the first prompt to be silently lost.
 *
 * Fix: added readyPattern: /❯/ to claude-code adapter, so IdleDetector
 * suppresses quiescence until the ❯ prompt appears.
 *
 * Run:  pnpm vitest run test/claude-code-input.e2e.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { resolveCommand } from '../src/adapters/cli/registry.js';

// ─── Constants (match production worker.ts) ─────────────────────────────────

const PTY_COLS = 300;
const PTY_ROWS = 50;
const TEST_PROMPT = 'just say the word PONG and nothing else';

// Claude Code's input prompt indicator
const INPUT_PROMPT_RE = /❯/;

// ─── Helpers ────────────────────────────────────────────────────────────────

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][0-9A-B]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

interface Chunk {
  time: number;
  offset: number;
  raw: string;
  stripped: string;
}

interface PtySession {
  proc: pty.IPty;
  chunks: Chunk[];
  spawnTime: number;
  rawOutput(): string;
  plainOutput(): string;
  outputAfter(ts: number): string;
}

function spawnClaudeCode(args: string[], cwd = '/tmp'): PtySession {
  const bin = resolveCommand('claude');
  const chunks: Chunk[] = [];
  const spawnTime = Date.now();
  const proc = pty.spawn(bin, args, {
    name: 'xterm-256color',
    cols: PTY_COLS,
    rows: PTY_ROWS,
    cwd,
    env: { ...process.env, CLAUDECODE: undefined } as unknown as Record<string, string>,
  });
  proc.onData(data => {
    chunks.push({
      time: Date.now(),
      offset: Date.now() - spawnTime,
      raw: data,
      stripped: stripAnsi(data),
    });
  });
  return {
    proc,
    chunks,
    spawnTime,
    rawOutput() { return chunks.map(c => c.raw).join(''); },
    plainOutput() { return stripAnsi(this.rawOutput()); },
    outputAfter(ts: number) {
      return stripAnsi(chunks.filter(c => c.time >= ts).map(c => c.raw).join(''));
    },
  };
}

/**
 * Check whether the prompt was actually submitted (not just echoed into
 * the input box). After real submission, Claude Code produces new output
 * like tool calls, model responses, or spinners.
 */
function wasSubmitted(session: PtySession, writeTs: number): boolean {
  const after = session.outputAfter(writeTs + 500);
  const stripped = after.replace(/\s+/g, '').trim();
  return stripped.length > 10;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Claude Code first-input submission (IdleDetector + readyPattern)', () => {
  let session: PtySession | null = null;

  afterEach(() => {
    if (session) {
      try { session.proc.kill(); } catch {}
      session = null;
    }
  });

  it('BUG: without readyPattern, idle fires before input prompt is rendered', async () => {
    /**
     * Reproduces the old behavior: no readyPattern → IdleDetector uses
     * pure quiescence (2s PTY silence) → idle fires prematurely during
     * plugin/extension loading before the ❯ prompt appears.
     */
    const adapter = createClaudeCodeAdapter();
    // Simulate old buggy behavior: strip readyPattern
    const buggyAdapter = { ...adapter, readyPattern: undefined };

    const sid = randomUUID();
    const args = adapter.buildArgs({ sessionId: sid, resume: false });
    session = spawnClaudeCode(args);

    const detector = new IdleDetector(buggyAdapter as any);
    let idleFiredAt = 0;
    detector.onIdle(() => { if (!idleFiredAt) idleFiredAt = Date.now(); });

    session.proc.onData(data => detector.feed(data));

    await new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (idleFiredAt || Date.now() - session!.spawnTime > 20_000) {
          clearInterval(check);
          resolve();
        }
      }, 200);
    });

    const elapsed = idleFiredAt ? idleFiredAt - session.spawnTime : -1;
    console.log(`[bug] No readyPattern → idle fired after ${elapsed}ms`);

    expect(idleFiredAt).toBeGreaterThan(0);
    // Fires prematurely — before the input prompt is likely rendered
    expect(elapsed, 'idle fires too early via quiescence (< 8s)').toBeLessThan(8000);

    // Check if the input prompt ❯ was actually visible when idle fired
    const outputAtIdle = stripAnsi(
      session.chunks.filter(c => c.time <= idleFiredAt).map(c => c.raw).join(''),
    );
    const promptVisible = INPUT_PROMPT_RE.test(outputAtIdle);
    console.log(`[bug] Input prompt visible at idle time: ${promptVisible}`);
    console.log(`[bug] Output tail at idle:\n${outputAtIdle.slice(-300)}`);

    detector.dispose();
  }, 30_000);

  it('BUG: first prompt lost when no readyPattern', async () => {
    /**
     * Simulates the old production daemon flow for claude-code:
     * 1. Spawn Claude Code
     * 2. IdleDetector (no readyPattern) fires on quiescence
     * 3. Worker writes the pending first prompt
     * 4. Prompt is lost because the input box isn't ready
     */
    const adapter = createClaudeCodeAdapter();
    const buggyAdapter = { ...adapter, readyPattern: undefined };

    const sid = randomUUID();
    const args = adapter.buildArgs({ sessionId: sid, resume: false });
    session = spawnClaudeCode(args);

    const detector = new IdleDetector(buggyAdapter as any);
    let writeTs = 0;

    // Simulate daemon flow: on first idle, write the pending prompt
    detector.onIdle(() => {
      if (!writeTs) {
        writeTs = Date.now();
        const elapsed = writeTs - session!.spawnTime;
        console.log(`[lost] Idle fired at +${elapsed}ms → writing prompt`);

        detector.reset();
        adapter.writeInput(session!.proc, TEST_PROMPT);
      }
    });

    session.proc.onData(data => detector.feed(data));

    await new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (writeTs && Date.now() - writeTs > 15_000) {
          clearInterval(check);
          resolve();
        }
        if (Date.now() - session!.spawnTime > 40_000) {
          clearInterval(check);
          resolve();
        }
      }, 500);
    });

    expect(writeTs, 'prompt should have been written').toBeGreaterThan(0);

    const idleElapsed = writeTs - session.spawnTime;
    const submitted = wasSubmitted(session, writeTs);
    const outputAfterWrite = session.outputAfter(writeTs);

    console.log(`[lost] Idle at: +${idleElapsed}ms`);
    console.log(`[lost] Submitted: ${submitted}`);
    console.log(`[lost] Output after write (first 500):\n${outputAfterWrite.slice(0, 500)}`);

    if (!submitted) {
      console.log('[lost] *** BUG CONFIRMED: first prompt was lost ***');
    } else {
      console.log('[lost] Prompt was processed (fast startup — idle happened to fire after prompt was ready)');
    }

    detector.dispose();
  }, 60_000);

  it('FIX: adapter now has readyPattern', () => {
    const adapter = createClaudeCodeAdapter();
    expect(adapter.readyPattern, 'claude-code adapter should have readyPattern').toBeDefined();
    expect(adapter.readyPattern!.test('❯')).toBe(true);
  });

  it('FIX: with readyPattern, idle waits for ❯ prompt', async () => {
    /**
     * With readyPattern: /❯/, IdleDetector suppresses quiescence until
     * the input prompt appears, ensuring idle fires only when ready.
     */
    const adapter = createClaudeCodeAdapter();

    const sid = randomUUID();
    const args = adapter.buildArgs({ sessionId: sid, resume: false });
    session = spawnClaudeCode(args);

    const detector = new IdleDetector(adapter);
    let idleFiredAt = 0;
    detector.onIdle(() => { if (!idleFiredAt) idleFiredAt = Date.now(); });

    session.proc.onData(data => detector.feed(data));

    await new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (idleFiredAt || Date.now() - session!.spawnTime > 30_000) {
          clearInterval(check);
          resolve();
        }
      }, 200);
    });

    const elapsed = idleFiredAt ? idleFiredAt - session.spawnTime : -1;
    console.log(`[fix] readyPattern ❯ → idle fired after ${elapsed}ms`);

    expect(idleFiredAt, 'idle should eventually fire').toBeGreaterThan(0);

    // Verify the input prompt was visible before idle fired
    const outputAtIdle = stripAnsi(
      session.chunks.filter(c => c.time <= idleFiredAt).map(c => c.raw).join(''),
    );
    const promptVisible = INPUT_PROMPT_RE.test(outputAtIdle);
    console.log(`[fix] Input prompt visible at idle time: ${promptVisible}`);

    expect(promptVisible, 'input prompt ❯ should be visible before idle fires').toBe(true);

    detector.dispose();
  }, 45_000);

  it('FIX: readyPattern → writeInput → Claude Code responds', async () => {
    /**
     * Full daemon flow with fix: readyPattern gates idle → prompt
     * written after ❯ appears → Claude Code processes it.
     */
    const adapter = createClaudeCodeAdapter();

    const sid = randomUUID();
    const args = adapter.buildArgs({ sessionId: sid, resume: false });
    session = spawnClaudeCode(args);

    const detector = new IdleDetector(adapter);
    let writeTs = 0;

    detector.onIdle(() => {
      if (!writeTs) {
        writeTs = Date.now();
        console.log(`[full] readyPattern matched → idle at +${writeTs - session!.spawnTime}ms, sending prompt`);
        detector.reset();
        adapter.writeInput(session!.proc, TEST_PROMPT);
      }
    });

    session.proc.onData(data => detector.feed(data));

    await new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (writeTs && Date.now() - writeTs > 15_000) {
          clearInterval(check);
          resolve();
        }
        if (Date.now() - session!.spawnTime > 50_000) {
          clearInterval(check);
          resolve();
        }
      }, 500);
    });

    expect(writeTs, 'prompt should have been sent').toBeGreaterThan(0);

    const submitted = wasSubmitted(session, writeTs);
    console.log(`[full] Submitted: ${submitted}`);
    console.log('[full] Output after write:\n' + session.outputAfter(writeTs).slice(0, 500));

    expect(submitted, 'Claude Code should accept and process the prompt').toBe(true);

    detector.dispose();
  }, 60_000);
});
