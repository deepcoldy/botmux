/**
 * "May the run's initiator operate this bot?" for a workflow node's Gate-2
 * working dir (design 2026-11-03 §15.4): the same gate as a typed `/cd`, on
 * the executing bot's real registry entry, with the initiator's identity
 * converted into that bot's app first — the main bot's app-scoped open_id is
 * never used for another bot. Any doubt answers "no".
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
import {
  WORKFLOW_WORKING_DIR_OPERATOR_ROUTE,
  parseWorkflowWorkingDirOperatorRequest,
  workflowInitiatorOperates,
} from '../src/core/workflow-working-dir-operator.js';
import { createLiveV3WorkingDirOperator } from '../src/im/lark/v3-bot-eligibility.js';

const MAIN = 'cli_main';
const OTHER = 'cli_other';
const CHAT = 'oc_run_chat';
/** The initiator as each app sees them (open_id is app-scoped). */
const ALICE_IN_MAIN = 'ou_alice_in_main';
const ALICE_IN_OTHER = 'ou_alice_in_other';
const ALICE_UNION = 'on_alice';

let prevDataDir: string;
let tmp: string;

function bot(appId: string, allowedUsers: string[]) {
  const entry = registerBot({ larkAppId: appId, larkAppSecret: 's', cliId: 'claude-code', allowedUsers } as never);
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
});

/** The production check, with this bot registry and a table of who each app
 *  knows by which union_id. */
function operates(directory: Record<string, Record<string, string>>, calls: string[] = []) {
  return (input: Parameters<typeof workflowInitiatorOperates>[1]) => workflowInitiatorOperates({
    resolveTargetOpenId: async (appId, unionId) => {
      calls.push(`${appId}:${unionId}`);
      return directory[appId]?.[unionId];
    },
    canUseCd: (appId, chatId, openId, unionId) => humanCanRunDaemonCommand(appId, chatId, openId, unionId, '/cd', 'group'),
  }, input);
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

describe('workflowInitiatorOperates', () => {
  it('the main bot\'s own app: the frozen open_id is the initiator there', async () => {
    bot(MAIN, [ALICE_IN_MAIN]);
    const calls: string[] = [];
    const check = operates({}, calls);
    expect(await check({ larkAppId: MAIN, chatId: CHAT, initiator: { sourceLarkAppId: MAIN, openId: ALICE_IN_MAIN } })).toBe(true);
    expect(await check({ larkAppId: MAIN, chatId: CHAT, initiator: { sourceLarkAppId: MAIN, openId: 'ou_bob_in_main' } })).toBe(false);
    expect(calls).toEqual([]);
  });

  it('another bot: the main bot\'s open_id is never used there — only the union_id, converted in that bot\'s app', async () => {
    // A colleague's bot that happens to list the main app's id string: it
    // must not count, that id means someone else (or no one) in this app.
    bot(OTHER, [ALICE_IN_MAIN]);
    const calls: string[] = [];
    const check = operates({ [OTHER]: { [ALICE_UNION]: ALICE_IN_OTHER } }, calls);
    const fromMain = { sourceLarkAppId: MAIN, openId: ALICE_IN_MAIN };
    expect(await check({ larkAppId: OTHER, chatId: CHAT, initiator: fromMain })).toBe(false);
    expect(await check({ larkAppId: OTHER, chatId: CHAT, initiator: { ...fromMain, unionId: ALICE_UNION } })).toBe(false);
    expect(calls).toEqual([`${OTHER}:${ALICE_UNION}`]);
    // Her own bot: she is its owner as its app sees her.
    __testOnly_resetBotRegistry();
    bot(OTHER, [ALICE_IN_OTHER]);
    expect(await check({ larkAppId: OTHER, chatId: CHAT, initiator: { ...fromMain, unionId: ALICE_UNION } })).toBe(true);
  });

  it('a conversion that fails or throws counts as "cannot operate"', async () => {
    bot(OTHER, [ALICE_IN_OTHER]);
    const initiator = { sourceLarkAppId: MAIN, openId: ALICE_IN_MAIN, unionId: ALICE_UNION };
    expect(await operates({})({ larkAppId: OTHER, chatId: CHAT, initiator })).toBe(false);
    expect(await workflowInitiatorOperates({
      resolveTargetOpenId: async () => { throw new Error('contact api down'); },
      canUseCd: () => true,
    }, { larkAppId: OTHER, chatId: CHAT, initiator })).toBe(false);
    // A malformed answer is no identity either.
    expect(await workflowInitiatorOperates({
      resolveTargetOpenId: async () => 'not-an-open-id',
      canUseCd: () => true,
    }, { larkAppId: OTHER, chatId: CHAT, initiator })).toBe(false);
  });

  it('the route accepts only well-formed requests', () => {
    expect(parseWorkflowWorkingDirOperatorRequest({ chatId: CHAT, initiator: { sourceLarkAppId: MAIN, unionId: ALICE_UNION } }))
      .toEqual({ chatId: CHAT, initiator: { sourceLarkAppId: MAIN, unionId: ALICE_UNION } });
    for (const bad of [
      null, [], { chatId: 'x', initiator: { sourceLarkAppId: MAIN } },
      { chatId: CHAT },
      { chatId: CHAT, initiator: { sourceLarkAppId: MAIN, openId: 'alice' } },
      { chatId: CHAT, initiator: { sourceLarkAppId: MAIN, unionId: 'ou_not_union' } },
      { chatId: CHAT, initiator: { sourceLarkAppId: '', unionId: ALICE_UNION } },
    ]) {
      expect(parseWorkflowWorkingDirOperatorRequest(bad)).toBeUndefined();
    }
  });
});

describe('createLiveV3WorkingDirOperator (Gate-2 asks each bot\'s daemon)', () => {
  const binding = { larkAppId: MAIN, chatId: CHAT, chatType: 'group' as const, rootMessageId: 'om_root', ownerOpenId: ALICE_IN_MAIN };

  function world(opts: { union?: 'resolved' | 'unavailable' | 'throws'; ports?: Record<string, number>; status?: number } = {}) {
    const posts: Array<{ port: number; path: string; body: unknown }> = [];
    const lookups: string[] = [];
    const operator = createLiveV3WorkingDirOperator(binding, {
      lookupUnionId: async (appId, openId) => {
        lookups.push(`${appId}:${openId}`);
        if (opts.union === 'throws') throw new Error('timeout');
        return (opts.union ?? 'resolved') === 'resolved' ? { status: 'resolved', unionId: ALICE_UNION } : { status: 'unavailable' };
      },
      daemonPort: (appId) => (opts.ports ?? { [MAIN]: 4100, [OTHER]: 4200, cli_third: 4300 })[appId],
      post: async (port, path, body) => {
        posts.push({ port, path, body });
        return { status: opts.status ?? 200, body: { ok: true, canOperate: true } };
      },
    });
    return { operator, posts, lookups };
  }

  it('the main bot is asked with the open_id its own app issued; any other bot only with the union_id, looked up once', async () => {
    const w = world();
    expect(await w.operator(MAIN)).toBe(true);
    expect(await w.operator(OTHER)).toBe(true);
    expect(await w.operator('cli_third')).toBe(true);
    expect(w.posts).toEqual([
      { port: 4100, path: WORKFLOW_WORKING_DIR_OPERATOR_ROUTE, body: { chatId: CHAT, initiator: { sourceLarkAppId: MAIN, openId: ALICE_IN_MAIN } } },
      { port: 4200, path: WORKFLOW_WORKING_DIR_OPERATOR_ROUTE, body: { chatId: CHAT, initiator: { sourceLarkAppId: MAIN, unionId: ALICE_UNION } } },
      { port: 4300, path: WORKFLOW_WORKING_DIR_OPERATOR_ROUTE, body: { chatId: CHAT, initiator: { sourceLarkAppId: MAIN, unionId: ALICE_UNION } } },
    ]);
    expect(w.lookups).toEqual([`${MAIN}:${ALICE_IN_MAIN}`]);
  });

  it('no union_id (unavailable or failed lookup): another bot is not asked at all and the answer is no', async () => {
    for (const union of ['unavailable', 'throws'] as const) {
      const w = world({ union });
      expect(await w.operator(OTHER)).toBe(false);
      expect(w.posts).toEqual([]);
    }
  });

  it('an offline daemon, or one that does not know the route (older version), answers no', async () => {
    expect(await world({ ports: {} }).operator(OTHER)).toBe(false);
    expect(await world({ status: 404 }).operator(OTHER)).toBe(false);
    expect(await world({ status: 404 }).operator(MAIN)).toBe(false);
  });

  it('a run without an authenticated initiator never operates anything', async () => {
    const operator = createLiveV3WorkingDirOperator({ ...binding, ownerOpenId: undefined }, {
      lookupUnionId: async () => ({ status: 'resolved', unionId: ALICE_UNION }),
      daemonPort: () => 4100,
      post: async () => ({ status: 200, body: { canOperate: true } }),
    });
    expect(await operator(MAIN)).toBe(false);
    expect(await operator(OTHER)).toBe(false);
  });
});
