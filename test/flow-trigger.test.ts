import { describe, expect, it, vi } from 'vitest';
import { validateTriggerRequest, type TriggerRequest } from '../src/services/trigger-types.js';
import { dispatchDidRun } from '../src/services/webhook-idempotency.js';
import { buildFlowTriggerInput, triggerFlowRun, type FlowTriggerDeps, type FlowTriggerManager } from '../src/flow/trigger.js';
import type { FlowFinishOutcome } from '../src/flow/daemon-manager.js';
import type { RunBinding } from '../src/flow/types.js';

function flowRequest(overrides: Partial<TriggerRequest['target']> = {}, options: TriggerRequest['options'] = {}): TriggerRequest {
  return {
    source: { type: 'webhook', connectorId: 'conn_ci', requestId: 'req_1', receivedAt: '2026-09-08T00:00:00.000Z' },
    target: { kind: 'flow', botId: 'app1', chatId: 'oc_chat', script: 'flows/on-push.mjs', ...overrides },
    envelope: { format: 'botmux.webhook.v1', sourceName: 'ci', trusted: false, payload: { ref: 'refs/heads/main' } },
    instruction: 'Review the push.',
    options,
  };
}

describe('validateTriggerRequest — flow target', () => {
  it('accepts a flow target with script and chatId', () => {
    const v = validateTriggerRequest(flowRequest());
    expect(v.ok).toBe(true);
  });

  it('requires a script', () => {
    const v = validateTriggerRequest(flowRequest({ script: undefined }));
    expect(v).toMatchObject({ ok: false, status: 400, body: { errorCode: 'target_required' } });
    expect((v as any).body.error).toContain('script');
  });

  it('requires a real chat target (no virtual http sessions)', () => {
    const v = validateTriggerRequest(flowRequest({ chatId: undefined }, { waitForFinalOutput: true }));
    expect(v).toMatchObject({ ok: false, body: { errorCode: 'target_required' } });
    const rootOnly = validateTriggerRequest(flowRequest({ chatId: undefined, rootMessageId: 'om_root' }));
    expect(rootOnly).toMatchObject({ ok: false, body: { errorCode: 'target_required' } });
    const withRoot = validateTriggerRequest(flowRequest({ rootMessageId: 'om_root' }));
    expect(withRoot.ok).toBe(true);
  });

  it('rejects sessionId and asyncReturnSessionId, allows waitForFinalOutput', () => {
    expect(validateTriggerRequest(flowRequest({ sessionId: 'sess_1' }))).toMatchObject({ ok: false, body: { errorCode: 'bad_request' } });
    expect(validateTriggerRequest(flowRequest({}, { asyncReturnSessionId: true }))).toMatchObject({ ok: false, body: { errorCode: 'bad_request' } });
    expect(validateTriggerRequest(flowRequest({}, { waitForFinalOutput: true, timeoutMs: 5_000 })).ok).toBe(true);
  });

  it('keeps the turn-only idempotencyKey scope lock', () => {
    const v = validateTriggerRequest(flowRequest({}, { idempotencyKey: 'k' }));
    expect(v).toMatchObject({ ok: false, body: { errorCode: 'bad_request' } });
  });
});

describe('dispatchDidRun — flow outcomes', () => {
  it('treats an interrupted flow run as dispatched so a retry cannot start a second run', () => {
    expect(dispatchDidRun({ ok: false, errorCode: 'flow_interrupted', triggerId: 'trg_1' })).toBe(true);
    expect(dispatchDidRun({ ok: false, errorCode: 'trigger_failed', triggerId: 'trg_1' })).toBe(false);
  });
});

interface FakeManager extends FlowTriggerManager {
  launches: Array<{ script: string; input: unknown; binding: RunBinding }>;
}

function fakeManager(opts: { launch?: { ok: false; error: string }; outcome?: FlowFinishOutcome | null } = {}): FakeManager {
  const launches: FakeManager['launches'] = [];
  return {
    launches,
    launch: vi.fn(async (req) => {
      launches.push({ script: req.script, input: req.input, binding: req.binding });
      return opts.launch ?? { ok: true as const, runId: 'run_1', runDir: '/tmp/run_1' };
    }),
    waitForFinish: vi.fn(async () => opts.outcome === undefined ? null : opts.outcome),
  };
}

function deps(manager: FakeManager, overrides: Partial<FlowTriggerDeps> = {}): FlowTriggerDeps & { seeds: Array<[string, string]>; notes: Array<[string, string]> } {
  const seeds: Array<[string, string]> = [];
  const notes: Array<[string, string]> = [];
  return {
    seeds,
    notes,
    larkAppId: 'app1',
    manager,
    apiOnly: () => false,
    sandboxed: () => false,
    isInChat: async () => true,
    messageChatId: async () => null,
    sendTopicSeed: async (chatId, text) => {
      seeds.push([chatId, text]);
      return 'om_seed';
    },
    notify: async (anchor, text) => {
      notes.push([anchor, text]);
    },
    resolveWorkingDir: () => ({ ok: true, workingDir: '/work' }),
    topicMessage: (req) => `外部事件触发：${req.envelope.sourceName}`,
    newTriggerId: () => 'trg_fixed',
    defaultWaitMs: 50,
    ...overrides,
  };
}

describe('triggerFlowRun', () => {
  it('opens a topic, binds the run to it, and hands the event to the script as input', async () => {
    const manager = fakeManager();
    const d = deps(manager);
    const res = await triggerFlowRun(flowRequest(), d);
    expect(res).toMatchObject({ ok: true, action: 'queued', triggerId: 'trg_fixed', target: { kind: 'flow', chatId: 'oc_chat', flowRunId: 'run_1', rootMessageId: 'om_seed' } });
    expect(d.seeds).toEqual([['oc_chat', '外部事件触发：ci\nflow: flows/on-push.mjs']]);
    expect(manager.launches).toHaveLength(1);
    const launch = manager.launches[0]!;
    expect(launch.script).toBe('flows/on-push.mjs');
    expect(launch.binding).toEqual<RunBinding>({
      larkAppId: 'app1',
      chatId: 'oc_chat',
      rootId: 'om_seed',
      sessionId: null,
      ownerOpenId: null,
      triggeredBy: 'webhook:conn_ci',
      workingDir: '/work',
      trigger: { kind: 'webhook', connectorId: 'conn_ci', triggerId: 'trg_fixed', source: 'ci' },
    });
    expect(launch.input).toEqual(buildFlowTriggerInput(flowRequest(), 'trg_fixed'));
    expect(launch.input).toMatchObject({ triggerId: 'trg_fixed', envelope: { trusted: false, payload: { ref: 'refs/heads/main' } }, instruction: 'Review the push.' });
  });

  it('never takes the script from the request body — only target.script decides what runs', async () => {
    const manager = fakeManager();
    const req = flowRequest();
    (req.envelope.payload as Record<string, unknown>).script = '../../etc/evil.mjs';
    await triggerFlowRun(req, deps(manager));
    expect(manager.launches[0]!.script).toBe('flows/on-push.mjs');
  });

  it('binds to an explicit rootMessageId after checking it belongs to the target chat', async () => {
    const manager = fakeManager();
    const d = deps(manager, { messageChatId: async () => 'oc_chat' });
    const res = await triggerFlowRun(flowRequest({ rootMessageId: 'om_existing' }), d);
    expect(res).toMatchObject({ ok: true, target: { rootMessageId: 'om_existing' } });
    expect(d.seeds).toEqual([]);
    expect(manager.launches[0]!.binding.rootId).toBe('om_existing');

    const mismatch = await triggerFlowRun(flowRequest({ rootMessageId: 'om_other' }), deps(fakeManager(), { messageChatId: async () => 'oc_elsewhere' }));
    expect(mismatch).toMatchObject({ ok: false, errorCode: 'chat_not_allowed' });
    const invisible = await triggerFlowRun(flowRequest({ rootMessageId: 'om_gone' }), deps(fakeManager(), { messageChatId: async () => null }));
    expect(invisible).toMatchObject({ ok: false, errorCode: 'target_required' });
  });

  it('lays cards flat in the chat when the connector disabled the topic seed', async () => {
    const manager = fakeManager();
    const d = deps(manager, { topicMessage: () => null });
    await triggerFlowRun(flowRequest(), d);
    expect(d.seeds).toEqual([]);
    expect(manager.launches[0]!.binding.rootId).toBe('oc_chat');
  });

  it('refuses core-only and sandboxed bots, wrong daemon, and chats the bot is not in', async () => {
    expect(await triggerFlowRun(flowRequest(), deps(fakeManager(), { apiOnly: () => true }))).toMatchObject({ ok: false, errorCode: 'bad_request' });
    expect(await triggerFlowRun(flowRequest(), deps(fakeManager(), { sandboxed: () => true }))).toMatchObject({ ok: false, errorCode: 'bad_request' });
    expect(await triggerFlowRun(flowRequest({ botId: 'app2' }), deps(fakeManager()))).toMatchObject({ ok: false, errorCode: 'bot_not_found' });
    expect(await triggerFlowRun(flowRequest(), deps(fakeManager(), { isInChat: async () => false }))).toMatchObject({ ok: false, errorCode: 'bot_not_in_chat' });
    expect(await triggerFlowRun(flowRequest(), deps(fakeManager(), { resolveWorkingDir: () => ({ ok: false, error: 'no dir' }) }))).toMatchObject({ ok: false, errorCode: 'trigger_failed', error: 'no dir' });
  });

  it('dry run resolves the target without sending anything or launching', async () => {
    const manager = fakeManager();
    const d = deps(manager);
    const res = await triggerFlowRun(flowRequest({}, { dryRun: true }), d);
    expect(res).toMatchObject({ ok: true, action: 'dry_run', target: { kind: 'flow', chatId: 'oc_chat' } });
    expect(d.seeds).toEqual([]);
    expect(manager.launches).toEqual([]);
  });

  it('reports a launch failure into the topic it already opened', async () => {
    const manager = fakeManager({ launch: { ok: false, error: '脚本不存在：flows/on-push.mjs' } });
    const d = deps(manager);
    const res = await triggerFlowRun(flowRequest(), d);
    expect(res).toMatchObject({ ok: false, errorCode: 'trigger_failed', error: '脚本不存在：flows/on-push.mjs', target: { rootMessageId: 'om_seed' } });
    expect(d.notes).toEqual([['om_seed', '❌ 外部事件触发 flow 失败：脚本不存在：flows/on-push.mjs']]);
  });

  it('waitForFinalOutput returns the script return value when the run finishes', async () => {
    const manager = fakeManager({ outcome: { kind: 'finished', status: 'completed', health: 'healthy', returned: { verdict: 'ship' }, error: null } });
    const res = await triggerFlowRun(flowRequest({}, { waitForFinalOutput: true, timeoutMs: 1_000 }), deps(manager));
    expect(res).toMatchObject({ ok: true, action: 'completed', output: { content: '{"verdict":"ship"}' }, flow: { runId: 'run_1', status: 'completed', returned: { verdict: 'ship' } } });
    expect(manager.waitForFinish).toHaveBeenCalledWith('run_1', 1_000);
  });

  it('waitForFinalOutput keeps ok:true for a failed run (it did execute) and reports the status', async () => {
    const manager = fakeManager({ outcome: { kind: 'finished', status: 'failed', health: 'degraded', returned: undefined, error: { code: 'script_error', message: 'boom' } } });
    const res = await triggerFlowRun(flowRequest({}, { waitForFinalOutput: true }), deps(manager));
    expect(res).toMatchObject({ ok: true, action: 'completed', output: { content: '' }, flow: { status: 'failed', error: { code: 'script_error', message: 'boom' } } });
    expect(manager.waitForFinish).toHaveBeenCalledWith('run_1', 50);
  });

  it('waitForFinalOutput maps timeout and interruption to distinct, retry-safe codes', async () => {
    const timeout = await triggerFlowRun(flowRequest({}, { waitForFinalOutput: true }), deps(fakeManager({ outcome: null })));
    expect(timeout).toMatchObject({ ok: false, errorCode: 'wait_timeout', target: { flowRunId: 'run_1' } });
    const interrupted = await triggerFlowRun(flowRequest({}, { waitForFinalOutput: true }), deps(fakeManager({ outcome: { kind: 'interrupted', reason: 'runner 异常退出', inflight: ['a#1'] } })));
    expect(interrupted).toMatchObject({ ok: false, errorCode: 'flow_interrupted', target: { flowRunId: 'run_1' }, flow: { status: 'interrupted' } });
    expect(dispatchDidRun(interrupted)).toBe(true);
  });
});
