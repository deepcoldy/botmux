/**
 * E2E test: Claude Code submission of messages with image attachments.
 *
 * Bug: Messages containing image attachments have multi-line content
 * (user text + attachment hint with file paths). When written to PTY
 * via `pty.write(content + '\r')`, the `\n` characters in the content
 * may cause premature submission or the input to hang without submitting.
 *
 * Also tests "Pasted text" style content — text copied from Lark rich
 * text may contain special Unicode characters that interfere with
 * Claude Code's input handling.
 *
 * Run:  pnpm vitest run test/claude-code-image-submit.e2e.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { resolveCommand } from '../src/adapters/cli/registry.js';
import { formatAttachmentsHint } from '../src/core/session-manager.js';

// ─── Constants (match production worker.ts) ─────────────────────────────────

const PTY_COLS = 300;
const PTY_ROWS = 50;

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
 * Wait for idle detection (prompt ready) on the given session.
 * Returns the timestamp when idle was detected.
 */
function waitForIdle(session: PtySession, adapter: ReturnType<typeof createClaudeCodeAdapter>, timeoutMs = 30_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const detector = new IdleDetector(adapter);
    let resolved = false;

    detector.onIdle(() => {
      if (!resolved) {
        resolved = true;
        detector.dispose();
        resolve(Date.now());
      }
    });

    session.proc.onData(data => detector.feed(data));

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        detector.dispose();
        reject(new Error(`Idle not detected within ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
}

/**
 * Check whether the prompt was actually submitted and processed by Claude.
 * After real submission, Claude Code produces new output (tool calls, model
 * responses, spinners, completion markers, etc.).
 */
function wasSubmitted(session: PtySession, writeTs: number, waitMs = 500): boolean {
  const after = session.outputAfter(writeTs + waitMs);
  const stripped = after.replace(/\s+/g, '').trim();
  // More than trivial echo = Claude started processing
  return stripped.length > 10;
}

/**
 * Wait until condition is met or timeout.
 */
function waitUntil(condFn: () => boolean, timeoutMs: number, intervalMs = 200): Promise<boolean> {
  return new Promise(resolve => {
    const start = Date.now();
    const check = setInterval(() => {
      if (condFn() || Date.now() - start > timeoutMs) {
        clearInterval(check);
        resolve(condFn());
      }
    }, intervalMs);
  });
}

// ─── Test fixtures ──────────────────────────────────────────────────────────

/** Simulates a thread reply with image attachment (the typical bug scenario) */
function buildImageReplyContent(userText: string, imagePath: string): string {
  const attachments = [{ type: 'image' as const, path: imagePath, name: 'test.jpg' }];
  return `${userText}${formatAttachmentsHint(attachments)}`;
}

/** Simulates a pure image message (no text, just [图片] + attachment) */
function buildPureImageContent(imagePath: string): string {
  return buildImageReplyContent('[图片]', imagePath);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Claude Code image/attachment message submission', () => {
  let session: PtySession | null = null;

  afterEach(() => {
    if (session) {
      try { session.proc.kill(); } catch {}
      session = null;
    }
  });

  it('message-parser: formatAttachmentsHint produces expected multi-line format', () => {
    const hint = formatAttachmentsHint([
      { type: 'image', path: '/tmp/attachments/img_abc.jpg', name: 'img_abc.jpg' },
    ]);
    expect(hint).toContain('\n\n附件');
    expect(hint).toContain('- /tmp/attachments/img_abc.jpg');
    // Verify the \n count — this is what gets written to PTY
    const newlines = (hint.match(/\n/g) || []).length;
    console.log(`[format] Attachment hint has ${newlines} newlines: ${JSON.stringify(hint)}`);
    expect(newlines).toBeGreaterThanOrEqual(3); // \n\n before 附件, \n before path
  });

  it('multi-line content structure matches what daemon sends to worker', () => {
    const content = buildImageReplyContent(
      '看起来表格不是很整齐呢？',
      '/root/.botmux/data/attachments/om_xxx/img_v3_abc.jpg',
    );
    console.log(`[structure] Full content:\n${content}`);
    console.log(`[structure] JSON: ${JSON.stringify(content)}`);

    // Verify structure
    expect(content).toContain('看起来表格不是很整齐呢？');
    expect(content).toContain('附件（使用 Read 工具查看）：');
    expect(content).toContain('- /root/.botmux/data/attachments/');

    // Count newlines — these are the problematic characters for PTY write
    const newlines = (content.match(/\n/g) || []).length;
    console.log(`[structure] Total newlines in content: ${newlines}`);
    expect(newlines).toBeGreaterThanOrEqual(3);
  });

  it('SCENARIO: multi-line image reply submitted via writeInput', async () => {
    /**
     * Reproduces the production flow for a thread reply with image:
     * 1. Spawn Claude Code, wait for ❯ prompt
     * 2. Write multi-line content (text + attachment hint) via writeInput
     * 3. Verify Claude Code processes it (not stuck at prompt)
     */
    const adapter = createClaudeCodeAdapter();
    const sid = randomUUID();
    const args = adapter.buildArgs({ sessionId: sid, resume: false });
    session = spawnClaudeCode(args);

    // Wait for first prompt
    const idleAt = await waitForIdle(session, adapter);
    const startupMs = idleAt - session.spawnTime;
    console.log(`[image-reply] Claude ready at +${startupMs}ms`);

    // Build the same content daemon would send for an image reply
    const content = buildImageReplyContent(
      'just say PONG',
      '/tmp/test-image.jpg',
    );
    console.log(`[image-reply] Writing multi-line content (${content.length} chars, ${(content.match(/\n/g) || []).length} newlines)`);

    const writeTs = Date.now();
    await adapter.writeInput(session.proc, content);

    // Wait for response
    const responded = await waitUntil(
      () => wasSubmitted(session!, writeTs),
      20_000,
    );

    const outputAfter = session.outputAfter(writeTs);
    console.log(`[image-reply] Submitted: ${responded}`);
    console.log(`[image-reply] Output after write (first 500):\n${outputAfter.slice(0, 500)}`);

    expect(responded, 'Claude Code should process multi-line image reply').toBe(true);
  }, 60_000);

  it('SCENARIO: pure image message ([图片] + attachment path)', async () => {
    /**
     * Tests pure image messages where content is just "[图片]" + attachment hint.
     */
    const adapter = createClaudeCodeAdapter();
    const sid = randomUUID();
    const args = adapter.buildArgs({ sessionId: sid, resume: false });
    session = spawnClaudeCode(args);

    const idleAt = await waitForIdle(session, adapter);
    console.log(`[pure-image] Claude ready at +${idleAt - session.spawnTime}ms`);

    const content = buildPureImageContent('/tmp/test-image.jpg');
    console.log(`[pure-image] Content: ${JSON.stringify(content)}`);

    const writeTs = Date.now();
    await adapter.writeInput(session.proc, content);

    const responded = await waitUntil(
      () => wasSubmitted(session!, writeTs),
      20_000,
    );

    console.log(`[pure-image] Submitted: ${responded}`);
    console.log(`[pure-image] Output after write:\n${session.outputAfter(writeTs).slice(0, 500)}`);

    expect(responded, 'Claude Code should process pure image message').toBe(true);
  }, 60_000);

  it('SCENARIO: bracketed paste mode wrapping for multi-line content', async () => {
    /**
     * Tests if wrapping multi-line content in bracketed paste escape sequences
     * (\x1b[200~...\x1b[201~) helps submission.
     *
     * Claude Code may enable bracketed paste mode. If so, wrapped content is
     * treated as a single paste and the trailing \r submits it.
     */
    const adapter = createClaudeCodeAdapter();
    const sid = randomUUID();
    const args = adapter.buildArgs({ sessionId: sid, resume: false });
    session = spawnClaudeCode(args);

    const idleAt = await waitForIdle(session, adapter);
    console.log(`[bracketed] Claude ready at +${idleAt - session.spawnTime}ms`);

    const content = buildImageReplyContent(
      'just say PONG',
      '/tmp/test-image.jpg',
    );

    // Wrap in bracketed paste sequences
    const bracketedContent = `\x1b[200~${content}\x1b[201~`;

    const writeTs = Date.now();
    session.proc.write(bracketedContent + '\r');

    const responded = await waitUntil(
      () => wasSubmitted(session!, writeTs),
      20_000,
    );

    console.log(`[bracketed] Submitted: ${responded}`);
    console.log(`[bracketed] Output after write:\n${session.outputAfter(writeTs).slice(0, 500)}`);

    // Log whether bracketed paste helped vs regular writeInput
    if (responded) {
      console.log('[bracketed] ✓ Bracketed paste mode works for multi-line submission');
    } else {
      console.log('[bracketed] ✗ Bracketed paste did not help');
    }

    // Bracketed paste alone doesn't help — the \r is still consumed by paste mode.
    // This is expected; the real fix is the delayed \r in writeInput.
    // Just log the result for documentation.
    console.log(`[bracketed] Note: bracketed paste alone does NOT fix the issue — delayed \\r is the correct fix`);
  }, 60_000);

  it('SCENARIO: special Unicode characters (Pasted text simulation)', async () => {
    /**
     * Tests content with special Unicode characters that Lark rich text
     * may inject — zero-width spaces, non-breaking spaces, smart quotes,
     * full-width characters, etc.
     */
    const adapter = createClaudeCodeAdapter();
    const sid = randomUUID();
    const args = adapter.buildArgs({ sessionId: sid, resume: false });
    session = spawnClaudeCode(args);

    const idleAt = await waitForIdle(session, adapter);
    console.log(`[unicode] Claude ready at +${idleAt - session.spawnTime}ms`);

    // Content with various Unicode that Lark may insert:
    // - \u200B zero-width space
    // - \u00A0 non-breaking space
    // - \uFEFF BOM / zero-width no-break space
    // - \u2018/\u2019 smart quotes
    // - Full-width characters
    const content = 'just say PONG\u200B\u00A0and nothing else';
    console.log(`[unicode] Content: ${JSON.stringify(content)}`);
    console.log(`[unicode] Char codes: ${[...content].map(c => `U+${c.codePointAt(0)!.toString(16).padStart(4, '0')}`).join(' ')}`);

    const writeTs = Date.now();
    await adapter.writeInput(session.proc, content);

    const responded = await waitUntil(
      () => wasSubmitted(session!, writeTs),
      20_000,
    );

    console.log(`[unicode] Submitted: ${responded}`);
    console.log(`[unicode] Output after write:\n${session.outputAfter(writeTs).slice(0, 500)}`);

    expect(responded, 'Content with special Unicode should still submit').toBe(true);
  }, 60_000);

  it('COMPARISON: single-line submission works (baseline)', async () => {
    /**
     * Baseline: verify single-line content works with the adapter.
     * Multi-line is already tested in the image reply scenarios above.
     */
    const adapter = createClaudeCodeAdapter();
    const sid = randomUUID();
    const args = adapter.buildArgs({ sessionId: sid, resume: false });
    session = spawnClaudeCode(args);

    await waitForIdle(session, adapter);

    const singleLine = 'just say PONG and nothing else';
    console.log(`[compare] Writing single-line: "${singleLine}"`);

    const writeTs = Date.now();
    await adapter.writeInput(session.proc, singleLine);

    const ok = await waitUntil(
      () => wasSubmitted(session!, writeTs),
      20_000,
    );
    console.log(`[compare] Single-line submitted: ${ok}`);
    expect(ok, 'Single-line should submit').toBe(true);
  }, 60_000);
});
