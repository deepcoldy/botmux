/**
 * Design §9.5 row 4 — "submission installed, journal has no result".
 *
 * The verdict append is made to throw right after the install renames (the
 * same on-disk state a crash leaves). A later drive must re-validate and
 * commit the installed product for a still-current attempt — before any
 * deadline can discard it — or set it aside when the attempt is gone.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const crash = vi.hoisted(() => ({ nextSucceeded: false }));

vi.mock('../src/workflows/v3/journal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/workflows/v3/journal.js')>();
  return {
    ...actual,
    withJournalMutationSync: ((journalPath, fn) => actual.withJournalMutationSync(journalPath, (mutation) => fn({
      get events() { return mutation.events; },
      append(event, options) {
        if (crash.nextSucceeded && event.type === 'nodeSucceeded') {
          crash.nextSucceeded = false;
          throw new Error('simulated crash between install and journal append');
        }
        return mutation.append(event, options);
      },
    }))) as typeof actual.withJournalMutationSync,
  };
});

import { appendEvent } from '../src/workflows/v3/journal.js';
import { readAndValidateManifest } from '../src/workflows/v3/manifest.js';
import {
  BotRun,
  FakeExecutor,
  cleanupBotRuns,
  expectTerminal,
  reportDag,
  reportFiles,
} from './helpers/v3-external-harness.js';

afterEach(async () => {
  crash.nextSucceeded = false;
  await cleanupBotRuns();
});

async function crashAfterInstall(run: BotRun, attemptId: string): Promise<void> {
  crash.nextSucceeded = true;
  await expect(run.submit(attemptId, { ...reportFiles('valid product'), sessionId: 'sess-1' }))
    .rejects.toThrow(/simulated crash/);
  expect(run.of('nodeSucceeded')).toEqual([]);
  expect(readFileSync(join(run.runDir, attemptId, 'work', 'report.md'), 'utf-8')).toBe('valid product');
}

describe('external submissions — installed but not journalled', () => {
  it('a restart re-validates and commits the install before the node deadline can discard it', async () => {
    const run = new BotRun(reportDag('crash-commit'));
    await run.drive(new FakeExecutor());
    const attemptId = run.openAttempt('write').attemptId;
    const accepted = run.accept(attemptId);
    if (!accepted.ok) throw new Error('accept failed');
    await crashAfterInstall(run, attemptId);

    run.clock.t = accepted.deadlineAt; // the deadline has passed by the time we restart
    const restarted = new FakeExecutor();
    expect(expectTerminal(await run.drive(restarted)).runStatus).toBe('succeeded');
    expect(run.of('nodeBlocked')).toEqual([]);
    expect(restarted.stops).toEqual([]);
    const [succeeded] = run.of('nodeSucceeded');
    await readAndValidateManifest(succeeded!.manifestPath, join(run.runDir, attemptId, 'work'));
    expect(existsSync(join(run.runDir, attemptId, 'submissions'))).toBe(false);
    expect(readdirSync(join(run.runDir, attemptId)).some((name) => name.includes('intent'))).toBe(false);
  });

  it('a later submission for the same attempt is the duplicate once the crash-left install commits', async () => {
    const run = new BotRun(reportDag('crash-then-resubmit'));
    await run.drive(new FakeExecutor());
    const attemptId = run.openAttempt('write').attemptId;
    run.accept(attemptId);
    await crashAfterInstall(run, attemptId);
    expect(await run.submit(attemptId, { ...reportFiles('second'), sessionId: 'sess-1' }))
      .toEqual({ ok: false, reason: 'already-succeeded' });
    expect(readFileSync(join(run.runDir, attemptId, 'work', 'report.md'), 'utf-8')).toBe('valid product');
  });

  it('an install whose attempt was cancelled meanwhile is set aside, not committed', async () => {
    const run = new BotRun(reportDag('crash-cancelled'));
    await run.drive(new FakeExecutor());
    const attemptId = run.openAttempt('write').attemptId;
    run.accept(attemptId);
    await crashAfterInstall(run, attemptId);
    appendEvent(run.journalPath, { type: 'runCancelRequested', cancelRequestId: 'cancel-c', by: 'ou' });

    expect(expectTerminal(await run.drive(new FakeExecutor())).runStatus).toBe('cancelled');
    expect(run.of('nodeSucceeded')).toEqual([]);
    expect(existsSync(join(run.runDir, attemptId, 'work'))).toBe(false);
    expect(existsSync(join(run.runDir, attemptId, 'submissions'))).toBe(false);
  });
});
