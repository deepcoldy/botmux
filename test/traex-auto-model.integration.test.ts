import { writeFileSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DaemonToWorker } from '../src/types.js';
import { t } from '../src/i18n/index.js';
import { fixture, rows, interruptionNote, interruptionNotices, modelOrderNoticeFragment, useTraexAutoModelIntegrationCleanup } from './helpers/traex-auto-model-integration.js';

useTraexAutoModelIntegrationCleanup();

describe('TraeX auto-model real Worker and PTY', () => {
  it('releases a cold-restored interrupted structured turn before accepting new input', async () => {
    const f = await fixture(false, false, false, undefined, false, undefined, false,
      undefined, 0, 0, false, false, undefined, undefined, undefined, true);
    await f.wait(() => f.logs.join('').includes('Cleared 1 stale structured turn(s)'), 'stale structured turn cleared');
    expect(interruptionNotices(f.messages)).toHaveLength(1);
    expect(f.logs.join('')).not.toContain('Ignoring prompt-ready heuristic while a structured turn is unfinished');

    f.child.send({ type: 'message', content: 'new request after cold recovery', turnId: 'om_after_recovery' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'new request submitted after recovery');
    expect(rows(f.submissions)[0]).toMatchObject({ model: 'core' });
    expect(rows(f.submissions)[0].text).toMatch(/^new request after cold recovery(?:\r|\n|$)/);
    expect(rows(f.submissions)[0].text).not.toContain('interrupted cold resume ask');
  }, 45_000);

  it('preflights a cold first turn before the only spawn and submits the original prompt once', async () => {
    const f = await fixture(true, 'ordered', false, undefined, false, undefined, true,
      undefined, 0, 0, false, false, undefined, undefined,
      { enabled: true, initialPrompt: 'cold preflight task' });
    await f.wait(() => rows(f.submissions).length === 1, 'cold prompt submitted');
    expect(rows(f.launches).map(row => row.model)).toEqual(['backup']);
    expect(rows(f.launches)[0].args).toContain('model_reasoning_effort="xhigh"');
    expect(rows(f.submissions)).toEqual([expect.objectContaining({ model: 'backup', text: 'cold preflight task' })]);
    expect(rows(f.rpcRequests).filter(row => row.method === 'model/list')).toHaveLength(1);
  }, 45_000);

  it.each(['failure', 'timeout'] as const)('fails open on a preflight probe %s without duplicating the first prompt', async probe => {
    const f = await fixture(true, 'ordered', false, undefined, false, undefined, true,
      undefined, 0, 0, false, false, undefined, undefined,
      { enabled: true, initialPrompt: `${probe} task`, probe, timeoutMs: 100 });
    await f.wait(() => rows(f.submissions).length === 1, `${probe} prompt submitted`);
    expect(rows(f.launches).map(row => row.model)).toEqual(['core']);
    expect(rows(f.submissions)).toEqual([expect.objectContaining({ model: 'core', text: `${probe} task` })]);
  }, 45_000);

  it('preflights an idle warm turn with exact resume, then keeps busy type-ahead on that model', async () => {
    const f = await fixture(true, 'ordered', false, undefined, false, undefined, false,
      'working', 0, 0, false, false, undefined, undefined, { enabled: true });
    f.child.send({ type: 'message', content: 'warm independent task', turnId: 'om_warm' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'warm task submitted');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup']);
    expect(rows(f.launches)[1].args).toContain(f.nativeId);
    expect(rows(f.submissions)[0]).toMatchObject({ model: 'backup' });
    expect(rows(f.submissions)[0].text).toMatch(/^warm independent task(?:\r|\n|$)/);
    const loadReads = rows(f.rpcRequests).filter(row => row.method === 'model/list').length;

    f.child.send({ type: 'message', content: 'busy correction', turnId: 'om_correction' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 2, 'busy correction submitted');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup']);
    expect(rows(f.submissions)[1]).toMatchObject({ model: 'backup', text: 'busy correction' });
    expect(rows(f.rpcRequests).filter(row => row.method === 'model/list')).toHaveLength(loadReads);
  }, 45_000);

  it('routes a durable dispatch through the same idle Worker admission before writing', async () => {
    const f = await fixture(true, 'ordered', false, undefined, false, undefined, false,
      'working', 0, 0, false, false, undefined, undefined, { enabled: true });
    f.child.send({ type: 'message', content: 'dispatch task', turnId: 'dispatch-turn', dispatchAttempt: 1 } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'dispatch submitted');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup']);
    expect(rows(f.submissions)).toHaveLength(1);
    expect(rows(f.submissions)[0]).toMatchObject({ model: 'backup' });
    expect(rows(f.submissions)[0].text).toMatch(/^dispatch task(?:\r|\n|$)/);
  }, 45_000);

  it('quota initial prompts use admission instead of bypassing persisted blocks', async () => {
    const f = await fixture(true, false, false, undefined, false, undefined, false, undefined, 0, 0, false, false,
      { code: 'usage_limit_exceeded', initial: true, blocked: true });
    await f.wait(() => f.messages.some(m => m.type === 'turn_terminal' && m.turnId === 'om_initial_quota' && m.status === 'failed'), 'blocked initial input settled');
    expect(rows(f.submissions)).toHaveLength(0);
  }, 45_000);

  it('quota initial fresh prompts recover on the discovered exact native session', async () => {
    const f = await fixture(true, false, false, undefined, false, undefined, true, undefined, 0, 0, false, false,
      { code: 'usage_limit_exceeded', initial: true });
    await f.wait(() => f.messages.some(m => m.type === 'turn_terminal' && m.turnId === 'om_initial_quota' && m.status === 'completed'), 'fresh initial recovery');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last']);
    expect(rows(f.submissions).filter(row => row.text.startsWith('initial quota task'))).toHaveLength(1);
    expect(rows(f.launches).slice(1).every(row => row.args.includes(f.nativeId))).toBe(true);
  }, 60_000);

  it('quota recovery preserves native identity, ordered models and one original input', async () => {
    const f = await fixture(true, false, false, undefined, false, undefined, false, undefined, 0, 0, false, false,
      { code: 'usage_limit_exceeded' });
    f.child.send({ type: 'message', content: 'original quota task', turnId: 'om_quota' } satisfies DaemonToWorker);
    await f.wait(() => f.messages.some(m => m.type === 'turn_terminal' && m.turnId === 'om_quota' && m.status === 'completed'), 'quota recovery complete');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last']);
    expect(rows(f.launches).every(row => row.args.includes(f.nativeId))).toBe(true);
    expect(rows(f.submissions).filter(row => row.text.startsWith('original quota task'))).toHaveLength(1);
    expect(rows(f.submissions).slice(1).every(row => row.text.includes(t('worker.traex_auto_model.continue_prompt')))).toBe(true);
    expect(f.messages.filter(m => m.type === 'turn_terminal' && m.turnId === 'om_quota')).toHaveLength(1);
    // Only the two structured failures query quotas; initial admission does not.
    expect(rows(f.rpcRequests).filter(row => row.method === 'debug/models')).toHaveLength(2);
  }, 60_000);

  it('quota mode stops after all models fail without cycling or replaying', async () => {
    const f = await fixture(true, false, false, undefined, false, undefined, false, undefined, 0, 0, false, false,
      { code: 'usageLimitExceeded', exhaustLast: true });
    f.child.send({ type: 'message', content: 'all depleted task', turnId: 'om_all' } satisfies DaemonToWorker);
    await f.wait(() => f.messages.some(m => m.type === 'turn_terminal' && m.turnId === 'om_all' && m.status === 'failed'), 'all quotas failed');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last']);
    expect(rows(f.submissions)).toHaveLength(3);
    expect(f.messages.filter(m => m.type === 'turn_terminal' && m.turnId === 'om_all')).toHaveLength(1);
  }, 60_000);

  it('quota mode does not turn ordinary rate limits into model switches', async () => {
    const f = await fixture(true, false, false, undefined, false, undefined, false, undefined, 0, 0, false, false,
      { code: 'rateLimitExceeded' });
    f.child.send({ type: 'message', content: 'rate limited task', turnId: 'om_rate' } satisfies DaemonToWorker);
    await f.wait(() => f.messages.some(m => m.type === 'turn_terminal' && m.turnId === 'om_rate' && m.status === 'failed'), 'ordinary failure');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core']);
    expect(rows(f.submissions)).toHaveLength(1);
    expect(rows(f.rpcRequests).filter(row => row.method === 'debug/models')).toHaveLength(0);
  }, 45_000);

  it('keeps planned model recovery silent and still reports a later genuine crash', async () => {
    const f = await fixture(true, 'busy');
    f.child.send({ type: 'message', content: 'original ask', turnId: 'om_original' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 2, 'Auto continuation');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'last']);
    expect(rows(f.launches).every(row => row.args.at(-1) === f.nativeId)).toBe(true);
    expect(rows(f.submissions)[1].text).toBe(t('worker.traex_auto_model.continue_prompt'));
    expect(interruptionNotices(f.messages)).toHaveLength(0);

    // The replacement's submitted continuation now owns the still-open turn.
    // Its real process death must arm the ordinary interruption scan again.
    await new Promise(resolveWait => setTimeout(resolveWait, 1_500));
    writeFileSync(f.crash, '1');
    await f.wait(() => f.messages.some(message => message.type === 'claude_exit'), 'genuine replacement crash');
    f.child.send({ type: 'restart', reason: 'cli_crash' } satisfies DaemonToWorker);
    await f.wait(() => interruptionNotices(f.messages).length === 1, 'genuine interruption notice');
    await f.wait(() => rows(f.submissions).length === 3, 'genuine restart continuation');
    expect(interruptionNotices(f.messages)[0]).toMatchObject({ turnId: 'om_original' });
    expect(rows(f.submissions)[2].text).toContain(interruptionNote());
    expect(rows(f.submissions).filter(row => row.text.startsWith('original ask'))).toHaveLength(1);
  }, 60_000);

  it('reports a replacement that exits before its first prompt instead of inheriting the planned cause', async () => {
    const f = await fixture(true, 'busy', false, undefined, false, undefined, false, undefined, 0, 0, true);
    f.child.send({ type: 'message', content: 'original ask', turnId: 'om_original' } satisfies DaemonToWorker);
    await f.wait(() => f.messages.some(message => message.type === 'claude_exit'), 'replacement exited before prompt');
    expect(f.messages.filter(message => message.type === 'prompt_ready')).toHaveLength(1);
    // Supply the daemon's normal crash-restart response; the fixture runs only
    // the real worker, so no daemon exists to answer claude_exit on its behalf.
    f.child.send({ type: 'restart', reason: 'cli_crash' } satisfies DaemonToWorker);
    await f.wait(() => interruptionNotices(f.messages).length === 1, 'failed replacement interruption notice');
    expect(interruptionNotices(f.messages)[0]).toMatchObject({ turnId: 'om_original' });
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'last', 'last']);
    expect(rows(f.submissions).filter(row => row.text.startsWith('original ask'))).toHaveLength(1);
  }, 60_000);

  it('surfaces a failed Auto launch through the existing worker error path', async () => {
    const f = await fixture(true, 'busy');
    f.child.send({ type: 'message', content: 'original ask', turnId: 'om_original' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'original submit');
    rmSync(f.fake);
    await f.wait(() => f.messages.some(message => message.type === 'error'), 'failed Auto launch error');
    expect(rows(f.launches)).toHaveLength(1);
    expect(rows(f.submissions)).toHaveLength(1);
  }, 45_000);

  it('buffers rapid fresh-start follow-ups until capacity switches to a working model', async () => {
    const f = await fixture(true, 'ordered', false, undefined, false, undefined, true, 'delayed-first-queue');
    f.child.send({ type: 'message', content: 'first request', turnId: 'om_first' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'first request before activity repaint');
    f.child.send({ type: 'message', content: 'second request', turnId: 'om_second' } satisfies DaemonToWorker);
    f.child.send({ type: 'message', content: 'third request', turnId: 'om_third' } satisfies DaemonToWorker);
    await new Promise(resolveWait => setTimeout(resolveWait, 700));
    expect(rows(f.submissions)).toHaveLength(1);
    await f.wait(() => rows(f.submissions).length === 4, 'recovery and both buffered requests');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup']);
    expect(rows(f.submissions).filter(row => row.text.startsWith('first request'))).toHaveLength(1);
    expect(rows(f.submissions).slice(-2).map(row => ({ text: row.text.split(/[\r\n]/)[0], model: row.model }))).toEqual([
      { text: 'second request', model: 'backup' }, { text: 'third request', model: 'backup' },
    ]);
    expect(rows(f.launches)[1].args).toContain(f.nativeId);
  }, 45_000);

  it('submits healthy running follow-ups in order on the current model', async () => {
    const f = await fixture(true, false, false, undefined, false, undefined, false, 'working');
    f.child.send({ type: 'message', content: 'original working ask', turnId: 'om_working' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'original working submit');
    const started = performance.now();
    const heartbeatStartMs = Date.now();
    f.measurements.length = 0;
    f.child.send({ type: 'message', content: 'healthy correction one', turnId: 'om_one' } satisfies DaemonToWorker);
    f.child.send({ type: 'message', content: 'healthy correction two', turnId: 'om_two' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 3, 'both running corrections');
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(1_500);
    expect(rows(f.submissions).map(row => row.text.split(/[\r\n]/)[0])).toEqual([
      'original working ask', 'healthy correction one', 'healthy correction two',
    ]);
    expect(rows(f.submissions).slice(1).every(row => !row.text.includes('botmux_skills_refresh'))).toBe(true);
    expect(rows(f.launches).map(row => row.model)).toEqual(['core']);
    const heartbeats = f.measurements.filter(row => row.type === 'admission_heartbeat' && row.atMs >= heartbeatStartMs);
    const captures = f.measurements.filter(row => row.type === 'admission_capture').map(row => row.elapsedMs);
    if (!process.env.BOTMUX_TEST_WORKER_BINARY) expect(heartbeats.length).toBeGreaterThan(0);
    console.log(JSON.stringify({ measurement: 'real-worker-running-additions',
      backend: process.env.BOTMUX_TEST_WORKER_BACKEND ?? 'pty', count: 2, elapsedMs,
      heartbeatTicks: heartbeats.length, maxHeartbeatGapMs: Math.max(0, ...heartbeats.map(row => row.gapMs)),
      captureCount: captures.length, captureMs: captures }));
  }, 45_000);

  it('keeps a successive input queued after the preceding write changes Working to capacity', async () => {
    const f = await fixture(true, false, false, undefined, false, undefined, false, 'queue-after-second');
    f.child.send({ type: 'message', content: 'original working ask', turnId: 'om_working' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'original working submit');
    f.child.send({ type: 'message', content: 'correction changes capacity', turnId: 'om_capacity' } satisfies DaemonToWorker);
    f.child.send({ type: 'message', content: 'held successor', turnId: 'om_held' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 2, 'correction submitted');
    await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
    expect(rows(f.submissions).map(row => row.text.split(/[\r\n]/)[0])).toEqual([
      'original working ask', 'correction changes capacity',
    ]);
    expect(rows(f.launches).map(row => row.model)).toEqual(['core']);
    writeFileSync(f.release, 'finish');
    await f.wait(() => rows(f.submissions).length === 3, 'held input after composer');
    expect(rows(f.submissions).filter(row => row.text.startsWith('held successor'))).toHaveLength(1);
  }, 45_000);

  // A late history receipt quarantines one write while the original turn is
  // still open. The hold must be released by the deferred recheck and the
  // type-ahead queue re-driven; neither release may wait for the open turn.
  it.each([
    { name: 'the original ask', submission: 1, quarantinedTurn: 'om_working' },
    { name: 'the capacity-changing correction', submission: 2, quarantinedTurn: 'om_capacity' },
  ])('delivers queued follow-ups after a late receipt quarantines $name', async ({ submission, quarantinedTurn }) => {
    const f = await fixture(true, false, false, undefined, false, undefined, false, 'queue-after-second',
      0, 0, false, false, undefined, { submission, ms: 400 });
    f.child.send({ type: 'message', content: 'original working ask', turnId: 'om_working' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'original working submit');
    f.child.send({ type: 'message', content: 'correction changes capacity', turnId: 'om_capacity' } satisfies DaemonToWorker);
    f.child.send({ type: 'message', content: 'held successor', turnId: 'om_held' } satisfies DaemonToWorker);
    await f.wait(() => f.logs.join('').includes(`after unconfirmed submit turn=${quarantinedTurn} `), 'late receipt quarantined');
    await f.wait(() => rows(f.submissions).length === 2, 'correction submitted');
    writeFileSync(f.release, 'finish');
    await f.wait(() => rows(f.submissions).length === 3, 'held input after deferred recheck');
    expect(rows(f.submissions).map(row => row.text.split(/[\r\n]/)[0])).toEqual([
      'original working ask', 'correction changes capacity', 'held successor',
    ]);
    expect(rows(f.launches).map(row => row.model)).toEqual(['core']);
  }, 75_000);

  it('preserves a fresh topic selection, final wait and catalog across an in-worker restart', async () => {
    const f = await fixture(true, 'busy', false, undefined, false, undefined, true);
    expect(f.init.resume).toBe(false);
    f.child.send({ type: 'message', content: 'fresh original ask', turnId: 'om_fresh' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 2, 'fresh-topic capacity switch');
    const currentRuntime = () => f.messages.filter(message => message.type === 'active_runtime')
      .map(message => message.traexAutoModelRuntime).filter(Boolean).at(-1);
    await f.wait(() => currentRuntime()?.waitingOnFinalModel === true, 'final-model hold published');
    const before = currentRuntime()!;
    expect(before).toMatchObject({ model: 'last', nativeSessionId: f.nativeId });
    expect(before.skillCatalogFingerprint).toEqual(expect.any(String));
    expect(rows(f.launches)[0].args[0]).not.toBe('resume');

    const readyCount = f.messages.filter(message => message.type === 'prompt_ready').length;
    f.child.send({ type: 'restart', reason: 'operator', model: 'core', codexRpcInput: false,
      traexAutoModel: f.init.traexAutoModel } satisfies DaemonToWorker);
    await f.wait(() => rows(f.launches).length === 3
      && f.messages.filter(message => message.type === 'prompt_ready').length > readyCount, 'same-worker restarted CLI ready');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'last', 'last']);
    expect(rows(f.launches)[2].args).toEqual(rows(f.launches)[1].args);

    const queryCount = rows(f.rpcRequests).length;
    await new Promise(resolveWait => setTimeout(resolveWait, 6_000));
    expect(rows(f.launches)).toHaveLength(3);
    expect(rows(f.rpcRequests)).toHaveLength(queryCount);
    expect(currentRuntime()).toMatchObject({ model: 'last', waitingOnFinalModel: true,
      skillCatalogFingerprint: before.skillCatalogFingerprint });
    // Restart may submit an attributed interruption note before the next user
    // input. Let that native turn finish; a final capacity wait must not admit
    // the next user turn just because the replacement reached its prompt.
    writeFileSync(f.release, 'finish resumed turn');
    f.child.send({ type: 'message', content: 'next ask after restart', turnId: 'om_after_restart' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).some(row => row.text.startsWith('next ask after restart')), 'input after restart');
    expect(rows(f.launches)).toHaveLength(3);
    expect(rows(f.submissions).filter(row => row.text.startsWith('fresh original ask'))).toHaveLength(1);
    expect(rows(f.submissions).slice(1).filter(row => row.text.includes('botmux_skills_refresh'))).toEqual([]);
  }, 80_000);

  it('refuses environment argv before launching an out-of-pool model', async () => {
    const f = await fixture(true, false, false, undefined, false, '--model outside');
    expect(rows(f.launches)).toEqual([]);
    expect(rows(f.rpcRequests)).toEqual([]);
    expect(f.messages.some(message => message.type === 'prompt_ready')).toBe(false);
  });

  it('continues the original turn and queued follow-up when resume restores a composer without a loaded banner', async () => {
    const f = await fixture(true, false, false, undefined, true);
    f.child.send({ type: 'message', content: 'original image ask', turnId: 'om_image' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'original image submit');
    await f.wait(() => /authoritative viewport still shows busy marker|structured turn is unfinished/.test(f.logs.join('')), 'confirmed active queue');
    f.child.send({ type: 'message', content: 'follow-up image', turnId: 'om_followup' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 2, 'restored composer continuation', 30_000);
    expect(f.logs.join('')).toContain('restored composer observed on screen');
    expect(f.logs.join('')).not.toContain('WARN First prompt hard timeout');
    expect(rows(f.submissions)[1].text).toBe(t('worker.traex_auto_model.continue_prompt'));
    expect(interruptionNotices(f.messages)).toHaveLength(0);
    expect(rows(f.submissions).filter(row => row.text.startsWith('original image ask'))).toHaveLength(1);
    expect(rows(f.submissions).filter(row => row.text.startsWith('follow-up image'))).toHaveLength(0);
    expect(rows(f.launches).every(row => row.args.at(-1) === f.nativeId)).toBe(true);
    // Let the fake CLI's history receipt finish before completing its turn;
    // this scenario exercises startup recovery, not terminal-before-receipt.
    await new Promise(resolveWait => setTimeout(resolveWait, 3_000));
    writeFileSync(f.release, 'finish');
    await f.wait(() => rows(f.submissions).length === 3, 'queued follow-up submit', 15_000);
    expect(rows(f.submissions).filter(row => row.text.startsWith('follow-up image'))).toHaveLength(1);
    expect(f.messages.some(message => message.type === 'user_notify' && message.message.includes('90 秒'))).toBe(false);
  }, 70_000);

  it('automatically uses terminal input for legacy Auto even when the daemon sends inherited RPC', async () => {
    const f = await fixture(true, false, false, { global: true });
    expect(f.messages.some(message => message.type === 'user_notify' && message.message.includes('RPC'))).toBe(false);
    expect(rows(f.rpcRequests)).toHaveLength(0);
    f.child.send({ type: 'message', content: 'original ask', turnId: 'om_legacy' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 2, 'legacy Auto continuation');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup']);
    expect(rows(f.launches).every(row => row.args[0] === 'resume' && row.args.at(-1) === f.nativeId)).toBe(true);
    expect(rows(f.submissions).filter(row => row.text.startsWith('original ask'))).toHaveLength(1);
  }, 45_000);

  it('resumes exact native history through exhaustion, then runs the next input on the preferred model', async () => {
    // Composer repaint precedes the authoritative terminal by 5.5s. A
    // follow-up stamped while capacity owns the pane must survive that gap
    // and still be submitted as its own turn after the preferred reset.
    const f = await fixture(true, false, true, undefined, false, undefined, false, undefined, 5_500, 0, false, true);
    f.child.send({ type: 'message', content: 'original ask', turnId: 'om_first' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'original submit');
    // Arrives during the queue: stays a distinct turn through both restarts.
    // A receipt on disk precedes the PTY redraw; require a visible queue frame.
    await f.wait(() => f.messages.some(message => message.type === 'screen_update'
      && message.content.includes('position 1590')), 'first model capacity viewport');
    f.child.send({ type: 'message', content: 'next ask', turnId: 'om_next' } satisfies DaemonToWorker);
    await f.wait(() => f.messages.some(message => message.type === 'user_notify' && message.message.includes('均持续排队')), 'exhaustion', 55_000);
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last']);
    expect(rows(f.submissions).map(row => row.model)).toEqual(['core', 'backup', 'last']);
    expect(rows(f.submissions).filter(row => row.text.startsWith('original ask'))).toHaveLength(1);
    expect(rows(f.submissions).filter(row => row.text.startsWith('next ask'))).toHaveLength(0);
    for (const launch of rows(f.launches)) {
      expect(launch.args[0]).toBe('resume');
      expect(launch.args.at(-1)).toBe(f.nativeId);
    }
    const notices = f.messages.filter(message => message.type === 'user_notify' && message.message.includes('均持续排队')).length;
    await new Promise(resolveWait => setTimeout(resolveWait, 6_000));
    expect(rows(f.launches)).toHaveLength(3);
    expect(f.messages.filter(message => message.type === 'user_notify' && message.message.includes('均持续排队'))).toHaveLength(notices);
    writeFileSync(f.release, 'go');
    // The preferred-model relaunch (4th launch row) and the re-submission are
    // written by different steps; waiting on the submission alone races the
    // launch record under load (the row can land seconds later). Wait for
    // both durabilities, with model attribution inside the predicate: an input
    // consumed by the pre-switch 'last' process can never satisfy this, so a
    // real misroute fails by timeout instead of flaking on the launch assert.
    await f.wait(() => {
      const nextSubmissions = rows(f.submissions).filter(row => row.text.startsWith('next ask'));
      return rows(f.launches).length === 4
        && nextSubmissions.length === 1
        && nextSubmissions[0]!.model === 'core';
    }, 'next ask relaunched on the preferred model after reset');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last', 'core']);
    expect(rows(f.submissions).filter(row => row.text.startsWith('next ask'))).toEqual([expect.objectContaining({ model: 'core' })]);
    expect(interruptionNotices(f.messages)).toHaveLength(0);
    await new Promise(resolveWait => setTimeout(resolveWait, 1_500));
    writeFileSync(f.crash, '1');
    await f.wait(() => f.messages.some(message => message.type === 'claude_exit'), 'preferred successor crash');
    f.child.send({ type: 'restart', reason: 'cli_crash' } satisfies DaemonToWorker);
    await f.wait(() => interruptionNotices(f.messages).length === 1, 'ordinary interruption after idle model reset');
    await f.wait(() => rows(f.submissions).length === 5, 'preferred successor restart continuation');
    expect(interruptionNotices(f.messages)[0]).toMatchObject({ turnId: 'om_next' });
    expect(rows(f.submissions)[4].text).toContain(interruptionNote());
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last', 'core', 'core']);
    expect(rows(f.submissions).filter(row => row.text.includes('next ask'))).toHaveLength(1);
  }, 100_000);

  it('keeps a follow-up arriving after exhaustion (but before the terminal) out of the degraded pane', async () => {
    // Both queue-walk-off branches clear queueSinceMs at the moment of
    // exhaustion, while the pane is STILL parked on the last fallback model
    // and the predecessor turn owns it. A follow-up arriving here must be
    // tagged from the latched exhausted state plus the live queued pane — not
    // type-ahead written into "last". Composer still precedes the terminal.
    const f = await fixture(true, false, true, undefined, false, undefined, false, undefined, 5_500);
    f.child.send({ type: 'message', content: 'original ask', turnId: 'om_first' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'original submit');
    await f.wait(() => f.messages.some(message => message.type === 'screen_update'
      && message.content.includes('position 1590')), 'first model capacity viewport');
    await f.wait(() => f.messages.some(message => message.type === 'user_notify' && message.message.includes('均持续排队')), 'exhaustion', 55_000);
    // Only now does the follow-up arrive: exhausted latch is set, queueSinceMs
    // is cleared, but the live pane still shows the queue at the last model.
    f.child.send({ type: 'message', content: 'next ask', turnId: 'om_next' } satisfies DaemonToWorker);
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last']);
    expect(rows(f.submissions).filter(row => row.text.startsWith('next ask'))).toHaveLength(0);
    const notices = f.messages.filter(message => message.type === 'user_notify' && message.message.includes('均持续排队')).length;
    await new Promise(resolveWait => setTimeout(resolveWait, 6_000));
    expect(rows(f.launches)).toHaveLength(3);
    expect(f.messages.filter(message => message.type === 'user_notify' && message.message.includes('均持续排队'))).toHaveLength(notices);
    writeFileSync(f.release, 'go');
    await f.wait(() => {
      const nextSubmissions = rows(f.submissions).filter(row => row.text.startsWith('next ask'));
      return rows(f.launches).length === 4
        && nextSubmissions.length === 1
        && nextSubmissions[0]!.model === 'core';
    }, 'next ask relaunched on the preferred model, never written to the fallback pane');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last', 'core']);
    expect(rows(f.submissions).filter(row => row.text.startsWith('next ask'))).toEqual([expect.objectContaining({ model: 'core' })]);
  }, 100_000);

  it('holds a follow-up stamped before the capacity latch until the preferred reset', async () => {
    // The follow-up arrives right after the submit, before any screen tick
    // has seen the queue, so nothing tags it to wait behind the active turn.
    const f = await fixture(true, false, true, undefined, false, undefined, false, undefined, 5_500);
    f.child.send({ type: 'message', content: 'original ask', turnId: 'om_first' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'original submit');
    f.child.send({ type: 'message', content: 'next ask', turnId: 'om_next' } satisfies DaemonToWorker);
    await f.wait(() => f.messages.some(message => message.type === 'user_notify' && message.message.includes('均持续排队')), 'exhaustion', 55_000);
    expect(rows(f.submissions).filter(row => row.text.startsWith('next ask'))).toHaveLength(0);
    writeFileSync(f.release, 'go');
    await f.wait(() => {
      const nextSubmissions = rows(f.submissions).filter(row => row.text.startsWith('next ask'));
      return rows(f.launches).length === 4
        && nextSubmissions.length === 1
        && nextSubmissions[0]!.model === 'core';
    }, 'next ask relaunched on the preferred model, never typed into the fallback pane');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last', 'core']);
  }, 100_000);

  it('writes a redelivered turn on an exhausted fallback model restored at idle', async () => {
    // The entry check keeps a redelivered turn on the current model. The
    // preferred-reset hold must not re-queue it: the idle composer that
    // admitted it never draws another ready edge.
    const f = await fixture(true, false, true, undefined, false, undefined, false, undefined, 0, 0, false, false,
      undefined, undefined, undefined, false, true);
    writeFileSync(f.release, 'go');
    f.child.send({ type: 'message', content: 'redelivered ask', turnId: 'om_redo', dispatchAttempt: 1 } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).some(row => row.text.startsWith('redelivered ask')), 'redelivered turn written');
    expect(rows(f.launches).map(row => row.model)).toEqual(['last']);
    expect(rows(f.submissions).filter(row => row.text.startsWith('redelivered ask')))
      .toEqual([expect.objectContaining({ model: 'last' })]);
  }, 60_000);

  it('when all loads are high, holds the lowest allowlisted model and publishes its card identity', async () => {
    const f = await fixture(true, 'busy', false, { global: true, override: false });
    f.child.send({ type: 'message', content: 'original ask', turnId: 'om_first' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 2, 'lowest-load continuation');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'last']);
    expect(rows(f.launches)[0].args).toContain('model_reasoning_effort="high"');
    expect(rows(f.launches)[0].args).toContain('model_backend_variant="standard"');
    expect(rows(f.launches)[1].args).toContain('model_reasoning_effort="xhigh"');
    expect(rows(f.launches)[1].args).toContain('model_backend_variant="max"');
    expect(rows(f.submissions).map(row => row.model)).toEqual(['core', 'last']);
    await f.wait(() => f.messages.some(message => message.type === 'active_runtime' && message.model === 'last'), 'card model identity');
    expect(f.messages).toContainEqual(expect.objectContaining({ type: 'active_runtime', model: 'last',
      reasoningEffort: 'xhigh', modelBackendVariant: 'max' }));
    expect(f.messages.filter(message => message.type === 'user_notify' && message.message.includes('120%'))).toHaveLength(1);
    await new Promise(resolveWait => setTimeout(resolveWait, 8_000));
    expect(rows(f.launches)).toHaveLength(2);
    expect(rows(f.submissions).filter(row => row.text.startsWith('original ask'))).toHaveLength(1);
    expect(rows(f.rpcRequests).map(row => row.method)).toEqual(['initialize', 'initialized', 'model/list']);
    writeFileSync(f.release, 'go');
    f.child.send({ type: 'message', content: 'next ask', turnId: 'om_next' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).some(row => row.text === 'next ask'), 'sticky input without repeated skill catalog');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'last']);
    expect(f.messages).toContainEqual(expect.objectContaining({ type: 'active_runtime',
      traexAutoModelRuntime: expect.objectContaining({ model: 'last', waitingOnFinalModel: true }) }));
  }, 55_000);

  it('prefers the earlier available model, proceeds if it queues, then retains it for the next turn', async () => {
    // Last positional arg: hold the 2nd capacity-switch notice in the worker
    // for 4s (deterministic stand-in for CI IPC scheduling lag — see fixture).
    const f = await fixture(true, 'ordered', false, undefined, undefined, undefined, undefined, undefined, undefined, 4_000);
    f.child.send({ type: 'message', content: 'original ask', turnId: 'om_first' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 2, 'earlier available backup');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup']);
    expect(rows(f.launches)[1].args).toContain('model_reasoning_effort="xhigh"');
    expect(rows(f.launches)[1].args).toContain('model_backend_variant="standard"');
    expect(f.messages).toContainEqual(expect.objectContaining({ type: 'active_runtime',
      model: 'backup', reasoningEffort: 'xhigh', modelBackendVariant: 'standard' }));
    await f.wait(() => f.messages.some(message => message.type === 'screen_update'
      && message.content.includes('position 1000')), 'backup capacity viewport');
    f.child.send({ type: 'message', content: 'next ask', turnId: 'om_next' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 3, 'later model after backup queues');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last']);
    expect(rows(f.launches)[2].args).toContain('model_backend_variant="max"');
    expect(rows(f.submissions).filter(row => row.text.startsWith('next ask'))).toHaveLength(0);
    expect(rows(f.submissions).filter(row => row.text.startsWith('original ask'))).toHaveLength(1);
    // The switch notice travels on the worker IPC channel, the submission on
    // the PTY channel: submissions===3 does not imply both notices arrived.
    // Wait on the SAME channel we assert (loaded CI runners otherwise see 1);
    // this test injects a worker-side delay on the 2nd notice via
    // delaySecondModelOrderNoticeMs to make that ordering deterministic.
    await f.wait(
      () => f.messages.filter(message => message.type === 'user_notify'
        && message.message.includes(modelOrderNoticeFragment)).length === 2,
      'both capacity-switch notices (core→backup, backup→last)',
    );
    expect(f.messages.filter(message => message.type === 'user_notify' && message.message.includes(modelOrderNoticeFragment))).toHaveLength(2);
    for (const launch of rows(f.launches)) {
      expect(launch.args[0]).toBe('resume');
      expect(launch.args.at(-1)).toBe(f.nativeId);
    }
    await f.wait(() => f.messages.some(message => message.type === 'user_notify' && message.message.includes('保持等待')), 'final wait');
    await new Promise(resolveWait => setTimeout(resolveWait, 6_000));
    expect(rows(f.launches)).toHaveLength(3);
    expect(new Set(rows(f.rpcRequests).map(row => row.method))).toEqual(new Set(['initialize', 'initialized', 'model/list']));
    expect(rows(f.rpcRequests).filter(row => row.method === 'model/list')).toHaveLength(3);
    writeFileSync(f.release, 'go');
    await f.wait(() => rows(f.submissions).some(row => row.text.startsWith('next ask')), 'next turn on retained model');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last']);
    expect(rows(f.submissions).filter(row => row.text.startsWith('next ask'))).toEqual([{ model: 'last', text: 'next ask' }]);
    expect(rows(f.submissions).slice(1).every(row => !row.text.includes('botmux_skills_refresh'))).toBe(true);
  }, 100_000);

  it('leaves capacity queues alone when the feature is disabled', async () => {
    const f = await fixture(false);
    f.child.send({ type: 'message', content: 'original ask', turnId: 'om_first' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'submit');
    await new Promise(resolveWait => setTimeout(resolveWait, 8_000));
    expect(rows(f.launches)).toHaveLength(1);
    expect(f.messages.filter(message => message.type === 'user_notify' && /白名单|allowlist/.test(message.message))).toHaveLength(0);
  }, 50_000);
});
