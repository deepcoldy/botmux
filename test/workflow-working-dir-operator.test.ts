/**
 * "May the run's initiator operate this bot?" for a workflow node's Gate-2
 * working dir (design 2026-11-03 §15.4): the gate a typed `/cd` passes on the
 * executing bot's real registry entry, plus being in the run's chat now, with
 * the initiator's identity converted into that bot's app first — the main
 * bot's app-scoped open_id is never used for another bot. Three answers:
 * yes / no / unknown (lookups failed or timed out).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

import { registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { humanCanRunDaemonCommand } from '../src/im/lark/event-dispatcher.js';
import { config } from '../src/config.js';
import { applyPlatformTeamSync } from '../src/services/platform-team-store.js';
import {
  WORKFLOW_WORKING_DIR_OPERATOR_ROUTE,
  createWorkflowWorkingDirOperatorWiring,
  parseWorkflowInitiatorUnionRequest,
  parseWorkflowWorkingDirOperatorRequest,
  withinOperatorBudget,
  workflowInitiatorCdGate,
  workflowInitiatorOperates,
  type WorkflowInitiatorOperatesDeps,
  type WorkflowOperateAnswer,
  type WorkflowWorkingDirOperatorIo,
} from '../src/core/workflow-working-dir-operator.js';
import { createLiveV3WorkingDirOperator } from '../src/im/lark/v3-bot-eligibility.js';
import type { TargetAppOpenIdResolution } from '../src/im/lark/client.js';

const MAIN = 'cli_main';
const OTHER = 'cli_other';
const CHAT = 'oc_run_chat';
/** The initiator as each app sees them (open_id is app-scoped). */
const ALICE_IN_MAIN = 'ou_alice_in_main';
const ALICE_IN_OTHER = 'ou_alice_in_other';
const ALICE_UNION = 'on_alice';

let prevDataDir: string;
let tmp: string;

function bot(appId: string, allowedUsers: string[], extra: Record<string, unknown> = {}) {
  const entry = registerBot({ larkAppId: appId, larkAppSecret: 's', cliId: 'claude-code', allowedUsers, ...extra } as never);
  entry.resolvedAllowedUsers = [...allowedUsers];
  return entry;
}

beforeEach(() => {
  prevDataDir = config.session.dataDir;
  tmp = mkdtempSync(join(tmpdir(), 'wd-operator-'));
  config.session.dataDir = tmp;
  __testOnly_resetBotRegistry();
});

afterEach(() => {
  config.session.dataDir = prevDataDir;
  rmSync(tmp, { recursive: true, force: true });
  vi.useRealTimers();
});

/** Production I/O for the wiring factory, over a fake contact directory
 *  (`union` overrides every open_id → union_id answer) and fake chat member
 *  lists; the command gate is the real one. */
function io(opts: {
  directory?: Record<string, Record<string, TargetAppOpenIdResolution>>;
  members?: Record<string, string[] | Error>;
  gate?: WorkflowWorkingDirOperatorIo['canRunDaemonCommand'];
  union?: () => ReturnType<WorkflowWorkingDirOperatorIo['resolveUnionIdFromOpenId']>;
} = {}) {
  const calls: string[] = [];
  const warnings: string[] = [];
  const value: WorkflowWorkingDirOperatorIo = {
    resolveTargetAppOpenId: async (appId, unionId) => {
      calls.push(`resolve:${appId}:${unionId}`);
      return opts.directory?.[appId]?.[unionId] ?? { status: 'definitive' };
    },
    resolveUnionIdFromOpenId: async (appId, openId) => {
      calls.push(`union:${appId}:${openId}`);
      if (opts.union) return opts.union();
      return openId === ALICE_IN_MAIN ? { status: 'resolved', unionId: ALICE_UNION } : { status: 'unavailable' };
    },
    listChatMemberOpenIds: async (appId, chatId) => {
      calls.push(`members:${appId}:${chatId}`);
      const members = opts.members?.[appId] ?? [];
      if (members instanceof Error) throw members;
      return members;
    },
    canRunDaemonCommand: opts.gate ?? humanCanRunDaemonCommand,
    selfLarkAppId: () => MAIN,
    warn: (message) => { warnings.push(message); },
  };
  return { io: value, calls, warnings };
}

describe('humanCanRunDaemonCommand: the /cd gate a typed command passes', () => {
  it('an operator passes; someone who may only talk passes only when the bot lowered /cd to talk, and not as a restricted grant', () => {
    const entry = bot(MAIN, ['ou_owner']);
    entry.config.chatGrants = { [CHAT]: ['ou_guest'] };
    expect(humanCanRunDaemonCommand(MAIN, CHAT, 'ou_owner', undefined, '/cd', 'group')).toBe(true);
    expect(humanCanRunDaemonCommand(MAIN, CHAT, 'ou_guest', undefined, '/cd', 'group')).toBe(false);
    expect(humanCanRunDaemonCommand(MAIN, CHAT, 'ou_stranger', undefined, '/cd', 'group')).toBe(false);
    entry.config.canTalkDaemonCommands = ['/cd'];
    expect(humanCanRunDaemonCommand(MAIN, CHAT, 'ou_guest', undefined, '/cd', 'group')).toBe(true);
    expect(humanCanRunDaemonCommand(MAIN, CHAT, 'ou_stranger', undefined, '/cd', 'group')).toBe(false);
    // restrictGrantCommands: a grant-only user cannot run commands at all.
    entry.config.restrictGrantCommands = true;
    expect(humanCanRunDaemonCommand(MAIN, CHAT, 'ou_guest', undefined, '/cd', 'group')).toBe(false);
    expect(humanCanRunDaemonCommand(MAIN, CHAT, 'ou_owner', undefined, '/cd', 'group')).toBe(true);
  });
});

describe('workflowInitiatorOperates: three answers', () => {
  function deps(overrides: Partial<WorkflowInitiatorOperatesDeps> = {}) {
    const seen: string[] = [];
    const value: WorkflowInitiatorOperatesDeps = {
      resolveTargetOpenId: async (appId, unionId) => (appId === OTHER && unionId === ALICE_UNION
        ? { status: 'resolved', openId: ALICE_IN_OTHER }
        : { status: 'definitive' }),
      canUseCd: (appId, _chat, openId) => { seen.push(`cd:${appId}:${openId}`); return true; },
      lookupUnionId: async (appId, openId) => { seen.push(`union:${appId}:${openId}`); return { unknown: 'not wired' }; },
      chatMembership: async (appId, _chat, openId) => { seen.push(`member:${appId}:${openId}`); return 'member'; },
      ...overrides,
    };
    return { value, seen };
  }
  const fromMain = { sourceLarkAppId: MAIN, openId: ALICE_IN_MAIN, unionId: ALICE_UNION };

  it('the main bot\'s own app uses the open_id it issued; another app only ever sees its own converted open_id', async () => {
    const d = deps();
    expect(await workflowInitiatorOperates(d.value, { larkAppId: MAIN, chatId: CHAT, initiator: fromMain })).toBe('yes');
    expect(await workflowInitiatorOperates(d.value, { larkAppId: OTHER, chatId: CHAT, initiator: fromMain })).toBe('yes');
    expect(d.seen).toEqual([`cd:${MAIN}:${ALICE_IN_MAIN}`, `member:${MAIN}:${ALICE_IN_MAIN}`, `cd:${OTHER}:${ALICE_IN_OTHER}`, `member:${OTHER}:${ALICE_IN_OTHER}`]);
  });

  it('a definitive "no such person here" is no; a transient or failed conversion, or no union_id, is unknown', async () => {
    const answer = (resolved: () => Promise<TargetAppOpenIdResolution>, initiator: typeof fromMain | { sourceLarkAppId: string; openId: string } = fromMain) =>
      workflowInitiatorOperates(deps({ resolveTargetOpenId: resolved }).value, { larkAppId: OTHER, chatId: CHAT, initiator });
    expect(await answer(async () => ({ status: 'definitive' }))).toBe('no');
    expect(await answer(async () => ({ status: 'transient' }))).toEqual({ unknown: expect.any(String) });
    expect(await answer(async () => { throw new Error('contact api down'); })).toEqual({ unknown: expect.any(String) });
    expect(await answer(async () => ({ status: 'resolved', openId: 'not-an-open-id' }))).toEqual({ unknown: expect.any(String) });
    expect(await answer(async () => ({ status: 'resolved', openId: ALICE_IN_OTHER }), { sourceLarkAppId: MAIN, openId: ALICE_IN_MAIN }))
      .toEqual({ unknown: expect.any(String) });
  });

  it('passing the /cd gate is not enough: not in the chat is no, an unreadable member list is unknown; failing the gate asks nothing more', async () => {
    const run = (overrides: Partial<WorkflowInitiatorOperatesDeps>) =>
      workflowInitiatorOperates(deps(overrides).value, { larkAppId: MAIN, chatId: CHAT, initiator: fromMain });
    expect(await run({ chatMembership: async () => 'not_member' })).toBe('no');
    expect(await run({ chatMembership: async () => 'unavailable' })).toEqual({ unknown: expect.any(String) });
    expect(await run({ chatMembership: async () => { throw new Error('boom'); } })).toEqual({ unknown: expect.any(String) });
    const membership = vi.fn(async () => 'member' as const);
    expect(await run({ canUseCd: () => false, chatMembership: membership })).toBe('no');
    expect(membership).not.toHaveBeenCalled();
  });

  it('the main bot\'s own app, no union_id on the run: a refusal by open_id is asked again with the union_id that app looks up; a failed lookup is unknown, one the app definitively cannot answer is no — never yes', async () => {
    const own = { sourceLarkAppId: MAIN, openId: ALICE_IN_MAIN };
    const ask = (overrides: Partial<WorkflowInitiatorOperatesDeps>, initiator: typeof own | typeof fromMain = own) =>
      workflowInitiatorOperates(deps(overrides).value, { larkAppId: MAIN, chatId: CHAT, initiator });
    // The gate lets her in by union_id only (the platform team member leg).
    const byUnion: WorkflowInitiatorOperatesDeps['canUseCd'] = (_app, _chat, _openId, unionId) => unionId === ALICE_UNION;
    const found = vi.fn(async () => ({ unionId: ALICE_UNION }));
    expect(await ask({ canUseCd: byUnion, lookupUnionId: found })).toBe('yes');
    expect(found).toHaveBeenCalledWith(MAIN, ALICE_IN_MAIN);
    for (const lookupUnionId of [
      async () => ({ unknown: 'contact api 503' }),
      async () => { throw new Error('down'); },
      async () => ({ unionId: 'not-a-union-id' }),
    ]) {
      const membership = vi.fn(async () => 'member' as const);
      expect(await ask({ canUseCd: byUnion, lookupUnionId, chatMembership: membership })).toEqual({ unknown: expect.any(String) });
      expect(membership).not.toHaveBeenCalled();
    }
    // The app definitively cannot see her: the open_id's refusal stands.
    const notFound = vi.fn(async () => 'member' as const);
    expect(await ask({ canUseCd: byUnion, lookupUnionId: async () => ({ notFound: 'not visible' }), chatMembership: notFound })).toBe('no');
    expect(notFound).not.toHaveBeenCalled();
    expect(await workflowInitiatorCdGate(deps({ canUseCd: byUnion, lookupUnionId: async () => ({ notFound: 'not visible' }) }).value,
      { larkAppId: MAIN, chatId: CHAT, initiator: own })).toBe('no');
    // Looked up and still refused: no.
    expect(await ask({ canUseCd: () => false, lookupUnionId: found })).toBe('no');
    // The open_id alone passes, or the run froze a union_id: nothing is looked up.
    const unused = vi.fn(async () => ({ unionId: ALICE_UNION }));
    expect(await ask({ lookupUnionId: unused })).toBe('yes');
    expect(await ask({ canUseCd: () => false, lookupUnionId: unused }, fromMain)).toBe('no');
    expect(unused).not.toHaveBeenCalled();
  });

  it('the /cd gate alone (what the main bot\'s own node checks before its cards go out) reads no member list', async () => {
    const membership = vi.fn(async () => 'member' as const);
    const gate = (overrides: Partial<WorkflowInitiatorOperatesDeps>) =>
      workflowInitiatorCdGate(deps({ chatMembership: membership, ...overrides }).value, { larkAppId: MAIN, chatId: CHAT, initiator: fromMain });
    expect(await gate({})).toBe('passes');
    expect(await gate({ canUseCd: () => false })).toBe('no');
    expect(await workflowInitiatorCdGate(deps({ chatMembership: membership, canUseCd: () => false }).value,
      { larkAppId: MAIN, chatId: CHAT, initiator: { sourceLarkAppId: MAIN, openId: ALICE_IN_MAIN } })).toEqual({ unknown: expect.any(String) });
    expect(membership).not.toHaveBeenCalled();
  });
});

describe('createWorkflowWorkingDirOperatorWiring (what the daemon wires)', () => {
  it('asks the command gate about exactly /cd, as a group command', async () => {
    bot(MAIN, [ALICE_IN_MAIN]);
    const asked: string[] = [];
    const w = io({ members: { [MAIN]: [ALICE_IN_MAIN] }, gate: (appId, chatId, openId, unionId, cmd, chatType) => {
      asked.push(`${cmd}:${chatType}`);
      return humanCanRunDaemonCommand(appId, chatId, openId, unionId, cmd, chatType);
    } });
    const wiring = createWorkflowWorkingDirOperatorWiring(w.io);
    expect(await wiring.initiatorOperates({ larkAppId: MAIN, chatId: CHAT, initiator: { sourceLarkAppId: MAIN, openId: ALICE_IN_MAIN } })).toBe('yes');
    expect(asked).toEqual(['/cd:group']);
  });

  it('a bot that lowered /cd to talk: a chat-wide grant counts only while the initiator is in the chat', async () => {
    // Her colleague's bot: she is no admin, but the bot lets anyone who may
    // talk in this chat use /cd (and lowered /status too).
    bot(OTHER, ['ou_colleague'], { allowedChatGroups: [CHAT], canTalkDaemonCommands: ['/cd', '/status'] });
    const directory = { [OTHER]: { [ALICE_UNION]: { status: 'resolved', openId: ALICE_IN_OTHER } as const } };
    const initiator = { sourceLarkAppId: MAIN, openId: ALICE_IN_MAIN, unionId: ALICE_UNION };
    const inChat = createWorkflowWorkingDirOperatorWiring(io({ directory, members: { [OTHER]: [ALICE_IN_OTHER, 'ou_colleague'] } }).io);
    expect(await inChat.initiatorOperates({ larkAppId: OTHER, chatId: CHAT, initiator })).toBe('yes');
    const left = createWorkflowWorkingDirOperatorWiring(io({ directory, members: { [OTHER]: ['ou_colleague'] } }).io);
    expect(await left.initiatorOperates({ larkAppId: OTHER, chatId: CHAT, initiator })).toBe('no');
    const unreadable = createWorkflowWorkingDirOperatorWiring(io({ directory, members: { [OTHER]: new Error('429') } }).io);
    expect(await unreadable.initiatorOperates({ larkAppId: OTHER, chatId: CHAT, initiator })).toEqual({ unknown: expect.any(String) });
  });

  it('only /cd counts: a bot that lowered other commands but not /cd keeps her out', async () => {
    bot(OTHER, ['ou_colleague'], { allowedChatGroups: [CHAT], canTalkDaemonCommands: ['/status', '/help'] });
    const wiring = createWorkflowWorkingDirOperatorWiring(io({
      directory: { [OTHER]: { [ALICE_UNION]: { status: 'resolved', openId: ALICE_IN_OTHER } } },
      members: { [OTHER]: [ALICE_IN_OTHER] },
    }).io);
    expect(await wiring.initiatorOperates({ larkAppId: OTHER, chatId: CHAT, initiator: { sourceLarkAppId: MAIN, unionId: ALICE_UNION } })).toBe('no');
  });

  it('never hands the main app\'s open_id to another app\'s gate, even if that bot happens to list the same string', async () => {
    bot(OTHER, [ALICE_IN_MAIN]);
    const w = io({ members: { [OTHER]: [ALICE_IN_MAIN] } });
    const wiring = createWorkflowWorkingDirOperatorWiring(w.io);
    // The union_id does not resolve in OTHER's app: no.
    expect(await wiring.initiatorOperates({ larkAppId: OTHER, chatId: CHAT, initiator: { sourceLarkAppId: MAIN, openId: ALICE_IN_MAIN, unionId: ALICE_UNION } })).toBe('no');
    expect(w.calls).toEqual([`resolve:${OTHER}:${ALICE_UNION}`]);
  });

  it('the main bot\'s own app, real gate: a platform team member of a bot that lowered /cd to talk passes once her union_id is looked up there; a lookup that fails is unknown, one its app definitively cannot answer leaves the open_id\'s no', async () => {
    bot(MAIN, ['ou_owner'], { canTalkDaemonCommands: ['/cd'] });
    const initiator = { sourceLarkAppId: MAIN, openId: ALICE_IN_MAIN };
    const ask = (w: ReturnType<typeof io>) => createWorkflowWorkingDirOperatorWiring(w.io).initiatorOperates({ larkAppId: MAIN, chatId: CHAT, initiator });
    const members = { [MAIN]: [ALICE_IN_MAIN] };
    const stranger = io({ members });
    expect(await ask(stranger)).toBe('no');
    expect(stranger.calls).toEqual([`union:${MAIN}:${ALICE_IN_MAIN}`]);
    applyPlatformTeamSync(tmp, {
      rev: 'rev-1',
      teams: [{ teamId: 'team-1', teamName: 'Team One', groupChatIds: [], memberUnionIds: [ALICE_UNION], bots: [{ appId: MAIN }] }],
    });
    const teamMember = io({ members });
    expect(await ask(teamMember)).toBe('yes');
    expect(teamMember.calls).toEqual([`union:${MAIN}:${ALICE_IN_MAIN}`, `members:${MAIN}:${CHAT}`]);
    for (const union of [async () => ({ status: 'retryable', error: '503' }) as const, async () => { throw new Error('down'); }]) {
      const failing = io({ members, union });
      expect(await ask(failing)).toEqual({ unknown: expect.any(String) });
      expect(failing.calls).toEqual([`union:${MAIN}:${ALICE_IN_MAIN}`]);
      expect(failing.warnings).toEqual([]);
    }
    // Not visible to the app, an invalid id, a missing contact scope: retrying
    // will not help, so the answer is the open_id's own (no), with a log line.
    const invisible = io({ members, union: async () => ({ status: 'unavailable' }) });
    expect(await ask(invisible)).toBe('no');
    expect(invisible.calls).toEqual([`union:${MAIN}:${ALICE_IN_MAIN}`]);
    expect(invisible.warnings).toEqual([expect.stringContaining(`${MAIN} cannot look up the run initiator's union_id`)]);
    // The gate alone, as the main bot's own node asks before its cards go out.
    const gateOnly = io({ members });
    expect(await createWorkflowWorkingDirOperatorWiring(gateOnly.io).initiatorCdGate({ larkAppId: MAIN, chatId: CHAT, initiator })).toBe('passes');
    expect(gateOnly.calls).toEqual([`union:${MAIN}:${ALICE_IN_MAIN}`]);
  });

  it('the main bot\'s union_id lookup goes through its own app', async () => {
    const w = io();
    const wiring = createWorkflowWorkingDirOperatorWiring(w.io);
    expect(await wiring.lookupOwnUnionId(ALICE_IN_MAIN)).toEqual({ unionId: ALICE_UNION });
    // Not visible to it: still unknown here — the union route answers 503 as before.
    expect(await wiring.lookupOwnUnionId('ou_nobody')).toEqual({ unknown: expect.any(String) });
    expect(w.warnings).toEqual([]);
    expect(w.calls).toEqual([`union:${MAIN}:${ALICE_IN_MAIN}`, `union:${MAIN}:ou_nobody`]);
  });
});

describe('withinOperatorBudget (fake clock)', () => {
  it('an answer that never comes is unknown once the budget passes — never yes', async () => {
    vi.useFakeTimers();
    let settled: WorkflowOperateAnswer | undefined;
    void withinOperatorBudget(new Promise<WorkflowOperateAnswer>(() => {}), 1_000).then((answer) => { settled = answer; });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ unknown: expect.any(String) });
  });

  it('a rejected or malformed answer is unknown; a real answer passes through', async () => {
    expect(await withinOperatorBudget(Promise.reject(new Error('x')), 1_000)).toEqual({ unknown: expect.any(String) });
    expect(await withinOperatorBudget(Promise.resolve(true as never), 1_000)).toEqual({ unknown: expect.any(String) });
    expect(await withinOperatorBudget(Promise.resolve('yes'), 1_000)).toBe('yes');
    expect(await withinOperatorBudget(Promise.resolve('no'), 1_000)).toBe('no');
  });
});

describe('IPC request shapes', () => {
  it('the operator question names only the run and node; the union question names the run and the asking bot', () => {
    expect(parseWorkflowWorkingDirOperatorRequest({ runId: 'r1', nodeId: 'write' })).toEqual({ runId: 'r1', nodeId: 'write' });
    for (const bad of [
      null, [], {}, { runId: 'r1' }, { runId: '', nodeId: 'write' },
      // A person or chat in the question is refused: the daemon reads them from the run.
      { runId: 'r1', nodeId: 'write', chatId: CHAT },
      { runId: 'r1', nodeId: 'write', initiator: { sourceLarkAppId: MAIN, openId: ALICE_IN_MAIN } },
      { runId: 'r1', nodeId: 'a b' },
    ]) {
      expect(parseWorkflowWorkingDirOperatorRequest(bad)).toBeUndefined();
    }
    expect(parseWorkflowInitiatorUnionRequest({ runId: 'r1', requesterLarkAppId: OTHER })).toEqual({ runId: 'r1', requesterLarkAppId: OTHER });
    expect(parseWorkflowInitiatorUnionRequest({ runId: 'r1' })).toBeUndefined();
    expect(parseWorkflowInitiatorUnionRequest({ runId: 'r1', requesterLarkAppId: OTHER, openId: ALICE_IN_MAIN })).toBeUndefined();
  });
});

describe('createLiveV3WorkingDirOperator (Gate-2 asks each bot\'s daemon)', () => {
  function world(opts: { ports?: Record<string, number>; status?: number; operate?: unknown; hang?: boolean } = {}) {
    const posts: Array<{ port: number; path: string; body: unknown }> = [];
    const operator = createLiveV3WorkingDirOperator({ runId: 'r1' }, {
      daemonPort: (appId) => (opts.ports ?? { [MAIN]: 4100, [OTHER]: 4200 })[appId],
      post: async (port, path, body) => {
        posts.push({ port, path, body });
        if (opts.hang) return new Promise(() => {});
        // An older daemon answers an unknown route with its generic 404.
        if (opts.status === 404) return { status: 404, body: { error: 'not_found', path } };
        return { status: opts.status ?? 200, body: { ok: true, operate: 'operate' in opts ? opts.operate : 'yes' } };
      },
    });
    return { operator, posts };
  }

  it('asks each bot with the run and node only — no person, no chat', async () => {
    const w = world();
    expect(await w.operator({ nodeId: 'inspect', larkAppId: MAIN })).toBe('yes');
    expect(await w.operator({ nodeId: 'write', larkAppId: OTHER })).toBe('yes');
    expect(w.posts).toEqual([
      { port: 4100, path: WORKFLOW_WORKING_DIR_OPERATOR_ROUTE, body: { runId: 'r1', nodeId: 'inspect' } },
      { port: 4200, path: WORKFLOW_WORKING_DIR_OPERATOR_ROUTE, body: { runId: 'r1', nodeId: 'write' } },
    ]);
  });

  it('passes the bot\'s three answers through; offline, older (404), errors and junk are unknown', async () => {
    expect(await world({ operate: 'no' }).operator({ nodeId: 'w', larkAppId: OTHER })).toBe('no');
    expect(await world({ operate: { unknown: 'member list unavailable' } }).operator({ nodeId: 'w', larkAppId: OTHER })).toEqual({ unknown: 'member list unavailable' });
    expect(await world({ ports: {} }).operator({ nodeId: 'w', larkAppId: OTHER })).toEqual({ unknown: expect.any(String) });
    expect(await world({ status: 404 }).operator({ nodeId: 'w', larkAppId: OTHER })).toEqual({ unknown: expect.stringContaining('版本过旧') });
    expect(await world({ status: 503 }).operator({ nodeId: 'w', larkAppId: OTHER })).toEqual({ unknown: expect.any(String) });
    expect(await world({ operate: true }).operator({ nodeId: 'w', larkAppId: OTHER })).toEqual({ unknown: expect.any(String) });
  });

  it('a daemon that never answers is unknown after the budget (fake clock)', async () => {
    vi.useFakeTimers();
    let settled: WorkflowOperateAnswer | undefined;
    void world({ hang: true }).operator({ nodeId: 'w', larkAppId: OTHER }).then((answer) => { settled = answer; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toEqual({ unknown: expect.any(String) });
  });
});
