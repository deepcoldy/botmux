import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/types.js';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    constructor(_opts: Record<string, unknown>) {}
  }
  return { Client: FakeClient };
});

const { resolveImportedTopicHandoff } = await import('../src/services/imported-topic-handoff.js');

const CHAT = 'oc_handoff_chat';
const ROOT = 'om_handoff_root';
const SELF = 'cli_self';
const SOURCE = 'cli_source';
const PEER = 'cli_peer';

type Cfg = {
  chatMentionModes?: Record<string, 'always' | 'topic' | 'never' | 'ambient'>;
  signedChatDefaults?: boolean;
  regularGroupMentionMode?: 'always' | 'topic' | 'never' | 'ambient';
};

function session(over: Partial<Session>): Session {
  return {
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    status: 'active',
    chatId: CHAT,
    scope: 'thread',
    rootMessageId: ROOT,
    larkAppId: SOURCE,
    ...over,
  } as Session;
}

const imported = (over: Partial<Session> = {}) => session({ projectImportSource: 'relay', ...over });

function resolve(opts: {
  sessionsAtRoot: Session[];
  chatScopeSessions?: Session[];
  configs?: Record<string, Cfg | undefined>;
  groupMode?: { mode: 'project' | 'standard'; coordinatorAppId?: string };
}) {
  const chatScopeSessions = vi.fn(() => opts.chatScopeSessions ?? []);
  const groupMode = vi.fn(() => opts.groupMode);
  const result = resolveImportedTopicHandoff({
    rootId: ROOT,
    chatId: CHAT,
    larkAppId: SELF,
    sessionsAtRoot: opts.sessionsAtRoot,
    chatScopeSessions,
    peerConfig: appId => opts.configs?.[appId],
    groupMode,
  });
  return { result, chatScopeSessions, groupMode };
}

const PROJECT = { mode: 'project' as const, coordinatorAppId: SELF };

describe('resolveImportedTopicHandoff — which imported session counts', () => {
  it('returns null unless ANOTHER bot holds an active imported thread session at this root in this chat', () => {
    const configs = { [SOURCE]: {} };
    expect(resolve({ sessionsAtRoot: [], configs }).result).toBeNull();
    // Worker dispatch topics (no projectImportSource) keep regular routing.
    expect(resolve({ sessionsAtRoot: [session({})], configs }).result).toBeNull();
    // This bot's own imported session is not a handoff.
    expect(resolve({ sessionsAtRoot: [imported({ larkAppId: SELF })], configs }).result).toBeNull();
    expect(resolve({ sessionsAtRoot: [imported({ chatId: 'oc_other' })], configs }).result).toBeNull();
    expect(resolve({ sessionsAtRoot: [imported({ status: 'closed' })], configs }).result).toBeNull();
    expect(resolve({ sessionsAtRoot: [imported({ scope: 'chat' })], configs }).result).toBeNull();
    expect(resolve({ sessionsAtRoot: [imported({ rootMessageId: 'om_other_root' })], configs }).result).toBeNull();

    expect(resolve({ sessionsAtRoot: [imported()], configs }).result).toMatchObject({ sourceLarkAppId: SOURCE });
  });
});

describe('resolveImportedTopicHandoff — does the importing bot answer un-@ itself', () => {
  it.each([
    { name: 'bot default always (unset)', cfg: {}, want: false },
    { name: 'bot default topic', cfg: { regularGroupMentionMode: 'topic' }, want: true },
    { name: 'bot default ambient', cfg: { regularGroupMentionMode: 'ambient' }, want: true },
    { name: 'bot default never', cfg: { regularGroupMentionMode: 'never' }, want: true },
    { name: 'per-chat topic over always default', cfg: { chatMentionModes: { [CHAT]: 'topic' } }, want: true },
    { name: 'per-chat always over topic default', cfg: { chatMentionModes: { [CHAT]: 'always' }, regularGroupMentionMode: 'topic' }, want: false },
    { name: 'other chat override does not apply', cfg: { chatMentionModes: { oc_other: 'never' } }, want: false },
    // The signed default may lift 'always' to 'ambient', but it is verified and
    // cached only in the importing bot's own daemon — unreadable from here.
    { name: 'signed default over always', cfg: { signedChatDefaults: true }, want: 'unknown' },
    { name: 'signed default over topic (answers either way)', cfg: { signedChatDefaults: true, regularGroupMentionMode: 'topic' }, want: true },
    { name: 'per-chat always pins over signed default', cfg: { signedChatDefaults: true, chatMentionModes: { [CHAT]: 'always' } }, want: false },
    { name: 'config missing', cfg: undefined, want: 'unknown' },
  ] as const)('$name → $want', ({ cfg, want }) => {
    const { result } = resolve({ sessionsAtRoot: [imported()], configs: { [SOURCE]: cfg as Cfg | undefined } });
    expect(result?.sourceAnswersWithoutMention).toBe(want);
  });
});

describe('resolveImportedTopicHandoff — may the project coordinator fold the reply in', () => {
  it('only the project coordinator of this chat, and only when the importing bot requires @', () => {
    const always = { [SOURCE]: {} };
    expect(resolve({ sessionsAtRoot: [imported()], configs: always, groupMode: PROJECT }).result?.coordinatorMayFold).toBe(true);
    // Another bot is the coordinator.
    expect(resolve({ sessionsAtRoot: [imported()], configs: always, groupMode: { mode: 'project', coordinatorAppId: PEER } }).result?.coordinatorMayFold).toBe(false);
    // Not a project group: the chat manager only adds top-level addressing.
    expect(resolve({ sessionsAtRoot: [imported()], configs: always, groupMode: { mode: 'standard', coordinatorAppId: SELF } }).result?.coordinatorMayFold).toBe(false);
    expect(resolve({ sessionsAtRoot: [imported()], configs: always, groupMode: undefined }).result?.coordinatorMayFold).toBe(false);
  });

  it('never folds when the importing bot answers itself or cannot be decided (no double reply)', () => {
    const answers = resolve({ sessionsAtRoot: [imported()], configs: { [SOURCE]: { regularGroupMentionMode: 'topic' } }, groupMode: PROJECT });
    expect(answers.result?.coordinatorMayFold).toBe(false);
    // Neither lazy input is read once the importing bot answers.
    expect(answers.groupMode).not.toHaveBeenCalled();
    expect(answers.chatScopeSessions).not.toHaveBeenCalled();
    const unknown = resolve({ sessionsAtRoot: [imported()], configs: { [SOURCE]: { signedChatDefaults: true } }, groupMode: PROJECT });
    expect(unknown.result?.coordinatorMayFold).toBe(false);
  });

  it('a third bot continuing this root without @ keeps it — via its own thread session or a shared-topic alias', () => {
    const configs: Record<string, Cfg> = { [SOURCE]: {}, [PEER]: { regularGroupMentionMode: 'topic' } };
    const peerThread = session({ larkAppId: PEER });
    expect(resolve({ sessionsAtRoot: [imported(), peerThread], configs, groupMode: PROJECT }).result?.coordinatorMayFold).toBe(false);

    const alias = { createdAt: '2026-11-13T00:00:00.000Z', lastUsedAt: '2026-11-13T00:00:00.000Z' };
    const peerAlias = session({ larkAppId: PEER, scope: 'chat', rootMessageId: 'om_peer_chat', replyThreadAliases: { [ROOT]: alias } });
    expect(resolve({ sessionsAtRoot: [imported()], chatScopeSessions: [peerAlias], configs, groupMode: PROJECT }).result?.coordinatorMayFold).toBe(false);
    // An alias for another root, or in another chat, does not count.
    const otherRootAlias = { ...peerAlias, replyThreadAliases: { om_other_root: alias } };
    const otherChatAlias = { ...peerAlias, chatId: 'oc_other' };
    expect(resolve({ sessionsAtRoot: [imported()], chatScopeSessions: [otherRootAlias, otherChatAlias], configs, groupMode: PROJECT }).result?.coordinatorMayFold).toBe(true);
  });

  it('a third bot that requires @ does not answer there, so the coordinator still folds; undecidable counts as answering', () => {
    const peerThread = session({ larkAppId: PEER });
    expect(resolve({ sessionsAtRoot: [imported(), peerThread], configs: { [SOURCE]: {}, [PEER]: {} }, groupMode: PROJECT })
      .result?.coordinatorMayFold).toBe(true);
    expect(resolve({ sessionsAtRoot: [imported(), peerThread], configs: { [SOURCE]: {}, [PEER]: { signedChatDefaults: true } }, groupMode: PROJECT })
      .result?.coordinatorMayFold).toBe(false);
  });
});
