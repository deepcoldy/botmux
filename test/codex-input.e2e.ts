/**
 * E2E test: Codex first-input submission.
 *
 * Root cause: Codex's trust dialog text is split across PTY chunks and
 * ANSI-stripped spaces collapse, so the worker's pattern never matched.
 * Fix: match "Yes, continue" (Codex's dialog option text) which appears
 * intact in a single chunk.
 *
 * Run:  pnpm test:codex
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as pty from 'node-pty';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';

// ─── Constants (match production worker.ts) ─────────────────────────────────

const CODEX_BIN = 'codex';
const CODEX_ARGS = ['--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox'];
const PTY_COLS = 300;
const PTY_ROWS = 50;
const TEST_PROMPT = 'just say the word PONG and nothing else';

// Fixed trust pattern (matches both Claude Code and Codex)
const TRUST_DIALOG_PATTERN = /Yes, I trust this folder|Yes, continue/;

// ─── Helpers ────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

function simpleStrip(data: string): string {
  return data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Codex first input submission', () => {
  let proc: pty.IPty | null = null;
  let tmpDir: string | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codex-e2e-'));
  });

  afterEach(() => {
    if (proc) { try { proc.kill(); } catch {} proc = null; }
    if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  });

  it('chunk analysis: "Yes, continue" appears intact in a single PTY chunk', async () => {
    /**
     * Verifies that "Yes, continue" can be matched per-chunk (unlike
     * "Do you trust the contents of this directory" which splits across chunks
     * and loses spaces after ANSI stripping).
     */
    const chunks: Chunk[] = [];
    const spawnTime = Date.now();

    proc = pty.spawn(CODEX_BIN, CODEX_ARGS, {
      name: 'xterm-256color',
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: tmpDir!,
      env: { ...process.env } as Record<string, string>,
    });
    proc.onData((data) => {
      chunks.push({
        time: Date.now(),
        offset: Date.now() - spawnTime,
        raw: data,
        stripped: simpleStrip(data),
      });
    });

    await delay(8_000);

    // Log chunks for debugging
    console.log('\n=== PTY CHUNKS ===');
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const gap = i > 0 ? c.time - chunks[i - 1].time : 0;
      const matches = TRUST_DIALOG_PATTERN.test(c.stripped);
      const preview = c.stripped.replace(/\n/g, '\\n').replace(/\r/g, '\\r').slice(0, 120);
      console.log(
        `  [${i}] +${c.offset}ms gap=${gap}ms len=${c.raw.length} match=${matches}` +
        `\n    "${preview}"`,
      );
    }

    const matchingChunk = chunks.find(c => TRUST_DIALOG_PATTERN.test(c.stripped));
    console.log(`\n>>> Matching chunk found: ${!!matchingChunk}`);
    if (matchingChunk) {
      console.log(`>>> Match at +${matchingChunk.offset}ms`);
    }

    expect(matchingChunk, '"Yes, continue" should appear in a single chunk').toBeTruthy();
  }, 30_000);

  it('production flow: trust dialog detected and dismissed, prompt submitted', async () => {
    /**
     * Simulates the full production worker flow:
     * 1. Codex spawns → trust dialog appears
     * 2. Worker detects "Yes, continue" per-chunk → sends \r
     * 3. IdleDetector waits for codex to finish loading
     * 4. Idle fires → prompt is written to the actual input box
     * 5. Prompt is submitted successfully
     */
    const spawnTime = Date.now();
    const chunks: Chunk[] = [];
    let trustDetectedAt: number | null = null;
    let idleFiredAt: number | null = null;

    proc = pty.spawn(CODEX_BIN, CODEX_ARGS, {
      name: 'xterm-256color',
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: tmpDir!,
      env: { ...process.env } as Record<string, string>,
    });

    const cliAdapter = createCodexAdapter();
    const idleDetector = new IdleDetector(cliAdapter);
    idleDetector.onIdle(() => {
      if (!idleFiredAt) {
        idleFiredAt = Date.now();
        console.log(`>>> Idle fired at +${idleFiredAt - spawnTime}ms`);
      }
    });

    // Exactly replicate production onPtyData
    let trustHandled = false;
    proc.onData((data) => {
      const stripped = simpleStrip(data);
      chunks.push({
        time: Date.now(),
        offset: Date.now() - spawnTime,
        raw: data,
        stripped,
      });

      // Production trust detection (per-chunk, with fixed pattern)
      if (!trustHandled) {
        if (TRUST_DIALOG_PATTERN.test(stripped)) {
          trustHandled = true;
          trustDetectedAt = Date.now();
          console.log(`>>> Trust detected at +${trustDetectedAt - spawnTime}ms, dismissing...`);
          proc!.write('\r');
          return; // skip idle detector feed (same as production)
        }
      }

      idleDetector.feed(data);
    });

    // Wait for trust dismissal + codex startup + idle detection
    await delay(20_000);

    console.log('\n=== TIMING ===');
    console.log(`Trust detected: ${trustDetectedAt ? `+${trustDetectedAt - spawnTime}ms` : 'NEVER'}`);
    console.log(`Idle fired:     ${idleFiredAt ? `+${idleFiredAt - spawnTime}ms` : 'NEVER'}`);

    expect(trustDetectedAt, 'trust dialog should be detected').toBeTruthy();
    expect(idleFiredAt, 'idle should fire after trust dismissal').toBeTruthy();

    if (trustDetectedAt && idleFiredAt) {
      expect(
        trustDetectedAt < idleFiredAt,
        `trust (${trustDetectedAt - spawnTime}ms) should be detected before idle (${idleFiredAt - spawnTime}ms)`,
      ).toBe(true);
    }

    // Now write the prompt (simulating flushPending after idle)
    const writeTs = Date.now();
    proc!.write(TEST_PROMPT);
    await delay(200);
    proc!.write('\r');
    console.log('>>> Wrote prompt after idle');

    await delay(10_000);

    const afterOutput = stripAnsi(
      chunks.filter(c => c.time >= writeTs).map(c => c.raw).join('')
    );
    const hasProcessing = /esc to interrupt/.test(afterOutput);
    const hasFullPrompt = afterOutput.includes('just say the word PONG');

    console.log('\n=== SUBMISSION ===');
    console.log(`Processing started: ${hasProcessing}`);
    console.log(`Full prompt intact:  ${hasFullPrompt}`);
    console.log('Output (first 600 chars):\n' + afterOutput.slice(0, 600));

    expect(hasProcessing, 'codex should start processing the prompt').toBe(true);
    expect(hasFullPrompt, 'full prompt should be preserved (no truncation)').toBe(true);

    idleDetector.dispose();
  }, 60_000);

  it('control: already-trusted dir works without trust dialog', async () => {
    const spawnTime = Date.now();
    const chunks: Chunk[] = [];
    let idleFiredAt: number | null = null;

    // Use /tmp which is already trusted
    proc = pty.spawn(CODEX_BIN, CODEX_ARGS, {
      name: 'xterm-256color',
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: '/tmp',
      env: { ...process.env } as Record<string, string>,
    });

    const cliAdapter = createCodexAdapter();
    const idleDetector = new IdleDetector(cliAdapter);
    idleDetector.onIdle(() => {
      if (!idleFiredAt) {
        idleFiredAt = Date.now();
      }
    });

    proc.onData((data) => {
      chunks.push({ time: Date.now(), offset: Date.now() - spawnTime, raw: data, stripped: simpleStrip(data) });
      idleDetector.feed(data);
    });

    await delay(15_000);

    expect(idleFiredAt, 'idle should fire').toBeTruthy();

    const writeTs = Date.now();
    proc!.write(TEST_PROMPT);
    await delay(200);
    proc!.write('\r');

    await delay(10_000);

    const afterOutput = stripAnsi(
      chunks.filter(c => c.time >= writeTs).map(c => c.raw).join('')
    );
    expect(/esc to interrupt/.test(afterOutput), 'should be submitted').toBe(true);
    expect(afterOutput.includes('just say the word PONG'), 'full prompt intact').toBe(true);

    idleDetector.dispose();
  }, 60_000);
});
