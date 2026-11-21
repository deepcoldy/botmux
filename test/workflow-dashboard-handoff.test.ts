/**
 * Draft model failures and 换编排 Bot (follow-up of design 2026-11-03
 * workflow-dashboard-orchestration D2): what a failed model call leaves on the
 * draft (structured cause, no provider text), and handing a draft from one
 * orchestrating bot's daemon to another's.
 *
 * Real draft services (one per bot, as two daemons) over the same run dir,
 * the real grill state machine and draft store. Fakes: each bot's clarify
 * session, the Architect worker, timers and the daemon registry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowDraftError } from '../src/workflows/v3/draft-service.js';
import {
  latestModelFailures,
  readWorkflowDraft,
  recentModelFailures,
  workflowDraftOwner,
  writeWorkflowDraft,
} from '../src/workflows/v3/draft-store.js';
import { draftFailureOf } from '../src/dashboard/web/workflow-draft-model.js';
import type { WorkflowDraftInitiator } from '../src/workflows/v3/draft-store.js';
import {
  BOTS, DOC, MAIN, OFFLINE, OWNER, PI, SKETCHES, STEWARD,
  architectSettled, makeService, specMarkdown,
} from './helpers/workflow-draft-fakes.js';

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'wf-handoff-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

/** One person on the platform login, as each bot's own app knows them. */
const ALICE_ON_MAIN: WorkflowDraftInitiator = { openId: 'ou_alice_main', unionId: 'on_alice', source: 'dashboard-platform' };
const ALICE_ON_DOC: WorkflowDraftInitiator = { openId: 'ou_alice_doc', unionId: 'on_alice', source: 'dashboard-platform' };
const BOB_ON_MAIN: WorkflowDraftInitiator = { openId: 'ou_bob_main', unionId: 'on_bob', source: 'dashboard-platform' };
const BOB_ON_DOC: WorkflowDraftInitiator = { openId: 'ou_bob_doc', unionId: 'on_bob', source: 'dashboard-platform' };

const FLEET = BOTS.map((bot) => (bot.larkAppId === MAIN ? { ...bot, model: 'demo-model-x' } : bot));

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WorkflowDraftError) return error.code;
    throw error;
  }
  return 'ok';
}

const specBlock = () => `好的。\n<botmux-spec>\n${specMarkdown(SKETCHES)}\n</botmux-spec>`;

/** The two daemons: MAIN (the draft's first orchestrator) and DOC. */
function fleet() {
  const a = makeService(base, { loadBots: () => FLEET });
  const b = makeService(base, { appId: DOC, loadBots: () => FLEET });
  return { a, b };
}

const record = (runId: string) => readWorkflowDraft(join(base, runId))!;

describe('a failed model call is recorded as a cause plus the raw error and where to see the terminal', () => {
  it('a 403 Claude files as authentication_failed: permission, with the bot, its CLI and configured model, the raw error and the session', async () => {
    const { a } = fleet();
    const { runId } = await a.service.create(ALICE_ON_MAIN, { goal: '参考历史生成 workflow' });
    const sessionId = [...a.clarify.sessions.keys()][0]!;
    a.clarify.fail('provider_authentication_failed', 'worker reported terminal failure: provider_authentication_failed');
    const view = await a.service.view(runId);
    expect(view.failure).toMatchObject({
      category: 'permission', code: 'provider_authentication_failed', step: 'clarify_turn',
      larkAppId: MAIN, cliId: 'claude-code', model: 'demo-model-x',
      detail: 'worker reported terminal failure: provider_authentication_failed',
      sessionId,
    });
    expect(view.clarify.turns.at(-1)).toMatchObject({ role: 'system', text: '这一轮失败了（provider_authentication_failed）' });
    // The picker's record keeps the cause only: no raw text reaches the bot list.
    expect(record(runId).modelCalls?.[MAIN]?.failure).toEqual({
      category: 'permission', code: 'provider_authentication_failed', step: 'clarify_turn',
      larkAppId: MAIN, cliId: 'claude-code', model: 'demo-model-x', at: expect.any(String),
    });
  });

  it('the provider\'s own error text replaces the trigger\'s summary, and the terminal tail is kept', async () => {
    const { a } = fleet();
    const { runId } = await a.service.create(ALICE_ON_MAIN, { goal: 'g' });
    a.clarify.settle({
      state: 'failed', errorCode: 'provider_authentication_failed',
      error: 'worker reported terminal failure: provider_authentication_failed',
      errorDetail: 'API Error: 403 Access denied for model demo-model-x',
      terminalTail: '  ⎿  API Error: 403 Access denied for model demo-model-x\n❯',
    });
    const failure = draftFailureOf(await a.service.view(runId))!;
    expect(failure).toMatchObject({
      category: 'permission', code: 'provider_authentication_failed',
      detail: 'API Error: 403 Access denied for model demo-model-x',
      terminalTail: '  ⎿  API Error: 403 Access denied for model demo-model-x\n❯',
    });
  });

  it('no provider text: the trigger\'s summary stays the detail, the screen tail is still shown', async () => {
    const { a } = fleet();
    const { runId } = await a.service.create(ALICE_ON_MAIN, { goal: 'g' });
    a.clarify.settle({
      state: 'failed', errorCode: 'grok_turn_error', error: 'worker reported terminal failure: grok_turn_error',
      terminalTail: 'grok> upstream 502',
    });
    expect(draftFailureOf(await a.service.view(runId))).toMatchObject({
      code: 'grok_turn_error', detail: 'worker reported terminal failure: grok_turn_error', terminalTail: 'grok> upstream 502',
    });
  });

  it('the raw error is shown, with credential shapes masked and the length clipped', async () => {
    const { a } = fleet();
    const { runId } = await a.service.create(ALICE_ON_MAIN, { goal: 'g' });
    const raw = 'Access denied for model x at https://relay.example.internal/v1 '
      + 'Authorization: Bearer abcdefgh12345678 key sk-abcdefghijklmnop api_key=zyxwvut98765 '
      + `${'x'.repeat(5000)}`;
    a.clarify.fail(undefined, raw);
    const view = await a.service.view(runId);
    expect(view.failure).toMatchObject({ category: 'unknown', step: 'clarify_turn' });
    expect(view.failure?.code).toBeUndefined();
    const detail = view.failure!.detail!;
    expect(detail).toContain('Access denied for model x at https://relay.example.internal/v1');
    expect(detail).not.toMatch(/abcdefgh12345678|sk-abcdefghijklmnop|zyxwvut98765/);
    expect(detail.length).toBeLessThanOrEqual(2000);
    expect(detail.length).toBeLessThan(raw.length);
    // Not attributable: not held against the bot's model.
    expect(record(runId).modelCalls?.[MAIN]?.failure).toBeUndefined();
  });

  it('no model in bots.json: none is named — not even a Claude bot\'s env ANTHROPIC_MODEL', async () => {
    const bots = BOTS.map((bot) => (bot.larkAppId === MAIN ? { ...bot, env: { ANTHROPIC_MODEL: 'env-only-model' } } : bot));
    const h = makeService(base, { loadBots: () => bots });
    const { runId } = await h.service.create(ALICE_ON_MAIN, { goal: 'g' });
    h.clarify.fail('provider_permission_denied');
    const view = await h.service.view(runId);
    expect(view.failure).toMatchObject({ category: 'permission', cliId: 'claude-code' });
    expect(view.failure).not.toHaveProperty('model');
    expect(JSON.stringify(record(runId))).not.toContain('env-only-model');
  });

  it('a reply that lands clears the failure and records the bot as working again', async () => {
    const { a } = fleet();
    const { runId } = await a.service.create(ALICE_ON_MAIN, { goal: 'g' });
    a.clarify.fail('provider_rate_limited');
    expect((await a.service.view(runId)).failure?.category).toBe('quota');
    await a.service.sendMessage(runId, ALICE_ON_MAIN, { text: '再试一次' });
    expect((await a.service.view(runId)).failure).toBeUndefined();
    a.advance(1_000);
    a.clarify.reply('好的');
    await a.service.view(runId);
    const calls = record(runId).modelCalls![MAIN]!;
    expect(calls.okAt! > calls.failure!.at).toBe(true);
    expect(latestModelFailures([record(runId)]).has(MAIN)).toBe(false);
  });

  it('a session that cannot start is a session failure, not a model failure', async () => {
    const { a } = fleet();
    a.clarify.createError = 'registry_unavailable';
    const { runId } = await a.service.create(ALICE_ON_MAIN, { goal: 'g' });
    const view = await a.service.view(runId);
    expect(view.failure).toMatchObject({ category: 'session', code: 'registry_unavailable', step: 'clarify_start', larkAppId: MAIN });
    expect(record(runId).modelCalls).toBeUndefined();
  });

  it('a failed Architect keeps its problems and worker stderr as the raw error, and its terminal tail (plain text, masked)', async () => {
    const h = makeService(base, { loadBots: () => FLEET });
    const { runId } = await h.service.create(ALICE_ON_MAIN, { goal: 'g' });
    h.clarify.reply(specBlock());
    await h.service.finalizeSpec(runId, ALICE_ON_MAIN, {});
    await h.service.approveSpec(runId, ALICE_ON_MAIN);
    h.architect.mode = 'fail';
    h.architect.onRun = (attemptDir: string) => {
      writeFileSync(join(attemptDir, 'stderr.log'), '[worker] API Error: 403 Access denied for model demo-model-x\n');
      writeFileSync(join(attemptDir, 'pty.log'), '\x1b[31m✗ API Error 403\x1b[0m\r\nAuthorization: Bearer abcdefgh12345678\r\n');
    };
    await h.service.startArchitect(runId, ALICE_ON_MAIN);
    await architectSettled(h.service, runId);
    const failure = (await h.service.view(runId)).failure!;
    expect(failure).toMatchObject({ step: 'architect', larkAppId: MAIN });
    expect(failure.detail).toContain('architect worker failed');
    expect(failure.detail).toContain('API Error: 403 Access denied for model demo-model-x');
    expect(failure.terminalTail).toContain('✗ API Error 403');
    expect(failure.terminalTail).not.toContain('\x1b');
    expect(failure.terminalTail).not.toContain('abcdefgh12345678');
  });

  it('a credential cut by the log tail window or the terminal clip is never kept or shown in part', async () => {
    // Every secret is written in letters nowhere else in the text: any run of
    // them in the record is a leaked piece, wherever the windows happen to cut.
    const letters = 'QWXZJK';
    const secret = (n: number, len: number) => Array.from({ length: len }, (_, i) => letters[(n * 7 + i * 5 + (i >> 2)) % letters.length]).join('');
    const leaked = /[QWXZJK]{4,}/;
    const h = makeService(base, { loadBots: () => FLEET });
    const { runId } = await h.service.create(ALICE_ON_MAIN, { goal: 'g' });
    h.clarify.reply(specBlock());
    await h.service.finalizeSpec(runId, ALICE_ON_MAIN, {});
    await h.service.approveSpec(runId, ALICE_ON_MAIN);
    h.architect.mode = 'fail';
    h.architect.onRun = (attemptDir: string) => {
      writeFileSync(join(attemptDir, 'stderr.log'), Array.from({ length: 700 }, (_, n) => `api_key=${secret(n, 41)}\n`).join(''));
      writeFileSync(join(attemptDir, 'pty.log'), Array.from({ length: 900 }, (_, n) => `\x1b[2mAuthorization: Bearer ${secret(n, 133)}\x1b[0m\r\n`).join(''));
    };
    await h.service.startArchitect(runId, ALICE_ON_MAIN);
    await architectSettled(h.service, runId);
    const failure = (await h.service.view(runId)).failure!;
    expect(failure.detail).toContain('api_key=‹hidden›');
    expect(failure.terminalTail).toContain('Authorization: ‹hidden›');
    expect(failure.detail).not.toMatch(leaked);
    expect(failure.terminalTail).not.toMatch(leaked);
    expect(readFileSync(join(base, runId, 'draft.json'), 'utf-8')).not.toMatch(leaked);
  });

  it('a session that cannot start: its raw error is masked everywhere it is kept (clarify.error too)', async () => {
    const { a } = fleet();
    a.clarify.createError = 'spawn failed: Authorization: Bearer QWERTYzxcv1234567890SECRETabcdef';
    const { runId } = await a.service.create(ALICE_ON_MAIN, { goal: 'g' });
    const view = await a.service.view(runId);
    expect(view.failure?.detail).toBe('spawn failed: Authorization: ‹hidden›');
    expect(view.clarify.error).toBe('spawn failed: Authorization: ‹hidden›');
    expect(JSON.stringify(view)).not.toContain('SECRETabcdef');
    expect(readFileSync(join(base, runId, 'draft.json'), 'utf-8')).not.toContain('SECRETabcdef');
  });

  it('an Architect that times out is recorded as a timeout of the orchestrator', async () => {
    const h = makeService(base, { loadBots: () => FLEET, architectTimeoutMs: 1 });
    const { runId } = await h.service.create(ALICE_ON_MAIN, { goal: 'g' });
    h.clarify.reply(specBlock());
    await h.service.finalizeSpec(runId, ALICE_ON_MAIN, {});
    await h.service.approveSpec(runId, ALICE_ON_MAIN);
    h.architect.mode = 'hang';
    await h.service.startArchitect(runId, ALICE_ON_MAIN);
    h.timers.fire();
    await architectSettled(h.service, runId);
    const view = await h.service.view(runId);
    expect(view.architect?.state).toBe('timed_out');
    expect(view.failure).toMatchObject({ category: 'timeout', step: 'architect', larkAppId: MAIN });
    expect(draftFailureOf(view)).toMatchObject({ category: 'timeout', step: 'architect', legacy: false });
  });

  it('an older draft with only the error string still reads; the page says "unknown" with the code and shows the string (masked)', async () => {
    const { a } = fleet();
    const { runId } = await a.service.create(ALICE_ON_MAIN, { goal: 'g' });
    a.clarify.fail('provider_authentication_failed');
    await a.service.view(runId);
    // As written before this change: no failure / modelCalls fields.
    const old = record(runId);
    delete old.failure;
    delete old.modelCalls;
    old.clarify.error = 'worker reported terminal failure: provider_authentication_failed (Bearer abcdefgh12345678)';
    writeWorkflowDraft(join(base, runId), old);
    const view = await a.service.view(runId);
    expect(view.failure).toBeUndefined();
    // The raw string an older record kept is masked on the way out too.
    expect(view.clarify.error).not.toContain('abcdefgh12345678');
    expect(draftFailureOf(view)).toEqual({
      category: 'unknown', code: 'provider_authentication_failed', step: 'clarify_turn', larkAppId: MAIN, legacy: true,
      detail: 'worker reported terminal failure: provider_authentication_failed (‹hidden›',
    });
  });

  it('the picker warning comes from the records on disk: latest failure per bot unless a later call went through', async () => {
    const { a } = fleet();
    const first = await a.service.create(ALICE_ON_MAIN, { goal: 'one' });
    a.clarify.fail('provider_permission_denied');
    await a.service.view(first.runId);
    expect(recentModelFailures(base).get(MAIN)).toMatchObject({ category: 'permission', model: 'demo-model-x' });
    a.advance(60_000);
    const second = await a.service.create(ALICE_ON_MAIN, { goal: 'two' });
    a.clarify.reply('ok');
    await a.service.view(second.runId);
    expect(recentModelFailures(base).has(MAIN)).toBe(false);
  });
});

/** A draft of MAIN at 澄清中 whose first turn failed, with a reply and a spec candidate before. */
async function failedClarify(h: ReturnType<typeof fleet>, initiator = ALICE_ON_MAIN) {
  const { runId } = await h.a.service.create(initiator, { goal: '出一份代码风险报告' });
  h.a.clarify.reply(specBlock());
  await h.a.service.view(runId);
  await h.a.service.sendMessage(runId, initiator, { text: '再补一句' });
  h.a.clarify.fail('provider_authentication_failed');
  const view = await h.a.service.view(runId);
  expect(view.failure?.category).toBe('permission');
  return runId;
}

describe('换编排 Bot', () => {
  it('hands the draft over: old session closed, owner and initiator move, conversation and spec candidate carried into a new session', async () => {
    const h = fleet();
    const runId = await failedClarify(h);
    const before = await h.a.service.view(runId);
    const oldSession = [...h.a.clarify.sessions.keys()][0]!;

    const prepared = await h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC });
    expect(prepared.draft.handoff).toMatchObject({ toAppId: DOC, state: 'ready' });
    expect(h.a.clarify.closes).toContain(oldSession);
    // Still MAIN's until the target takes it.
    expect(workflowDraftOwner(base, runId)).toBe(MAIN);

    const after = await h.b.service.acceptHandoff(runId, ALICE_ON_DOC, { token: prepared.token });
    expect(workflowDraftOwner(base, runId)).toBe(DOC);
    expect(after.orchestratorAppId).toBe(DOC);
    expect(record(runId).initiator).toEqual(ALICE_ON_DOC);
    expect(after.handoff).toBeUndefined();
    // The history: who (each app's own open_id), from / to, when; no first
    // confirmation yet, so no confirmer change.
    expect(after.handoffs).toEqual([{
      fromAppId: MAIN, toAppId: DOC, at: expect.any(String),
      by: { source: 'dashboard-platform', fromOpenId: ALICE_ON_MAIN.openId, toOpenId: ALICE_ON_DOC.openId, unionId: 'on_alice' },
    }]);
    expect(after.failure).toBeUndefined();
    expect(after.clarify.specCandidate?.markdown).toBe(before.clarify.specCandidate?.markdown);
    expect(after.clarify.turns.slice(0, before.clarify.turns.length)).toEqual(before.clarify.turns);
    expect(after.clarify.turns.at(-1)).toMatchObject({ role: 'system', text: expect.stringContaining('换成了') });
    expect(after.clarify).toMatchObject({ state: 'active', pending: true });
    // The new bot's session got the conversation so far as its first turn.
    const [newSession] = [...h.b.clarify.sessions.values()];
    expect(newSession!.prompts[0]).toContain('再补一句');
    expect(newSession!.prompts[0]).toContain('"sketchId": "inspect"');

    // The old daemon no longer writes it; the new one does.
    expect(await code(h.a.service.sendMessage(runId, ALICE_ON_MAIN, { text: 'x' }))).toBe('bot_mismatch');
    h.b.clarify.reply('收到');
    await h.b.service.view(runId);
    await h.b.service.sendMessage(runId, ALICE_ON_DOC, { text: '继续' });
  });

  it('only the initiator: another person cannot prepare on the old bot nor accept on the new one', async () => {
    const h = fleet();
    const runId = await failedClarify(h);
    expect(await code(h.a.service.prepareHandoff(runId, BOB_ON_MAIN, { toLarkAppId: DOC }))).toBe('not_initiator');
    const { token } = await h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC });
    expect(await code(h.b.service.acceptHandoff(runId, BOB_ON_DOC, { token }))).toBe('not_initiator');
    expect(workflowDraftOwner(base, runId)).toBe(MAIN);
  });

  it('a local-token draft is handed over too: the new initiator is the target bot\'s owner, as the target resolved them', async () => {
    const h = fleet();
    const runId = await failedClarify(h, OWNER);
    const { token } = await h.a.service.prepareHandoff(runId, OWNER, { toLarkAppId: DOC });
    // A platform login does not take over a local-token draft (another login path).
    expect(await code(h.b.service.acceptHandoff(runId, ALICE_ON_DOC, { token }))).toBe('not_initiator');
    const DOC_OWNER: WorkflowDraftInitiator = { openId: 'ou_doc_owner', source: 'dashboard-local' };
    const after = await h.b.service.acceptHandoff(runId, DOC_OWNER, { token });
    expect(after.orchestratorAppId).toBe(DOC);
    expect(record(runId).initiator).toEqual(DOC_OWNER);
    expect(after.handoffs?.at(-1)?.by).toEqual({ source: 'dashboard-local', fromOpenId: OWNER.openId, toOpenId: DOC_OWNER.openId });
  });

  it('a platform draft: the same union_id is required on the target; a missing one is refused', async () => {
    const h = fleet();
    const runId = await failedClarify(h);
    const { token } = await h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC });
    const { unionId: _drop, ...noUnion } = ALICE_ON_DOC;
    expect(await code(h.b.service.acceptHandoff(runId, noUnion, { token }))).toBe('not_initiator');
    expect(await code(h.b.service.acceptHandoff(runId, { openId: 'ou_owner_doc', source: 'dashboard-local' }, { token }))).toBe('not_initiator');
    expect(workflowDraftOwner(base, runId)).toBe(MAIN);
  });

  it('the target must be able to orchestrate: steward, unsupported CLI, offline and unknown bots are refused before anything closes', async () => {
    const h = fleet();
    const runId = await failedClarify(h);
    for (const target of [STEWARD, PI, OFFLINE, 'cli_nowhere']) {
      expect(await code(h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: target }))).toBe('orchestrator_ineligible');
    }
    expect(record(runId).handoff).toBeUndefined();
    expect(h.a.clarify.closes).toEqual([]);
  });

  it('not once 拉群开始 began, nor at 待确认流程', async () => {
    const h = fleet();
    const runId = await failedClarify(h);
    const draft = record(runId);
    writeWorkflowDraft(join(base, runId), {
      ...draft,
      launch: {
        attempt: 1, state: 'paused', startedAt: draft.createdAt, updatedAt: draft.createdAt,
        groupName: 'g #00000001', marker: '#00000001', extraMembers: [], ownerChannel: 'union_id',
      },
    });
    expect(await code(h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC }))).toBe('state_conflict');

    const other = makeService(join(base), { loadBots: () => FLEET });
    const { runId: dagRun } = await other.service.create(ALICE_ON_MAIN, { goal: 'dag' });
    other.clarify.reply(specBlock());
    await other.service.finalizeSpec(dagRun, ALICE_ON_MAIN, {});
    await other.service.approveSpec(dagRun, ALICE_ON_MAIN);
    await other.service.startArchitect(dagRun, ALICE_ON_MAIN);
    await architectSettled(other.service, dagRun);
    expect((await other.service.view(dagRun)).phase).toBe('dag_ready');
    expect(await code(other.service.prepareHandoff(dagRun, ALICE_ON_MAIN, { toLarkAppId: DOC }))).toBe('state_conflict');
  });

  it('a failed Architect (待编排) is handed over without a clarify session; the new bot orchestrates', async () => {
    const h = fleet();
    const { runId } = await h.a.service.create(ALICE_ON_MAIN, { goal: 'g' });
    h.a.clarify.reply(specBlock());
    await h.a.service.finalizeSpec(runId, ALICE_ON_MAIN, {});
    await h.a.service.approveSpec(runId, ALICE_ON_MAIN);
    h.a.architect.mode = 'fail';
    await h.a.service.startArchitect(runId, ALICE_ON_MAIN);
    await architectSettled(h.a.service, runId);
    const { token } = await h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC });
    const after = await h.b.service.acceptHandoff(runId, ALICE_ON_DOC, { token });
    expect(after).toMatchObject({ orchestratorAppId: DOC, phase: 'awaiting_architect' });
    expect(h.b.clarify.creates).toBe(0);
    // The first confirmation names the person in the new bot's app, and the
    // history says from what to what (each open_id under its own app).
    expect(record(runId).specConfirmation?.confirmedByOpenId).toBe(ALICE_ON_DOC.openId);
    expect(after.handoffs?.at(-1)).toMatchObject({
      fromAppId: MAIN, toAppId: DOC,
      by: { source: 'dashboard-platform', fromOpenId: ALICE_ON_MAIN.openId, toOpenId: ALICE_ON_DOC.openId, unionId: 'on_alice' },
      specConfirmation: { fromOpenId: ALICE_ON_MAIN.openId, toOpenId: ALICE_ON_DOC.openId },
    });
    expect(after.handoffs?.at(-1)).not.toHaveProperty('token');
    expect(after.clarify.turns.at(-1)?.text).toContain('「确认需求」的确认人已改为新编排 Bot 下的发起人身份');
    await h.b.service.startArchitect(runId, ALICE_ON_DOC);
    await architectSettled(h.b.service, runId);
    expect((await h.b.service.view(runId)).phase).toBe('dag_ready');
  });

  it('while a handoff is pending the old bot takes no other write; cancelling leaves the draft with it, 「继续」 reopens a session', async () => {
    const h = fleet();
    const runId = await failedClarify(h);
    await h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC });
    expect(await code(h.a.service.sendMessage(runId, ALICE_ON_MAIN, { text: 'x' }))).toBe('handoff_pending');
    expect(await code(h.a.service.continueClarify(runId, ALICE_ON_MAIN))).toBe('handoff_pending');
    expect(await h.a.service.sweepIdleClarify()).toEqual([]);
    const cancelled = await h.a.service.cancelHandoff(runId, ALICE_ON_MAIN);
    expect(cancelled.handoff).toBeUndefined();
    expect(cancelled.clarify.state).toBe('disconnected');
    const resumed = await h.a.service.continueClarify(runId, ALICE_ON_MAIN);
    expect(resumed.clarify).toMatchObject({ state: 'active', pending: true });
    expect(workflowDraftOwner(base, runId)).toBe(MAIN);
  });

  it('「放弃」 while a handoff is pending ends it: the page shows no handoff, the target cannot take the draft over', async () => {
    const h = fleet();
    const runId = await failedClarify(h);
    const { token } = await h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC });
    const abandoned = await h.a.service.abandon(runId, ALICE_ON_MAIN);
    expect(abandoned.handoff).toBeUndefined();
    expect(record(runId).handoff).toBeUndefined();
    expect(await code(h.b.service.acceptHandoff(runId, ALICE_ON_DOC, { token }))).toBe('state_conflict');
    expect(workflowDraftOwner(base, runId)).toBe(MAIN);
  });

  it('refuses to start a handoff while a clarify turn is still in flight: the session is never closed mid-turn and no handoff is recorded', async () => {
    const h = fleet();
    // create() leaves the first clarify turn pending (the model has not answered).
    const { runId } = await h.a.service.create(ALICE_ON_MAIN, { goal: 'g' });
    expect((await h.a.service.view(runId)).clarify.pending).toBeTruthy();
    expect(await code(h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC }))).toBe('clarify_turn_running');
    // The draft stays with its owner, its session open, no handoff under way.
    expect(workflowDraftOwner(base, runId)).toBe(MAIN);
    expect(record(runId).handoff).toBeUndefined();
    expect(h.a.clarify.closes).toEqual([]);
  });

  it('two tabs: one target wins, the other token is refused; the winning accept repeated opens no second session', async () => {
    const h = fleet();
    const runId = await failedClarify(h);
    const c = makeService(base, { appId: 'cli_third', loadBots: () => [...FLEET, { larkAppId: 'cli_third', larkAppSecret: 'x', cliId: 'claude-code' }] });
    h.a.deps.loadBots = () => [...FLEET, { larkAppId: 'cli_third', larkAppSecret: 'x', cliId: 'claude-code' }] as any;
    h.a.setOnline([MAIN, DOC, 'cli_third']);
    const toDoc = await h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC });
    const toThird = await h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: 'cli_third' });
    expect(toThird.token).not.toBe(toDoc.token);
    expect(await code(h.b.service.acceptHandoff(runId, ALICE_ON_DOC, { token: toDoc.token }))).toBe('state_conflict');
    const [first, second] = await Promise.all([
      c.service.acceptHandoff(runId, { ...ALICE_ON_DOC, openId: 'ou_alice_third' }, { token: toThird.token }),
      c.service.acceptHandoff(runId, { ...ALICE_ON_DOC, openId: 'ou_alice_third' }, { token: toThird.token }).catch((error) => error),
    ]);
    expect(first.orchestratorAppId).toBe('cli_third');
    // The loser either answers the moved draft or is turned away while the
    // winner holds the lock; never a second session.
    if (!(second instanceof Error)) expect(second.orchestratorAppId).toBe('cli_third');
    const again = await c.service.acceptHandoff(runId, { ...ALICE_ON_DOC, openId: 'ou_alice_third' }, { token: toThird.token });
    expect(again.orchestratorAppId).toBe('cli_third');
    expect(c.clarify.creates).toBe(1);
    expect(workflowDraftOwner(base, runId)).toBe('cli_third');
  });

  it('a close that fails keeps the draft with the old bot (closing); after a restart the repeat finishes and only then the new bot can take it', async () => {
    const h = fleet();
    const runId = await failedClarify(h);
    h.a.clarify.closeError = 'close refused: busy';
    expect(await code(h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC }))).toBe('clarify_unavailable');
    expect(record(runId).handoff).toMatchObject({ toAppId: DOC, state: 'closing' });
    const token = record(runId).handoff!.token;
    expect(await code(h.b.service.acceptHandoff(runId, ALICE_ON_DOC, { token }))).toBe('busy');
    expect(workflowDraftOwner(base, runId)).toBe(MAIN);

    // The old daemon restarts (a new service instance over the same disk).
    const a2 = makeService(base, { loadBots: () => FLEET, clarifier: h.a.clarify.clarifier });
    h.a.clarify.closeError = undefined;
    a2.service.recoverInterrupted();
    const repeated = await a2.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC });
    expect(repeated.token).toBe(token);
    expect(record(runId).handoff?.state).toBe('ready');
    await h.b.service.acceptHandoff(runId, ALICE_ON_DOC, { token });
    expect(workflowDraftOwner(base, runId)).toBe(DOC);
    expect(await code(a2.service.view(runId))).toBe('bot_mismatch');
  });

  it('the new bot crashes right after taking the draft: it owns it, the session slot heals, 「继续」 there starts a session', async () => {
    const h = fleet();
    const runId = await failedClarify(h);
    const { token } = await h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC });
    // The ownership write lands, the session start never answers (the process dies).
    h.b.clarify.clarifier.create = () => new Promise(() => {});
    void h.b.service.acceptHandoff(runId, ALICE_ON_DOC, { token });
    for (let i = 0; i < 50 && workflowDraftOwner(base, runId) !== DOC; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(workflowDraftOwner(base, runId)).toBe(DOC);
    // Its holder (the dead process) is gone: the restarted daemon drops the reservation.
    const b2 = makeService(base, { appId: DOC, loadBots: () => FLEET, isHolderAlive: () => false });
    const healed = await b2.service.view(runId);
    expect(healed.clarify).toMatchObject({ pending: false, state: 'disconnected' });
    const resumed = await b2.service.continueClarify(runId, ALICE_ON_DOC);
    expect(resumed.clarify).toMatchObject({ state: 'active', pending: true });
    expect(await code(h.a.service.continueClarify(runId, ALICE_ON_MAIN))).toBe('bot_mismatch');
    expect(JSON.parse(readFileSync(join(base, runId, 'draft.json'), 'utf-8')).orchestratorAppId).toBe(DOC);
  });

  it('a template run is never handed over', async () => {
    const h = fleet();
    const runId = await failedClarify(h);
    const draft = record(runId);
    writeFileSync(join(base, runId, 'draft.json'), JSON.stringify({
      ...draft,
      template: {
        workflowId: `wf_${'0'.repeat(32)}`, revisionId: `rev_${'0'.repeat(64)}`, contentHash: `sha256:${'0'.repeat(64)}`,
        humanVersion: 1, displayName: 't', ownerOpenId: 'ou_alice_main', params: {}, hasInputs: false,
        dagSha256: `sha256:${'0'.repeat(64)}`, specSha256: `sha256:${'0'.repeat(64)}`, preparedAt: draft.createdAt,
      },
    }));
    expect(await code(h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC }))).toBe('template_run');
  });
});

/** The old bot's close, held until the test lets each call through (or fail). */
function gatedClose(h: ReturnType<typeof fleet>) {
  const real = h.a.clarify.clarifier.close.bind(h.a.clarify.clarifier);
  const held: Array<{ session: { sessionId: string; headlessId?: string }; pass: () => Promise<void>; fail: (message: string) => void }> = [];
  h.a.clarify.clarifier.close = (session) => new Promise<void>((resolve, reject) => {
    held.push({
      session,
      pass: async () => { await real(session); resolve(); },
      fail: (message) => reject(new Error(message)),
    });
  });
  const waitHeld = async (n: number) => {
    for (let i = 0; i < 200 && held.length < n; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(held.length).toBe(n);
  };
  return { held, waitHeld };
}

describe('换编排 Bot: overlapping steps', () => {
  it('取消更换 while the old bot is closing: the draft forgets the closed session, so the next message is not refused', async () => {
    const h = fleet();
    const runId = await failedClarify(h);
    const gate = gatedClose(h);
    const preparing = code(h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC }));
    await gate.waitHeld(1);
    await h.a.service.cancelHandoff(runId, ALICE_ON_MAIN);
    await gate.held[0]!.pass();
    expect(await preparing).toBe('state_conflict');
    const after = record(runId);
    expect(after.handoff).toBeUndefined();
    expect(after.clarify.sessionId).toBeUndefined();
    expect(after.clarify.state).toBe('disconnected');
    expect(workflowDraftOwner(base, runId)).toBe(MAIN);
    // 「继续」 opens a new session straight away (no dead session in the way).
    const resumed = await h.a.service.continueClarify(runId, ALICE_ON_MAIN);
    expect(resumed.clarify).toMatchObject({ state: 'active', pending: true });
  });

  it('two tabs, same target: the second close failing after the first landed records no orphan; the accept goes through', async () => {
    const h = fleet();
    const runId = await failedClarify(h);
    const gate = gatedClose(h);
    const tab1 = h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC });
    const tab2 = code(h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC }));
    await gate.waitHeld(2);
    expect(gate.held[1]!.session.sessionId).toBe(gate.held[0]!.session.sessionId);
    await gate.held[0]!.pass();
    const { token } = await tab1;
    gate.held[1]!.fail('session already closed');
    await tab2;
    expect(record(runId).orphanSessions).toBeUndefined();
    expect(record(runId).handoff).toMatchObject({ token, state: 'ready' });
    await h.b.service.acceptHandoff(runId, ALICE_ON_DOC, { token });
    expect(workflowDraftOwner(base, runId)).toBe(DOC);
    expect(h.b.clarify.creates).toBe(1);
  });

  it('a token from a cancelled handoff is dead: prepare → cancel → prepare again, the first token is refused', async () => {
    const h = fleet();
    const runId = await failedClarify(h);
    const stale = await h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC });
    await h.a.service.cancelHandoff(runId, ALICE_ON_MAIN);
    const fresh = await h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC });
    expect(fresh.token).not.toBe(stale.token);
    expect(await code(h.b.service.acceptHandoff(runId, ALICE_ON_DOC, { token: stale.token }))).toBe('state_conflict');
    expect(workflowDraftOwner(base, runId)).toBe(MAIN);
    await h.b.service.acceptHandoff(runId, ALICE_ON_DOC, { token: fresh.token });
    expect(workflowDraftOwner(base, runId)).toBe(DOC);
  });

  it('a ready handoff whose draft still lists an unclosed session of the old bot is not taken; the new bot never closes the old app\'s session', async () => {
    const h = fleet();
    const runId = await failedClarify(h);
    const { token } = await h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC });
    const draft = record(runId);
    writeWorkflowDraft(join(base, runId), { ...draft, orphanSessions: [{ sessionId: 'sess-old-app', headlessId: 'hl_draft_00000099' }] });
    expect(await code(h.b.service.acceptHandoff(runId, ALICE_ON_DOC, { token }))).toBe('state_conflict');
    expect(workflowDraftOwner(base, runId)).toBe(MAIN);
    await h.b.service.sweepIdleClarify();
    expect(h.b.clarify.closes).toEqual([]);
  });

  it('the accept repeated after it landed answers the initiator only', async () => {
    const h = fleet();
    const runId = await failedClarify(h);
    const { token } = await h.a.service.prepareHandoff(runId, ALICE_ON_MAIN, { toLarkAppId: DOC });
    await h.b.service.acceptHandoff(runId, ALICE_ON_DOC, { token });
    expect((await h.b.service.acceptHandoff(runId, ALICE_ON_DOC, { token })).orchestratorAppId).toBe(DOC);
    expect(await code(h.b.service.acceptHandoff(runId, BOB_ON_DOC, { token }))).toBe('not_initiator');
    expect(await code(h.b.service.acceptHandoff(runId, { openId: 'ou_doc_owner', source: 'dashboard-local' }, { token }))).toBe('not_initiator');
    expect(h.b.clarify.creates).toBe(1);
  });
});
