/**
 * Claude transcript rotation across a daemon restart, against a REAL worker
 * (tmux backend + claude-code adapter + transcript bridge) and a fake Claude
 * Code that keeps its pid-state record the way 2.1.305 does: `/clear` and
 * in-pane `/resume` rewrite `sessions/<pid>.json`'s sessionId, `/compact`
 * appends to the same transcript.
 *
 * Incident 2026-10-22 (session 6b50f4a4): `/clear` moved Claude to a new
 * transcript; after the fleet restart the re-attached worker kept reading the
 * pre-clear file, and four replies (background-task turns) never reached the
 * group, with nothing in the logs. Zero-injection mode, as on that bot: the
 * transcript is how every reply — local turns included — reaches the group.
 *
 * The worker is SIGKILLed between generations so the tmux pane and the fake
 * Claude survive, exactly like a daemon restart. Which launch layers sit in
 * front of the fake depends on the host (the OSC 7501 relay needs bun to run
 * from source, the session scope needs a user systemd); the relay → scope →
 * CLI unwrapping itself is pinned in find-launched-cli-pid.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { lookupCliDisplayName } from '../src/adapters/cli/display-names.js';
import { setDefaultLocale, t } from '../src/i18n/index.js';
import {
  backgroundTurn,
  claudeHarnessRunnable as runnable,
  cleanUpClaudeHarnesses,
  passthrough,
  promptReadyCount,
  restart,
  runBackgroundTurn,
  setupFakeClaude as setup,
} from './helpers/claude-worker-harness.js';

// The workers run with locale zh; the expected notice comes from the same key.
setDefaultLocale('zh');
const UNREAD_NOTICE = t('worker.claude_bridge_turn_unread', { cliName: lookupCliDisplayName('claude-code') ?? 'Claude Code' });

afterEach(cleanUpClaudeHarnesses);

describe.skipIf(!runnable)('Claude transcript rotation across a daemon restart', () => {
  it('after /clear, the restored worker reads the post-clear transcript and replays nothing', async () => {
    const h = setup({ turnMs: 1_000 });
    const first = h.startWorker();
    await first.waitFor(() => promptReadyCount(first) > 0, 'the CLI to be ready');
    await backgroundTurn(h, first, 'R1 before the clear');
    await passthrough(h, first, '/clear');
    await backgroundTurn(h, first, 'R2 after the clear');
    expect(readFileSync(h.transcript(h.clearSid), 'utf8')).toContain('R2 after the clear');

    const restored = await restart(h, first);
    await backgroundTurn(h, restored, 'R3 after the restart');
    expect(restored.finals().filter(text => /R[12] /.test(text)), restored.logs.join('')).toEqual([]);
    expect(restored.notices().map(n => n.message)).not.toContain(UNREAD_NOTICE);
  }, 150_000);

  it('after /compact, the restored worker stays on the same transcript and replays nothing', async () => {
    const h = setup({ turnMs: 1_000 });
    const first = h.startWorker();
    await first.waitFor(() => promptReadyCount(first) > 0, 'the CLI to be ready');
    await backgroundTurn(h, first, 'R1 before the compact');
    await passthrough(h, first, '/compact');
    expect(readFileSync(h.transcript(h.sessionId), 'utf8')).toContain('compact_boundary');

    const restored = await restart(h, first);
    await backgroundTurn(h, restored, 'R2 after the restart');
    expect(readFileSync(h.transcript(h.sessionId), 'utf8')).toContain('R2 after the restart');
    expect(restored.finals().filter(text => text.includes('R1 ')), restored.logs.join('')).toEqual([]);
    expect(restored.notices().map(n => n.message)).not.toContain(UNREAD_NOTICE);
  }, 150_000);

  it('an in-pane /resume to an older conversation forwards only what happens after it', async () => {
    const olderSid = randomUUID();
    const h = setup({ turnMs: 1_000, history: { sid: olderSid, reply: 'OLD reply from an hour ago' } });
    const g = h.startWorker();
    await g.waitFor(() => promptReadyCount(g) > 0, 'the CLI to be ready');
    await backgroundTurn(h, g, 'R1 before the resume');
    await passthrough(h, g, `/resume ${olderSid}`);
    await backgroundTurn(h, g, 'R2 after the resume');
    expect(readFileSync(h.transcript(olderSid), 'utf8')).toContain('R2 after the resume');
    expect(g.finals().filter(text => text.includes('OLD reply')), g.logs.join('')).toEqual([]);
  }, 150_000);

  it.each(['node-cli', 'cli-named-launcher'] as const)('behind a launch layer nobody knows (%s), an unread turn is found under the pane and forwarded without a notice', async layer => {
    // The bound pid is the launcher: no pid-state record of its own, so the
    // bridge cannot follow /clear until the unread turn makes it look for the
    // Claude process under the pane.
    const h = setup({ turnMs: 3_500, unknownLayer: layer });
    const g = h.startWorker();
    await g.waitFor(() => promptReadyCount(g) > 0, 'the CLI to be ready');
    await backgroundTurn(h, g, 'R1 before the clear');
    await passthrough(h, g, '/clear');
    await backgroundTurn(h, g, 'R2 after the clear');
    expect(readFileSync(h.transcript(h.clearSid), 'utf8')).toContain('R2 after the clear');
    expect(g.finals().filter(text => text.includes('R2 '))).toHaveLength(1);
    expect(g.notices().map(n => n.message)).not.toContain(UNREAD_NOTICE);
  }, 150_000);

  it('with a pid-state record that keeps the spawn id, /clear is followed through the session files Claude holds open', async () => {
    // The record still names the pre-clear transcript after /clear; the tasks
    // dir Claude holds open names the session it writes now.
    const h = setup({ turnMs: 3_500, stalePidState: true });
    const g = h.startWorker();
    await g.waitFor(() => promptReadyCount(g) > 0, 'the CLI to be ready');
    await backgroundTurn(h, g, 'R1 before the clear');
    await passthrough(h, g, '/clear');
    await backgroundTurn(h, g, 'R2 via the open session files');
    // Settled on the post-clear file: the stale record does not pull it back.
    await backgroundTurn(h, g, 'R3 after the recovery');
    expect(readFileSync(h.transcript(h.clearSid), 'utf8')).toContain('R3 after the recovery');
    expect(g.finals().filter(text => /R[123] /.test(text)), g.logs.join('')).toHaveLength(3);
    expect(g.notices().map(n => n.message)).not.toContain(UNREAD_NOTICE);
  }, 150_000);

  it('turns the bridge cannot read are reported once, and forwarded once the transcript is found', async () => {
    // No pid-state record: after /clear nothing can tell the bridge where the
    // CLI writes. Turns long enough to be judged.
    const h = setup({ turnMs: 3_500, pidStateGated: true });
    const g = h.startWorker();
    await g.waitFor(() => promptReadyCount(g) > 0, 'the CLI to be ready');
    await backgroundTurn(h, g, 'R1 before the clear');
    await passthrough(h, g, '/clear');

    for (const reply of ['R2 unread', 'R3 unread']) await runBackgroundTurn(h, g, reply);
    expect(readFileSync(h.transcript(h.clearSid), 'utf8')).toContain('R3 unread');
    expect(g.finals().filter(text => text.includes('unread'))).toEqual([]);
    expect(g.notices().filter(n => n.message === UNREAD_NOTICE), g.logs.join('')).toHaveLength(1);

    // Claude's state becomes readable: the bridge moves over and delivers the
    // replies it missed — once each, with no second notice.
    writeFileSync(h.pidStateGate, '');
    await g.waitFor(() => ['R2 unread', 'R3 unread'].every(reply => g.finals().some(text => text.includes(reply))),
      'the unread replies to be forwarded');
    expect(g.finals().filter(text => text.includes('unread'))).toHaveLength(2);
    expect(g.finals().filter(text => text.includes('R1 '))).toHaveLength(1);
    expect(g.notices().filter(n => n.message === UNREAD_NOTICE)).toHaveLength(1);
  }, 150_000);
});
