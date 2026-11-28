import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PtyHandle } from '../src/adapters/cli/types.js';

// history.jsonl / brain / --log-file roots all derive from os.homedir(): point
// HOME at a temp dir before importing the adapter. BOTMUX_TIME_SCALE shrinks the
// submit waits without changing which branch runs.
const home = mkdtempSync(join(tmpdir(), 'agy-owned-home-'));
const previousHome = process.env.HOME;
const previousScale = process.env.BOTMUX_TIME_SCALE;
process.env.HOME = home;
process.env.BOTMUX_TIME_SCALE = '0.05';

const { createAntigravityAdapter } = await import('../src/adapters/cli/antigravity.js');

const CLI_HOME = join(home, '.gemini', 'antigravity-cli');
const HISTORY = join(CLI_HOME, 'history.jsonl');

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousScale === undefined) delete process.env.BOTMUX_TIME_SCALE; else process.env.BOTMUX_TIME_SCALE = previousScale;
  rmSync(home, { recursive: true, force: true });
});

/** agy (Go encoding/json) escapes <, >, & in history.jsonl. */
function historyLine(display: string, conversationId?: string): string {
  const encoded = JSON.stringify(display).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `{"display":${encoded},"timestamp":${Date.now()},"workspace":"/w"${conversationId ? `,"conversationId":"${conversationId}"` : ''}}\n`;
}

function transcriptPath(cid: string): string {
  return join(CLI_HOME, 'brain', cid, '.system_generated', 'logs', 'transcript_full.jsonl');
}

/** agy's USER_INPUT envelope around the submitted payload. */
function userInput(cid: string, payload: string): void {
  const path = transcriptPath(cid);
  mkdirSync(join(path, '..'), { recursive: true });
  appendFileSync(path, JSON.stringify({
    type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE',
    content: `<USER_REQUEST>\n${payload}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is now.\n</ADDITIONAL_METADATA>`,
  }) + '\n');
}

function plannerStep(cid: string): void {
  const path = transcriptPath(cid);
  mkdirSync(join(path, '..'), { recursive: true });
  appendFileSync(path, JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', content: 'ok' }) + '\n');
}

/** The result without its deferred probe (a function), for structural asserts. */
function plain(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const { proveConsumed: _probe, settleConsumed: _settle, ...rest } = result as Record<string, unknown>;
  return rest;
}

/** Run the result's deferred consumption probe, as the worker's watcher would. */
function probe(result: unknown): unknown {
  const fn = (result as { proveConsumed?: () => unknown } | undefined)?.proveConsumed;
  return typeof fn === 'function' ? fn() : 'no-probe';
}

function makePty(onEnter: () => void): PtyHandle {
  return {
    write: () => true,
    sendText: () => true,
    sendSpecialKeys: (...keys: string[]) => { if (keys[0] === 'Enter') onEnter(); return true; },
  } as unknown as PtyHandle;
}

/** A managed (non-adopt) pane: buildArgs wires the process-scoped --log-file,
 * which agy fills with `Streaming conversation <id>` once it streams. */
function launch(opts: { resumeCid?: string } = {}) {
  const adapter = createAntigravityAdapter('/usr/local/bin/agy');
  const args = adapter.buildArgs({
    sessionId: `s-${randomUUID()}`,
    resume: !!opts.resumeCid,
    ...(opts.resumeCid ? { resumeSessionId: opts.resumeCid } : {}),
    reattach: false,
  } as any);
  const logPath = args[args.indexOf('--log-file') + 1]!;
  return {
    adapter,
    /** agy writes its log from startup, before any conversation exists. */
    startupLog: () => appendFileSync(logPath, 'I1127 10:00:00.000000 1 x.go:1] Listing conversations\n'),
    stream: (cid: string) => appendFileSync(logPath, `I1127 10:00:00.000000 1 x.go:1] Streaming conversation ${cid}\n`),
  };
}

beforeEach(() => {
  mkdirSync(CLI_HOME, { recursive: true });
  writeFileSync(HISTORY, '');
});

describe('antigravity writeInput — ownership of the submit proof', () => {
  it('proves a fresh first submit from the own conversation transcript even though history has no conversationId', async () => {
    const cid = randomUUID();
    const { adapter, stream, startupLog } = launch();
    startupLog();
    const content = '<botmux_routing>first turn</botmux_routing>\nhello';
    const result = await adapter.writeInput(makePty(() => {
      appendFileSync(HISTORY, historyLine(content));
      stream(cid);
      userInput(cid, content);
    }), content);
    expect(plain(result)).toEqual({ submitted: true, cliSessionId: cid, ownershipProven: true });
  });

  it('does not prove a fresh first submit when the write-time conversation is unknowable', async () => {
    const cid = randomUUID();
    userInput(cid, 'older turn of a sibling-reused conversation');
    const { adapter, stream } = launch();
    const content = 'fresh launch before agy wrote its log';
    const result = await adapter.writeInput(makePty(() => {
      appendFileSync(HISTORY, historyLine(content));
      stream(cid);
      userInput(cid, content);
    }), content);
    expect(plain(result)).toEqual({ submitted: true, cliSessionId: cid });
    expect(probe(result)).toBeUndefined();
  });

  it('proves a resumed follow-up whose USER_INPUT lands after the write-time transcript baseline', async () => {
    const cid = randomUUID();
    userInput(cid, 'older turn');
    plannerStep(cid);
    const { adapter, stream } = launch({ resumeCid: cid });
    const content = '<session_id>abc</session_id>\nfollow-up';
    const result = await adapter.writeInput(makePty(() => {
      appendFileSync(HISTORY, historyLine(content, cid));
      stream(cid);
      userInput(cid, content);
    }), content);
    expect(result).toMatchObject({ submitted: true, cliSessionId: cid, ownershipProven: true });
  });

  it('does not prove a same-text history line submitted by another agy window', async () => {
    const own = randomUUID();
    const foreign = randomUUID();
    userInput(own, 'older turn');
    const { adapter, stream } = launch({ resumeCid: own });
    const content = '<botmux_routing>identical opening across sessions</botmux_routing>';
    const result = await adapter.writeInput(makePty(() => {
      stream(own);
      // The sibling window consumed the identical text into ITS conversation.
      appendFileSync(HISTORY, historyLine(content, foreign));
      userInput(foreign, content);
    }), content);
    expect(plain(result)).toEqual({ submitted: true, cliSessionId: own });
    expect(probe(result)).toBeUndefined();
  });

  it('does not count a same-text USER_INPUT that predates this write', async () => {
    const cid = randomUUID();
    const content = '继续';
    userInput(cid, content);
    plannerStep(cid);
    const { adapter, stream } = launch({ resumeCid: cid });
    const result = await adapter.writeInput(makePty(() => {
      appendFileSync(HISTORY, historyLine(content, cid));
      stream(cid);
      // Queue mode: Enter is logged, but agy has not fed it to the model yet.
    }), content);
    expect(plain(result)).toEqual({ submitted: true, cliSessionId: cid });
    expect(probe(result)).toBeUndefined();
  });

  it('does not accept a USER_INPUT whose payload only shares the prefix', async () => {
    const cid = randomUUID();
    userInput(cid, 'older turn');
    const { adapter, stream } = launch({ resumeCid: cid });
    const content = `${'x'.repeat(60)} tail A`;
    const result = await adapter.writeInput(makePty(() => {
      appendFileSync(HISTORY, historyLine(content, cid));
      stream(cid);
      userInput(cid, `${'x'.repeat(60)} tail B`);
    }), content);
    expect(plain(result)).toEqual({ submitted: true, cliSessionId: cid });
    expect(probe(result)).toBeUndefined();
  });

  it('proves late through the deferred recheck once history and the own USER_INPUT appear', async () => {
    const cid = randomUUID();
    userInput(cid, 'older turn');
    const { adapter, stream } = launch({ resumeCid: cid });
    const content = 'slow cold start payload';
    const result = await adapter.writeInput(makePty(() => {}), content);
    expect(result).toMatchObject({ submitted: false });
    const recheck = (result as { recheck: () => unknown }).recheck;
    expect(recheck()).toBe(false);
    appendFileSync(HISTORY, historyLine(content, cid));
    stream(cid);
    const unproven = recheck();
    expect(plain(unproven)).toEqual({ submitted: true, cliSessionId: cid });
    userInput(cid, content);
    expect(probe(unproven)).toEqual({ cliSessionId: cid });
    expect(recheck()).toEqual({ submitted: true, cliSessionId: cid, ownershipProven: true });
  });

  it('never lets one identical submit take another one\'s USER_INPUT while both are unresolved', async () => {
    const cid = randomUUID();
    userInput(cid, 'older turn');
    const { adapter, stream } = launch({ resumeCid: cid });
    stream(cid);
    const content = '继续';
    // agy is busy: both Enters are logged, nothing reaches the model yet.
    const first = await adapter.writeInput(makePty(() => appendFileSync(HISTORY, historyLine(content, cid))), content);
    const second = await adapter.writeInput(makePty(() => appendFileSync(HISTORY, historyLine(content, cid))), content);
    expect(plain(first)).toEqual({ submitted: true, cliSessionId: cid });
    expect(plain(second)).toEqual({ submitted: true, cliSessionId: cid });
    // One record appears: it may be either input's (agy can drop a queued one).
    userInput(cid, content);
    expect(probe(second)).toBeUndefined();
    expect(probe(first)).toBeUndefined();
    userInput(cid, content);
    expect(probe(first)).toBeUndefined();
    expect(probe(second)).toBeUndefined();
  });

  it('does not let a later identical submit reuse a record already claimed by an earlier one', async () => {
    const cid = randomUUID();
    userInput(cid, 'older turn');
    const { adapter, stream } = launch({ resumeCid: cid });
    stream(cid);
    const content = '继续';
    const a1 = await adapter.writeInput(makePty(() => appendFileSync(HISTORY, historyLine(content, cid))), content);
    userInput(cid, content); // a1 dequeued
    expect(probe(a1)).toEqual({ cliSessionId: cid });
    const a2 = await adapter.writeInput(makePty(() => {
      appendFileSync(HISTORY, historyLine(content, cid));
      userInput(cid, content);
    }), content);
    expect(plain(a2)).toEqual({ submitted: true, cliSessionId: cid, ownershipProven: true });
    // a3 is queued: its Enter is logged, agy has not fed it.
    const a3 = await adapter.writeInput(makePty(() => appendFileSync(HISTORY, historyLine(content, cid))), content);
    expect(plain(a3)).toEqual({ submitted: true, cliSessionId: cid });
    expect(probe(a3)).toBeUndefined();
    userInput(cid, content);
    expect(probe(a3)).toEqual({ cliSessionId: cid });
  });

  it('lets an identical submit prove again once the earlier unresolved one\'s turn finished', async () => {
    const cid = randomUUID();
    userInput(cid, 'older turn');
    const { adapter, stream } = launch({ resumeCid: cid });
    stream(cid);
    const content = '每小时巡检';
    // Dropped by agy (e.g. Esc on the queue); its turn ends without a record.
    const dropped = await adapter.writeInput(makePty(() => appendFileSync(HISTORY, historyLine(content, cid))), content) as any;
    const blocked = await adapter.writeInput(makePty(() => {
      appendFileSync(HISTORY, historyLine(content, cid));
      userInput(cid, content);
    }), content);
    // The record could be the dropped one's: neither may take it.
    expect(plain(blocked)).toEqual({ submitted: true, cliSessionId: cid });
    expect(probe(dropped)).toBeUndefined();
    dropped.settleConsumed();
    expect(probe(dropped)).toBeUndefined();
    // `blocked` was written before that settle, so it stays ambiguous.
    expect(probe(blocked)).toBeUndefined();
    (blocked as any).settleConsumed();
    const next = await adapter.writeInput(makePty(() => {
      appendFileSync(HISTORY, historyLine(content, cid));
      userInput(cid, content);
    }), content);
    expect(plain(next)).toEqual({ submitted: true, cliSessionId: cid, ownershipProven: true });
  });

  it('a settled probe never proves, even when a matching record shows up afterwards', async () => {
    const cid = randomUUID();
    userInput(cid, 'older turn');
    const { adapter, stream } = launch({ resumeCid: cid });
    stream(cid);
    const content = 'finished without a record';
    const result = await adapter.writeInput(makePty(() => appendFileSync(HISTORY, historyLine(content, cid))), content) as any;
    result.settleConsumed();
    // The pane's user typed the same text by hand after the turn ended.
    userInput(cid, content);
    expect(probe(result)).toBeUndefined();
  });

  it('does not prove a fresh first submit from an older conversation the user resumed into', async () => {
    const old = randomUUID();
    const content = '<botmux_routing>same first turn</botmux_routing>';
    userInput(old, content);
    const { adapter, stream, startupLog } = launch();
    startupLog();
    const result = await adapter.writeInput(makePty(() => {
      appendFileSync(HISTORY, historyLine(content));
      // `/resume` in the pane: the log now streams the pre-existing conversation.
      stream(old);
    }), content);
    expect(plain(result)).toEqual({ submitted: true, cliSessionId: old });
    expect(probe(result)).toBeUndefined();
  });

  it('does not prove after /new when the user resumes into another conversation before the new one exists', async () => {
    const fresh = randomUUID();
    const other = randomUUID();
    const content = 'same text in another conversation';
    userInput(other, 'older');
    const { adapter, stream } = launch({ resumeCid: fresh });
    stream(fresh); // /new: brain file for `fresh` is created lazily
    const result = await adapter.writeInput(makePty(() => {
      appendFileSync(HISTORY, historyLine(content, other));
      stream(other);
      userInput(other, content);
    }), content);
    expect(plain(result)).toEqual({ submitted: true, cliSessionId: other });
    expect(probe(result)).toBeUndefined();
  });

  it('returns without waiting for a busy agy and proves later through the deferred probe', async () => {
    const cid = randomUUID();
    userInput(cid, 'older turn');
    const { adapter, stream } = launch({ resumeCid: cid });
    stream(cid);
    const content = 'type-ahead while agy works';
    let feed: () => void = () => {};
    const result = await adapter.writeInput(makePty(() => {
      appendFileSync(HISTORY, historyLine(content, cid));
      // agy feeds it only at its next step, after writeInput has returned.
      feed = () => userInput(cid, content);
    }), content);
    expect(plain(result)).toEqual({ submitted: true, cliSessionId: cid });
    expect(probe(result)).toBeUndefined();
    feed();
    expect(probe(result)).toEqual({ cliSessionId: cid });
  });

  it('keeps watching a fresh submit whose conversation id is not streamed yet', async () => {
    const cid = randomUUID();
    const { adapter, stream, startupLog } = launch();
    startupLog();
    const content = 'history lands before the conversation id';
    const first = await adapter.writeInput(makePty(() => appendFileSync(HISTORY, historyLine(content))), content);
    expect(plain(first)).toEqual({ submitted: true });
    expect(probe(first)).toBeUndefined();
    stream(cid);
    userInput(cid, content);
    expect(probe(first)).toEqual({ cliSessionId: cid });
    // The first entry is resolved, so an identical follow-up can prove its own record.
    const second = await adapter.writeInput(makePty(() => {
      appendFileSync(HISTORY, historyLine(content, cid));
      userInput(cid, content);
    }), content);
    expect(plain(second)).toEqual({ submitted: true, cliSessionId: cid, ownershipProven: true });
  });

  it('keeps the deferred recheck probe alive while its conversation id is unknown', async () => {
    const cid = randomUUID();
    const content = 'slow-fresh-recheck';
    const { adapter, stream, startupLog } = launch();
    startupLog();
    const initial = await adapter.writeInput(makePty(() => {}), content);
    expect(initial).toMatchObject({
      submitted: false, proveConsumed: expect.any(Function), settleConsumed: expect.any(Function),
    });
    appendFileSync(HISTORY, historyLine(content));
    const confirmed = (initial as any).recheck();
    expect(plain(confirmed)).toEqual({ submitted: true });
    stream(cid);
    userInput(cid, content);
    expect(probe(confirmed)).toEqual({ cliSessionId: cid });
  });

  it('never proves on an adopted pane without a process-scoped log', async () => {
    const cid = randomUUID();
    const adapter = createAntigravityAdapter('/usr/local/bin/agy');
    // The worker hands an adopted pane its guessed conversation id via the busy probe.
    adapter.isSessionBusy!({ cliSessionId: cid, getCurrentScreen: () => '' } as any);
    const content = 'adopted pane input';
    const result = await adapter.writeInput(makePty(() => {
      appendFileSync(HISTORY, historyLine(content, cid));
      userInput(cid, content);
    }), content);
    expect((result as { ownershipProven?: boolean } | undefined)?.ownershipProven).toBeUndefined();
  });
});
