/**
 * invite-command：`@bot /invite @目标bot` / `--app cli_xxx` 拉群外 bot 进本群。
 * 覆盖：参数解析纯函数、花名册读取、target-only 守卫、owner 闸门、名字→appId
 * 解析（唯一/未解析/歧义）、已在群内幂等、批量失败逐个回退。
 * Run: pnpm vitest run test/invite-command.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

// 拦截回执与拉人 API，避免真实 Lark 调用。
const replyMock = vi.fn(async () => 'om_reply');
const rosterMock = vi.fn(async (_app: string, _chat: string) => [] as any[]);
const addBotMock = vi.fn(async (_app: string, _chat: string, ids: string[]) =>
  ids.map(id => ({ id, ok: true })) as { id: string; ok: boolean; error?: string }[]);
vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return {
    ...actual,
    replyMessage: (...a: any[]) => replyMock(...a),
    listChatBotMembers: (...a: any[]) => rosterMock(...a),
  };
});
vi.mock('../src/services/groups-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/groups-store.js')>();
  return { ...actual, addBotToChat: (...a: any[]) => addBotMock(...a) };
});

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryHandleInviteCommand, parseInviteArgs, readBotsInfoEntries } from '../src/im/lark/invite-command.js';
import { isCommandTargetOnly } from '../src/im/lark/mention-targets.js';
import { registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';

const OWNER = 'ou_owner';
const ME = 'ou_bot';

/** text 形态：`@_user_1`（=本 bot，前导操作方点名）+ `/invite` + 尾部目标。 */
function inviteMessage(overrides: {
  text?: string; mentions?: any[]; chatType?: string; chatId?: string;
} = {}) {
  return {
    message_id: 'om_inv', chat_id: overrides.chatId ?? 'oc_1',
    ...(overrides.chatType ? { chat_type: overrides.chatType } : {}),
    content: JSON.stringify({ text: overrides.text ?? '@_user_1 /invite @_user_2' }),
    mentions: overrides.mentions ?? [
      { key: '@_user_1', id: { open_id: ME }, name: 'Claude' },
      { key: '@_user_2', id: { open_id: 'ou_codex' }, name: 'Codex' },
    ],
  };
}

let tmpDir: string;
function writeBotsInfo(entries: Array<{ larkAppId: string; botName: string | null }>) {
  writeFileSync(join(tmpDir, 'bots-info.json'), JSON.stringify(entries));
}
function writePlatformSync(bots: Array<{ appId: string; name?: string; unionId?: string }>) {
  writeFileSync(join(tmpDir, 'platform-team-sync.json'), JSON.stringify({
    rev: 'r1', updatedAt: Date.now(),
    teams: [{ teamId: 't1', teamName: '大厅', groupChatIds: [], memberUnionIds: [], bots }],
  }));
}
function writeHostedFederations(bots: Array<{ larkAppId: string; botName: string }>) {
  writeFileSync(join(tmpDir, 'federations.json'), JSON.stringify({ version: 1, teams: {
    default: [{ deploymentId: 'dep_sg', name: 'sg-box', syncToken: 'x', joinedAt: 1, lastSeenAt: 2, bots }],
  } }));
}
function writeMemberships() {
  writeFileSync(join(tmpDir, 'federation-memberships.json'), JSON.stringify({
    'http://hub::default': { hubUrl: 'http://hub', teamId: 'default', teamName: 'a', syncToken: 'tok', deploymentId: 'd', joinedAt: 1 },
  }));
}

beforeEach(() => {
  replyMock.mockClear();
  rosterMock.mockClear();
  addBotMock.mockClear();
  rosterMock.mockImplementation(async () => []);
  addBotMock.mockImplementation(async (_a, _c, ids: string[]) => ids.map(id => ({ id, ok: true })));
  const bot = registerBot({ larkAppId: 'b1', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [OWNER] });
  bot.botOpenId = ME;
  bot.resolvedAllowedUsers = [OWNER];
  tmpDir = mkdtempSync(join(tmpdir(), 'invite-cmd-'));
  config.session.dataDir = tmpDir;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.SESSION_DATA_DIR;
});

describe('parseInviteArgs', () => {
  it('parses --app with space and = forms, deduped', () => {
    expect(parseInviteArgs('/invite --app cli_a --app=cli_b --app cli_a', [])).toEqual({
      appIds: ['cli_a', 'cli_b'], badAppTokens: [], leftover: '',
    });
  });
  it('flags non-cli_ tokens after --app', () => {
    const r = parseInviteArgs('/invite --app not_an_app', []);
    expect(r.appIds).toEqual([]);
    expect(r.badAppTokens).toEqual(['not_an_app']);
  });
  it('flags dangling --app', () => {
    expect(parseInviteArgs('/invite --app', []).badAppTokens.length).toBe(1);
  });
  it('captures leftover garbage tokens', () => {
    expect(parseInviteArgs('/invite 乱七八糟', []).leftover).toBe('乱七八糟');
  });
  it('strips mention display names before tokenizing', () => {
    const r = parseInviteArgs('/invite @张 三 --app cli_a', [{ name: '张 三' }]);
    expect(r.appIds).toEqual(['cli_a']);
    expect(r.leftover).toBe('');
  });
});

describe('readBotsInfoEntries', () => {
  it('returns [] when file missing', () => {
    expect(readBotsInfoEntries()).toEqual([]);
  });
  it('parses entries with larkAppId', () => {
    writeBotsInfo([{ larkAppId: 'cli_codex', botName: 'Codex' }]);
    expect(readBotsInfoEntries()).toEqual([{ larkAppId: 'cli_codex', botName: 'Codex' }]);
  });
});

describe('tryHandleInviteCommand — 拦截与闸门', () => {
  it('unrelated message is not intercepted', async () => {
    const msg = inviteMessage({ text: '@_user_1 帮我看下代码' });
    expect(await tryHandleInviteCommand('b1', msg, OWNER)).toBe(false);
  });

  it('non-owner: replies owner_only, never calls addBotToChat', async () => {
    writeBotsInfo([{ larkAppId: 'cli_codex', botName: 'Codex' }]);
    expect(await tryHandleInviteCommand('b1', inviteMessage(), 'ou_intruder')).toBe(true);
    expect(addBotMock).not.toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalled();
    expect(String(replyMock.mock.calls.at(-1)![2])).toContain('owner');
  });

  it('another bot addressed (I am not mentioned): intercepted but fully silent', async () => {
    const msg = inviteMessage({ mentions: [
      { key: '@_user_1', id: { open_id: 'ou_otherbot' }, name: 'CoCo' },
      { key: '@_user_2', id: { open_id: 'ou_codex' }, name: 'Codex' },
    ] });
    expect(await tryHandleInviteCommand('b1', msg, OWNER)).toBe(true);
    expect(replyMock).not.toHaveBeenCalled();
    expect(addBotMock).not.toHaveBeenCalled();
  });

  it('target-only guard: I am @ed AFTER /invite → silent (I am the invitee, not the operator)', async () => {
    const msg = inviteMessage({
      text: '@_user_1 /invite @_user_2',
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_opbot' }, name: 'OpBot' },
        { key: '@_user_2', id: { open_id: ME }, name: 'Claude' },
      ],
    });
    expect(await tryHandleInviteCommand('b1', msg, OWNER)).toBe(true);
    expect(replyMock).not.toHaveBeenCalled();
    expect(addBotMock).not.toHaveBeenCalled();
  });

  it('p2p chat: refuses with p2p reply', async () => {
    expect(await tryHandleInviteCommand('b1', inviteMessage({ chatType: 'p2p' }), OWNER)).toBe(true);
    expect(addBotMock).not.toHaveBeenCalled();
    expect(String(replyMock.mock.calls.at(-1)![2])).toContain('私聊');
  });

  it('p2p without any @ (real DM form): still gets the p2p reply, not silence', async () => {
    const msg = { message_id: 'om_dm', chat_id: 'oc_dm', chat_type: 'p2p', content: JSON.stringify({ text: '/invite @Codex' }), mentions: [] };
    expect(await tryHandleInviteCommand('b1', msg, OWNER)).toBe(true);
    expect(addBotMock).not.toHaveBeenCalled();
    expect(String(replyMock.mock.calls.at(-1)![2])).toContain('私聊');
  });

  it('no targets at all → usage reply, no API call', async () => {
    const msg = inviteMessage({ text: '@_user_1 /invite', mentions: [
      { key: '@_user_1', id: { open_id: ME }, name: 'Claude' },
    ] });
    expect(await tryHandleInviteCommand('b1', msg, OWNER)).toBe(true);
    expect(addBotMock).not.toHaveBeenCalled();
    expect(String(replyMock.mock.calls.at(-1)![2])).toContain('用法');
  });

  it('bad --app token → usage reply', async () => {
    const msg = inviteMessage({ text: '@_user_1 /invite --app oops', mentions: [
      { key: '@_user_1', id: { open_id: ME }, name: 'Claude' },
    ] });
    expect(await tryHandleInviteCommand('b1', msg, OWNER)).toBe(true);
    expect(addBotMock).not.toHaveBeenCalled();
    expect(String(replyMock.mock.calls.at(-1)![2])).toContain('用法');
  });
});

describe('tryHandleInviteCommand — 解析与拉人', () => {
  it('happy path: unique roster name resolves and is added', async () => {
    writeBotsInfo([{ larkAppId: 'cli_codex', botName: 'Codex' }]);
    expect(await tryHandleInviteCommand('b1', inviteMessage(), OWNER)).toBe(true);
    expect(addBotMock).toHaveBeenCalledWith('b1', 'oc_1', ['cli_codex']);
    const out = String(replyMock.mock.calls.at(-1)![2]);
    expect(out).toContain('已拉进群');
    expect(out).toContain('Codex');
  });

  it('already-in-chat target (live roster openId match) is skipped', async () => {
    writeBotsInfo([{ larkAppId: 'cli_codex', botName: 'Codex' }]);
    rosterMock.mockImplementation(async () => [
      { larkAppId: 'cli_codex', openId: 'ou_codex', name: 'Codex', displayName: 'Codex' },
    ]);
    expect(await tryHandleInviteCommand('b1', inviteMessage(), OWNER)).toBe(true);
    expect(addBotMock).not.toHaveBeenCalled();
    expect(String(replyMock.mock.calls.at(-1)![2])).toContain('已在群内');
  });

  it('name not in bots-info → unresolved with --app hint, no add', async () => {
    writeBotsInfo([{ larkAppId: 'cli_gemini', botName: 'Gemini' }]);
    expect(await tryHandleInviteCommand('b1', inviteMessage(), OWNER)).toBe(true);
    expect(addBotMock).not.toHaveBeenCalled();
    const out = String(replyMock.mock.calls.at(-1)![2]);
    expect(out).toContain('无法解析');
    expect(out).toContain('Codex');
    expect(out).toContain('--app');
  });

  it('duplicate display name → ambiguous with candidate app ids, no add', async () => {
    writeBotsInfo([
      { larkAppId: 'cli_dup1', botName: 'Codex' },
      { larkAppId: 'cli_dup2', botName: 'Codex' },
    ]);
    expect(await tryHandleInviteCommand('b1', inviteMessage(), OWNER)).toBe(true);
    expect(addBotMock).not.toHaveBeenCalled();
    const out = String(replyMock.mock.calls.at(-1)![2]);
    expect(out).toContain('多个机器人');
    // 本机同名多候选：候选带来源标注（local），与跨源歧义同款格式。
    expect(out).toContain('cli_dup1(local)');
    expect(out).toContain('cli_dup2(local)');
  });

  it('--app bypasses name resolution (also works for bots outside the roster)', async () => {
    writeBotsInfo([]);
    const msg = inviteMessage({ text: '@_user_1 /invite --app cli_ext', mentions: [
      { key: '@_user_1', id: { open_id: ME }, name: 'Claude' },
    ] });
    expect(await tryHandleInviteCommand('b1', msg, OWNER)).toBe(true);
    expect(addBotMock).toHaveBeenCalledWith('b1', 'oc_1', ['cli_ext']);
    expect(String(replyMock.mock.calls.at(-1)![2])).toContain('已拉进群');
  });

  it('mixed batch: resolvable added, already-in-chat skipped, unresolved reported — only resolvable hits the API', async () => {
    writeBotsInfo([{ larkAppId: 'cli_codex', botName: 'Codex' }]);
    rosterMock.mockImplementation(async () => [
      { larkAppId: 'b1', openId: ME, name: 'Claude', displayName: 'Claude' },
      { larkAppId: 'cli_gemini', openId: 'ou_gemini', name: 'Gemini', displayName: 'Gemini' },
    ]);
    const msg = inviteMessage({
      text: '@_user_1 /invite @_user_2 @_user_3 @_user_4',
      mentions: [
        { key: '@_user_1', id: { open_id: ME }, name: 'Claude' },
        { key: '@_user_2', id: { open_id: 'ou_codex' }, name: 'Codex' },
        { key: '@_user_3', id: { open_id: 'ou_gemini' }, name: 'Gemini' },
        { key: '@_user_4', id: { open_id: 'ou_ghost' }, name: 'Ghost' },
      ],
    });
    expect(await tryHandleInviteCommand('b1', msg, OWNER)).toBe(true);
    expect(addBotMock).toHaveBeenCalledWith('b1', 'oc_1', ['cli_codex']);
    const out = String(replyMock.mock.calls.at(-1)![2]);
    expect(out).toContain('Codex');
    expect(out).toContain('已在群内');
    expect(out).toContain('Gemini');
    expect(out).toContain('无法解析');
    expect(out).toContain('Ghost');
  });

  it('whole-batch failure falls back to per-id invites and reports individual results', async () => {
    writeBotsInfo([
      { larkAppId: 'cli_codex', botName: 'Codex' },
      { larkAppId: 'cli_gemini', botName: 'Gemini' },
    ]);
    addBotMock
      .mockImplementationOnce(async (_a, _c, ids: string[]) => ids.map(id => ({ id, ok: false, error: 'batch boom' })))
      .mockImplementation(async (_a, _c, ids: string[]) =>
        ids.map(id => ({ id, ok: id !== 'cli_gemini', ...(id === 'cli_gemini' ? { error: 'invalid_id' } : {}) })));
    const msg = inviteMessage({
      text: '@_user_1 /invite @_user_2 @_user_3',
      mentions: [
        { key: '@_user_1', id: { open_id: ME }, name: 'Claude' },
        { key: '@_user_2', id: { open_id: 'ou_codex' }, name: 'Codex' },
        { key: '@_user_3', id: { open_id: 'ou_gemini' }, name: 'Gemini' },
      ],
    });
    expect(await tryHandleInviteCommand('b1', msg, OWNER)).toBe(true);
    // 1 次批量（全失败）+ 2 次逐个 = 3 次调用
    expect(addBotMock).toHaveBeenCalledTimes(3);
    const out = String(replyMock.mock.calls.at(-1)![2]);
    expect(out).toContain('已拉进群');
    expect(out).toContain('Codex');
    expect(out).toContain('拉入失败');
    expect(out).toContain('Gemini');
  });

  it('post (rich-text) form: operator at-node + invite text node + target at-node', async () => {
    writeBotsInfo([{ larkAppId: 'cli_codex', botName: 'Codex' }]);
    const postMsg = {
      message_id: 'om_post', chat_id: 'oc_1',
      content: JSON.stringify({ zh_cn: { content: [[
        { tag: 'at', user_id: ME, user_name: 'Claude' },
        { tag: 'text', text: ' /invite ' },
        { tag: 'at', user_id: 'ou_codex', user_name: 'Codex' },
      ]] } }),
      mentions: [],
    };
    expect(await tryHandleInviteCommand('b1', postMsg, OWNER)).toBe(true);
    expect(addBotMock).toHaveBeenCalledWith('b1', 'oc_1', ['cli_codex']);
  });
});

// 回归锁（codex blocker）：飞书对「群外 bot」的 @ 是 app_id 形态
// （{id_type:'app_id', id:'cli_xxx'} 或 object {app_id:'cli_xxx'}），
// 过去 mentionOpenId 直接 drop → 目标空 → 误回 usage 不拉人。这些用例在修复前必挂。
describe('tryHandleInviteCommand — app_id 形态目标（群外 bot 主场景）', () => {
  it('text form, target mention as app_id OBJECT (WS shape, no open_id) → invited by app_id directly', async () => {
    writeBotsInfo([]);   // 花名册为空也应能拉（app_id 自带，不依赖名字解析）
    const msg = inviteMessage({
      text: '@_user_1 /invite @_user_2',
      mentions: [
        { key: '@_user_1', id: { open_id: ME }, name: 'Claude' },
        { key: '@_user_2', id: { app_id: 'cli_codex' }, name: 'Codex' },
      ],
    });
    expect(await tryHandleInviteCommand('b1', msg, OWNER)).toBe(true);
    expect(addBotMock).toHaveBeenCalledWith('b1', 'oc_1', ['cli_codex']);
    expect(String(replyMock.mock.calls.at(-1)![2])).toContain('已拉进群');
  });

  it('text form, target mention as app_id STRING (REST shape) → invited by app_id directly', async () => {
    writeBotsInfo([]);
    const msg = inviteMessage({
      text: '@_user_1 /invite @_user_2',
      mentions: [
        { key: '@_user_1', id: { open_id: ME }, name: 'Claude' },
        { key: '@_user_2', id: 'cli_codex', id_type: 'app_id', name: 'Codex' },
      ],
    });
    expect(await tryHandleInviteCommand('b1', msg, OWNER)).toBe(true);
    expect(addBotMock).toHaveBeenCalledWith('b1', 'oc_1', ['cli_codex']);
  });

  it('post form, target at-node carries cli_ app_id in user_id → invited directly', async () => {
    writeBotsInfo([]);
    const postMsg = {
      message_id: 'om_post2', chat_id: 'oc_1',
      content: JSON.stringify({ zh_cn: { content: [[
        { tag: 'at', user_id: ME, user_name: 'Claude' },
        { tag: 'text', text: ' /invite ' },
        { tag: 'at', user_id: 'cli_codex', user_name: 'Codex' },
      ]] } }),
      mentions: [],
    };
    expect(await tryHandleInviteCommand('b1', postMsg, OWNER)).toBe(true);
    expect(addBotMock).toHaveBeenCalledWith('b1', 'oc_1', ['cli_codex']);
  });

  it('app_id target already in chat (roster app_id match) is skipped, not re-invited', async () => {
    writeBotsInfo([]);
    rosterMock.mockImplementation(async () => [
      { larkAppId: 'cli_codex', openId: 'ou_codex_scoped', name: 'Codex', displayName: 'Codex' },
    ]);
    const msg = inviteMessage({
      text: '@_user_1 /invite @_user_2',
      mentions: [
        { key: '@_user_1', id: { open_id: ME }, name: 'Claude' },
        { key: '@_user_2', id: { app_id: 'cli_codex' }, name: 'Codex' },
      ],
    });
    expect(await tryHandleInviteCommand('b1', msg, OWNER)).toBe(true);
    expect(addBotMock).not.toHaveBeenCalled();
    expect(String(replyMock.mock.calls.at(-1)![2])).toContain('已在群内');
  });

  it('target-only guard fires when THIS bot is @ed as app_id after /invite (SAME owner) → fully silent', async () => {
    // `@OpBot /invite @ThisBot`，本 bot 以 app_id 形态(larkAppId=b1)被 @ 在命令词之后
    // = 本 bot 是 invitee，命令属于前导 @ 的 OpBot → 必须静默放手：既不拉人也不回复。
    const msg = inviteMessage({
      text: '@_user_1 /invite @_user_2',
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_opbot' }, name: 'OpBot' },
        { key: '@_user_2', id: 'b1', id_type: 'app_id', name: 'Claude' },
      ],
    });
    expect(await tryHandleInviteCommand('b1', msg, OWNER)).toBe(true);
    // 行为断言（不是只看拉人 API）：target-only 必须两者都不调用，否则会多回一条「已在群内」。
    expect(addBotMock).not.toHaveBeenCalled();
    expect(replyMock).not.toHaveBeenCalled();
  });

  it('target-only guard fires when THIS bot is @ed as app_id after /invite (CROSS owner) → no owner_only leak', async () => {
    // 命令属于别的 daemon 的 owner；本 bot 是 app_id 形态的 invitee。修复前 guard 漏判 →
    // 走到 owner 闸门对陌生 sender 误回 owner_only（异主泄漏）。契约=静默放手。
    const msg = inviteMessage({
      text: '@_user_1 /invite @_user_2',
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_opbot' }, name: 'OpBot' },
        { key: '@_user_2', id: 'b1', id_type: 'app_id', name: 'Claude' },
      ],
    });
    expect(await tryHandleInviteCommand('b1', msg, 'ou_not_my_owner')).toBe(true);
    expect(addBotMock).not.toHaveBeenCalled();
    expect(replyMock).not.toHaveBeenCalled();   // 不泄漏 owner_only
  });

  it('target-only guard fires for post form when THIS bot at-node (cli_ app_id) is after /invite', async () => {
    const postMsg = {
      message_id: 'om_post3', chat_id: 'oc_1',
      content: JSON.stringify({ zh_cn: { content: [[
        { tag: 'at', user_id: 'ou_opbot', user_name: 'OpBot' },
        { tag: 'text', text: ' /invite ' },
        { tag: 'at', user_id: 'b1', user_name: 'Claude' },   // 本 bot 以 app_id 形态被 @ 在命令后
      ]] } }),
      mentions: [],
    };
    expect(await tryHandleInviteCommand('b1', postMsg, OWNER)).toBe(true);
    expect(addBotMock).not.toHaveBeenCalled();
    expect(replyMock).not.toHaveBeenCalled();
  });
});

// isCommandTargetOnly 单元级：直接锁 guard 机制识别 app_id 形态本 bot（text + post）。
// handler 级的 post 用例在修复前靠 isBotMentioned 选举门也会静默（同 end-behavior），
// 无法单独证明 guard 有牙；这里直接断言 guard 返回值，修复前 post/text 两支都必挂。
describe('isCommandTargetOnly — app_id 形态本 bot 识别', () => {
  const INVITE = /\/invite\b/i;
  const APPID = 'cli_me';

  it('text: bot @ed as app_id AFTER cmd → true (needs botAppId arg)', () => {
    const msg = { content: JSON.stringify({ text: '@_user_1 /invite @_user_2' }), mentions: [
      { key: '@_user_1', id: { open_id: 'ou_op' }, name: 'Op' },
      { key: '@_user_2', id: APPID, id_type: 'app_id', name: 'Me' },
    ] };
    expect(isCommandTargetOnly(msg, 'ou_me', INVITE, APPID)).toBe(true);
  });

  it('post: bot at-node app_id AFTER cmd → true (needs botAppId arg)', () => {
    const msg = { content: JSON.stringify({ zh_cn: { content: [[
      { tag: 'at', user_id: 'ou_op', user_name: 'Op' },
      { tag: 'text', text: ' /invite ' },
      { tag: 'at', user_id: APPID, user_name: 'Me' },
    ]] } }), mentions: [] };
    expect(isCommandTargetOnly(msg, 'ou_me', INVITE, APPID)).toBe(true);
  });

  it('text: bot @ed as app_id BEFORE cmd (operator role) → false (not target-only)', () => {
    const msg = { content: JSON.stringify({ text: '@_user_1 /invite @_user_2' }), mentions: [
      { key: '@_user_1', id: APPID, id_type: 'app_id', name: 'Me' },
      { key: '@_user_2', id: { open_id: 'ou_target' }, name: 'T' },
    ] };
    expect(isCommandTargetOnly(msg, 'ou_me', INVITE, APPID)).toBe(false);
  });
});

describe('tryHandleInviteCommand — 团队目录兜底解析（跨部署「同团队」bot）', () => {
  it('platform team sync hit: name missing from local bots-info still resolves', async () => {
    writeBotsInfo([]);
    writePlatformSync([{ appId: 'cli_sg1', name: 'botmux开发者(claude@sg1)' }]);
    const msg = inviteMessage({ mentions: [
      { key: '@_user_1', id: { open_id: ME }, name: 'Claude' },
      { key: '@_user_2', id: { open_id: 'ou_sg1bot' }, name: 'botmux开发者(claude@sg1)' },
    ] });
    expect(await tryHandleInviteCommand('b1', msg, OWNER)).toBe(true);
    expect(addBotMock).toHaveBeenCalledWith('b1', 'oc_1', ['cli_sg1']);
    const out = String(replyMock.mock.calls.at(-1)![2]);
    expect(out).toContain('已拉进群');
    expect(out).toContain('botmux开发者(claude@sg1)');   // 展示名，不退化成裸 appId
  });

  it('hosted federation member hit resolves', async () => {
    writeBotsInfo([]);
    writeHostedFederations([{ larkAppId: 'cli_fedbot', botName: 'Codex远程' }]);
    const msg = inviteMessage({ mentions: [
      { key: '@_user_1', id: { open_id: ME }, name: 'Claude' },
      { key: '@_user_2', id: { open_id: 'ou_fedbot' }, name: 'Codex远程' },
    ] });
    expect(await tryHandleInviteCommand('b1', msg, OWNER)).toBe(true);
    expect(addBotMock).toHaveBeenCalledWith('b1', 'oc_1', ['cli_fedbot']);
  });

  it('spoke→hub roster hit resolves via HTTP with syncToken', async () => {
    writeBotsInfo([]);
    writeMemberships();
    const fetchStub = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: true, bots: [{ larkAppId: 'cli_sg1', name: 'botmux开发者(claude@sg1)', deployment: { name: 'sg1' } }] }),
    }));
    vi.stubGlobal('fetch', fetchStub as any);
    try {
      const msg = inviteMessage({ mentions: [
        { key: '@_user_1', id: { open_id: ME }, name: 'Claude' },
        { key: '@_user_2', id: { open_id: 'ou_sg1bot' }, name: 'botmux开发者(claude@sg1)' },
      ] });
      expect(await tryHandleInviteCommand('b1', msg, OWNER)).toBe(true);
      expect(addBotMock).toHaveBeenCalledWith('b1', 'oc_1', ['cli_sg1']);
      const [, init] = fetchStub.mock.calls[0] as any;
      expect(init.headers.authorization).toBe('Bearer tok');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cross-app same name across team directory → ambiguous with source annotations, nothing added', async () => {
    writeBotsInfo([]);
    writePlatformSync([
      { appId: 'cli_a', name: 'Codex' },
      { appId: 'cli_b', name: 'codex' },   // 大小写不敏感同名
    ]);
    expect(await tryHandleInviteCommand('b1', inviteMessage(), OWNER)).toBe(true);
    expect(addBotMock).not.toHaveBeenCalled();
    const out = String(replyMock.mock.calls.at(-1)![2]);
    expect(out).toContain('多个机器人');
    expect(out).toContain('cli_a(platform:t1)');
    expect(out).toContain('cli_b(platform:t1)');
  });

  it('no team directory sources → unresolved AND no hub HTTP attempted', async () => {
    writeBotsInfo([]);
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub as any);
    try {
      expect(await tryHandleInviteCommand('b1', inviteMessage(), OWNER)).toBe(true);
      expect(addBotMock).not.toHaveBeenCalled();
      expect(String(replyMock.mock.calls.at(-1)![2])).toContain('无法解析');
      expect(fetchStub).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('local-only hit with NO team sources resolves without any HTTP', async () => {
    writeBotsInfo([{ larkAppId: 'cli_codex', botName: 'Codex' }]);
    // 无 memberships / 平台名册 / 托管联邦 → hasAnyTeamDirectorySource=false → 不发 HTTP。
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub as any);
    try {
      expect(await tryHandleInviteCommand('b1', inviteMessage(), OWNER)).toBe(true);
      expect(addBotMock).toHaveBeenCalledWith('b1', 'oc_1', ['cli_codex']);
      expect(fetchStub).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('local hit + team sources present: STILL consults the directory (cannot assume local is unique), resolves to local when team adds no rival', async () => {
    writeBotsInfo([{ larkAppId: 'cli_codex', botName: 'Codex' }]);
    writeMemberships();                              // 有团队源 → 必须查目录核对唯一性
    const fetchStub = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, bots: [] }) }));
    vi.stubGlobal('fetch', fetchStub as any);
    try {
      expect(await tryHandleInviteCommand('b1', inviteMessage(), OWNER)).toBe(true);
      expect(addBotMock).toHaveBeenCalledWith('b1', 'oc_1', ['cli_codex']);
      expect(fetchStub).toHaveBeenCalled();          // 关键：不再因「本机命中」短路跳过团队目录
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('P1 regression: local name hit + DIFFERENT-app same name in team directory → ambiguous, nothing added (no silent wrong-bot pull)', async () => {
    // 本机 Codex→cli_local；团队里 Codex→cli_remote（用户 @ 的可能正是远端那个，但
    // mention 没带 app_id）。修复前：本机恰 1 个候选就静默拉 cli_local。修复后：合并
    // 去重后有 2 个不同 app → 报歧义，一个都不拉。
    writeBotsInfo([{ larkAppId: 'cli_local', botName: 'Codex' }]);
    writePlatformSync([{ appId: 'cli_remote', name: 'Codex' }]);
    expect(await tryHandleInviteCommand('b1', inviteMessage(), OWNER)).toBe(true);
    expect(addBotMock).not.toHaveBeenCalled();
    const out = String(replyMock.mock.calls.at(-1)![2]);
    expect(out).toContain('多个机器人');
    expect(out).toContain('cli_local(local)');
    expect(out).toContain('cli_remote(platform:t1)');
  });

  it('P1: same appId in both local roster and team directory → deduped to ONE, resolves (not spurious ambiguity)', async () => {
    // 同一个 app 同时在本机花名册和平台名册出现，不能误报歧义。
    writeBotsInfo([{ larkAppId: 'cli_codex', botName: 'Codex' }]);
    writePlatformSync([{ appId: 'cli_codex', name: 'Codex' }]);
    expect(await tryHandleInviteCommand('b1', inviteMessage(), OWNER)).toBe(true);
    expect(addBotMock).toHaveBeenCalledWith('b1', 'oc_1', ['cli_codex']);
  });
});
