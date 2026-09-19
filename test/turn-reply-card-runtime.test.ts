import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonSession } from '../src/core/types.js';
import { config } from '../src/config.js';
import { getBot } from '../src/bot-registry.js';
import { replyCardModeFor, updateTurnReplyCard, settleTurnReplyCards, queueTurnReplyTools, flushTurnReplyTools } from '../src/core/turn-reply-card.js';
import { updateMessage } from '../src/im/lark/client.js';
import { TurnReplyCardStore } from '../src/services/turn-reply-card.js';
import { writeRoleReplyPrivately } from '../src/core/role-resolver.js';
import type { CotEntry } from '../src/types.js';

vi.mock('../src/config.js', () => ({ config: { session: { dataDir: '' } } }));
vi.mock('../src/core/cost-calculator.js', () => ({ getSessionUsageSnapshot: vi.fn(() => ({ context: null, tokens: null })) }));
vi.mock('../src/im/lark/card-handler.js', () => ({ resolveCardOperatorUnionId: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({ getBot: vi.fn(), normalizeUsageDisplay: () => 'off' }));
vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}), uploadFile: vi.fn(), MessageWithdrawnError: class extends Error {},
}));
vi.mock('../src/i18n/index.js', () => ({ localeForBot: () => 'zh', t: (key: string) => key }));

function session(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    larkAppId: 'app_mode', chatId: 'oc_mode', scope: 'thread', currentTurnId: 'om_mode',
    session: { sessionId: 'sid_mode', chatId: 'oc_mode', rootMessageId: 'om_root', status: 'active', cliId: 'claude-code', backendType: 'tmux' },
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
    vi.mocked(updateMessage).mockClear();
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

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

  it.each(['claude-code', 'codex'] as const)('keeps sandboxed %s turns entirely on the default path', async cliId => {
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

  it('freezes the old turn while mode changes apply to the next turn', () => {
    const ds = session();
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

  it.each(['gemini', 'codex-app', 'hermes'])('leaves %s on its established delivery path', cli => {
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
    await updateTurnReplyCard(ds, 'om_mode', { kind: 'terminal', phase: 'completed', durationMs: 2500 }, send);
    expect(vi.mocked(updateMessage).mock.calls.at(-1)?.[2]).toContain('已完成');
    expect(new TurnReplyCardStore(dir).read({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_mode' })?.durationMs).toBe(2500);
  });

  it.each(['claude-code', 'codex'] as const)('keeps %s live narration when queued snapshots end in tool calls', async cliId => {
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
