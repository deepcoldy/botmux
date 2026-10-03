import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mocks = vi.hoisted(() => ({ request: vi.fn(), create: vi.fn(), reply: vi.fn() }));
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {
  request = mocks.request;
  im = { v1: { message: { create: mocks.create, reply: mocks.reply } } };
} }));
import { registerBot } from '../src/bot-registry.js';
import { __testOnly_resetLarkGate } from '../src/im/lark/api-gate.js';
import { chatBoundWorkflowWriteOptions } from '../src/workflows/v3/botmux-host-policy.js';
import { createDefaultHostExecutorRegistry, createDefaultProviderReconcilers } from '../src/workflows/hostExecutors/registry.js';
import { driveV3Run, resolveV3GateClick, type V3DaemonRunDeps } from '../src/workflows/v3/daemon-run.js';
import { birthRun, readGrillState, writeGrillState } from '../src/workflows/v3/grill-state.js';
import { readJournal } from '../src/workflows/v3/journal.js';

const APP = 'cli_workflow_source';
const CHAT = 'oc_source';
const SOURCE = 'om_source';
const roots: string[] = [];
const bot = { larkAppId: APP, larkAppSecret: 'test-only', cliId: 'claude-code' as const, topicUnavailablePolicy: 'stop' as const };
let unavailable = false;
let missing = false;
beforeEach(() => {
  __testOnly_resetLarkGate(); vi.clearAllMocks(); unavailable = false; missing = false;
  vi.stubEnv('BOTMUX_LARK_QPS', '100000'); vi.stubEnv('BOTMUX_LARK_GATE_RETRY_BASE_MS', '1');
  registerBot(bot);
  mocks.request.mockReset().mockImplementation(async ({ method, url }) => {
    if (method !== 'GET' || !url.includes('/im/v1/messages/')) throw new Error('unexpected provider request');
    const id = url.split('/').at(-1);
    return { code: 0, data: { items: id === SOURCE && missing ? [] : [{ message_id: id, deleted: id === SOURCE && unavailable }] } };
  });
  mocks.create.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_result' } });
  mocks.reply.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_result' } });
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs(); __testOnly_resetLarkGate();
});
function sourceOptions(rootMessageId: string | undefined = SOURCE) {
  return chatBoundWorkflowWriteOptions({ params: {}, context: { larkAppId: APP, chatId: CHAT,
    ...(rootMessageId === undefined ? {} : { rootMessageId }) } });
}
function input(kind: 'send' | 'reply') {
  return { larkAppId: APP, ...(kind === 'send' ? { chatId: CHAT } : { rootMessageId: 'om_target' }), content: 'result' };
}

describe('workflow IM source factories', () => {
  it.each(['send', 'reply'] as const)('%s protects both live and recovery attempts', async kind => {
    unavailable = true;
    const options = sourceOptions();
    const executor = createDefaultHostExecutorRegistry(options).get('feishu-' + kind)!.executor;
    await expect(executor.invoke(input(kind), 'stable')).rejects.toMatchObject({ code: 'TOPIC_SEND_BLOCKED' });
    const result = await createDefaultProviderReconcilers(options).get('feishu-im')!.idempotentSubmit!('stable', input(kind));
    expect(result).toMatchObject({ ok: false, errorClass: 'manual' });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.reply).not.toHaveBeenCalled();
  });
  it.each(['live', 'recovery'] as const)('rechecks the original source after a rate limit during %s', async mode => {
    mocks.create.mockImplementationOnce(async () => {
      unavailable = true; throw { isAxiosError: true, response: { status: 429 } };
    });
    const options = sourceOptions();
    if (mode === 'live') {
      await expect(createDefaultHostExecutorRegistry(options).get('feishu-send')!.executor.invoke(input('send'), 'original-key'))
        .rejects.toMatchObject({ code: 'TOPIC_SEND_BLOCKED' });
    } else {
      await expect(createDefaultProviderReconcilers(options).get('feishu-im')!.idempotentSubmit!('original-key', input('send')))
        .resolves.toMatchObject({ ok: false, errorClass: 'manual' });
    }
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[0][0].data.uuid).toBe('original-key');
    expect(mocks.request.mock.calls.map(([r]) => r.url.split('/').at(-1))).toEqual([SOURCE, SOURCE]);
  });
  it('keeps primitive source identity frozen when the supplied context object changes', async () => {
    const snapshot = { params: {}, context: { larkAppId: APP, chatId: CHAT, rootMessageId: SOURCE } };
    const options = chatBoundWorkflowWriteOptions(snapshot);
    snapshot.context.rootMessageId = 'om_new_source'; unavailable = true;
    await expect(createDefaultHostExecutorRegistry(options).get('feishu-send')!.executor.invoke(input('send'), 'same-key'))
      .rejects.toMatchObject({ code: 'TOPIC_SEND_BLOCKED' });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('pauses missing source observations and missing authorized context', async () => {
    missing = true;
    for (const options of [sourceOptions(), chatBoundWorkflowWriteOptions(undefined)]) {
      await expect(createDefaultHostExecutorRegistry(options).get('feishu-send')!.executor.invoke(input('send'), 'same-key'))
        .rejects.toMatchObject({ code: 'TOPIC_SEND_CHECK_FAILED' });
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('keeps explicit chat context, legacy behavior, effect hashes and UUIDs unchanged', async () => {
    const chat = chatBoundWorkflowWriteOptions({ params: {}, context: { larkAppId: APP, chatId: CHAT } });
    const first = createDefaultHostExecutorRegistry(chat).get('feishu-send')!.executor;
    await first.invoke(input('send'), 'chat-key');
    expect(mocks.request).not.toHaveBeenCalled();
    registerBot({ ...bot, topicUnavailablePolicy: 'legacy' }); unavailable = true;
    const guarded = createDefaultHostExecutorRegistry(sourceOptions()).get('feishu-send')!.executor;
    const ordinary = createDefaultHostExecutorRegistry().get('feishu-send')!.executor;
    expect(guarded.canonicalInput(input('send'))).toEqual(ordinary.canonicalInput(input('send')));
    await guarded.invoke(input('send'), 'legacy-key');
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls.map(([r]) => r.data.uuid)).toEqual(['chat-key', 'legacy-key']);
  });
});

function newBase() { const root = mkdtempSync(join(tmpdir(), 'workflow-source-')); roots.push(root); return root; }
function seed(base: string, runId: string) {
  const { runDir } = birthRun({ goal: 'g', baseDir: base, runId,
    chatBinding: { larkAppId: APP, chatId: CHAT, rootMessageId: SOURCE } });
  const dagPath = join(runDir, 'dag.json');
  writeFileSync(dagPath, JSON.stringify({ runId, nodes: [{ id: 'send', type: 'host', executor: 'feishu-send',
    input: { larkAppId: { $ref: 'context.larkAppId' }, chatId: { $ref: 'context.chatId' }, content: 'approved result' },
    depends: [], inputs: [], humanGate: { prompt: 'Approve fixture send?' } }] }));
  writeGrillState(runDir, { ...readGrillState(runDir)!, status: 'dag_approved', dagPath });
  return runDir;
}
function deps(baseDir: string): V3DaemonRunDeps {
  return { baseDir, loadBots: () => [bot],
    makeRunNode: () => async () => { throw new Error('host-only test must not spawn a worker'); },
    postGateCard: async () => {}, postBlockedCard: async () => {}, onTerminal: async () => {} };
}
async function approve(base: string, runId: string) {
  expect(await driveV3Run(runId, deps(base))).toMatchObject({ reason: 'awaitingGate' });
  expect(resolveV3GateClick(base, runId, { waitId: 'send#001-host-001-gate', selected: 'approve', by: 'ou_fixture' }))
    .toMatchObject({ kind: 'resolved', resolution: 'approved' });
}

describe('daemon workflow source survives durable recovery', () => {
  it('blocks the real daemon sender after approval if the original topic was withdrawn', async () => {
    const base = newBase(); const runId = 'source-live'; const runDir = seed(base, runId);
    await approve(base, runId); unavailable = true;
    const outcome = await driveV3Run(runId, deps(base));
    expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'blocked' });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(readJournal(join(runDir, 'journal.ndjson'))).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'hostEffectIntent' }), expect.objectContaining({ type: 'hostEffectUncertain' }),
    ]));
  });
  it.each([false, true])('restores an open intent with its original source and key (withdrawn=%s)', async withdrawn => {
    const base = newBase(); const recoveryBase = newBase(); const runId = 'source-recovery'; const runDir = seed(base, runId);
    const recoveryDir = join(recoveryBase, runId);
    await approve(base, runId);
    mocks.create.mockImplementationOnce(async () => {
      // Snapshot the actual durable intent before the provider result/manifest.
      // Only temporary fixture directories are copied; this models a crash.
      cpSync(runDir, recoveryDir, { recursive: true });
      return { code: 0, data: { message_id: 'om_result' } };
    });
    expect(await driveV3Run(runId, deps(base))).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
    expect(existsSync(recoveryDir)).toBe(true);
    const originalKey = mocks.create.mock.calls[0][0].data.uuid;
    mocks.create.mockClear(); mocks.request.mockClear(); unavailable = withdrawn;
    const outcome = await driveV3Run(runId, deps(recoveryBase));
    expect(outcome).toMatchObject({ reason: 'terminal', runStatus: withdrawn ? 'blocked' : 'succeeded' });
    expect(mocks.create).toHaveBeenCalledTimes(withdrawn ? 0 : 1);
    if (!withdrawn) expect(mocks.create.mock.calls[0][0].data.uuid).toBe(originalKey);
    const events = readJournal(join(recoveryDir, 'journal.ndjson'));
    expect(events.filter(e => e.type === 'hostEffectIntent')).toHaveLength(1);
    if (withdrawn) expect(events.some(e => e.type === 'hostEffectUncertain')).toBe(true);
    expect(mocks.request.mock.calls.some(([r]) => r.url.endsWith('/' + SOURCE))).toBe(true);
  });
});
