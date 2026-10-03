/**
 * E2E test: Codex first-input submission.
 *
 * Root cause: Codex's trust dialog text is split across PTY chunks and
 * ANSI-stripped spaces collapse, so the worker's pattern never matched.
 * Fix: match Codex's dialog option text, which appears intact in a single
 * chunk even when surrounding prompt text is split by PTY framing.
 *
 * Run:  pnpm test:codex
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as pty from 'node-pty';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';

// Codex's workspace trust screen has changed shape over time: pre-0.130 builds
// emitted "Yes, continue", 0.130-era builds removed that screen, and 0.155+
// builds emit "Trust this folder?" with "Trust and continue". These tests spawn
// the real codex binary to capture the dialog's PTY framing, so skip only the
// known no-dialog version band instead of assuming all modern releases removed
// the prompt.
function codexEmitsTrustDialog(): boolean {
  try {
    const out = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
    // Format observed: "codex-cli 0.130.0". Extract semver-like tail.
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!m) return true; // unknown version → run the test, fail loudly if assumption wrong
    const [maj, min] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (maj !== 0) return true;
    return min < 130 || min >= 155;
  } catch {
    return false; // codex not installed → skip
  }
}

const CODEX_HAS_TRUST_DIALOG = codexEmitsTrustDialog();

// ─── Constants (match production worker.ts) ─────────────────────────────────

const CODEX_BIN = 'codex';
// Mirror production codex.ts baseArgs for the DEFAULT launch (bypassCodexHookTrust
// toggle ON, unrestricted bot): bypass both the approval/sandbox gate AND the 0.14x
// interactive hook-trust gate ("Press t to trust"). Without the latter the
// not-version-gated "control" test below wedges on codex ≥0.14x whenever the botmux
// hooks in ~/.codex/hooks.json are modified-since-last-trusted.
const CODEX_ARGS = ['--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'];
const PTY_COLS = 300;
const PTY_ROWS = 50;
const TEST_PROMPT = 'just say the word PONG and nothing else';

// Use the production matcher as the e2e source of truth; this test exists to
// prove the current Codex TUI still emits one of those option labels in a
// matchable PTY chunk.
function loadProductionTrustDialogPattern(): RegExp {
  const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
  const match = source.match(/const TRUST_DIALOG_PATTERN = (\/[^;]+\/);/);
  if (!match) throw new Error('TRUST_DIALOG_PATTERN not found in worker.ts');
  // eslint-disable-next-line no-new-func
  return new Function(`return ${match[1]};`)() as RegExp;
}

const TRUST_DIALOG_PATTERN = loadProductionTrustDialogPattern();

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

  it.skipIf(!CODEX_HAS_TRUST_DIALOG)('chunk analysis: trust option label appears intact in a single PTY chunk', async () => {
    /**
     * Verifies that the selectable trust option can be matched per-chunk
     * (unlike longer prompt text, which can split across chunks and lose spaces
     * after ANSI stripping).
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

    expect(matchingChunk, 'trust option label should appear in a single chunk').toBeTruthy();
  }, 30_000);

  it.skipIf(!CODEX_HAS_TRUST_DIALOG)('production flow: trust dialog detected and dismissed, prompt submitted', async () => {
    /**
     * Simulates the full production worker flow:
     * 1. Codex spawns → trust dialog appears
     * 2. Worker detects the trust option label per-chunk → defers 400ms, then sends \r
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

      // Production trust detection (per-chunk, with fixed pattern). Codex
      // 0.149 drops a synchronous Enter (upstream openai/codex#39487), so
      // production defers the keystroke 400ms after detection — replicate
      // that timing here.
      if (!trustHandled) {
        if (TRUST_DIALOG_PATTERN.test(stripped)) {
          trustHandled = true;
          trustDetectedAt = Date.now();
          console.log(`>>> Trust detected at +${trustDetectedAt - spawnTime}ms, dismissing in 400ms...`);
          setTimeout(() => { proc!.write('\r'); }, 400);
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
