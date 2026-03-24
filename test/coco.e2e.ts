/**
 * CoCo CLI adapter — end-to-end tests.
 *
 * Verifies:
 *   1. buildArgs: correct flags for new session & resume
 *   2. writeInput: content + carriage-return sent to PTY
 *   3. ensureMcpConfig: registers MCP via `coco mcp add-json`, entry appears in traecli.yaml
 *   4. PTY spawn: coco actually starts with our flags and produces output
 *   5. Prompt round-trip: send a simple task, get a response
 *
 * Run:  pnpm vitest run test/coco-e2e.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as pty from 'node-pty';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createCocoAdapter } from '../src/adapters/cli/coco.js';
import { resolveCommand } from '../src/adapters/cli/registry.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
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
    cols: 200,
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

function waitForQuiescence(session: PtySession, quietMs = 2000, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let lastLen = 0;
    const check = setInterval(() => {
      const curLen = session.rawOutput().length;
      if (Date.now() > deadline) {
        clearInterval(check);
        reject(new Error(`Quiescence timeout — output still changing`));
      }
      if (curLen === lastLen && curLen > 0) {
        clearInterval(check);
        resolve();
      }
      lastLen = curLen;
    }, quietMs);
  });
}

// ─── Unit-level tests ─────────────────────────────────────────────────────────

describe('CoCo adapter: buildArgs', () => {
  const adapter = createCocoAdapter();
  const sid = 'test-session-001';

  it('new session: --session-id <id> --yolo', () => {
    const args = adapter.buildArgs({ sessionId: sid, resume: false });
    expect(args).toContain('--session-id');
    expect(args).toContain(sid);
    expect(args).toContain('--yolo');
    expect(args).not.toContain('--resume');
  });

  it('resume session: --resume <id> --yolo', () => {
    const args = adapter.buildArgs({ sessionId: sid, resume: true });
    expect(args).toContain('--resume');
    expect(args).toContain(sid);
    expect(args).toContain('--yolo');
    expect(args).not.toContain('--session-id');
  });
});

describe('CoCo adapter: writeInput', () => {
  const adapter = createCocoAdapter();

  it('sends content + \\r', async () => {
    const written: string[] = [];
    const mock = { write: (d: string) => written.push(d) };

    await adapter.writeInput(mock, 'hello world');
    expect(written).toEqual(['hello world', '\r']);
  });

  it('empty content still sends \\r', async () => {
    const written: string[] = [];
    const mock = { write: (d: string) => written.push(d) };

    await adapter.writeInput(mock, '');
    expect(written).toEqual(['', '\r']);
  });
});

describe('CoCo adapter: properties', () => {
  it('has correct static properties', () => {
    const adapter = createCocoAdapter();
    expect(adapter.id).toBe('coco');
    expect(adapter.altScreen).toBe(false);
    expect(adapter.completionPattern).toBeUndefined();
    expect(adapter.resolvedBin).toBeTruthy();
  });

  it('respects pathOverride', () => {
    const cocoBin = resolveCommand('coco');
    expect(createCocoAdapter(cocoBin).resolvedBin).toBe(cocoBin);

    const fake = '/usr/local/bin/coco-fake';
    expect(createCocoAdapter(fake).resolvedBin).toBe(fake);
  });
});

// ─── Real CLI tests ───────────────────────────────────────────────────────────

describe('CoCo adapter: ensureMcpConfig', () => {
  const adapter = createCocoAdapter();
  const testName = `_e2e_test_${Date.now()}`;

  afterEach(() => {
    // Clean up test entry from traecli.yaml
    const yamlPath = join(homedir(), '.trae', 'traecli.yaml');
    if (!existsSync(yamlPath)) return;
    const yaml = readFileSync(yamlPath, 'utf-8');
    if (!yaml.includes(testName)) return;
    const lines = yaml.split('\n');
    const cleaned: string[] = [];
    let skip = false;
    for (const line of lines) {
      if (line.trim() === `- name: ${testName}`) { skip = true; continue; }
      if (skip && (line.startsWith('      ') || line.startsWith('\t\t'))) continue;
      if (skip) skip = false;
      if (!skip) cleaned.push(line);
    }
    writeFileSync(yamlPath, cleaned.join('\n'));
  });

  it('installs MCP entry via coco mcp add-json', () => {
    adapter.ensureMcpConfig({
      name: testName,
      command: 'echo',
      args: ['mcp-test'],
      env: { TEST_KEY: 'test_value' },
    });

    const yamlPath = join(homedir(), '.trae', 'traecli.yaml');
    expect(existsSync(yamlPath)).toBe(true);

    const yaml = readFileSync(yamlPath, 'utf-8');
    expect(yaml).toContain(testName);
    expect(yaml).toContain('echo');
    expect(yaml).toContain('mcp-test');
  });
});

describe('CoCo adapter: PTY spawn', () => {
  let session: PtySession | null = null;

  afterEach(() => {
    if (session) {
      try { session.proc.kill(); } catch {}
      session = null;
    }
  });

  it('starts without unknown-flag errors', async () => {
    const adapter = createCocoAdapter();
    const sid = `e2e-${Date.now()}`;
    const args = adapter.buildArgs({ sessionId: sid, resume: false });

    session = spawnCoco(args);
    await waitForQuiescence(session, 3000);

    const plain = session.plainOutput();
    expect(plain.length).toBeGreaterThan(0);

    const hasError = /unknown flag|unknown option|error.*--yolo|error.*--session-id/i.test(plain);
    expect(hasError, `unexpected error in output: ${plain.substring(0, 300)}`).toBe(false);
  }, 45_000);
});

// ─── First-input submission tests ─────────────────────────────────────────────

/**
 * Check whether the prompt was actually submitted (not just echoed into
 * the input box). After real submission, coco produces new output like
 * tool calls, model responses, or spinners.
 */
function wasSubmitted(session: PtySession, writeTs: number): boolean {
  const after = session.outputAfter(writeTs + 500);
  const stripped = after.replace(/\s+/g, '').trim();
  return stripped.length > 10;
}

describe('CoCo first-input submission (IdleDetector + readyPattern)', () => {
  let session: PtySession | null = null;

  afterEach(() => {
    if (session) {
      try { session.proc.kill(); } catch {}
      session = null;
    }
  });

  it('BUG: without readyPattern, idle fires before TUI is ready', async () => {
    const { IdleDetector } = await import('../src/utils/idle-detector.js');
    const adapter = createCocoAdapter();
    const sid = `e2e-bug-${Date.now()}`;
    const args = adapter.buildArgs({ sessionId: sid, resume: false });

    session = spawnCoco(args);
    // Simulate old behavior: no readyPattern
    const noPatternAdapter = { ...adapter, readyPattern: undefined };
    const detector = new IdleDetector(noPatternAdapter as any);

    let idleFiredAt = 0;
    detector.onIdle(() => { if (!idleFiredAt) idleFiredAt = Date.now(); });

    const spawnTs = Date.now();
    session.proc.onData(data => detector.feed(data));

    await new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (idleFiredAt || Date.now() - spawnTs > 20_000) {
          clearInterval(check);
          resolve();
        }
      }, 200);
    });

    const elapsed = idleFiredAt ? idleFiredAt - spawnTs : -1;
    console.log(`[bug] No readyPattern → idle fired after ${elapsed}ms (before TUI ready)`);

    expect(idleFiredAt).toBeGreaterThan(0);
    expect(elapsed, 'fires prematurely (< 5s) — input box not rendered yet').toBeLessThan(5000);

    detector.dispose();
  }, 30_000);

  it('FIX: with readyPattern, idle waits for ⏵⏵ in TUI', async () => {
    const { IdleDetector } = await import('../src/utils/idle-detector.js');
    const adapter = createCocoAdapter(); // has readyPattern: /⏵⏵/
    const sid = `e2e-fix-${Date.now()}`;
    const args = adapter.buildArgs({ sessionId: sid, resume: false });

    session = spawnCoco(args);
    const detector = new IdleDetector(adapter);

    let idleFiredAt = 0;
    detector.onIdle(() => { if (!idleFiredAt) idleFiredAt = Date.now(); });

    const spawnTs = Date.now();
    session.proc.onData(data => detector.feed(data));

    await new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (idleFiredAt || Date.now() - spawnTs > 30_000) {
          clearInterval(check);
          resolve();
        }
      }, 200);
    });

    const elapsed = idleFiredAt ? idleFiredAt - spawnTs : -1;
    console.log(`[fix] readyPattern ⏵⏵ → idle fired after ${elapsed}ms (TUI confirmed ready)`);

    expect(idleFiredAt, 'idle should eventually fire').toBeGreaterThan(0);
    // Must fire AFTER TUI renders (⏵⏵ seen), which happens after xterm query timeout (~5s)
    expect(elapsed, 'waits for TUI render before marking idle').toBeGreaterThanOrEqual(5000);

    detector.dispose();
  }, 45_000);

  it('full daemon flow: readyPattern → writeInput → CoCo responds', async () => {
    const { IdleDetector } = await import('../src/utils/idle-detector.js');
    const adapter = createCocoAdapter();
    const sid = `e2e-full-${Date.now()}`;
    const args = adapter.buildArgs({ sessionId: sid, resume: false });

    session = spawnCoco(args);
    const detector = new IdleDetector(adapter);

    const pendingPrompt = 'just say PONG';
    let writeTs = 0;

    detector.onIdle(() => {
      if (!writeTs) {
        writeTs = Date.now();
        console.log(`[full] readyPattern matched → idle fired at ${writeTs - spawnTs}ms, sending prompt`);
        adapter.writeInput(session!.proc, pendingPrompt);
      }
    });

    const spawnTs = Date.now();
    session.proc.onData(data => detector.feed(data));

    // Wait for submission + response
    await new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (writeTs && Date.now() - writeTs > 15_000) {
          clearInterval(check);
          resolve();
        }
        if (Date.now() - spawnTs > 45_000) {
          clearInterval(check);
          resolve();
        }
      }, 500);
    });

    expect(writeTs, 'prompt should have been sent').toBeGreaterThan(0);

    const submitted = wasSubmitted(session, writeTs);
    console.log(`[full] Submitted: ${submitted}`);
    console.log('[full] Output after write:\n' + session.outputAfter(writeTs).slice(0, 500));

    expect(submitted, 'CoCo should accept and process the prompt').toBe(true);

    detector.dispose();
  }, 60_000);
});
