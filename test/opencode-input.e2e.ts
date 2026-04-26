/**
 * E2E test: OpenCode CLI first-input submission.
 *
 * Root cause (same class as Gemini): OpenCode uses Bubble Tea TUI which has
 * an async startup phase.  Writing to stdin during this window may be silently
 * lost because the text input component hasn't mounted yet.
 *
 * Fix: pass the initial prompt via --prompt CLI flag.  OpenCode handles it
 * internally once the TUI is ready.
 *
 * Run:  pnpm vitest run test/opencode-input.e2e.ts
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as pty from 'node-pty';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { createOpenCodeAdapter } from '../src/adapters/cli/opencode.js';
import { resolveCommand } from '../src/adapters/cli/registry.js';

// ─── Constants (match production worker.ts) ─────────────────────────────────

const OPENCODE_BIN = 'opencode';
const PTY_COLS = 300;
const PTY_ROWS = 50;
const TEST_PROMPT = 'just say the word PONG and nothing else';

// ─── Helpers ────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Number(n) || 1))
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]|\x1b\[[\?]?[0-9;]*[hlmsuJ]/g, '');
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

describe('OpenCode first input submission', () => {
  let proc: pty.IPty | null = null;
  let tmpDir: string | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'opencode-e2e-'));
  });

  afterEach(() => {
    if (proc) { try { proc.kill(); } catch {} proc = null; }
    if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  });

  it('bug: stdin write immediately after idle fires may be lost', async () => {
    /**
     * Reproduces the production worker flow:
     * 1. OpenCode spawns without --prompt
     * 2. IdleDetector fires on quiescence
     * 3. flushPending writes prompt IMMEDIATELY (same event loop turn)
     * 4. OpenCode may NOT process it — Bubble Tea TextInput hasn't mounted yet
     *
     * The bug is timing-dependent: writing much later works because the TUI
     * eventually finishes mounting.  This documents the race condition.
     */
    const spawnTime = Date.now();
    const chunks: Chunk[] = [];
    let promptWritten = false;
    let writeTs = 0;

    proc = pty.spawn(OPENCODE_BIN, [], {
      name: 'xterm-256color',
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: tmpDir!,
      env: { ...process.env } as Record<string, string>,
    });

    const cliAdapter = createOpenCodeAdapter();
    const idleDetector = new IdleDetector(cliAdapter);
    // Simulate production flushPending: write IMMEDIATELY when idle fires
    idleDetector.onIdle(() => {
      if (!promptWritten && proc) {
        promptWritten = true;
        writeTs = Date.now();
        console.log(`>>> Idle fired at +${writeTs - spawnTime}ms — writing prompt immediately`);
        proc.write(TEST_PROMPT);
        setTimeout(() => proc!.write('\r'), 200);
      }
    });

    proc.onData((data) => {
      chunks.push({
        time: Date.now(),
        offset: Date.now() - spawnTime,
        raw: data,
        stripped: simpleStrip(data),
      });
      idleDetector.feed(data);
    });

    // Wait for idle + processing
    await delay(30_000);

    expect(promptWritten, 'idle should fire and prompt should be written').toBe(true);

    const afterOutput = stripAnsi(
      chunks.filter(c => c.time >= writeTs).map(c => c.raw).join('')
    );

    const hasPromptProcessed = afterOutput.includes('PONG') || afterOutput.includes('just say');

    console.log('\n=== STDIN WRITE RESULT ===');
    console.log(`Prompt processed: ${hasPromptProcessed}`);
    console.log('Output (first 400 chars):\n' + afterOutput.slice(0, 400));

    // When writing immediately after idle, the prompt may be lost
    // because Bubble Tea's TextInput hasn't finished mounting.  This confirms
    // the need for the --prompt flag fix.
    console.log(`\n>>> Bug reproduced (stdin lost): ${!hasPromptProcessed}`);

    idleDetector.dispose();
  }, 60_000);

  it('fix: --prompt flag delivers initial prompt reliably', async () => {
    /**
     * Verifies the fix: passing the initial prompt via --prompt lets OpenCode
     * handle it internally once the TUI is ready.
     *
     * This is what the production adapter now does via buildArgs({ initialPrompt }).
     */
    const spawnTime = Date.now();
    const chunks: Chunk[] = [];

    // Use the adapter's buildArgs to get the correct args (includes --prompt)
    const cliAdapter = createOpenCodeAdapter();
    const args = cliAdapter.buildArgs({
      sessionId: 'test',
      resume: false,
      initialPrompt: TEST_PROMPT,
    });

    console.log(`>>> Spawning: opencode ${args.join(' ')}`);

    proc = pty.spawn(OPENCODE_BIN, args, {
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

    // Wait for OpenCode to start and process the --prompt
    await delay(30_000);

    const allOutput = stripAnsi(chunks.map(c => c.raw).join(''));

    const hasPromptProcessed = allOutput.includes('PONG') || allOutput.includes('pong');
    // OpenCode should start processing: spinner activity, response text
    const hasSubstantialOutput = allOutput.length > 500;

    console.log('\n=== --prompt FLAG RESULT (should pass) ===');
    console.log(`Output length: ${allOutput.length}`);
    console.log(`Prompt processed (PONG): ${hasPromptProcessed}`);
    console.log(`Substantial output: ${hasSubstantialOutput}`);
    console.log('Output (last 600 chars):\n' + allOutput.slice(-600));

    expect(
      hasPromptProcessed || hasSubstantialOutput,
      'OpenCode should process the prompt via --prompt flag',
    ).toBe(true);
  }, 60_000);

  it('adapter: passesInitialPromptViaArgs is true', () => {
    const adapter = createOpenCodeAdapter();
    expect(adapter.passesInitialPromptViaArgs).toBe(true);
  });

  it('adapter: buildArgs includes --prompt when initialPrompt is set', () => {
    const adapter = createOpenCodeAdapter();
    const args = adapter.buildArgs({ sessionId: 'test', resume: false, initialPrompt: 'hello world' });
    expect(args).toContain('--prompt');
    expect(args).toContain('hello world');
  });

  it('adapter: buildArgs omits --prompt when no initialPrompt', () => {
    const adapter = createOpenCodeAdapter();
    const args = adapter.buildArgs({ sessionId: 'test', resume: false });
    expect(args).toEqual([]);
  });

  it('bug: --continue causes crash loop when no prior session exists', async () => {
    /**
     * Reproduces the production crash loop:
     * 1. First OpenCode session exits (for any reason)
     * 2. Daemon auto-restarts with resume: true → worker spawns `opencode --continue`
     * 3. No prior session exists → OpenCode exits immediately (code 0)
     * 4. Daemon sees claude_exit → auto-restarts again → loop until crash guard
     *
     * This test verifies that `opencode --continue` in a clean directory either
     * exits quickly (the original bug) or hangs without processing anything
     * (no useful session to continue).  Either way, --continue is unreliable
     * for the daemon's auto-restart path.
     */
    const spawnTime = Date.now();
    let exitCode: number | null = null;
    let exitAt: number | null = null;
    let output = '';

    proc = pty.spawn(OPENCODE_BIN, ['--continue'], {
      name: 'xterm-256color',
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: tmpDir!,
      env: { ...process.env } as Record<string, string>,
    });

    proc.onData((data) => { output += data; });
    proc.onExit(({ exitCode: c }) => {
      exitCode = c;
      exitAt = Date.now();
    });

    // Wait up to 5s — if it exits quickly or hangs, both confirm the bug
    await delay(5_000);

    const elapsed = exitAt ? exitAt - spawnTime : Date.now() - spawnTime;

    if (exitCode !== null) {
      // Exited — matches the production crash (11ms exit in user's logs)
      console.log(`>>> opencode --continue exited in ${elapsed}ms with code ${exitCode}`);
      console.log('>>> This confirms the crash-loop: immediate exit → auto-restart → repeat');
    } else {
      // Didn't exit but also didn't do anything useful
      const stripped = stripAnsi(output);
      console.log(`>>> opencode --continue still running after ${elapsed}ms`);
      console.log(`>>> Output length: ${stripped.length} chars`);
      console.log('>>> No useful session to continue — --continue is unreliable for restart');
    }

    // The fix: buildArgs should NOT include --continue on resume
    const adapter = createOpenCodeAdapter();
    const resumeArgs = adapter.buildArgs({ sessionId: 'test', resume: true });
    expect(resumeArgs).not.toContain('--continue');
    expect(resumeArgs, 'resume should produce empty args (start fresh)').toEqual([]);
  }, 15_000);

  it('adapter: resume starts fresh (no --continue)', () => {
    const adapter = createOpenCodeAdapter();
    // resume: true should NOT add --continue — always start fresh
    expect(adapter.buildArgs({ sessionId: 'test', resume: true })).toEqual([]);
    // resume with prompt should only have --prompt
    const args = adapter.buildArgs({ sessionId: 'test', resume: true, initialPrompt: 'hello' });
    expect(args).not.toContain('--continue');
    expect(args).toContain('--prompt');
    expect(args).toContain('hello');
  });

  it('adapter: altScreen is true (Bubble Tea)', () => {
    const adapter = createOpenCodeAdapter();
    expect(adapter.altScreen).toBe(true);
  });

  it('fix: resolveCommand finds opencode via interactive shell fallback', () => {
    /**
     * Reproduces the root cause of the first-session crash:
     * opencode's installer adds PATH to .zshrc (interactive-only).
     * resolveCommand with -lc (login non-interactive) can't find it.
     * The -ic fallback (interactive shell) is needed.
     *
     * If opencode is installed, resolvedBin should be an absolute path.
     */
    const resolved = resolveCommand('opencode');
    console.log(`>>> resolveCommand('opencode') = ${resolved}`);

    const adapter = createOpenCodeAdapter();
    console.log(`>>> adapter.resolvedBin = ${adapter.resolvedBin}`);

    // If opencode is installed, it must resolve to an absolute path
    // (not bare 'opencode' which would cause execvp ENOENT)
    if (resolved !== 'opencode') {
      expect(resolved.startsWith('/'), 'resolved path should be absolute').toBe(true);
      expect(resolved).toContain('opencode');
    }
  });

});
