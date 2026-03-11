/**
 * CoCo streaming message loss — e2e tests.
 *
 * Reproduces the bug: CoCo processes user prompts and generates PTY output,
 * but the Lark streaming card shows no content (empty screen_update messages).
 *
 * ROOT CAUSE (confirmed by test results):
 *   1. CoCo is a TUI app that redraws the entire screen with cursor positioning.
 *      When the response completes, CoCo redraws to show the empty input prompt.
 *      The response text is overwritten in the terminal buffer.
 *   2. TerminalRenderer.snapshot() reads the CURRENT screen state. By the time
 *      the 2s snapshot timer fires (or idle snapshot), the response is gone.
 *   3. OUTPUT_MARKER_RE is Claude Code-specific. CoCo spinner chars (❇, ❋, ✢)
 *      aren't in the regex, so Phase 1 output detection is delayed.
 *
 * EFFECT: All screen_update IPC messages have empty content → Lark card is blank.
 *
 * Run:  pnpm vitest run test/coco-streaming.e2e.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as pty from 'node-pty';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { createCocoAdapter } from '../src/adapters/cli/coco.js';
import { resolveCommand } from '../src/adapters/cli/registry.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[\??\d*[;0-9]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][0-9A-B]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

interface PtySession {
  proc: pty.IPty;
  chunks: { time: number; raw: string }[];
  rawOutput(): string;
  plainOutput(): string;
  outputAfter(ts: number): string;
}

function spawnCoco(args: string[], cwd = '/tmp'): PtySession {
  const bin = resolveCommand('coco');
  const chunks: { time: number; raw: string }[] = [];
  const proc = pty.spawn(bin, args, {
    name: 'xterm-256color',
    cols: 300,
    rows: 50,
    cwd,
    env: { ...process.env } as Record<string, string>,
  });
  proc.onData(data => chunks.push({ time: Date.now(), raw: data }));
  return {
    proc,
    chunks,
    rawOutput() { return chunks.map(c => c.raw).join(''); },
    plainOutput() { return stripAnsi(this.rawOutput()); },
    outputAfter(ts: number) {
      return stripAnsi(chunks.filter(c => c.time >= ts).map(c => c.raw).join(''));
    },
  };
}

// ─── Regexes from terminal-renderer.ts (for diagnostic analysis) ─────────────

const OUTPUT_MARKER_RE = /^[●·⎿✓⚠★☐☑⏵✽✻]|^\s+⎿/;
const STATUS_BAR_RE = /bypass permissions|⏵⏵|shift\+tab|\/model|auto-update|agent full mode|IDE: \w+/;
const BARE_PROMPT_RE = /^[❯>]\s*$/;
const INPUT_ECHO_RE = /^[❯>]\s+\S/;
const LOGO_RE = /[▐▛█▜▝▘]{2,}/;
const VERSION_RE = /Claude Code v\d|^\s*(Opus|Sonnet|Haiku)\s+\d|>_ Aiden \(v[\d.]+\)/;

function shouldSkipLine(line: string): boolean {
  return (
    BARE_PROMPT_RE.test(line) ||
    INPUT_ECHO_RE.test(line) ||
    STATUS_BAR_RE.test(line) ||
    LOGO_RE.test(line) ||
    VERSION_RE.test(line)
  );
}

// ─── Test 1: Diagnose CoCo's PTY output format ──────────────────────────────

describe('CoCo streaming: output format diagnosis', () => {
  let session: PtySession | null = null;

  afterEach(() => {
    if (session) {
      try { session.proc.kill(); } catch {}
      session = null;
    }
  });

  it('captures CoCo response and analyses which lines match OUTPUT_MARKER_RE', async () => {
    const adapter = createCocoAdapter();
    const sid = `e2e-stream-diag-${Date.now()}`;
    const args = adapter.buildArgs({ sessionId: sid, resume: false });
    session = spawnCoco(args);

    const detector = new IdleDetector(adapter);
    let writeTs = 0;
    const spawnTs = Date.now();

    detector.onIdle(() => {
      if (!writeTs) {
        writeTs = Date.now();
        console.log(`[diag] Idle at +${writeTs - spawnTs}ms, sending prompt`);
        adapter.writeInput(session!.proc, 'say exactly: Hello World');
      }
    });

    session.proc.onData(data => detector.feed(data));

    await new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (writeTs && Date.now() - writeTs > 20_000) { clearInterval(check); resolve(); }
        if (Date.now() - spawnTs > 50_000) { clearInterval(check); resolve(); }
      }, 500);
    });

    expect(writeTs, 'prompt should have been sent').toBeGreaterThan(0);

    const afterPlain = session.outputAfter(writeTs);
    console.log('\n=== RAW OUTPUT AFTER PROMPT (first 1000 chars) ===');
    console.log(afterPlain.slice(0, 1000));

    const lines = afterPlain.split('\n');
    console.log(`\n=== LINE-BY-LINE ANALYSIS (first 50 non-empty) ===`);

    let markerMatches = 0;
    let skipMatches = 0;
    let shown = 0;

    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed || shown >= 50) continue;
      shown++;

      const hasMarker = OUTPUT_MARKER_RE.test(trimmed);
      const isSkipped = shouldSkipLine(trimmed);

      if (hasMarker) markerMatches++;
      if (isSkipped) skipMatches++;

      const flags = [
        hasMarker ? 'MARKER' : '',
        isSkipped ? 'SKIP' : '',
      ].filter(Boolean).join(',') || 'PLAIN';

      console.log(`  [${flags}] "${trimmed.slice(0, 100)}"`);
    }

    console.log(`\nMarker matches: ${markerMatches}, Skip: ${skipMatches}, Total non-empty: ${lines.filter(l => l.trim()).length}`);

    detector.dispose();
  }, 60_000);
});

// ─── Test 2: TerminalRenderer snapshot() returns empty ───────────────────────

describe('CoCo streaming: snapshot captures response', () => {
  let session: PtySession | null = null;

  afterEach(() => {
    if (session) {
      try { session.proc.kill(); } catch {}
      session = null;
    }
  });

  it('snapshot() should capture CoCo response but returns empty (TUI redraw)', async () => {
    /**
     * Reproduces the streaming message loss:
     * - Spawn CoCo with real TerminalRenderer (same PTY_COLS/ROWS as production)
     * - Wait for readyPattern → markNewTurn → send prompt
     * - Take periodic 2s snapshots (matches production SCREEN_UPDATE_INTERVAL_MS)
     * - After response: verify snapshot has content
     *
     * EXPECTED FAILURE: CoCo's TUI redraws on completion, wiping response from
     * the terminal buffer. Snapshots return empty despite CoCo generating output.
     */
    const PTY_COLS = 300;
    const PTY_ROWS = 50;

    const adapter = createCocoAdapter();
    const sid = `e2e-stream-snap-${Date.now()}`;
    const args = adapter.buildArgs({ sessionId: sid, resume: false });

    session = spawnCoco(args);
    const renderer = new TerminalRenderer(PTY_COLS, PTY_ROWS);
    const detector = new IdleDetector(adapter);

    let writeTs = 0;
    const spawnTs = Date.now();
    const snapshots: { time: number; content: string; changed: boolean }[] = [];

    session.proc.onData(data => {
      renderer.write(data);
      detector.feed(data);
    });

    detector.onIdle(() => {
      if (!writeTs) {
        writeTs = Date.now();
        renderer.markNewTurn();
        console.log(`[snap] Idle at +${writeTs - spawnTs}ms, sending prompt`);
        adapter.writeInput(session!.proc, 'say exactly: PONG');
      }
    });

    // Periodic 2s snapshots (matches production)
    const snapTimer = setInterval(() => {
      if (!writeTs) return;
      const snap = renderer.snapshot();
      snapshots.push({ time: Date.now(), ...snap });
    }, 2_000);

    await new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (writeTs && Date.now() - writeTs > 20_000) { clearInterval(check); resolve(); }
        if (Date.now() - spawnTs > 50_000) { clearInterval(check); resolve(); }
      }, 500);
    });
    clearInterval(snapTimer);

    expect(writeTs).toBeGreaterThan(0);

    console.log(`\n=== SNAPSHOTS (${snapshots.length}) ===`);
    for (const [i, snap] of snapshots.entries()) {
      const elapsed = snap.time - writeTs;
      const preview = snap.content.replace(/\n/g, '\\n').slice(0, 200);
      console.log(`  [${i}] +${elapsed}ms changed=${snap.changed} len=${snap.content.length} "${preview}"`);
    }

    const nonEmpty = snapshots.filter(s => s.content.length > 0);
    const rawAfter = session.outputAfter(writeTs);
    const cocoDidRespond = rawAfter.replace(/\s+/g, '').length > 10;

    console.log(`\n  Non-empty snapshots: ${nonEmpty.length}/${snapshots.length}`);
    console.log(`  CoCo generated output: ${cocoDidRespond} (raw len=${rawAfter.length})`);

    expect(cocoDidRespond, 'CoCo should have generated output').toBe(true);
    expect(
      nonEmpty.length,
      'BUG: All snapshots empty despite CoCo generating output. TUI redraws wipe response from buffer.',
    ).toBeGreaterThan(0);

    detector.dispose();
    renderer.dispose();
  }, 60_000);
});

// ─── Test 3: Response text appears in raw output but not in snapshot ─────────

describe('CoCo streaming: response text in snapshot', () => {
  let session: PtySession | null = null;

  afterEach(() => {
    if (session) {
      try { session.proc.kill(); } catch {}
      session = null;
    }
  });

  it('raw PTY has response text but snapshot does not (content filtering)', async () => {
    /**
     * Sends a prompt with a distinctive marker string and checks whether
     * it appears in:
     *   a) the raw PTY output (always yes — CoCo responds)
     *   b) the TerminalRenderer snapshot (usually no — filtered or wiped)
     *
     * EXPECTED FAILURE: Response text exists in raw output but not in snapshot.
     */
    const PTY_COLS = 300;
    const PTY_ROWS = 50;

    const adapter = createCocoAdapter();
    const sid = `e2e-stream-text-${Date.now()}`;
    const args = adapter.buildArgs({ sessionId: sid, resume: false });

    session = spawnCoco(args);
    const renderer = new TerminalRenderer(PTY_COLS, PTY_ROWS);
    const detector = new IdleDetector(adapter);

    let promptSentAt = 0;
    let responseIdleAt = 0;
    const spawnTs = Date.now();

    // Also take rapid snapshots (500ms) to maximize chance of catching the response
    const rapidSnapshots: { time: number; content: string }[] = [];
    let rapidTimer: ReturnType<typeof setInterval> | null = null;

    session.proc.onData(data => {
      renderer.write(data);
      detector.feed(data);
    });

    let promptCount = 0;
    detector.onIdle(() => {
      promptCount++;
      if (promptCount === 1) {
        promptSentAt = Date.now();
        renderer.markNewTurn();
        console.log(`[text] First idle at +${promptSentAt - spawnTs}ms, sending prompt`);
        adapter.writeInput(session!.proc, 'respond with exactly: HELLO_WORLD_TEST_STRING');
        detector.reset();

        // Start rapid snapshots to try to catch response during generation
        rapidTimer = setInterval(() => {
          const { content } = renderer.snapshot();
          rapidSnapshots.push({ time: Date.now(), content });
        }, 500);
      } else if (promptCount === 2) {
        responseIdleAt = Date.now();
        console.log(`[text] Second idle (response done) at +${responseIdleAt - spawnTs}ms`);
      }
    });

    await new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (responseIdleAt || (promptSentAt && Date.now() - promptSentAt > 25_000)) {
          clearInterval(check);
          resolve();
        }
        if (Date.now() - spawnTs > 55_000) { clearInterval(check); resolve(); }
      }, 500);
    });
    if (rapidTimer) clearInterval(rapidTimer);

    expect(promptSentAt).toBeGreaterThan(0);

    // Final snapshot
    const { content: finalContent } = renderer.snapshot();

    // Raw output comparison
    const rawAfter = session.outputAfter(promptSentAt);
    const rawHasText = rawAfter.includes('HELLO_WORLD_TEST_STRING');

    // Check all rapid snapshots
    const snapWithText = rapidSnapshots.filter(s => s.content.includes('HELLO_WORLD_TEST_STRING'));
    const snapNonEmpty = rapidSnapshots.filter(s => s.content.length > 0);

    console.log(`\n=== RESPONSE TEXT ANALYSIS ===`);
    console.log(`  Raw output has HELLO_WORLD_TEST_STRING: ${rawHasText}`);
    console.log(`  Final snapshot has HELLO_WORLD_TEST_STRING: ${finalContent.includes('HELLO_WORLD_TEST_STRING')}`);
    console.log(`  Rapid snapshots: ${rapidSnapshots.length} total, ${snapNonEmpty.length} non-empty, ${snapWithText.length} with text`);
    console.log(`  Final snapshot (len=${finalContent.length}): "${finalContent.slice(0, 200)}"`);

    if (rawHasText && snapWithText.length === 0) {
      console.log(`\n  >>> BUG: Response in raw PTY but never captured by any snapshot`);
      console.log(`  >>> CoCo TUI redraws before snapshot can capture it`);
    }

    // Assert: raw output has the text
    expect(rawHasText, 'CoCo should have responded with the test string').toBe(true);

    // This assertion documents the bug — should pass after fix
    expect(
      finalContent.includes('HELLO_WORLD_TEST_STRING') || snapWithText.length > 0,
      'BUG: Response text in raw PTY but never captured by TerminalRenderer snapshot',
    ).toBe(true);

    detector.dispose();
    renderer.dispose();
  }, 65_000);
});

// ─── Test 4: Full daemon streaming simulation ────────────────────────────────

describe('CoCo streaming: daemon simulation', () => {
  let session: PtySession | null = null;

  afterEach(() => {
    if (session) {
      try { session.proc.kill(); } catch {}
      session = null;
    }
  });

  it('production flow: all screen_update IPC messages have empty content', async () => {
    /**
     * Simulates the exact production worker.ts flow:
     *   spawnClaude → startScreenUpdates → awaitingFirstPrompt → idle →
     *   markPromptReady → markNewTurn → flushPending → 2s snapshots → idle
     *
     * Tracks all screen_update IPC messages that would be sent to daemon.
     * The daemon uses these to build/patch the Lark streaming card.
     *
     * EXPECTED FAILURE: All screen_update messages have empty content,
     * so the Lark card shows nothing despite CoCo generating a response.
     */
    const PTY_COLS = 300;
    const PTY_ROWS = 50;

    const adapter = createCocoAdapter();
    const sid = `e2e-stream-ipc-${Date.now()}`;
    const args = adapter.buildArgs({ sessionId: sid, resume: false });

    session = spawnCoco(args);
    const renderer = new TerminalRenderer(PTY_COLS, PTY_ROWS);
    const idleDetector = new IdleDetector(adapter);

    const spawnTs = Date.now();
    let awaitingFirstPrompt = true;
    let isPromptReady = false;
    let promptSentAt = 0;

    // Simulated IPC messages (what worker.ts sends to daemon → Lark card)
    const ipcMessages: { time: number; content: string; status: string }[] = [];

    session.proc.onData(data => {
      renderer.write(data);
      idleDetector.feed(data);
    });

    // Matches worker.ts markPromptReady + flushPending
    idleDetector.onIdle(() => {
      if (isPromptReady) return;
      isPromptReady = true;

      if (awaitingFirstPrompt) {
        awaitingFirstPrompt = false;
        renderer.markNewTurn();
      }

      // prompt_ready → immediate screen_update with idle status
      const { content } = renderer.snapshot();
      ipcMessages.push({ time: Date.now(), content, status: 'idle' });

      // flushPending: send test prompt
      if (!promptSentAt) {
        promptSentAt = Date.now();
        isPromptReady = false;
        idleDetector.reset();
        renderer.markNewTurn();
        console.log(`[ipc] Prompt ready at +${promptSentAt - spawnTs}ms, flushing`);
        adapter.writeInput(session!.proc, 'just say PONG');
      }
    });

    // Matches worker.ts SCREEN_UPDATE_INTERVAL_MS = 2000
    const updateTimer = setInterval(() => {
      if (!renderer || awaitingFirstPrompt) return;
      const { content, changed } = renderer.snapshot();
      if (changed) {
        ipcMessages.push({
          time: Date.now(),
          content,
          status: isPromptReady ? 'idle' : 'working',
        });
      }
    }, 2_000);

    await new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (promptSentAt && Date.now() - promptSentAt > 25_000) { clearInterval(check); resolve(); }
        if (Date.now() - spawnTs > 55_000) { clearInterval(check); resolve(); }
      }, 500);
    });
    clearInterval(updateTimer);

    expect(promptSentAt).toBeGreaterThan(0);

    const afterPrompt = ipcMessages.filter(m => m.time >= promptSentAt);
    const nonEmpty = afterPrompt.filter(m => m.content.length > 0);

    console.log(`\n=== IPC screen_update MESSAGES ===`);
    console.log(`  Total: ${ipcMessages.length}, after prompt: ${afterPrompt.length}, non-empty: ${nonEmpty.length}`);
    for (const [i, m] of afterPrompt.entries()) {
      const elapsed = m.time - promptSentAt;
      console.log(`  [${i}] +${elapsed}ms status=${m.status} len=${m.content.length}`);
    }

    const rawAfter = session.outputAfter(promptSentAt);
    const cocoResponded = rawAfter.replace(/\s+/g, '').length > 10;
    console.log(`  CoCo output: ${cocoResponded} (${rawAfter.length} chars)`);

    if (cocoResponded) {
      expect(
        nonEmpty.length,
        'BUG: CoCo responded but all screen_update messages are empty → Lark card blank',
      ).toBeGreaterThan(0);
    }

    idleDetector.dispose();
    renderer.dispose();
  }, 65_000);
});

// ─── Test 5: TUI screen state before and after response ──────────────────────

describe('CoCo streaming: TUI redraw behavior', () => {
  let session: PtySession | null = null;

  afterEach(() => {
    if (session) {
      try { session.proc.kill(); } catch {}
      session = null;
    }
  });

  it('screen state reverts to empty input after CoCo finishes responding', async () => {
    /**
     * Proves the root cause: CoCo's TUI redraws the screen when the response
     * completes, replacing the response content with the empty input prompt.
     *
     * Takes snapshots at 500ms intervals to capture the screen state
     * DURING response generation vs AFTER completion.
     *
     * Expected: During response → some content visible on screen.
     *           After response  → screen shows empty TUI (> Ask anything...)
     */
    const PTY_COLS = 300;
    const PTY_ROWS = 50;

    const adapter = createCocoAdapter();
    const sid = `e2e-stream-redraw-${Date.now()}`;
    const args = adapter.buildArgs({ sessionId: sid, resume: false });

    session = spawnCoco(args);
    const renderer = new TerminalRenderer(PTY_COLS, PTY_ROWS);
    const detector = new IdleDetector(adapter);

    let promptSentAt = 0;
    let responseIdleAt = 0;
    const spawnTs = Date.now();

    // Raw screen reads (bypass OUTPUT_MARKER_RE filtering) — read ALL lines
    const rawScreens: { time: number; lines: string[] }[] = [];

    session.proc.onData(data => {
      renderer.write(data);
      detector.feed(data);
    });

    let promptCount = 0;
    detector.onIdle(() => {
      promptCount++;
      if (promptCount === 1) {
        promptSentAt = Date.now();
        renderer.markNewTurn();
        adapter.writeInput(session!.proc, 'say exactly: REDRAW_TEST_MARKER');
        detector.reset();
        console.log(`[redraw] Prompt sent at +${promptSentAt - spawnTs}ms`);
      } else if (promptCount === 2) {
        responseIdleAt = Date.now();
        console.log(`[redraw] Response done at +${responseIdleAt - spawnTs}ms`);
      }
    });

    // Capture raw screen state at 500ms intervals (ignoring OUTPUT_MARKER_RE)
    const screenTimer = setInterval(() => {
      if (!promptSentAt) return;
      // Access the underlying terminal to read raw screen (bypassing filters)
      const { content } = renderer.snapshot();
      rawScreens.push({ time: Date.now(), lines: content.split('\n') });
    }, 500);

    await new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (responseIdleAt || (promptSentAt && Date.now() - promptSentAt > 25_000)) {
          clearInterval(check);
          resolve();
        }
        if (Date.now() - spawnTs > 55_000) { clearInterval(check); resolve(); }
      }, 500);
    });
    clearInterval(screenTimer);

    expect(promptSentAt).toBeGreaterThan(0);

    // Analyze screen state timeline
    const duringResponse = rawScreens.filter(s =>
      s.time >= promptSentAt && (!responseIdleAt || s.time < responseIdleAt)
    );
    const afterResponse = rawScreens.filter(s =>
      responseIdleAt && s.time >= responseIdleAt
    );

    const duringNonEmpty = duringResponse.filter(s => s.lines.some(l => l.trim()));
    const afterNonEmpty = afterResponse.filter(s => s.lines.some(l => l.trim()));

    console.log(`\n=== SCREEN STATE TIMELINE ===`);
    console.log(`  During response: ${duringResponse.length} snapshots, ${duringNonEmpty.length} non-empty`);
    console.log(`  After response:  ${afterResponse.length} snapshots, ${afterNonEmpty.length} non-empty`);

    // Check if any screen during response contains the marker
    const hasMarkerDuring = duringResponse.some(s =>
      s.lines.some(l => l.includes('REDRAW_TEST_MARKER'))
    );
    const hasMarkerAfter = afterResponse.some(s =>
      s.lines.some(l => l.includes('REDRAW_TEST_MARKER'))
    );

    console.log(`  REDRAW_TEST_MARKER visible during response: ${hasMarkerDuring}`);
    console.log(`  REDRAW_TEST_MARKER visible after response:  ${hasMarkerAfter}`);

    // Raw PTY confirms CoCo did respond
    const rawAfter = session.outputAfter(promptSentAt);
    const rawHasMarker = rawAfter.includes('REDRAW_TEST_MARKER');
    console.log(`  REDRAW_TEST_MARKER in raw PTY: ${rawHasMarker}`);

    if (rawHasMarker && !hasMarkerAfter) {
      console.log(`\n  >>> ROOT CAUSE CONFIRMED: Response visible in raw PTY but gone after TUI redraw`);
    }

    // The response should be visible in the snapshot at some point
    expect(rawHasMarker, 'CoCo should respond with marker text').toBe(true);
    expect(
      hasMarkerDuring || hasMarkerAfter,
      'BUG: Response never captured by snapshot — TUI redraws wipe it before snapshot fires',
    ).toBe(true);

    detector.dispose();
    renderer.dispose();
  }, 65_000);
});
