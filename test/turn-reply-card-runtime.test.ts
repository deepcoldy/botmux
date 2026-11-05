import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonSession } from '../src/core/types.js';
import { config } from '../src/config.js';
import { getBot } from '../src/bot-registry.js';
import { replyCardModeFor, updateTurnReplyCard, settleTurnReplyCards, supersedeTurnReplyCard, sweepInterruptedReplyCards, queueTurnReplyTools, flushTurnReplyTools } from '../src/core/turn-reply-card.js';
import { MessageWithdrawnError, updateMessage, uploadFile, replyMessage, sendMessage } from '../src/im/lark/client.js';
import { observePublishedGroupMessage } from '../src/services/group-context-runtime.js';
import { TurnReplyCardStore } from '../src/services/turn-reply-card.js';
import { writeRoleReplyPrivately } from '../src/core/role-resolver.js';
import type { CotEntry } from '../src/types.js';
import { buildTurnReplyCard, replyCardPresentation } from '../src/im/lark/turn-reply-card.js';
import { bindGroupContextDelivery, writePreparedGroupContext } from '../src/services/group-context-delivery-store.js';
import { groupContextEpoch } from '../src/services/group-context-prompt.js';
import { readGroupContextAuthorOrigin } from '../src/services/group-context-publication.js';
import { piBridgeSpec } from '../src/adapters/cli/pi.js';
import { traexBridgeSpec } from '../src/adapters/cli/traex.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { PI_TURN_BOUNDARY_CUSTOM_TYPE } from '../src/adapters/cli/pi-turn-boundary-extension.js';

vi.mock('../src/config.js', () => ({ config: { session: { dataDir: '' } } }));
vi.mock('../src/core/cost-calculator.js', () => ({ getSessionUsageSnapshot: vi.fn(() => ({ context: null, tokens: null })) }));
vi.mock('../src/im/lark/card-handler.js', () => ({ resolveCardOperatorUnionId: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({ getBot: vi.fn(), normalizeUsageDisplay: () => 'off' }));
vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}), uploadFile: vi.fn(), replyMessage: vi.fn(), sendMessage: vi.fn(),
  MessageWithdrawnError: class extends Error {},
}));
vi.mock('../src/i18n/index.js', () => ({ localeForBot: () => 'zh', t: (key: string) => key }));
vi.mock('../src/services/group-context-runtime.js', () => ({ observePublishedGroupMessage: vi.fn() }));

function session(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    larkAppId: 'app_mode', chatId: 'oc_mode', scope: 'thread', currentTurnId: 'om_mode',
    session: { sessionId: 'sid_mode', chatId: 'oc_mode', rootMessageId: 'om_root', status: 'active', cliId: 'claude-code', backendType: 'tmux', workerGeneration: 1 },
    ...overrides,
  } as DaemonSession;
}

describe('reply-card runtime eligibility and recovery', () => {
  let dir: string;
  let bot: ReturnType<typeof getBot>;
  beforeEach(() => {
    vi.stubEnv('BOTMUX_SANDBOX', undefined);
    dir = mkdtempSync(join(tmpdir(), 'botmux-reply-runtime-'));
    config.session.dataDir = dir;
    bot = { config: { larkAppId: 'app_mode', cliId: 'claude-code', replyCardMode: 'unified' } } as ReturnType<typeof getBot>;
    vi.mocked(getBot).mockReturnValue(bot);
    vi.mocked(updateMessage).mockReset();
    vi.mocked(observePublishedGroupMessage).mockClear();
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

  it.each(['oc_mode', 'om_root'])('recovers a failed overflow with stable delivery identity for root %s', async rootId => {
    const store = new TurnReplyCardStore(dir);
    const key = { larkAppId: 'app_mode', sessionId: 'sid_mode', turnId: 'om_mode' };
    await store.prepare(key, { mode: 'unified', chatId: 'oc_mode', rootId });
    const io = {
      render: (record: Parameters<typeof buildTurnReplyCard>[0]) => buildTurnReplyCard(record, { canStop: true }),
      beforeEffect: vi.fn(), isWithdrawn: () => false,
      send: vi.fn(async () => 'om_reply'), patch: vi.fn(async () => {}),
      sendOverflow: vi.fn(async () => { throw new Error('upload unavailable'); }),
    };
    await store.update(key, { kind: 'start' }, io);
    await store.update(key, { kind: 'progress', text: 'Long process '.repeat(600) }, io);
    await expect(store.update(key, { kind: 'terminal', phase: 'completed' }, io)).rejects.toThrow('upload unavailable');
    const record = store.read(key)!;
    record.createdAtMs = record.updatedAtMs = 1;
    writeFileSync(join(store.directory, `${store.id(key)}.json`), JSON.stringify(record));
    vi.mocked(uploadFile).mockReset().mockResolvedValue('file_recovered');
    vi.mocked(replyMessage).mockReset();
    vi.mocked(sendMessage).mockReset();
    const files = new Set<string>();
    let first = true;
    const deliver = async (uuid: string) => {
      files.add(uuid);
      if (first) {
        first = false;
        throw new Error('attachment ACK lost');
      }
      return 'om_file_recovered';
    };
    vi.mocked(replyMessage).mockImplementation(async (_app, _root, _content, _type, _thread, uuid) => deliver(uuid!));
    vi.mocked(sendMessage).mockImplementation(async (_app, _chat, _content, _type, uuid) => deliver(uuid!));
    vi.mocked(updateMessage).mockRejectedValueOnce(new Error('PATCH unavailable'));
    const restartSweep = async () => {
      // Each retry models another daemon start, after the failed attempt.
      const persisted = store.read(key)!;
      persisted.updatedAtMs = 1;
      writeFileSync(join(store.directory, `${store.id(key)}.json`), JSON.stringify(persisted));
      await sweepInterruptedReplyCards(key.larkAppId);
    };
    await restartSweep();
    expect(store.read(key)?.publishPending).toBe(true);
    await restartSweep();
    expect(store.read(key)).toMatchObject({ phase: 'completed', overflowMessageId: 'om_file_recovered', pendingPatch: { final: false } });
    await restartSweep();
    expect(store.read(key)?.publishPending).toBeUndefined();
    expect(store.read(key)?.pendingPatch).toBeUndefined();
    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(files.size).toBe(1);
    expect(rootId === 'oc_mode' ? sendMessage : replyMessage).toHaveBeenCalledTimes(2);
    expect(rootId === 'oc_mode' ? replyMessage : sendMessage).not.toHaveBeenCalled();
    expect(io.send).toHaveBeenCalledTimes(1);
  });

  it.each(['completed', 'failed', 'cancelled', 'ambiguous', 'superseded'] as const)(
    'startup retries an unacknowledged %s PATCH and preserves its terminal facts', async phase => {
      const ds = session();
      const store = new TurnReplyCardStore(dir);
      const key = { larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_mode' };
      await store.prepare(key, { mode: 'unified', chatId: ds.chatId, rootId: ds.session.rootMessageId });
      const io = {
        render: (record: Parameters<typeof buildTurnReplyCard>[0]) => buildTurnReplyCard(record, { canStop: true }),
        beforeEffect: vi.fn(), isWithdrawn: () => false,
        send: vi.fn(async () => 'om_reply'), patch: vi.fn(async () => {}),
      };
      await store.update(key, { kind: 'start' }, io);
      io.patch.mockRejectedValueOnce(new Error('PATCH unavailable'));
      await expect(store.update(key, { kind: 'terminal', phase, durationMs: 1234 }, io)).rejects.toThrow();
      const record = store.read(key)!;
      record.createdAtMs = record.updatedAtMs = 1;
      writeFileSync(join(store.directory, `${store.id(key)}.json`), JSON.stringify(record));

      bot.config.apiOnly = true;
      await sweepInterruptedReplyCards(ds.larkAppId);
      expect(updateMessage).not.toHaveBeenCalled();
      expect(store.read(key)?.pendingPatch).toEqual(record.pendingPatch);
      bot.config.apiOnly = false;
      await sweepInterruptedReplyCards('other_app');
      expect(updateMessage).not.toHaveBeenCalled();
      vi.mocked(updateMessage).mockRejectedValueOnce(new Error('provider unavailable'));
      await sweepInterruptedReplyCards(ds.larkAppId);
      expect(store.read(key)?.pendingPatch).toEqual(record.pendingPatch);
      await sweepInterruptedReplyCards(ds.larkAppId);
      expect(updateMessage).toHaveBeenLastCalledWith(ds.larkAppId, 'om_reply', record.pendingPatch!.content,
        { returnAcknowledgement: true });
      expect(store.read(key)).toMatchObject({ phase, durationMs: 1234, lastCard: record.pendingPatch!.content });
      expect(store.read(key)?.pendingPatch).toBeUndefined();
      expect(io.send).toHaveBeenCalledTimes(1);
      const calls = vi.mocked(updateMessage).mock.calls.length;
      await sweepInterruptedReplyCards(ds.larkAppId);
      expect(updateMessage).toHaveBeenCalledTimes(calls);
    },
  );

  describe.each(['traex', 'pi'] as const)('%s transcript to reply card', cliId => {
    function harness() {
      const ds = session();
      ds.session.cliId = cliId;
      const now = Date.now();
      const path = join(dir, '2026-11-03_deadbeef-1234-4678-9abc-def012345679.jsonl');
      writeFileSync(path, '');
      const spec = cliId === 'pi' ? piBridgeSpec : traexBridgeSpec;
      const queue = new CodexBridgeQueue(() => now);
      let sent = 0;
      const send = vi.fn(async () => `om_reply_${++sent}`);
      const pending: Promise<unknown>[] = [];
      const activity = new Map<string, CotEntry[]>();
      queue.setCotObserver((entries, turn) => {
        const cumulative = [...(activity.get(turn.turnId) ?? []), ...entries];
        activity.set(turn.turnId, cumulative);
        queueTurnReplyTools(ds, { turnId: turn.turnId, entries: cumulative }, send, () => true);
      });
      queue.setCotSupersededObserver(turn => {
        pending.push(supersedeTurnReplyCard(ds, turn, send, () => true));
      });
      const stamp = { timestamp: new Date(now).toISOString() };
      let offset = 0;
      function append(...records: object[]) {
        appendFileSync(path, records.map(record => JSON.stringify({ ...stamp, ...record })).join('\n') + '\n');
      }
      function user(text: string) {
        return cliId === 'pi'
          ? { type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } }
          : { type: 'history_mutation', payload: { operation: 'append', turn_id: 'native_turn', items: [],
            display_completions: [{ thread_id: 'deadbeef-1234-4678-9abc-def012345679', turn_id: 'native_turn',
              item: { type: 'UserMessage', id: `input-${text}`, content: [{ type: 'text', text }] } }] } };
      }
      function terminal(text: string, status: 'completed' | 'failed' | 'ambiguous' = 'completed') {
        if (cliId === 'pi') {
          const stopReason = { completed: 'stop', failed: 'error', ambiguous: 'aborted' }[status];
          return { type: 'message', message: { role: 'assistant', stopReason,
            content: [{ type: 'text', text }], ...(status === 'failed' ? { errorMessage: text } : {}) } };
        }
        return { type: 'event_msg', payload: { type: status === 'ambiguous' ? 'turn_aborted' : 'task_complete',
          turn_id: 'native_turn', last_agent_message: text,
          ...(status === 'failed' ? { error: { message: text } } : {}) } };
      }
      async function poll() {
        const drained = spec.drain(path, offset, { adoptMode: false, state: undefined });
        offset = drained.newOffset;
        queue.ingest(drained.events);
        await Promise.all(pending.splice(0));
        for (const turnId of activity.keys()) await flushTurnReplyTools(ds, turnId);
        return queue.drainEmittable();
      }
      return { ds, now, path, queue, send, append, user, terminal, poll,
        store: new TurnReplyCardStore(dir),
        key: { larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: ds.currentTurnId! } };
    }

    it.each(['thread', 'chat'] as const)('publishes tools and explicit final once in %s scope', async scope => {
      const h = harness();
      h.ds.scope = scope;
      h.ds.session.scope = scope;
      h.queue.mark(h.key.turnId, 'inspect files', h.now);
      await updateTurnReplyCard(h.ds, h.key.turnId, { kind: 'start' }, h.send);
      h.append(h.user('inspect files'));
      if (cliId === 'pi') {
        h.append({ type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: [
          { type: 'thinking', thinking: 'Inspect the repository' },
          { type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'README.md' } },
        ] } }, { type: 'message', message: { role: 'toolResult', toolCallId: 'read',
          content: [{ type: 'text', text: 'Project documentation' }] } });
      } else {
        h.append({ type: 'history_mutation', payload: { operation: 'append', turn_id: 'native_turn', items: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Inspect the repository' }] },
          { type: 'function_call', call_id: 'read', name: 'read', arguments: '{"path":"README.md"}' },
          { type: 'function_call_output', call_id: 'read', output: 'Project documentation' },
        ] } });
      }
      expect(await h.poll()).toEqual([]);
      expect(h.store.read(h.key)).toMatchObject({ phase: 'working',
        tools: [{ id: 'read', completed: true, result: 'Project documentation' }] });
      const card = (text: string) => JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: text }] } });
      await updateTurnReplyCard(h.ds, h.key.turnId, { kind: 'final', text: 'Explicit answer',
        card: card('Explicit answer'), source: 'explicit' }, h.send);
      h.append(h.terminal('Transcript fallback'));
      const [turn] = await h.poll();
      expect(turn).toMatchObject({ turnId: h.key.turnId, finalText: 'Transcript fallback' });
      expect(turn.terminalStatus ?? 'completed').toBe('completed');
      await updateTurnReplyCard(h.ds, turn.turnId, { kind: 'final', text: turn.finalText!,
        card: card(turn.finalText!), source: 'bridge' }, h.send);
      await updateTurnReplyCard(h.ds, turn.turnId, { kind: 'terminal', phase: 'completed' }, h.send);
      expect(h.store.read(h.key)).toMatchObject({ phase: 'completed', finalText: 'Explicit answer', finalSource: 'explicit' });
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(vi.mocked(updateMessage).mock.calls.every(call => call[1] === 'om_reply_1')).toBe(true);
      expect(await h.poll()).toEqual([]);
    });

    it.each(['failed', 'ambiguous'] as const)('settles native %s without creating another card', async status => {
      const h = harness();
      h.queue.mark(h.key.turnId, 'inspect files', h.now);
      await updateTurnReplyCard(h.ds, h.key.turnId, { kind: 'start' }, h.send);
      h.append(h.user('inspect files'), h.terminal('provider unavailable', status));
      if (cliId === 'pi' && status === 'failed') {
        expect(await h.poll()).toEqual([]);
        expect(h.store.read(h.key)?.phase).toBe('working');
        h.append({ type: 'custom', customType: PI_TURN_BOUNDARY_CUSTOM_TYPE, data: { lastStopReason: 'error' } });
      }
      const [turn] = await h.poll();
      expect(turn).toMatchObject({ turnId: h.key.turnId, terminalStatus: status });
      await updateTurnReplyCard(h.ds, turn.turnId, { kind: 'terminal', phase: turn.terminalStatus! }, h.send);
      expect(h.store.read(h.key)).toMatchObject({ phase: status, messageId: 'om_reply_1' });
      expect(h.send).toHaveBeenCalledTimes(1);
    });

    if (cliId === 'pi') it('keeps a retriable provider error working until the successful retry finishes', async () => {
      const h = harness();
      h.queue.mark(h.key.turnId, 'inspect files', h.now);
      await updateTurnReplyCard(h.ds, h.key.turnId, { kind: 'start' }, h.send);
      h.append(h.user('inspect files'), h.terminal('temporary error', 'failed'));
      expect(await h.poll()).toEqual([]);
      expect(h.store.read(h.key)?.phase).toBe('working');
      h.append({ type: 'message', message: { role: 'assistant', stopReason: 'toolUse',
        content: [{ type: 'text', text: 'Retrying the request' }] } });
      expect(await h.poll()).toEqual([]);
      expect(h.store.read(h.key)?.phase).toBe('working');
      h.append(h.terminal('Recovered answer'));
      const [turn] = await h.poll();
      expect(turn).toMatchObject({ turnId: h.key.turnId, finalText: 'Recovered answer' });
      expect(turn.terminalStatus ?? 'completed').toBe('completed');
      await updateTurnReplyCard(h.ds, turn.turnId, { kind: 'final', source: 'bridge', text: turn.finalText!,
        card: '{"schema":"2.0","body":{"elements":[{"tag":"markdown","content":"Recovered answer"}]}}' }, h.send);
      await updateTurnReplyCard(h.ds, turn.turnId, { kind: 'terminal', phase: 'completed' }, h.send);
      expect(h.store.read(h.key)).toMatchObject({ phase: 'completed', finalText: 'Recovered answer' });
      expect(h.send).toHaveBeenCalledTimes(1);
    });

    it('retires a steered turn before the successor receives its final', async () => {
      const h = harness();
      h.queue.mark(h.key.turnId, 'first input', h.now);
      await updateTurnReplyCard(h.ds, h.key.turnId, { kind: 'start' }, h.send);
      h.append(h.user('first input'));
      expect(await h.poll()).toEqual([]);
      h.queue.mark('om_successor', 'second input', h.now);
      await updateTurnReplyCard(h.ds, 'om_successor', { kind: 'start' }, h.send);
      h.append(h.user('second input'), h.terminal('Successor answer'));
      const [turn] = await h.poll();
      expect(turn).toMatchObject({ turnId: 'om_successor', finalText: 'Successor answer' });
      expect(h.store.read(h.key)).toMatchObject({ phase: 'superseded', messageId: 'om_reply_1' });
      await updateTurnReplyCard(h.ds, turn.turnId, { kind: 'final', source: 'bridge', text: turn.finalText!,
        card: '{"schema":"2.0","body":{"elements":[{"tag":"markdown","content":"Successor answer"}]}}' }, h.send);
      expect(h.store.read({ ...h.key, turnId: 'om_successor' })).toMatchObject({
        finalText: 'Successor answer', messageId: 'om_reply_2',
      });
      expect(h.store.read(h.key)?.finalText).toBeUndefined();
      expect(h.send).toHaveBeenCalledTimes(2);
    });
  });

  it.each((['traex', 'pi'] as const).flatMap(cliId => [
    'legacy', 'api-only', 'adopt', 'headless', 'remote', 'document', 'vc', 'scheduled', 'non-lark',
  ].map(entry => ({ cliId, entry }))))('keeps $cliId $entry on the established path', ({ cliId, entry }) => {
    const ds = session();
    ds.session.cliId = cliId;
    if (entry === 'legacy') bot.config.replyCardMode = 'legacy';
    if (entry === 'api-only') bot.config.apiOnly = true;
    if (entry === 'adopt') ds.session.adoptedFrom = {} as NonNullable<typeof ds.session.adoptedFrom>;
    if (entry === 'headless') ds.session.headless = { id: 'headless-test', createdAt: new Date().toISOString(), source: 'cli' };
    if (entry === 'remote') ds.session.backendType = 'riff';
    if (entry === 'document') { ds.scope = 'chat'; ds.chatId = 'doc:document'; }
    if (entry === 'vc') ds.session.vcMeetingReceiver = {
      listenerAppId: ds.larkAppId, meetingId: 'meeting-test', memberId: 'member-test', memberEpoch: 1,
    };
    if (entry === 'scheduled') ds.currentTurnId = 'schedule:test';
    if (entry === 'non-lark') ds.chatId = 'discord:channel';
    expect(replyCardModeFor(ds)).toBe('legacy');
    expect(existsSync(new TurnReplyCardStore(dir).directory)).toBe(false);
  });

  it.each((['grok', 'traex', 'pi'] as const).flatMap(cliId =>
    (['completed', 'failed', 'cancelled', 'ambiguous', 'superseded'] as const).map(phase => ({ cliId, phase })),
  ))('settles $cliId as $phase and isolates later turns', async ({ cliId, phase }) => {
    const ds = session();
    ds.session.cliId = cliId;
    let sends = 0;
    const send = vi.fn(async () => `om_reply_${++sends}`);
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'start' }, send);
    queueTurnReplyTools(ds, { turnId: 'om_mode', entries: [
      { kind: 'text', text: 'Inspecting the project.' },
      { kind: 'tool_call', id: 'read', name: 'Read', args: '{}', subject: 'README.md' },
      { kind: 'tool_result', id: 'read', result: 'Project documentation' },
    ] }, send, () => true);
    await flushTurnReplyTools(ds, 'om_mode');
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'terminal', phase }, send);
    const store = new TurnReplyCardStore(dir);
    const key = { larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_mode' };
    expect(store.read(key)).toMatchObject({ phase, messageId: 'om_reply_1' });
    expect(store.read(key)?.tools).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateMessage).mock.calls.every(call => call[1] === 'om_reply_1')).toBe(true);
    await updateTurnReplyCard(ds, 'om_next', { kind: 'start' }, send);
    const nextBefore = store.read({ ...key, turnId: 'om_next' });
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'tools', tools: [], activity: [] }, send);
    expect(store.read(key)?.phase).toBe(phase);
    expect(store.read({ ...key, turnId: 'om_next' })).toEqual(nextBefore);
    expect(nextBefore).toMatchObject({ phase: 'working', messageId: 'om_reply_2' });
  });

  it.each([['grok', 'opencode', 'unified'], ['opencode', 'grok', 'legacy'],
    ['traex', 'opencode', 'unified'], ['opencode', 'traex', 'legacy'],
    ['pi', 'opencode', 'unified'], ['opencode', 'pi', 'legacy']] as const)(
    'uses frozen %s rather than stale %s for reply-card admission', (frozen, stale, expected) => {
      const ds = session();
      ds.session.cliId = stale;
      ds.session.cliLaunchSnapshot = {
        version: 1, state: 'resolved', entryId: 'fixture', cliId: frozen, cliRuntime: null,
        cliPathOverride: null, wrapperCli: null, model: null, reasoningEffort: null, launchShell: null, startupCommands: [],
      };
      expect(replyCardModeFor(ds)).toBe(expected);
    },
  );

  it.each(['grok', 'traex', 'pi'] as const)('preserves a superseded %s card across disconnect and startup recovery', async cliId => {
    const ds = session();
    ds.session.cliId = cliId;
    const send = vi.fn(async () => 'om_reply');
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'start' }, send);
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'terminal', phase: 'superseded' }, send);
    const store = new TurnReplyCardStore(dir);
    const key = { larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_mode' };
    const record = store.read(key)!;
    // Simulate a persisted card from before this daemon started.
    record.createdAtMs = record.updatedAtMs = 1;
    writeFileSync(join(store.directory, `${store.id(key)}.json`), JSON.stringify(record));
    vi.mocked(updateMessage).mockClear();
    await settleTurnReplyCards(ds);
    await sweepInterruptedReplyCards(ds.larkAppId);
    expect(store.read(key)).toEqual(record);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('retires only a visible persisted final-only card on supersede (visible=%s)', async visible => {
    const ds = session();
    ds.session.cliId = 'grok';
    new TurnReplyCardStore(dir).prepareSync({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_mode' }, {
      mode: 'final-only', chatId: ds.chatId, rootId: ds.session.rootMessageId,
    });
    const send = vi.fn(async () => 'om_reply');
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'start' }, send, { forceVisible: visible });
    await supersedeTurnReplyCard(ds, { turnId: 'om_mode' }, send, () => true);
    expect(send).toHaveBeenCalledTimes(visible ? 1 : 0);
    if (visible) expect(vi.mocked(updateMessage).mock.calls.at(-1)?.[2]).toContain('已由后续消息接续');
    else expect(updateMessage).not.toHaveBeenCalled();
  });

  it.each(['unified', 'final-only'] as const)('silently retires an unshown %s turn before delayed activity starts', async mode => {
    const ds = session();
    ds.session.cliId = 'grok';
    ds.replyCardRunningTurnId = 'om_mode';
    const store = new TurnReplyCardStore(dir);
    const key = { larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_mode' };
    store.prepareSync(key, { mode, chatId: ds.chatId, rootId: ds.session.rootMessageId });
    const send = vi.fn(async () => 'om_reply');
    queueTurnReplyTools(ds, { turnId: 'om_mode', entries: [] }, send, () => true);
    await supersedeTurnReplyCard(ds, { turnId: 'om_mode' }, send, () => true);
    await flushTurnReplyTools(ds, 'om_mode');
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'start' }, send);
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'refresh' }, send);
    expect(store.read(key)?.phase).toBe('superseded');
    expect(ds.replyCardRunningTurnId).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('shows the selected runtime on unified cards even with usage off', async () => {
    const ds = session();
    ds.session.cliId = 'codex';
    ds.session.model = 'gpt-5.6-sol';
    ds.activeReasoningEffort = 'high';
    const send = vi.fn(async (_content: string) => 'om_reply');
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'start' }, send);
    const card = JSON.parse(send.mock.calls[0]![0]);
    const line = card.body.elements.find((e: any) => e.element_id === 'botmux_turn_usage');
    expect(line?.content).toBe('**gpt-5.6-sol** high');
  });

  it.each([false, true])('private replies bypass dynamic cards with an existing reservation=%s', async reserved => {
    const ds = session();
    Object.assign(ds.session, { larkAppId: ds.larkAppId, chatType: 'group', scope: 'thread' });
    if (reserved) expect(replyCardModeFor(ds)).toBe('unified');
    writeRoleReplyPrivately(ds.larkAppId, ds.chatId, true);
    ds.cotForced = true;
    const send = vi.fn(async () => 'om_reply');
    expect(replyCardModeFor(ds)).toBe('legacy');
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'start' }, send);
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'final', text: 'answer', card: '{}', source: 'bridge' }, send);
    expect(send).not.toHaveBeenCalled();
    expect(updateMessage).not.toHaveBeenCalled();
    writeRoleReplyPrivately(ds.larkAppId, ds.chatId, false);
    expect(replyCardModeFor(ds, 'om_next')).toBe('unified');
  });
  it('observes the actual final card only after the patch succeeds with its platform timestamp', async () => {
    const ds = session();
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'start' }, async () => 'om_reply');
    let acknowledge!: (value: any) => void;
    vi.mocked(updateMessage).mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
    const final = updateTurnReplyCard(ds, 'om_mode', { kind: 'final', text: 'Final answer',
      card: '{"schema":"2.0","body":{"elements":[{"tag":"markdown","content":"Final answer"}]}}', source: 'explicit' }, async () => 'unused');
    await vi.waitFor(() => expect(updateMessage).toHaveBeenCalledTimes(1));
    expect(observePublishedGroupMessage).not.toHaveBeenCalled();
    acknowledge({ update_time: '1791280000456' });
    await final;
    expect(observePublishedGroupMessage).toHaveBeenCalledWith('app_mode', expect.objectContaining({
      message_id: 'om_reply', chat_id: 'oc_mode', root_id: 'om_root', msg_type: 'interactive',
      update_time: '1791280000456', body: { content: vi.mocked(updateMessage).mock.calls[0]![2] },
    }));
  });

  it('does not observe a final card when its patch is withdrawn', async () => {
    const ds = session();
    ds.session.cliSessionId = 'native_mode';
    const binding = { appId: ds.larkAppId, chatId: ds.chatId, turnId: 'om_mode', sessionId: ds.session.sessionId, workerGeneration: 1,
      epoch: groupContextEpoch(ds.session.sessionId, ds.session.cliSessionId, ds.session.cliId, 'om_mode') };
    writePreparedGroupContext({ ...binding, createdAt: Date.now(), body: '', includedSeqs: [], throughSeq: 0, incomplete: false }, dir);
    bindGroupContextDelivery(binding, dir);
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'start' }, async () => 'om_reply');
    vi.mocked(updateMessage).mockRejectedValueOnce(new MessageWithdrawnError('om_reply'));
    const final = { kind: 'final' as const, text: 'Failed answer',
      card: '{"schema":"2.0","body":{"elements":[{"tag":"markdown","content":"Failed answer"}]}}', source: 'explicit' as const };
    const resend = vi.fn(async () => 'forbidden_recreation');
    await expect(updateTurnReplyCard(ds, 'om_mode', final, resend)).rejects.toThrow();
    await expect(updateTurnReplyCard(ds, 'om_mode', final, resend)).rejects.toThrow();
    expect(resend).not.toHaveBeenCalled();
    expect(observePublishedGroupMessage).not.toHaveBeenCalled();
  });

  it('attributes only the authored final patch to its exact native conversation', async () => {
    const ds = session();
    ds.session.cliSessionId = 'native_mode';
    const binding = { appId: ds.larkAppId, chatId: ds.chatId, turnId: 'om_mode', sessionId: ds.session.sessionId, workerGeneration: 1,
      epoch: groupContextEpoch(ds.session.sessionId, ds.session.cliSessionId, ds.session.cliId, 'om_mode') };
    writePreparedGroupContext({ ...binding, createdAt: Date.now(), body: '', includedSeqs: [], throughSeq: 0, incomplete: false }, dir);
    bindGroupContextDelivery(binding, dir);
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'start' }, async () => 'om_reply');
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'final', text: 'Native answer',
      card: '{"schema":"2.0","body":{"elements":[{"tag":"markdown","content":"Native answer"}]}}', source: 'bridge' }, async () => 'unused');
    expect(vi.mocked(observePublishedGroupMessage).mock.calls.at(-1)?.[2]).toEqual(binding);
    vi.mocked(observePublishedGroupMessage).mockClear();
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'terminal', phase: 'completed' }, async () => 'unused');
    expect(vi.mocked(observePublishedGroupMessage).mock.calls.at(-1)?.[2]).toBeUndefined();
  });

  it.each([false, true])('records a first final CREATE only after acknowledgement (retry=%s)', async retry => {
    const ds = session();
    ds.session.cliSessionId = 'native_mode';
    const binding = { appId: ds.larkAppId, chatId: ds.chatId, turnId: 'om_mode', sessionId: ds.session.sessionId, workerGeneration: 1,
      epoch: groupContextEpoch(ds.session.sessionId, ds.session.cliSessionId, ds.session.cliId, 'om_mode') };
    writePreparedGroupContext({ ...binding, createdAt: Date.now(), body: '', includedSeqs: [], throughSeq: 0, incomplete: false }, dir);
    bindGroupContextDelivery(binding, dir);
    let acknowledge!: (value: string) => void;
    const send = vi.fn(async () => new Promise<string>(resolve => { acknowledge = resolve; }));
    if (retry) send.mockRejectedValueOnce(new Error('transient create failure'));
    const delivered = updateTurnReplyCard(ds, 'om_mode', { kind: 'final', text: 'First final answer',
      card: '{"schema":"2.0","body":{"elements":[{"tag":"markdown","content":"First final answer"}]}}', source: 'bridge' }, send);
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'), { timeout: 3000 });
    expect(observePublishedGroupMessage).not.toHaveBeenCalled();
    acknowledge('om_first_final');
    await delivered;
    expect(updateMessage).not.toHaveBeenCalled();
    expect(observePublishedGroupMessage).toHaveBeenCalledExactlyOnceWith('app_mode', expect.objectContaining({
      message_id: 'om_first_final', chat_id: 'oc_mode', msg_type: 'interactive',
      body: { content: send.mock.calls.at(-1)?.[0] },
    }), binding);
  });

  it('keeps provisional authorship only in the bound worker generation', () => {
    const input = { appId: 'app_mode', chatId: 'oc_mode', turnId: 'om_mode', sessionId: 'sid_mode',
      nativeSessionId: 'native_mode', cliId: 'claude-code', workerGeneration: 1 };
    const binding = { appId: input.appId, chatId: input.chatId, turnId: input.turnId, sessionId: input.sessionId,
      epoch: groupContextEpoch(input.sessionId, undefined, input.cliId, input.turnId), workerGeneration: 0 };
    writePreparedGroupContext({ ...binding, createdAt: Date.now(), body: '', includedSeqs: [], throughSeq: 0, incomplete: false }, dir);
    bindGroupContextDelivery(binding, dir);
    expect(readGroupContextAuthorOrigin(input, dir)).toEqual(binding);
    expect(readGroupContextAuthorOrigin({ ...input, workerGeneration: 2 }, dir)).toBeUndefined();
    expect(readGroupContextAuthorOrigin({ ...input, workerGeneration: undefined }, dir)).toBeUndefined();
    expect(readGroupContextAuthorOrigin({ ...input, sessionId: 'another_session' }, dir)).toBeUndefined();
  });

  it('does not attribute a known native session to a different or unknown worker generation', () => {
    const input = { appId: 'app_mode', chatId: 'oc_mode', turnId: 'om_mode', sessionId: 'sid_mode',
      nativeSessionId: 'native_mode', cliId: 'claude-code', workerGeneration: 1 };
    const binding = { appId: input.appId, chatId: input.chatId, turnId: input.turnId, sessionId: input.sessionId,
      epoch: groupContextEpoch(input.sessionId, input.nativeSessionId, input.cliId, input.turnId), workerGeneration: 1 };
    writePreparedGroupContext({ ...binding, createdAt: Date.now(), body: '', includedSeqs: [], throughSeq: 0, incomplete: false }, dir);
    bindGroupContextDelivery(binding, dir);
    expect(readGroupContextAuthorOrigin(input, dir)).toEqual(binding);
    expect(readGroupContextAuthorOrigin({ ...input, workerGeneration: 2 }, dir)).toBeUndefined();
    expect(readGroupContextAuthorOrigin({ ...input, workerGeneration: undefined }, dir)).toBeUndefined();
  });

  it.each([false, true, undefined])('applies tool result preference %s to rendering and persisted flushes', async enabled => {
    bot.config.thinkingCardToolResult = enabled;
    expect(replyCardPresentation(bot.config, 'oc_mode').showToolResults).toBe(enabled !== false);
    const ds = session();
    const send = vi.fn(async () => 'om_reply');
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'start' }, send);
    queueTurnReplyTools(ds, { turnId: 'om_mode', entries: [
      { kind: 'tool_call', id: 'read', name: 'Read', args: '{}', subject: 'README.md' },
      { kind: 'tool_result', id: 'read', result: 'RESULT_BODY_MARKER' },
    ] }, send, () => true);
    await flushTurnReplyTools(ds, 'om_mode');
    const stored = new TurnReplyCardStore(dir).read({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_mode' });
    expect(stored?.tools).toHaveLength(1);
    expect(stored?.tools[0]?.result).toBe(enabled === false ? undefined : 'RESULT_BODY_MARKER');
    const patched = vi.mocked(updateMessage).mock.calls.at(-1)![2];
    expect(patched.includes('RESULT_BODY_MARKER')).toBe(enabled !== false);
    expect(patched).toContain('README.md');
  });

  it.each(['claude-code', 'codex', 'grok', 'traex', 'pi'] as const)('keeps sandboxed %s turns entirely on the default path', async cliId => {
    const ds = session();
    ds.session.cliId = cliId;
    ds.session.sandbox = true;
    const send = vi.fn(async () => 'om_reply');
    expect(replyCardModeFor(ds)).toBe('legacy');
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'start' }, send);
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'terminal', phase: 'completed' }, send);
    expect(send).not.toHaveBeenCalled();
    expect(updateMessage).not.toHaveBeenCalled();
    expect(existsSync(new TurnReplyCardStore(dir).directory)).toBe(false);
  });

  it.each(['new-bot', 'worker-sandbox', 'legacy-isolation', 'worker-isolation', 'global'] as const)(
    'rejects %s isolation even with a persisted unified reservation', source => {
      const ds = session();
      new TurnReplyCardStore(dir).prepareSync({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_mode' }, {
        mode: 'unified', chatId: ds.chatId, rootId: ds.session.rootMessageId,
      });
      if (source === 'new-bot') bot.config.sandbox = true;
      if (source === 'legacy-isolation') bot.config.readIsolation = true;
      if (source === 'worker-sandbox') ds.initConfig = { sandbox: true } as DaemonSession['initConfig'];
      if (source === 'worker-isolation') ds.initConfig = { readIsolation: true } as DaemonSession['initConfig'];
      if (source === 'global') vi.stubEnv('BOTMUX_SANDBOX', '1');
      expect(replyCardModeFor(ds)).toBe('legacy');
    },
  );

  it('does not let a cached unified mode override the frozen sandbox state on worker replacement', () => {
    const ds = session();
    expect(replyCardModeFor(ds)).toBe('unified');
    ds.session.sandbox = true;
    expect(replyCardModeFor(ds)).toBe('legacy');
  });

  it('follows frozen session and worker isolation instead of retroactively applying bot toggles', () => {
    const plain = session();
    plain.session.sandbox = false;
    plain.initConfig = { sandbox: false, readIsolation: false } as DaemonSession['initConfig'];
    bot.config.sandbox = true;
    bot.config.readIsolation = true;
    expect(replyCardModeFor(plain)).toBe('unified');
    bot.config.sandbox = false;
    bot.config.readIsolation = false;
    const isolated = session();
    isolated.session.sandbox = true;
    expect(replyCardModeFor(isolated)).toBe('legacy');
    const legacyIsolated = session();
    legacyIsolated.initConfig = { readIsolation: true } as DaemonSession['initConfig'];
    expect(replyCardModeFor(legacyIsolated)).toBe('legacy');
  });

  it.each(['claude-code', 'traex', 'pi'] as const)('freezes the old %s turn while mode changes apply to the next turn', cliId => {
    const ds = session();
    ds.session.cliId = cliId;
    expect(replyCardModeFor(ds)).toBe('unified');
    bot.config.disableStreamingCard = true;
    expect(replyCardModeFor(ds)).toBe('unified');
    expect(replyCardModeFor(ds, 'om_next')).toBe('unified');
    bot.config.replyCardMode = 'legacy';
    expect(replyCardModeFor(session())).toBe('unified'); // a restarted daemon reads the reservation
    expect(replyCardModeFor(ds, 'om_legacy')).toBe('legacy');
  });

  it.each(['bot', 'chat'] as const)('%s status-card off does not mute dynamic reply updates', async scope => {
    if (scope === 'bot') bot.config.disableStreamingCard = true;
    else bot.config.noCardChats = ['oc_mode'];
    const ds = session();
    const send = vi.fn(async () => 'om_reply');
    expect(replyCardModeFor(ds)).toBe('unified');
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'start' }, send);
    expect(send).toHaveBeenCalledTimes(1);
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'final', text: 'answer', card: '{"schema":"2.0","body":{"elements":[{"tag":"markdown","content":"answer"}]}}', source: 'bridge' }, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateMessage).mock.calls.at(-1)?.[1]).toBe('om_reply');
    expect(vi.mocked(updateMessage).mock.calls.at(-1)?.[2]).toContain('answer');
  });

  it.each(['opencode', 'codex-app', 'hermes'])('leaves %s on its established delivery path', cli => {
    const ds = session();
    ds.session.cliId = cli as typeof ds.session.cliId;
    expect(replyCardModeFor(ds)).toBe('legacy');
  });

  it.each(['v3_run_turn', 'schedule:daily:1', 'doc-comment:1'])('does not claim non-ordinary turn %s', turnId => {
    expect(replyCardModeFor(session(), turnId)).toBe('legacy');
  });

  it('keeps API-only, non-Lark, adopted, remote and substitute sessions compatible', () => {
    bot.config.apiOnly = true;
    expect(replyCardModeFor(session())).toBe('legacy');
    bot.config.apiOnly = false;
    expect(replyCardModeFor(session({ chatId: 'discord:channel' }))).toBe('legacy');
    expect(replyCardModeFor(session({ adoptedFrom: {} as DaemonSession['adoptedFrom'] }))).toBe('legacy');
    const remote = session(); remote.session.backendType = 'riff';
    expect(replyCardModeFor(remote)).toBe('legacy');
    const substitute = session({ scope: 'chat', currentReplyTarget: { turnId: 'om_mode', rootMessageId: 'om_root', updatedAt: '', substitute: true } });
    expect(replyCardModeFor(substitute)).toBe('legacy');
  });

  it('freezes a visible card on disconnect and accepts the recovered native terminal', async () => {
    const ds = session();
    const send = vi.fn(async () => 'om_existing');
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'start' }, send);
    await settleTurnReplyCards(ds);
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateMessage).mock.calls.at(-1)?.[2]).toContain('执行状态待确认');
    expect(observePublishedGroupMessage).toHaveBeenCalledWith('app_mode', expect.objectContaining({
      message_id: 'om_existing', chat_id: 'oc_mode', body: { content: vi.mocked(updateMessage).mock.calls.at(-1)![2] },
    }));
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'terminal', phase: 'completed', durationMs: 2500 }, send);
    expect(vi.mocked(updateMessage).mock.calls.at(-1)?.[2]).toContain('已完成');
    expect(new TurnReplyCardStore(dir).read({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_mode' })?.durationMs).toBe(2500);
  });

  it.each(['claude-code', 'codex', 'grok', 'traex', 'pi'] as const)('keeps %s live narration when queued snapshots end in tool calls', async cliId => {
    const ds = session();
    ds.session.cliId = cliId;
    const send = vi.fn(async (_body: string) => 'om_reply');
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'start' }, send);
    const entries: CotEntry[] = [
      { kind: 'text', text: 'NARRATION_A' },
      { kind: 'tool_call', id: 'pwd', name: 'Bash', args: '{}', subject: 'pwd' },
      { kind: 'tool_result', id: 'pwd', result: '/tmp' },
    ];
    queueTurnReplyTools(ds, { turnId: 'om_mode', entries: entries.slice(0, 1) }, send, () => true);
    queueTurnReplyTools(ds, { turnId: 'om_mode', entries }, send, () => true);
    await flushTurnReplyTools(ds, 'om_mode');
    const liveText = () => JSON.parse(vi.mocked(updateMessage).mock.calls.at(-1)![2]).body.elements
      .filter((element: any) => element.tag === 'markdown').map((element: any) => element.content).join('\n');
    expect(liveText()).toContain('💭 NARRATION_A');
    expect(liveText()).toContain('**Bash** ✓ · pwd');

    entries.push({ kind: 'tool_call', id: 'files', name: 'Read', args: '{}', subject: 'README.md' });
    queueTurnReplyTools(ds, { turnId: 'om_mode', entries }, send, () => true);
    await flushTurnReplyTools(ds, 'om_mode');
    expect(liveText()).toContain('💭 NARRATION_A');

    entries.push({ kind: 'text', text: 'NARRATION_B' },
      { kind: 'tool_call', id: 'time', name: 'Bash', args: '{}', subject: 'date' });
    queueTurnReplyTools(ds, { turnId: 'om_mode', entries }, send, () => true);
    await flushTurnReplyTools(ds, 'om_mode');
    expect(liveText()).toContain('💭 NARRATION_B');
    expect(liveText()).not.toContain('NARRATION_A');
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateMessage).mock.calls.every(call => call[1] === 'om_reply')).toBe(true);
  });

  it('uses the replacement worker sender and ownership when coalescing tool updates', async () => {
    const ds = session();
    const oldSend = vi.fn(async (_body: string) => 'old_card');
    const newSend = vi.fn(async (_body: string) => 'new_card');
    queueTurnReplyTools(ds, { turnId: 'om_mode', entries: [
      { kind: 'tool_call', id: 'old', name: 'Read', args: '{}', subject: 'old.md' },
    ] }, oldSend, () => false);
    queueTurnReplyTools(ds, { turnId: 'om_mode', entries: [
      { kind: 'tool_call', id: 'new', name: 'Read', args: '{}', subject: 'new.md' },
    ] }, newSend, () => true);
    await expect(flushTurnReplyTools(ds, 'om_mode')).resolves.toBeUndefined();
    expect(oldSend).not.toHaveBeenCalled();
    expect(newSend).toHaveBeenCalledTimes(1);
    expect(newSend.mock.calls[0]?.[0]).toContain('new.md');
  });

  it('flushes the new snapshot even when an earlier in-flight update loses ownership', async () => {
    const ds = session();
    const send = vi.fn(async (_body: string) => 'om_card');
    let oldOwns = true;
    queueTurnReplyTools(ds, { turnId: 'om_mode', entries: [
      { kind: 'tool_call', id: 'old', name: 'Read', args: '{}', subject: 'old.md' },
    ] }, send, () => oldOwns);
    const first = flushTurnReplyTools(ds, 'om_mode').catch(error => error);
    oldOwns = false;
    queueTurnReplyTools(ds, { turnId: 'om_mode', entries: [
      { kind: 'tool_call', id: 'new', name: 'Read', args: '{}', subject: 'latest.md' },
    ] }, send, () => true);
    const next = flushTurnReplyTools(ds, 'om_mode').catch(error => error);
    expect(await first).toBeInstanceOf(Error);
    const result = await next;
    // Drain a remaining timer as well when this regression is run against the old code.
    await flushTurnReplyTools(ds, 'om_mode');
    expect(result).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toContain('latest.md');
  });

  it('preserves quiet delivery for an already accepted final-only turn on disconnect', async () => {
    const ds = session();
    new TurnReplyCardStore(dir).prepareSync({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_mode' }, {
      mode: 'final-only', chatId: ds.chatId, rootId: ds.session.rootMessageId,
    });
    const send = vi.fn(async () => 'unused');
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'start' }, send);
    await settleTurnReplyCards(ds);
    expect(send).not.toHaveBeenCalled();
    expect(updateMessage).not.toHaveBeenCalled();
  });
});
