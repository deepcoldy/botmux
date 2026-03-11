#!/usr/bin/env tsx
/**
 * CoCo CLI adapter — end-to-end tests.
 *
 * Verifies:
 *   1. buildArgs: correct flags for new session & resume
 *   2. writeInput: content + carriage-return sent to PTY
 *   3. ensureMcpConfig: registers MCP via `coco mcp add-json`, entry appears in traecli.yaml
 *   4. PTY spawn: coco actually starts with our flags and produces output
 *   5. Prompt round-trip: send a simple task, get a response, session exits cleanly
 *
 * Run:  pnpm tsx test/coco-e2e.ts
 */
import * as pty from 'node-pty';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createCocoAdapter } from '../src/adapters/cli/coco.js';
import { resolveCommand } from '../src/adapters/cli/registry.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/** Wait for a pattern in PTY output, with timeout. */
function waitForOutput(
  proc: pty.IPty,
  pattern: RegExp | string,
  timeoutMs = 30_000,
): Promise<{ matched: boolean; output: string }> {
  return new Promise(resolve => {
    let buf = '';
    const timer = setTimeout(() => {
      disposable.dispose();
      resolve({ matched: false, output: buf });
    }, timeoutMs);
    const disposable = proc.onData(data => {
      buf += data;
      const plain = stripAnsi(buf);
      const match = typeof pattern === 'string'
        ? plain.includes(pattern)
        : pattern.test(plain);
      if (match) {
        clearTimeout(timer);
        disposable.dispose();
        resolve({ matched: true, output: buf });
      }
    });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function testBuildArgs(): Promise<void> {
  console.log('\n── Test: buildArgs ──');
  const adapter = createCocoAdapter();
  const sid = 'test-session-001';

  const newArgs = adapter.buildArgs({ sessionId: sid, resume: false });
  assert(newArgs.includes('--session-id'), 'new session has --session-id');
  assert(newArgs.includes(sid), `new session has session id "${sid}"`);
  assert(newArgs.includes('--yolo'), 'new session has --yolo');
  assert(!newArgs.includes('--resume'), 'new session does NOT have --resume');

  const resumeArgs = adapter.buildArgs({ sessionId: sid, resume: true });
  assert(resumeArgs.includes('--resume'), 'resume has --resume');
  assert(resumeArgs.includes(sid), `resume has session id "${sid}"`);
  assert(resumeArgs.includes('--yolo'), 'resume has --yolo');
  assert(!resumeArgs.includes('--session-id'), 'resume does NOT have --session-id');
}

async function testWriteInput(): Promise<void> {
  console.log('\n── Test: writeInput ──');
  const adapter = createCocoAdapter();
  const written: string[] = [];
  const mockPty = { write: (d: string) => written.push(d) };

  await adapter.writeInput(mockPty, 'hello world');
  assert(written.length === 1, `writeInput sends 1 write (got ${written.length})`);
  assert(written[0] === 'hello world\r', 'writeInput appends \\r');

  written.length = 0;
  await adapter.writeInput(mockPty, '');
  assert(written[0] === '\r', 'empty input still sends \\r');
}

async function testAdapterProperties(): Promise<void> {
  console.log('\n── Test: adapter properties ──');
  const adapter = createCocoAdapter();
  assert(adapter.id === 'coco', `id is "coco" (got "${adapter.id}")`);
  assert(adapter.altScreen === false, 'altScreen is false');
  assert(adapter.completionPattern === undefined, 'completionPattern is undefined');
  assert(adapter.resolvedBin.length > 0, `resolvedBin is set: ${adapter.resolvedBin}`);
}

async function testEnsureMcpConfig(): Promise<void> {
  console.log('\n── Test: ensureMcpConfig ──');
  const adapter = createCocoAdapter();
  const testName = `_e2e_test_${Date.now()}`;

  adapter.ensureMcpConfig({
    name: testName,
    command: 'echo',
    args: ['mcp-test'],
    env: { TEST_KEY: 'test_value' },
  });

  // coco writes to ~/.trae/traecli.yaml
  const yamlPath = join(homedir(), '.trae', 'traecli.yaml');
  assert(existsSync(yamlPath), `traecli.yaml exists at ${yamlPath}`);

  const yaml = readFileSync(yamlPath, 'utf-8');
  assert(yaml.includes(testName), `traecli.yaml contains entry "${testName}"`);
  assert(yaml.includes('echo'), 'entry has correct command');
  assert(yaml.includes('mcp-test'), 'entry has correct args');

  // Clean up — remove test entry by rewriting yaml (coco has no mcp remove)
  const lines = yaml.split('\n');
  const cleaned: string[] = [];
  let skip = false;
  for (const line of lines) {
    if (line.trim() === `- name: ${testName}`) {
      skip = true;
      continue;
    }
    if (skip && (line.startsWith('      ') || line.startsWith('\t\t'))) continue;
    if (skip && !line.startsWith('      ') && !line.startsWith('\t\t')) skip = false;
    if (!skip) cleaned.push(line);
  }
  const { writeFileSync } = await import('node:fs');
  writeFileSync(yamlPath, cleaned.join('\n'));
  console.log(`  🧹 cleaned up test entry "${testName}"`);
}

async function testPtySpawn(): Promise<void> {
  console.log('\n── Test: PTY spawn ──');
  const adapter = createCocoAdapter();
  const sid = `e2e-${Date.now()}`;
  const args = adapter.buildArgs({ sessionId: sid, resume: false });

  console.log(`  spawning: ${adapter.resolvedBin} ${args.join(' ')}`);

  const proc = pty.spawn(adapter.resolvedBin, args, {
    name: 'xterm-256color',
    cols: 200,
    rows: 50,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });

  // Wait for coco to show something (prompt or welcome message)
  const { matched, output } = await waitForOutput(proc, /[>❯$%]|coco|model/i, 30_000);
  const plain = stripAnsi(output);

  assert(matched, 'coco started and produced output');
  assert(plain.length > 0, `got output (${plain.length} chars)`);

  // Check that coco is not complaining about unknown flags
  const hasError = /unknown flag|unknown option|error.*--yolo|error.*--session-id/i.test(plain);
  assert(!hasError, 'no unknown-flag errors', hasError ? plain.substring(0, 200) : undefined);

  proc.kill();
  await sleep(500);
  console.log('  🧹 coco process killed');
}

async function testPromptRoundTrip(): Promise<void> {
  console.log('\n── Test: prompt round-trip ──');
  const adapter = createCocoAdapter();
  const sid = `e2e-rt-${Date.now()}`;
  const args = adapter.buildArgs({ sessionId: sid, resume: false });

  const proc = pty.spawn(adapter.resolvedBin, args, {
    name: 'xterm-256color',
    cols: 200,
    rows: 50,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });

  // Wait for prompt
  const startup = await waitForOutput(proc, /[>❯$%]/i, 30_000);
  if (!startup.matched) {
    assert(false, 'coco prompt appeared', `timeout — output: ${stripAnsi(startup.output).substring(0, 300)}`);
    proc.kill();
    return;
  }
  assert(true, 'coco prompt appeared');

  // Send a simple, fast task
  const prompt = 'echo "e2e_test_ok" and exit';
  await adapter.writeInput(proc, prompt);

  // Wait for coco to respond (should echo or acknowledge)
  const response = await waitForOutput(proc, /e2e_test_ok|tool|bash|echo/i, 60_000);
  const plain = stripAnsi(response.output);
  assert(response.matched, 'coco responded to prompt', plain.substring(0, 300));

  proc.kill();
  await sleep(500);
  console.log('  🧹 coco process killed');
}

async function testPathOverride(): Promise<void> {
  console.log('\n── Test: pathOverride ──');
  const cocoBin = resolveCommand('coco');

  // With explicit path override
  const adapter = createCocoAdapter(cocoBin);
  assert(adapter.resolvedBin === cocoBin, `resolvedBin uses override: ${adapter.resolvedBin}`);

  // With non-existent path — should still set it (resolveCommand returns as-is for absolute)
  const fakePath = '/usr/local/bin/coco-fake';
  const adapter2 = createCocoAdapter(fakePath);
  assert(adapter2.resolvedBin === fakePath, `resolvedBin uses fake path: ${adapter2.resolvedBin}`);
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🧪 CoCo CLI Adapter — E2E Tests\n');

  // Fast unit-level checks
  await testAdapterProperties();
  await testBuildArgs();
  await testWriteInput();
  await testPathOverride();

  // Real CLI interactions
  await testEnsureMcpConfig();
  await testPtySpawn();
  await testPromptRoundTrip();

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
