/**
 * Dispatch-boundary subtraction of a frozen group background bundle.
 *
 * A follow-up prepared while the previous input was still being accepted may
 * include sources that are covered by the time it is really dispatched.
 * Prompt assembly and queueing carry the frozen bundle unchanged; at the
 * delivery boundary exactly the covered sources' frozen fragments are removed
 * (pure subtraction: no re-render, no re-read, no budget re-selection), the
 * result is persisted as the dispatch snapshot, and every retry and receipt of
 * that dispatch reads the snapshot rather than the live coverage.
 *
 * Run: bun x vitest run --project unit test/group-context-dispatch-refine.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setGroupContextSettings } from '../src/services/group-context-settings-store.js';
import { upsertGroupContextMessage, _resetGroupContextStoreForTest } from '../src/services/group-context-store.js';
import {
  writePreparedGroupContext, bindGroupContextDelivery, bindGroupContextWorkerGeneration, confirmGroupContextNativeInput,
  readPreparedGroupContext, getDeliveredGroupContextSeqs, subtractCoveredGroupContextSources, planGroupContextDispatch,
  recordGroupContextDispatch, readGroupContextDeliveryReceipt, type PreparedGroupContext,
} from '../src/services/group-context-delivery-store.js';
import { groupContextEpoch, groupContextForPrompt, commitGroupContextDispatchIntoPayload } from '../src/services/group-context-prompt.js';
import { prepareGroupContextForTurn } from '../src/services/group-context-runtime.js';
import { buildBridgeInputContent, formatAttachmentsHint } from '../src/core/session-manager.js';
import { addCodexAppContext } from '../src/utils/codex-app-context.js';
import { writePromptContext, claimPromptContext, fingerprintPromptText, prefixOf } from '../src/services/prompt-context-store.js';

vi.mock('../src/im/lark/client.js', () => ({
  listChatMessagesUntil: vi.fn(async () => []),
  listThreadMessagesWithContext: vi.fn(async () => ({ messages: [], verifiedThread: false })),
  listMessagesByThreadId: vi.fn(async () => []),
  downloadMessageResource: vi.fn(async () => {}),
}));

const APP = 'cli_a';
const CHAT = 'oc_room';
const SESSION = 'sess';
const NATIVE = 'native_one';
// Retention prunes 1970 timestamps; anchor the fixture to now.
const T0 = Date.now() - 600_000;
let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'group-context-refine-'));
  vi.stubEnv('SESSION_DATA_DIR', dataDir);
  _resetGroupContextStoreForTest();
  await setGroupContextSettings(CHAT, { enabled: true }, dataDir);
});
afterEach(() => {
  _resetGroupContextStoreForTest();
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

function say(messageId: string, text: string, createTime: number, resourceRefs: Array<{ type: string; key: string; name?: string }> = []) {
  return upsertGroupContextMessage(APP, { messageId, chatId: CHAT, senderId: 'ou_user', senderType: 'user', senderName: 'u', msgType: 'text', text, createTime, resourceRefs, sourceAppId: APP, conversationScope: 'main' });
}

async function prepare(turnId: string, createTime: number, query = 'q') {
  const epoch = groupContextEpoch(SESSION, NATIVE, 'codex', turnId);
  const prepared = await prepareGroupContextForTurn({ appId: APP, chatId: CHAT, turnId, query, createTime, scope: 'main', sessionId: SESSION, epoch });
  return { prepared: prepared!, epoch };
}

/** The turn really crosses the delivery boundary with its frozen background
 * embedded, then the native input receipt lands. A receipt alone covers
 * nothing: coverage is exactly what the recorded dispatch carried. */
function consume(turnId: string, epoch: string, generation = 1) {
  const binding = { appId: APP, chatId: CHAT, turnId, sessionId: SESSION, epoch };
  bindGroupContextDelivery(binding, dataDir);
  const reserved = bindGroupContextWorkerGeneration(binding, generation, dataDir)!;
  const frozen = readPreparedGroupContext(APP, CHAT, turnId, dataDir, epoch)!;
  expect(commitGroupContextDispatchIntoPayload({ content: `prefix\n\n${frozen.body}\n\nq` }, reserved, dataDir)).toBeDefined();
  expect(confirmGroupContextNativeInput(reserved, { kind: 'codex_history_match' }, dataDir)).toBe(true);
}

function identity(turnId: string, epoch: string) {
  return { appId: APP, chatId: CHAT, turnId, sessionId: SESSION, epoch, workerGeneration: 1 };
}

/** The payload a daemon assembles: the frozen body embedded in a larger prompt. */
function payloadWith(body: string) {
  return { content: `<role>bot</role>\n\n${body}\n\n<user_message>hi</user_message>`, codexAppInput: { additionalContext: { botmux_group_history: { kind: 'untrusted' as const, value: body } } as Record<string, { kind: 'untrusted' | 'application'; value: string }> } };
}

describe('assembly keeps the frozen bundle', () => {
  it('delivers the frozen body during assembly even when sources are already covered', async () => {
    const a = say('om_a', 'first topic', T0 + 1_000);
    const b = say('om_b', 'second topic', T0 + 2_000);
    const first = await prepare('om_turn_1', T0 + 5_000);
    const second = await prepare('om_turn_2', T0 + 6_000);
    expect(second.prepared.includedSeqs).toEqual([a.seq, b.seq]);
    expect(second.prepared.sources?.map(source => source.seq)).toEqual([a.seq, b.seq]);
    consume('om_turn_1', first.epoch);
    const assembled = groupContextForPrompt({ ...identity('om_turn_2', second.epoch) }, dataDir)!;
    expect(assembled.body).toBe(second.prepared.body);
    expect(assembled.includedSeqs).toEqual([a.seq, b.seq]);
  });
});

describe('pure subtraction over the frozen bundle', () => {
  it('removes exactly the covered fragments and keeps every other frozen excerpt verbatim', async () => {
    const a = say('om_a', 'covered '.repeat(80), T0 + 1_000);
    const b = say('om_b', 'unconfirmed B '.repeat(80), T0 + 2_000);
    const c = say('om_c', 'unconfirmed C '.repeat(80), T0 + 3_000, [{ type: 'image', key: 'img_c' }]);
    await setGroupContextSettings(CHAT, { maxContextChars: 2_400 }, dataDir);
    const first = await prepare('om_turn_1', T0 + 5_000, 'covered');
    const second = await prepare('om_turn_2', T0 + 6_000, 'covered');
    expect(second.prepared.includedSeqs).toEqual([a.seq, b.seq, c.seq]);
    // The small budget forced excerpts; they must survive the subtraction untouched.
    expect(second.prepared.body).toContain('kind="excerpt"');
    consume('om_turn_1', first.epoch);
    const result = subtractCoveredGroupContextSources(second.prepared, new Set([a.seq]))!;
    expect(result.includedSeqs).toEqual([b.seq, c.seq]);
    for (const source of second.prepared.sources!.filter(source => source.seq !== a.seq)) expect(result.body).toContain(source.text);
    expect(result.body).not.toContain(second.prepared.sources!.find(source => source.seq === a.seq)!.text);
    // Header and policy are the frozen ones; nothing was re-rendered.
    expect(result.body.split('\n')[0]).toBe(second.prepared.body.split('\n')[0]);
    expect(result.body.length).toBe(second.prepared.body.length - second.prepared.sources!.find(source => source.seq === a.seq)!.text.length - 1);
    // A budget shrink after preparation changes nothing: the subtraction never re-selects.
    await setGroupContextSettings(CHAT, { maxContextChars: 1_000 }, dataDir);
    expect(subtractCoveredGroupContextSources(second.prepared, new Set([a.seq]))).toEqual(result);
  });

  it('never refills from the local store: a frozen [old, newest] bundle minus the covered one is just [newest]', async () => {
    say('om_needle', 'needle covered '.repeat(80), T0 + 10);
    const first = await prepare('om_turn_1', T0 + 5_000, 'needle');
    for (let n = 0; n < 8; n++) say(`om_old_${n}`, `old unconfirmed ${n} ${'x '.repeat(100)}`, T0 + n);
    const newest = say('om_new', 'newest unconfirmed '.repeat(80), T0 + 20);
    await setGroupContextSettings(CHAT, { maxContextChars: 1_400 }, dataDir);
    const second = await prepare('om_turn_2', T0 + 6_000, 'needle');
    expect(second.prepared.includedSeqs).toEqual([first.prepared.includedSeqs[0], newest.seq]);
    consume('om_turn_1', first.epoch);
    const payload = payloadWith(second.prepared.body);
    const committed = commitGroupContextDispatchIntoPayload(payload, identity('om_turn_2', second.epoch), dataDir)!.dispatched;
    expect(committed.includedSeqs).toEqual([newest.seq]);
    expect(committed.body).not.toContain('old unconfirmed');
    expect(committed.body).not.toContain('needle covered');
    expect(committed.body).toContain('newest unconfirmed');
  });

  it('leaves attachments of the remaining sources and drops those of covered ones', async () => {
    const a = say('om_a', 'first', T0 + 1_000, [{ type: 'image', key: 'img_a' }]);
    const b = say('om_b', 'second', T0 + 2_000, [{ type: 'image', key: 'img_b' }]);
    const epoch = groupContextEpoch(SESSION, NATIVE, 'codex', 'om_turn_2');
    const base = (await prepare('om_turn_x', T0 + 6_000)).prepared;
    const frozen: PreparedGroupContext = {
      ...base, turnId: 'om_turn_2', epoch,
      attachments: [
        { type: 'image', path: '/tmp/a.png', name: 'a.png', resourceKey: 'img_a' },
        { type: 'image', path: '/tmp/b.png', name: 'b.png', resourceKey: 'img_b' },
        { type: 'file', path: '/tmp/loose.txt', name: 'loose.txt' },
      ],
    };
    writePreparedGroupContext(frozen, dataDir);
    const result = subtractCoveredGroupContextSources(frozen, new Set([a.seq]))!;
    expect(result.includedSeqs).toEqual([b.seq]);
    expect(result.attachments?.map(attachment => attachment.name)).toEqual(['b.png', 'loose.txt']);
  });

  it('returns undefined for a legacy bundle without fragments, so the frozen body is delivered as is', () => {
    const epoch = groupContextEpoch(SESSION, NATIVE, 'codex', 'om_legacy');
    const legacy: PreparedGroupContext = { appId: APP, chatId: CHAT, turnId: 'om_legacy', createdAt: Date.now(), body: 'FROZEN', includedSeqs: [7], throughSeq: 7, incomplete: false, epoch };
    expect(subtractCoveredGroupContextSources(legacy, new Set([7]))).toBeUndefined();
    writePreparedGroupContext(legacy, dataDir);
    // Unbound rows fail closed; a bound legacy row dispatches verbatim.
    expect(planGroupContextDispatch(identity('om_legacy', epoch), dataDir)).toBeUndefined();
    bindGroupContextDelivery(identity('om_legacy', epoch), dataDir);
    const plan = planGroupContextDispatch(identity('om_legacy', epoch), dataDir)!;
    expect(plan.recorded).toBe(false);
    expect(plan.dispatch).toMatchObject({ body: 'FROZEN', includedSeqs: [7] });
    expect(recordGroupContextDispatch(identity('om_legacy', epoch), plan.dispatch, dataDir)).toMatchObject({ body: 'FROZEN', includedSeqs: [7] });
    expect(planGroupContextDispatch(identity('om_legacy', epoch), dataDir)?.recorded).toBe(true);
  });
});

describe('dispatch boundary commit', () => {
  it('rewrites the embedded body once, covers exactly the dispatched sources, and keeps retries identical', async () => {
    const a = say('om_a', 'first topic', T0 + 1_000);
    const b = say('om_b', 'second topic', T0 + 2_000);
    const c = say('om_c', 'third topic', T0 + 3_000);
    const first = await prepare('om_turn_1', T0 + 5_000);
    const second = await prepare('om_turn_2', T0 + 6_000);
    expect(second.prepared.includedSeqs).toEqual([a.seq, b.seq, c.seq]);
    // Assembled and queued with the frozen body; the previous input's receipt lands meanwhile.
    const payload = payloadWith(second.prepared.body);
    consume('om_turn_1', first.epoch);
    // The real dispatch subtracts the covered sources from the payload in place.
    const committed = commitGroupContextDispatchIntoPayload(payload, identity('om_turn_2', second.epoch), dataDir)!;
    expect(committed.replaced).toBe(2);
    expect(committed.dispatched.includedSeqs).toEqual([]);
    expect(committed.dispatched.body).toBe('');
    // An emptied background is omitted, not sent as a wrapper, on every transport.
    expect(payload.content).not.toContain('first topic');
    expect(payload.content).not.toContain('<shared_group_context');
    expect(payload.content).toBe('<role>bot</role>\n\n<user_message>hi</user_message>');
    expect('botmux_group_history' in payload.codexAppInput.additionalContext).toBe(false);
    expect(readGroupContextDeliveryReceipt(APP, CHAT, 'om_turn_2', dataDir, second.epoch)?.dispatchedAt).toBeTypeOf('number');
    // The stored frozen bundle is untouched; assembly for a rebuild now yields the snapshot.
    expect(readPreparedGroupContext(APP, CHAT, 'om_turn_2', dataDir, second.epoch)!.includedSeqs).toEqual([a.seq, b.seq, c.seq]);
    expect(groupContextForPrompt(identity('om_turn_2', second.epoch), dataDir)!.includedSeqs).toEqual([]);
    // A retry of the same dispatch carries exactly the committed content.
    const retry = payloadWith(second.prepared.body);
    const again = commitGroupContextDispatchIntoPayload(retry, identity('om_turn_2', second.epoch), dataDir)!;
    expect(retry.content).toBe(payload.content);
    expect(again.dispatched.body).toBe(committed.dispatched.body);
    // The receipt of this dispatch covers only what was dispatched (here nothing new).
    expect(confirmGroupContextNativeInput(identity('om_turn_2', second.epoch), { kind: 'codex_history_match' }, dataDir)).toBe(true);
    expect(getDeliveredGroupContextSeqs(APP, CHAT, SESSION, second.epoch, dataDir)).toEqual([a.seq, b.seq, c.seq]);
  });

  it('does not change a dispatched snapshot when coverage grows afterwards', async () => {
    const a = say('om_a', 'first topic', T0 + 1_000);
    const first = await prepare('om_turn_1', T0 + 5_000);
    const b = say('om_b', 'second topic', T0 + 5_500);
    const second = await prepare('om_turn_2', T0 + 6_000);
    const third = await prepare('om_turn_3', T0 + 7_000);
    expect(second.prepared.includedSeqs).toEqual([a.seq, b.seq]);
    // Turn 2 is dispatched before anything is covered: the snapshot is the frozen bundle.
    const payload = payloadWith(second.prepared.body);
    const committed = commitGroupContextDispatchIntoPayload(payload, identity('om_turn_2', second.epoch), dataDir)!;
    expect(committed.replaced).toBe(0);
    expect(committed.dispatched.includedSeqs).toEqual([a.seq, b.seq]);
    // Later, turn 1's receipt covers `a`. Turn 2's retry must still carry `a`.
    consume('om_turn_1', first.epoch);
    const retry = payloadWith(second.prepared.body);
    const again = commitGroupContextDispatchIntoPayload(retry, identity('om_turn_2', second.epoch), dataDir)!;
    expect(again.dispatched.includedSeqs).toEqual([a.seq, b.seq]);
    expect(retry.content).toContain('first topic');
    expect(retry.content).toBe(payload.content);
    // Turn 3, not yet dispatched, subtracts both `a` (turn 1) and, once turn 2 is consumed, `b`.
    expect(confirmGroupContextNativeInput(identity('om_turn_2', second.epoch), { kind: 'codex_history_match' }, dataDir)).toBe(true);
    const late = payloadWith(third.prepared.body);
    const lateCommit = commitGroupContextDispatchIntoPayload(late, identity('om_turn_3', third.epoch), dataDir)!;
    expect(lateCommit.dispatched.includedSeqs).toEqual([]);
    expect(late.content).not.toContain('second topic');
  });

  it('leaves the payload untouched when the frozen body is not embedded verbatim, and fails closed without a binding match', async () => {
    const a = say('om_a', 'first topic', T0 + 1_000);
    const first = await prepare('om_turn_1', T0 + 5_000);
    const second = await prepare('om_turn_2', T0 + 6_000);
    consume('om_turn_1', first.epoch);
    const payload = { content: 'no background here' };
    // Nothing located → nothing recorded, nothing bound, and a later receipt covers nothing.
    expect(commitGroupContextDispatchIntoPayload(payload, identity('om_turn_2', second.epoch), dataDir)).toBeUndefined();
    expect(payload.content).toBe('no background here');
    expect(readGroupContextDeliveryReceipt(APP, CHAT, 'om_turn_2', dataDir, second.epoch)?.dispatchedAt).toBeUndefined();
    bindGroupContextDelivery(identity('om_turn_2', second.epoch), dataDir);
    expect(confirmGroupContextNativeInput(identity('om_turn_2', second.epoch), { kind: 'codex_history_match' }, dataDir)).toBe(true);
    expect(getDeliveredGroupContextSeqs(APP, CHAT, SESSION, second.epoch, dataDir)).toEqual([a.seq]);
    // A different consumer session cannot commit or read this turn's dispatch.
    const other = { content: second.prepared.body };
    expect(commitGroupContextDispatchIntoPayload(other, { ...identity('om_turn_2', second.epoch), sessionId: 'other' }, dataDir)).toBeUndefined();
    expect(other.content).toBe(second.prepared.body);
  });
});

describe('dispatch boundary: attachments and transports', () => {
  it('removes background attachments of dropped sources from every transport and omits the emptied block', async () => {
    const a = say('om_a', 'an image was shared '.repeat(60), T0 + 1_000, [{ type: 'image', key: 'img_a' }]);
    const frozenA = await prepare('om_turn_1', T0 + 5_000);
    const epoch2 = groupContextEpoch(SESSION, NATIVE, 'codex', 'om_turn_2');
    // The follow-up bundle carries the same source and its downloaded attachment.
    const base = (await prepare('om_turn_x', T0 + 6_000)).prepared;
    const attachment = { type: 'image' as const, path: '/tmp/old-context.png', name: 'old-context.png', resourceKey: 'img_a' };
    const frozen = writePreparedGroupContext({ ...base, turnId: 'om_turn_2', epoch: epoch2, attachments: [attachment] }, dataDir);
    expect(frozen.body.length).toBeGreaterThan(900); // forces Codex context chunking
    const current = { type: 'image' as const, path: '/tmp/current-user.png', name: 'current-user.png', resourceKey: 'img_now' };
    // Assembled exactly as the daemon does: bridge prose + Codex App sidecar (chunked), attachments merged with the user's own.
    const payload = {
      content: buildBridgeInputContent('inspect current task', { sharedGroupContext: frozen.body, attachments: [current, attachment] }),
      codexAppInput: { additionalContext: {} as Record<string, { kind: 'untrusted' | 'application'; value: string }>, localImages: [{ path: current.path }, { path: attachment.path }] },
    };
    addCodexAppContext(payload.codexAppInput.additionalContext, 'botmux_group_history', frozen.body, 'untrusted');
    addCodexAppContext(payload.codexAppInput.additionalContext, 'botmux_attachments', formatAttachmentsHint([current, attachment]), 'untrusted');
    expect(Object.keys(payload.codexAppInput.additionalContext).filter(key => key.startsWith('botmux_group_history_')).length).toBeGreaterThan(1);
    consume('om_turn_1', frozenA.epoch);
    const committed = commitGroupContextDispatchIntoPayload(payload, identity('om_turn_2', epoch2), dataDir)!;
    expect(committed.dispatched.includedSeqs).toEqual([]);
    expect(committed.dispatched.attachments).toBeUndefined();
    // Prose: no background block, no background attachment line, the user's own attachment kept.
    expect(payload.content).not.toContain('<shared_group_context');
    expect(payload.content).not.toContain(attachment.path);
    expect(payload.content).toContain(current.path);
    expect(payload.content).toContain('inspect current task');
    // Codex App sidecar: history chunks gone, attachment hint rewritten, local images filtered.
    expect(Object.keys(payload.codexAppInput.additionalContext).some(key => key.startsWith('botmux_group_history'))).toBe(false);
    const hint = Object.keys(payload.codexAppInput.additionalContext).filter(key => key.startsWith('botmux_attachments')).sort().map(key => payload.codexAppInput.additionalContext[key].value).join('');
    expect(hint).toContain(current.path);
    expect(hint).not.toContain(attachment.path);
    expect(payload.codexAppInput.localImages).toEqual([{ path: current.path }]);
    expect(a.seq).toBeGreaterThan(0);
  });

  it('removes the whole attachment hint when only background attachments were listed', async () => {
    const a = say('om_a', 'an image was shared', T0 + 1_000, [{ type: 'image', key: 'img_a' }]);
    const frozenA = await prepare('om_turn_1', T0 + 5_000);
    const epoch2 = groupContextEpoch(SESSION, NATIVE, 'codex', 'om_turn_2');
    const base = (await prepare('om_turn_x', T0 + 6_000)).prepared;
    const attachment = { type: 'image' as const, path: '/tmp/old-context.png', name: 'old-context.png', resourceKey: 'img_a' };
    const frozen = writePreparedGroupContext({ ...base, turnId: 'om_turn_2', epoch: epoch2, attachments: [attachment] }, dataDir);
    const payload = { content: `${frozen.body}\n\n<user_message>q</user_message>\n\n${formatAttachmentsHint([attachment])}` };
    consume('om_turn_1', frozenA.epoch);
    expect(commitGroupContextDispatchIntoPayload(payload, identity('om_turn_2', epoch2), dataDir)!.dispatched.includedSeqs).toEqual([]);
    expect(payload.content).toBe('<user_message>q</user_message>\n\n');
    expect(a.seq).toBeGreaterThan(0);
  });

  it('keeps the Claude hook sidecar claimable by the final PTY text after the background is subtracted', async () => {
    const a = say('om_a', 'already read background', T0 + 1_000);
    const first = await prepare('om_turn_1', T0 + 5_000);
    const second = await prepare('om_turn_2', T0 + 6_000);
    expect(second.prepared.includedSeqs).toEqual([a.seq]);
    // The builder (hook injection mode) writes the sidecar keyed by the assembled PTY text.
    const assembled = `${second.prepared.body}\n\n<user_message>current user task</user_message>`;
    const envelope = '<botmux_reminder>r</botmux_reminder>\n<sender name="Alice"/>';
    writePromptContext(SESSION, 'om_turn_2', assembled, envelope);
    const payload = { content: assembled };
    consume('om_turn_1', first.epoch);
    // Real dispatch subtracts the covered background and rewrites the PTY text.
    const committed = commitGroupContextDispatchIntoPayload(payload, identity('om_turn_2', second.epoch), dataDir)!;
    expect(committed.dispatched.includedSeqs).toEqual([]);
    expect(payload.content).toBe('<user_message>current user task</user_message>');
    // The hook fingerprints what the CLI actually received: the claim must still succeed, once.
    expect(claimPromptContext(SESSION, 'om_turn_2', fingerprintPromptText(assembled), prefixOf(assembled))).toBeUndefined();
    expect(claimPromptContext(SESSION, 'om_turn_2', fingerprintPromptText(payload.content), prefixOf(payload.content))).toBe(envelope);
    expect(claimPromptContext(SESSION, 'om_turn_2', fingerprintPromptText(payload.content), prefixOf(payload.content))).toBeUndefined();
  });
});
