/**
 * Source-level guard for the raw_input + follow-up ATOMIC delivery contract
 * (PR #157 review blocker, round 2).
 *
 * Why source-level: worker.ts is a process script with no exports, so its
 * IPC handler can't be unit-tested directly. The race it guards against:
 * `process.on('message', async ...)` handlers do NOT serialize — the
 * raw_input branch awaits 200ms between sendText and Enter, and a separate
 * `message` IPC handled in that window writes into the PTY first (type-ahead
 * adapters flush immediately), interleaving the follow-up into the slash
 * command. The fix makes the follow-up ride on the raw_input IPC itself and
 * the worker enqueue it strictly after the Enter.
 *
 * Daemon-side single-IPC behavior is covered in
 * test/worker-ready-display-mode.test.ts; this file pins the worker-side
 * ordering and the daemon-side "never a second IPC" structure in source.
 *
 * Run: pnpm vitest run test/raw-input-followup-atomicity.test.ts
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSrc = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf-8');
const poolSrc = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf-8');

function caseRegion(src: string, marker: string, span = 3000): string {
  const start = src.indexOf(marker);
  expect(start, `${marker} not found`).toBeGreaterThanOrEqual(0);
  return src.slice(start, start + span);
}

describe('worker raw_input handler', () => {
  const region = caseRegion(workerSrc, "case 'raw_input':");

  it('enqueues followUpContent strictly AFTER the slash-command Enter', () => {
    const enterIdx = region.indexOf("sendSpecialKeys('Enter')");
    const followIdx = region.indexOf('msg.followUpContent');
    expect(enterIdx).toBeGreaterThanOrEqual(0);
    expect(followIdx).toBeGreaterThanOrEqual(0);
    expect(followIdx).toBeGreaterThan(enterIdx);
  });

  it('routes the follow-up through sendToPty (normal busy-queue semantics)', () => {
    expect(region).toContain('sendToPty(msg.followUpContent)');
  });
});

describe('daemon prompt_ready dispatch', () => {
  const region = caseRegion(poolSrc, "case 'prompt_ready':", 2000);

  it('bundles the follow-up onto the raw_input IPC instead of a second message IPC', () => {
    expect(region).toContain('followUpContent: followUp?.cliInput');
    // A separate `message` IPC here would reopen the race — must not exist.
    expect(region).not.toContain("type: 'message'");
  });
});
