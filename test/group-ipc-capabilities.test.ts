import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __testOnly_resetBotRegistry,
  getBot,
  LarkTransportDisabledError,
  registerBot,
} from '../src/bot-registry.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import {
  setIpcAuthSecret,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import {
  normalizeGroupLarkAppIds,
  parseGroupCreateOptions,
  parseGroupShareLinkRequest,
  parseGroupTopNoticeRequest,
  prepareDashboardGroupCreate,
} from '../src/core/group-ipc-options.js';
import { invalidateGlobalConfigCache, setGroupOwnerNoticeEnabled } from '../src/global-config.js';
import * as chatTopNotice from '../src/im/lark/chat-top-notice.js';
import * as larkClient from '../src/im/lark/client.js';
import * as groupsStore from '../src/services/groups-store.js';
import { spawnSyncTsScript, spawnTsScript } from './helpers/ts-runner.js';

const CLI_ENTRY = resolve(process.cwd(), 'src/cli.ts');
const CREATE_GROUP_FIXTURE = resolve(process.cwd(), 'test/fixtures/create-group-cli-capture.ts');

async function runCliAsync(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawnTsScript(CLI_ENTRY, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', status => resolvePromise({ status, stdout, stderr }));
  });
}

describe('group IPC & CLI capabilities', () => {
  let handle: IpcServerHandle | null = null;

  beforeEach(() => {
    vi.restoreAllMocks();
    __testOnly_resetBotRegistry();
    setIpcAuthSecret(null);
    setLarkAppId('');
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    setIpcAuthSecret(null);
    setLarkAppId('');
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    vi.restoreAllMocks();
  });

  describe('POST /api/groups/create (Daemon IPC)', () => {
    it('passes kickoffBotLarkAppId, kickoffPrompt, ownerNotice:false, managerUserIds (before owner transfer) and returns full CreateGroupResult', async () => {
      const creatorId = 'cli_creator_1';
      const peerId = 'cli_peer_1';
      setLarkAppId(creatorId);

      let ownerTransferred = false;
      const order: string[] = [];

      const createSpy = vi.spyOn(groupsStore, 'createChat').mockResolvedValue({
        chatId: 'oc_created_full',
        invalidBotIds: [],
        invalidUserIds: [],
      });
      const addBotSpy = vi.spyOn(groupsStore, 'addBotToChat').mockResolvedValue([
        { id: peerId, ok: true },
      ]);
      const shareLinkSpy = vi.spyOn(groupsStore, 'getChatShareLink').mockResolvedValue({
        ok: true,
        shareLink: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=tok_full',
      });
      const transferSpy = vi.spyOn(groupsStore, 'transferChatOwner').mockImplementation(async () => {
        order.push('transfer');
        ownerTransferred = true;
        return { ok: true };
      });
      const managersSpy = vi.spyOn(groupsStore, 'addChatManagers').mockImplementation(async (_app, _chat, ids) => {
        order.push('managers');
        // Real Feishu invariant: creator bot cannot add managers after ownership transfer (code 232025).
        if (ownerTransferred) return { ok: false, error: 'only owner can add managers (code: 232025)' };
        return { ok: true, addedManagers: ids };
      });
      const botMembersSpy = vi.spyOn(larkClient, 'listChatBotMembers').mockResolvedValue([
        {
          larkAppId: peerId,
          openId: 'ou_peer_in_creator_scope',
          name: 'Peer Bot',
          displayName: 'Peer Bot',
          source: 'configured',
          hasTeamRole: false,
          mentionable: true,
          mentionSource: 'cross-ref',
        },
      ]);
      const sendSpy = vi.spyOn(larkClient, 'sendMessage').mockResolvedValue('om_kickoff_1');

      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Multi-Bot Collaboration',
          creatorLarkAppId: creatorId,
          larkAppIds: [` ${creatorId} `, ` ${peerId} `, peerId],
          chatMode: 'topic',
          userOpenIds: ['ou_owner_1'],
          transferOwnerTo: 'ou_owner_1',
          notifyOwnerOpenId: 'ou_owner_1',
          ownerNotice: false,
          managerUserIds: [' ou_mgr_1 ', 'ou_mgr_1', 'ou_mgr_2'],
          kickoffBotLarkAppId: ` ${peerId} `,
          kickoffPrompt: '  请开始协作任务  ',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        ok: true,
        chatId: 'oc_created_full',
        creator: creatorId,
        shareLink: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=tok_full',
        shareLinkError: null,
        ownerTransferredTo: 'ou_owner_1',
        transferError: null,
        managersAdded: ['ou_mgr_1', 'ou_mgr_2'],
        managerError: null,
        notifyMessageId: null,
        notifyError: null,
        kickoffMessageId: 'om_kickoff_1',
        kickoffError: null,
      });

      // Managers are auto-invited in createChat and added BEFORE transferChatOwner.
      expect(order).toEqual(['managers', 'transfer']);
      expect(createSpy).toHaveBeenCalledWith(creatorId, {
        name: 'Multi-Bot Collaboration',
        botIds: [],
        userIds: ['ou_owner_1', 'ou_mgr_1', 'ou_mgr_2'],
        chatMode: 'topic',
      });
      // Trimmed and deduplicated peer bot invite list.
      expect(addBotSpy).toHaveBeenCalledWith(creatorId, 'oc_created_full', [peerId]);
      expect(shareLinkSpy).toHaveBeenCalledWith(creatorId, 'oc_created_full');
      expect(transferSpy).toHaveBeenCalledWith(creatorId, 'oc_created_full', 'ou_owner_1');
      expect(managersSpy).toHaveBeenCalledWith(creatorId, 'oc_created_full', ['ou_mgr_1', 'ou_mgr_2']);
      expect(botMembersSpy).toHaveBeenCalledWith(creatorId, 'oc_created_full');
      // Only kickoff message was sent — ownerNotice: false suppressed the @-owner notice.
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith(
        creatorId,
        'oc_created_full',
        '<at user_id="ou_peer_in_creator_scope"></at> 请开始协作任务',
        'text',
      );
    });

    it('falls back to promoting transferOwnerTo as manager only when ownership transfer fails', async () => {
      setLarkAppId('cli_creator_fb');
      vi.spyOn(groupsStore, 'createChat').mockResolvedValue({
        chatId: 'oc_transfer_fail',
        invalidBotIds: [],
        invalidUserIds: [],
      });
      vi.spyOn(groupsStore, 'getChatShareLink').mockResolvedValue({ ok: true, shareLink: 'https://example.test/l' });
      vi.spyOn(groupsStore, 'transferChatOwner').mockResolvedValue({ ok: false, error: 'transfer_denied' });
      vi.spyOn(groupsStore, 'getChatOwner').mockResolvedValue('ou_creator_bot');
      const managersSpy = vi.spyOn(groupsStore, 'addChatManagers').mockImplementation(async (_app, _chat, ids) => ({
        ok: true,
        addedManagers: ids,
      }));

      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          larkAppIds: ['cli_creator_fb'],
          userOpenIds: ['ou_owner_fb', 'ou_mgr_fb'],
          transferOwnerTo: 'ou_owner_fb',
          ownerNotice: false,
          managerUserIds: ['ou_owner_fb', 'ou_mgr_fb'],
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        ownerTransferredTo: null,
        transferError: 'transfer_denied',
        managersAdded: ['ou_mgr_fb', 'ou_owner_fb'],
        managerError: null,
      });
      expect(managersSpy).toHaveBeenNthCalledWith(1, 'cli_creator_fb', 'oc_transfer_fail', ['ou_mgr_fb']);
      expect(managersSpy).toHaveBeenNthCalledWith(2, 'cli_creator_fb', 'oc_transfer_fail', ['ou_owner_fb']);
    });

    it('keeps legacy ownerNotice behavior when omitted or true while global groupOwnerNotice is enabled', async () => {
      const cfgDir = mkdtempSync(join(tmpdir(), 'group-ipc-owner-notice-on-'));
      try {
        vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE', join(cfgDir, 'config.json'));
        invalidateGlobalConfigCache();
        setGroupOwnerNoticeEnabled(true);

        setLarkAppId('cli_creator_notice_on');
        vi.spyOn(groupsStore, 'createChat').mockResolvedValue({
          chatId: 'oc_notice_on',
          invalidBotIds: [],
          invalidUserIds: [],
        });
        vi.spyOn(groupsStore, 'getChatShareLink').mockResolvedValue({ ok: true, shareLink: 'https://example.test/link' });
        const sendSpy = vi.spyOn(larkClient, 'sendMessage').mockResolvedValue('om_owner_notice_1');

        handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
        for (const extra of [{}, { ownerNotice: true }]) {
          sendSpy.mockClear();
          const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups/create`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              larkAppIds: ['cli_creator_notice_on'],
              userOpenIds: ['ou_owner_on'],
              notifyOwnerOpenId: 'ou_owner_on',
              ...extra,
            }),
          });
          expect(res.status).toBe(200);
          expect(await res.json()).toMatchObject({
            ok: true,
            chatId: 'oc_notice_on',
            notifyMessageId: 'om_owner_notice_1',
            notifyError: null,
          });
          expect(sendSpy).toHaveBeenCalledTimes(1);
          expect(sendSpy.mock.calls[0]?.[2]).toContain('<at user_id="ou_owner_on"></at>');
        }
      } finally {
        rmSync(cfgDir, { recursive: true, force: true });
      }
    });

    it('preserves shareLinkError in response when getChatShareLink fails', async () => {
      setLarkAppId('cli_creator_2');
      vi.spyOn(groupsStore, 'createChat').mockResolvedValue({
        chatId: 'oc_no_link',
        invalidBotIds: [],
        invalidUserIds: [],
      });
      vi.spyOn(groupsStore, 'getChatShareLink').mockResolvedValue({
        ok: false,
        error: 'permission_denied (code: 99991672)',
      });

      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ larkAppIds: ['cli_creator_2'] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        chatId: 'oc_no_link',
        shareLink: null,
        shareLinkError: 'permission_denied (code: 99991672)',
        kickoffMessageId: null,
        kickoffError: null,
      });
    });

    it('keeps ownerNotice:true respecting machine-wide groupOwnerNotice=false', async () => {
      const cfgDir = mkdtempSync(join(tmpdir(), 'group-ipc-owner-notice-'));
      try {
        vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE', join(cfgDir, 'config.json'));
        invalidateGlobalConfigCache();
        setGroupOwnerNoticeEnabled(false);

        setLarkAppId('cli_creator_3');
        vi.spyOn(groupsStore, 'createChat').mockResolvedValue({
          chatId: 'oc_global_off',
          invalidBotIds: [],
          invalidUserIds: [],
        });
        vi.spyOn(groupsStore, 'getChatShareLink').mockResolvedValue({
          ok: true,
          shareLink: 'https://example.test/link',
        });
        const sendSpy = vi.spyOn(larkClient, 'sendMessage').mockResolvedValue('om_unexpected');

        handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
        const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups/create`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            larkAppIds: ['cli_creator_3'],
            userOpenIds: ['ou_owner_3'],
            notifyOwnerOpenId: 'ou_owner_3',
            ownerNotice: true,
          }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
          ok: true,
          chatId: 'oc_global_off',
          notifyMessageId: null,
          notifyError: null,
        });
        expect(sendSpy).not.toHaveBeenCalled();
      } finally {
        rmSync(cfgDir, { recursive: true, force: true });
      }
    });

    it('enforces HMAC auth, bound-bot port-reuse guard (409), and apiOnly transport guard (400 accepted:false) on /api/groups/create', async () => {
      const secret = 'Z3JvdXAtY3JlYXRlLWF1dGgtaG1hYy10ZXN0LXNlY3JldA';
      registerBot({ larkAppId: 'cli_auth_create', larkAppSecret: 's', cliId: 'claude-code', workingDir: process.cwd() });
      registerBot({ larkAppId: 'cli_apionly_create', larkAppSecret: '', cliId: 'claude-code', apiOnly: true, workingDir: process.cwd() });
      setLarkAppId('cli_auth_create');
      setIpcAuthSecret(secret);

      const createSpy = vi.spyOn(groupsStore, 'createChat').mockResolvedValue({
        chatId: 'oc_auth_created',
        invalidBotIds: [],
        invalidUserIds: [],
      });
      vi.spyOn(groupsStore, 'getChatShareLink').mockResolvedValue({ ok: true, shareLink: 'https://example.test/l' });

      handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });

      // 1. Unauthenticated request → 401.
      const unauth = await fetch(`http://127.0.0.1:${handle.port}/api/groups/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ larkAppIds: ['cli_auth_create'] }),
      });
      expect(unauth.status).toBe(401);

      // 2. Port-reuse / wrong creatorLarkAppId (even when both bots are in larkAppIds) → 409 bot_mismatch, accepted:false.
      const wrongCreator = await fetchDaemonIpc(handle.port, '/api/groups/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          creatorLarkAppId: 'cli_other_bot',
          larkAppIds: ['cli_auth_create', 'cli_other_bot'],
        }),
      }, secret);
      expect(wrongCreator.status).toBe(409);
      expect(await wrongCreator.json()).toEqual({ ok: false, error: 'bot_mismatch', accepted: false });

      // 3. Bound bot absent from larkAppIds → 409 bot_mismatch, accepted:false.
      const missingSelf = await fetchDaemonIpc(handle.port, '/api/groups/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ larkAppIds: ['cli_other_bot'] }),
      }, secret);
      expect(missingSelf.status).toBe(409);
      expect(await missingSelf.json()).toEqual({ ok: false, error: 'bot_mismatch', accepted: false });

      // 4. Malformed creatorLarkAppId → 400 invalid_creator_lark_app_id, accepted:false.
      const badCreator = await fetchDaemonIpc(handle.port, '/api/groups/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creatorLarkAppId: ' cli_auth_create ', larkAppIds: ['cli_auth_create'] }),
      }, secret);
      expect(badCreator.status).toBe(400);
      expect(await badCreator.json()).toEqual({ ok: false, error: 'invalid_creator_lark_app_id', accepted: false });

      // 5. apiOnly daemon → 400 lark_transport_disabled, accepted:false BEFORE createChat.
      setLarkAppId('cli_apionly_create');
      const apiOnlyRes = await fetchDaemonIpc(handle.port, '/api/groups/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ larkAppIds: ['cli_apionly_create'] }),
      }, secret);
      expect(apiOnlyRes.status).toBe(400);
      expect(await apiOnlyRes.json()).toEqual({ ok: false, error: 'lark_transport_disabled', accepted: false });
      expect(createSpy).not.toHaveBeenCalled();

      // 6. Authenticated valid request on normal bot → 200.
      setLarkAppId('cli_auth_create');
      const okRes = await fetchDaemonIpc(handle.port, '/api/groups/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creatorLarkAppId: 'cli_auth_create', larkAppIds: ['cli_auth_create'] }),
      }, secret);
      expect(okRes.status).toBe(200);
      expect(await okRes.json()).toMatchObject({ ok: true, chatId: 'oc_auth_created' });
    });

    it('fails closed with accepted:false BEFORE createChat on every invalid new option or non-object body', async () => {
      setLarkAppId('cli_creator_4');
      const createSpy = vi.spyOn(groupsStore, 'createChat').mockResolvedValue({
        chatId: 'oc_must_not_exist',
        invalidBotIds: [],
        invalidUserIds: [],
      });
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

      const post = (payload: unknown) => fetch(`http://127.0.0.1:${handle!.port}/api/groups/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const cases: Array<[string, unknown, string]> = [
        ['null body', null, 'bad_json'],
        ['array body', ['cli_creator_4'], 'bad_json'],
        ['empty larkAppIds', { larkAppIds: [] }, 'larkAppIds_required'],
        ['blank item in larkAppIds', { larkAppIds: ['cli_creator_4', '   '] }, 'larkAppIds_required'],
        ['non-string item in larkAppIds', { larkAppIds: ['cli_creator_4', 123] }, 'larkAppIds_required'],
        ['unpaired kickoffBotLarkAppId', { larkAppIds: ['cli_creator_4', 'cli_p'], kickoffBotLarkAppId: 'cli_p' }, 'kickoff_args_must_be_paired'],
        ['unpaired kickoffPrompt', { larkAppIds: ['cli_creator_4', 'cli_p'], kickoffPrompt: 'hello' }, 'kickoff_args_must_be_paired'],
        ['blank kickoffBotLarkAppId', { larkAppIds: ['cli_creator_4', 'cli_p'], kickoffBotLarkAppId: '  ', kickoffPrompt: 'hi' }, 'invalid_kickoff_bot_lark_app_id'],
        ['non-string kickoffBotLarkAppId', { larkAppIds: ['cli_creator_4', 'cli_p'], kickoffBotLarkAppId: 123, kickoffPrompt: 'hi' }, 'invalid_kickoff_bot_lark_app_id'],
        ['blank kickoffPrompt', { larkAppIds: ['cli_creator_4', 'cli_p'], kickoffBotLarkAppId: 'cli_p', kickoffPrompt: '   ' }, 'invalid_kickoff_prompt'],
        ['non-string kickoffPrompt', { larkAppIds: ['cli_creator_4', 'cli_p'], kickoffBotLarkAppId: 'cli_p', kickoffPrompt: true }, 'invalid_kickoff_prompt'],
        ['self kickoff', { larkAppIds: ['cli_creator_4', 'cli_p'], kickoffBotLarkAppId: 'cli_creator_4', kickoffPrompt: 'hi' }, 'creator_cannot_kickoff_self'],
        ['kickoff bot not selected', { larkAppIds: ['cli_creator_4', 'cli_p'], kickoffBotLarkAppId: 'cli_other', kickoffPrompt: 'hi' }, 'kickoff_bot_not_selected'],
        ['string ownerNotice', { larkAppIds: ['cli_creator_4'], ownerNotice: 'false' }, 'invalid_owner_notice'],
        ['null ownerNotice', { larkAppIds: ['cli_creator_4'], ownerNotice: null }, 'invalid_owner_notice'],
        ['number ownerNotice', { larkAppIds: ['cli_creator_4'], ownerNotice: 0 }, 'invalid_owner_notice'],
        ['non-array managerUserIds', { larkAppIds: ['cli_creator_4'], managerUserIds: 'ou_1' }, 'invalid_manager_user_ids'],
        ['union_id in managerUserIds', { larkAppIds: ['cli_creator_4'], managerUserIds: ['on_union_1'] }, 'invalid_manager_user_ids'],
        ['email in managerUserIds', { larkAppIds: ['cli_creator_4'], managerUserIds: ['user@example.com'] }, 'invalid_manager_user_ids'],
        ['empty string in managerUserIds', { larkAppIds: ['cli_creator_4'], managerUserIds: [''] }, 'invalid_manager_user_ids'],
        ['non-string in managerUserIds', { larkAppIds: ['cli_creator_4'], managerUserIds: [42] }, 'invalid_manager_user_ids'],
        ['too many managerUserIds', {
          larkAppIds: ['cli_creator_4'],
          managerUserIds: Array.from({ length: 51 }, (_, i) => `ou_m_${i}`),
        }, 'invalid_manager_user_ids'],
      ];

      for (const [label, payload, expectedError] of cases) {
        const res = await post(payload);
        expect(res.status, label).toBe(400);
        expect(await res.json(), label).toMatchObject({ ok: false, error: expectedError, accepted: false });
      }
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  describe('Dashboard prepareDashboardGroupCreate (creator selection, pinning, apiOnly & validation)', () => {
    it('keeps legacy payload forwarding compatible and attaches creatorLarkAppId for port-reuse protection', () => {
      const plan = prepareDashboardGroupCreate(
        { name: 'Legacy Chat', larkAppIds: ['cli_a', 'cli_b'] },
        id => ({ larkAppId: id, resolvedAllowedUsers: id === 'cli_a' ? ['ou_owner_a'] : [] }),
      );
      expect(plan).toEqual({
        ok: true,
        creatorLarkAppId: 'cli_a',
        autoInvited: 'ou_owner_a',
        roleProfileId: null,
        forwardBody: {
          name: 'Legacy Chat',
          creatorLarkAppId: 'cli_a',
          larkAppIds: ['cli_a', 'cli_b'],
          userOpenIds: ['ou_owner_a'],
          ownerUnionIds: [],
          transferOwnerTo: 'ou_owner_a',
          notifyOwnerOpenId: 'ou_owner_a',
          bindWorkingDir: undefined,
          roleProfileId: undefined,
        },
      });
    });

    it('auto-invites managerUserIds, excludes kickoffBotLarkAppId and apiOnly bots from creator selection, and supports creatorLarkAppId pinning', () => {
      const kickoffBot = 'cli_kickoff_first';
      const apiOnlyBot = 'cli_api_only';
      const creatorBot = 'cli_creator_third';

      const plan = prepareDashboardGroupCreate(
        {
          name: 'Headless Collab',
          larkAppIds: [` ${kickoffBot} `, apiOnlyBot, creatorBot, creatorBot],
          chatMode: 'topic',
          ownerNotice: false,
          managerUserIds: ['ou_mgr_a', 'ou_mgr_a'],
          kickoffBotLarkAppId: kickoffBot,
          kickoffPrompt: '请输出分析结论',
        },
        id => ({
          larkAppId: id,
          resolvedAllowedUsers: id === creatorBot ? ['ou_c'] : ['ou_other'],
        }),
        { isApiOnly: id => id === apiOnlyBot },
      );

      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(plan.creatorLarkAppId).toBe(creatorBot);
      expect(plan.forwardBody).toMatchObject({
        creatorLarkAppId: creatorBot,
        larkAppIds: [kickoffBot, creatorBot],
        userOpenIds: ['ou_c', 'ou_mgr_a'],
        transferOwnerTo: 'ou_c',
        notifyOwnerOpenId: 'ou_c',
        ownerNotice: false,
        managerUserIds: ['ou_mgr_a'],
        kickoffBotLarkAppId: kickoffBot,
        kickoffPrompt: '请输出分析结论',
      });

      // Explicit creatorLarkAppId pinning never falls back to another bot when offline.
      expect(prepareDashboardGroupCreate(
        { larkAppIds: ['cli_a', 'cli_b'], creatorLarkAppId: 'cli_b' },
        id => (id === 'cli_a' ? { larkAppId: id, resolvedAllowedUsers: ['ou_a'] } : undefined),
      )).toEqual({ ok: false, status: 503, error: 'no_online_daemon' });

      // Explicit creatorLarkAppId succeeds when online even if cli_a has resolvedAllowedUsers first.
      const pinned = prepareDashboardGroupCreate(
        { larkAppIds: ['cli_a', 'cli_b'], creatorLarkAppId: 'cli_b' },
        id => ({ larkAppId: id, resolvedAllowedUsers: id === 'cli_a' ? ['ou_a'] : ['ou_b'] }),
      );
      expect(pinned).toMatchObject({ ok: true, creatorLarkAppId: 'cli_b', autoInvited: 'ou_b' });
    });

    it('rejects bad inputs, empty/malformed larkAppIds, invalid roleProfileId, self-kickoff, and apiOnly kickoff/creator', () => {
      const onlineAll = (id: string) => ({ larkAppId: id, resolvedAllowedUsers: [] });

      expect(normalizeGroupLarkAppIds(['  ', 'cli_a'])).toEqual({ ok: false, error: 'larkAppIds_required' });
      expect(normalizeGroupLarkAppIds(['cli_a', 123])).toEqual({ ok: false, error: 'larkAppIds_required' });
      expect(prepareDashboardGroupCreate(null, onlineAll)).toEqual({ ok: false, status: 400, error: 'bad_json' });
      expect(prepareDashboardGroupCreate({ larkAppIds: [] }, onlineAll)).toEqual({ ok: false, status: 400, error: 'larkAppIds_required' });
      expect(prepareDashboardGroupCreate({ larkAppIds: ['   '] }, onlineAll)).toEqual({ ok: false, status: 400, error: 'larkAppIds_required' });
      expect(prepareDashboardGroupCreate({ larkAppIds: ['cli_a', 123] }, onlineAll)).toEqual({ ok: false, status: 400, error: 'larkAppIds_required' });
      expect(prepareDashboardGroupCreate({ larkAppIds: ['cli_a'], roleProfileId: '../escape' }, onlineAll)).toEqual({
        ok: false, status: 400, error: 'invalid_role_profile_id',
      });
      expect(prepareDashboardGroupCreate({ larkAppIds: ['cli_a'], creatorLarkAppId: 'cli_not_in_list' }, onlineAll)).toEqual({
        ok: false, status: 400, error: 'invalid_creator_lark_app_id',
      });
      expect(prepareDashboardGroupCreate(
        { larkAppIds: ['cli_only'], kickoffBotLarkAppId: 'cli_only', kickoffPrompt: 'hi' },
        onlineAll,
      )).toEqual({ ok: false, status: 400, error: 'creator_cannot_kickoff_self' });
      expect(prepareDashboardGroupCreate(
        { larkAppIds: ['cli_only', ' cli_only '], kickoffBotLarkAppId: 'cli_only', kickoffPrompt: 'hi' },
        onlineAll,
      )).toEqual({ ok: false, status: 400, error: 'creator_cannot_kickoff_self' });
      expect(prepareDashboardGroupCreate(
        { larkAppIds: ['cli_a', 'cli_b'], kickoffBotLarkAppId: 'cli_c', kickoffPrompt: 'hi' },
        onlineAll,
      )).toEqual({ ok: false, status: 400, error: 'kickoff_bot_not_selected' });
      // apiOnly kickoff target or pinned creator rejected pre-create with 400.
      expect(prepareDashboardGroupCreate(
        { larkAppIds: ['cli_normal', 'cli_api'], kickoffBotLarkAppId: 'cli_api', kickoffPrompt: 'hi' },
        onlineAll,
        { isApiOnly: id => id === 'cli_api' },
      )).toEqual({ ok: false, status: 400, error: 'lark_transport_disabled' });
      expect(prepareDashboardGroupCreate(
        { larkAppIds: ['cli_api', 'cli_normal'], kickoffBotLarkAppId: 'cli_normal', kickoffPrompt: 'hi' },
        onlineAll,
        { isApiOnly: id => id === 'cli_api' },
      )).toEqual({ ok: false, status: 503, error: 'no_online_daemon' });
      // Only the kickoff bot is online → 503 no_online_daemon.
      expect(prepareDashboardGroupCreate(
        { larkAppIds: ['cli_kick', 'cli_offline'], kickoffBotLarkAppId: 'cli_kick', kickoffPrompt: 'hi' },
        id => (id === 'cli_kick' ? { larkAppId: id, resolvedAllowedUsers: [] } : undefined),
      )).toEqual({ ok: false, status: 503, error: 'no_online_daemon' });
      expect(prepareDashboardGroupCreate({ larkAppIds: ['cli_a'], ownerNotice: 'no' }, onlineAll)).toEqual({
        ok: false, status: 400, error: 'invalid_owner_notice',
      });
      expect(prepareDashboardGroupCreate({ larkAppIds: ['cli_a'], managerUserIds: ['on_wrong_id_type'] }, onlineAll)).toEqual({
        ok: false, status: 400, error: 'invalid_manager_user_ids',
      });
    });
  });

  describe('POST /api/groups/:chatId/top-notice & /share-link (IPC auth, cross-bot, membership & validation)', () => {
    const AUTH_SECRET = 'dGVzdC1zZWNyZXQtZm9yLWdyb3VwLWlwYy1jYXBhYmlsaXRpZXM';

    it('enforces trusted-host HMAC auth when authRequired is enabled', async () => {
      setLarkAppId('cli_auth_bot');
      setIpcAuthSecret(AUTH_SECRET);
      vi.spyOn(larkClient, 'isCurrentBotInChat').mockResolvedValue(true);
      const topSpy = vi.spyOn(chatTopNotice, 'putChatTopNotice').mockResolvedValue(undefined);
      const linkSpy = vi.spyOn(groupsStore, 'getChatShareLink').mockResolvedValue({
        ok: true,
        shareLink: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=tok_auth',
      });

      handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });

      const unauthTop = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_auth/top-notice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'om_msg_1' }),
      });
      expect(unauthTop.status).toBe(401);
      const unauthLink = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_auth/share-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(unauthLink.status).toBe(401);
      expect(topSpy).not.toHaveBeenCalled();
      expect(linkSpy).not.toHaveBeenCalled();

      const authTop = await fetchDaemonIpc(handle.port, '/api/groups/oc_auth/top-notice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'om_msg_1', larkAppId: 'cli_auth_bot' }),
      }, AUTH_SECRET);
      expect(authTop.status).toBe(200);
      expect(await authTop.json()).toEqual({
        ok: true,
        larkAppId: 'cli_auth_bot',
        chatId: 'oc_auth',
        messageId: 'om_msg_1',
      });
      expect(topSpy).toHaveBeenCalledWith('cli_auth_bot', 'oc_auth', 'om_msg_1');

      const authLink = await fetchDaemonIpc(handle.port, '/api/groups/oc_auth/share-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ validityPeriod: 'week', larkAppId: 'cli_auth_bot' }),
      }, AUTH_SECRET);
      expect(authLink.status).toBe(200);
      expect(await authLink.json()).toEqual({
        ok: true,
        larkAppId: 'cli_auth_bot',
        chatId: 'oc_auth',
        validityPeriod: 'week',
        shareLink: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=tok_auth',
      });
      expect(linkSpy).toHaveBeenCalledWith('cli_auth_bot', 'oc_auth', 'week');
    });

    it('blocks cross-bot mismatch (409), apiOnly bot (400), and non-member bot (403) before Lark calls', async () => {
      registerBot({ larkAppId: 'cli_normal', larkAppSecret: 'sec', cliId: 'claude-code', workingDir: process.cwd() });
      registerBot({ larkAppId: 'cli_api_only', larkAppSecret: '', cliId: 'claude-code', apiOnly: true, workingDir: process.cwd() });

      const inChatSpy = vi.spyOn(larkClient, 'isCurrentBotInChat').mockResolvedValue(false);
      const topSpy = vi.spyOn(chatTopNotice, 'putChatTopNotice').mockResolvedValue(undefined);
      const linkSpy = vi.spyOn(groupsStore, 'getChatShareLink').mockResolvedValue({
        ok: true,
        shareLink: 'https://example.test/link',
      });

      setLarkAppId('cli_normal');
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

      const mismatchTop = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_chat/top-notice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'om_1', larkAppId: 'cli_other' }),
      });
      expect(mismatchTop.status).toBe(409);
      expect(await mismatchTop.json()).toEqual({ ok: false, error: 'bot_mismatch' });

      const mismatchLink = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_chat/share-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ larkAppId: 'cli_other' }),
      });
      expect(mismatchLink.status).toBe(409);
      expect(await mismatchLink.json()).toEqual({ ok: false, error: 'bot_mismatch' });
      expect(inChatSpy).not.toHaveBeenCalled();

      const notInTop = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_chat/top-notice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'om_1' }),
      });
      expect(notInTop.status).toBe(403);
      expect(await notInTop.json()).toEqual({ ok: false, error: 'bot_not_in_chat' });

      const notInLink = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_chat/share-link`, {
        method: 'POST',
      });
      expect(notInLink.status).toBe(403);
      expect(await notInLink.json()).toEqual({ ok: false, error: 'bot_not_in_chat' });
      expect(topSpy).not.toHaveBeenCalled();
      expect(linkSpy).not.toHaveBeenCalled();

      inChatSpy.mockClear();
      setLarkAppId('cli_api_only');
      const apiOnlyTop = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_chat/top-notice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'om_1' }),
      });
      expect(apiOnlyTop.status).toBe(400);
      expect(await apiOnlyTop.json()).toEqual({ ok: false, error: 'lark_transport_disabled' });

      const apiOnlyLink = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_chat/share-link`, {
        method: 'POST',
      });
      expect(apiOnlyLink.status).toBe(400);
      expect(await apiOnlyLink.json()).toEqual({ ok: false, error: 'lark_transport_disabled' });
      expect(inChatSpy).not.toHaveBeenCalled();
    });

    it('maps membership lookup failures (502), top-notice errors (409/404/400/502), and share-link errors (502)', async () => {
      setLarkAppId('cli_err_bot');
      const inChatSpy = vi.spyOn(larkClient, 'isCurrentBotInChat');
      const topSpy = vi.spyOn(chatTopNotice, 'putChatTopNotice');
      const linkSpy = vi.spyOn(groupsStore, 'getChatShareLink');

      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

      // Membership check throws → 502 without invoking putChatTopNotice / getChatShareLink.
      inChatSpy.mockRejectedValueOnce(new Error('chat_membership_unknown'));
      const topCheckFail = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_a/top-notice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'om_1' }),
      });
      expect(topCheckFail.status).toBe(502);
      expect(await topCheckFail.json()).toEqual({ ok: false, error: 'chat_membership_unknown' });
      expect(topSpy).not.toHaveBeenCalled();

      inChatSpy.mockRejectedValueOnce(new Error('lark timeout'));
      const linkCheckFail = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_a/share-link`, {
        method: 'POST',
      });
      expect(linkCheckFail.status).toBe(502);
      expect(await linkCheckFail.json()).toEqual({ ok: false, error: 'lark timeout' });
      expect(linkSpy).not.toHaveBeenCalled();

      inChatSpy.mockResolvedValue(true);

      topSpy.mockRejectedValueOnce(new Error('message_chat_mismatch: expected oc_a, got oc_b'));
      const mismatch = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_a/top-notice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'om_from_b' }),
      });
      expect(mismatch.status).toBe(409);
      expect(await mismatch.json()).toEqual({ ok: false, error: 'message_chat_mismatch' });

      topSpy.mockRejectedValueOnce(new Error('message_chat_unavailable: om_gone'));
      const missing = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_a/top-notice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'om_gone' }),
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ ok: false, error: 'message_chat_unavailable' });

      topSpy.mockRejectedValueOnce(new LarkTransportDisabledError('cli_err_bot', 'putChatTopNotice'));
      const disabled = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_a/top-notice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'om_1' }),
      });
      expect(disabled.status).toBe(400);
      expect(await disabled.json()).toEqual({ ok: false, error: 'lark_transport_disabled' });

      topSpy.mockRejectedValueOnce(new Error('230001: denied'));
      const providerErr = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_a/top-notice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'om_1' }),
      });
      expect(providerErr.status).toBe(502);
      expect(await providerErr.json()).toEqual({ ok: false, error: '230001: denied' });

      linkSpy.mockResolvedValueOnce({ ok: false, error: 'no permission (code: 232025)' });
      const failedLink = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_a/share-link`, {
        method: 'POST',
      });
      expect(failedLink.status).toBe(502);
      expect(await failedLink.json()).toEqual({ ok: false, error: 'no permission (code: 232025)' });
      expect(linkSpy).toHaveBeenCalledWith('cli_err_bot', 'oc_a', 'permanently');
    });

    it('rejects malformed chatId, messageId, validityPeriod, larkAppId, unknown keys, non-object JSON, and malformed URL encoding fail-closed', async () => {
      setLarkAppId('cli_val_bot');
      const inChatSpy = vi.spyOn(larkClient, 'isCurrentBotInChat').mockResolvedValue(true);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

      expect(parseGroupTopNoticeRequest('om_not_chat', { messageId: 'om_1' }, 'cli_val_bot')).toEqual({
        ok: false, status: 400, error: 'invalid_chat_id',
      });
      expect(parseGroupTopNoticeRequest('oc_ok', { messageId: 'bad' }, 'cli_val_bot')).toEqual({
        ok: false, status: 400, error: 'invalid_message_id',
      });
      expect(parseGroupTopNoticeRequest('oc_ok', { messageId: 'om_1', extra: 1 }, 'cli_val_bot')).toEqual({
        ok: false, status: 400, error: 'invalid_request',
      });
      for (const badAppId of ['', ' cli_val_bot ', 123, null]) {
        expect(parseGroupTopNoticeRequest('oc_ok', { messageId: 'om_1', larkAppId: badAppId }, 'cli_val_bot')).toEqual({
          ok: false, status: 400, error: 'invalid_lark_app_id',
        });
        expect(parseGroupShareLinkRequest('oc_ok', { larkAppId: badAppId }, 'cli_val_bot')).toEqual({
          ok: false, status: 400, error: 'invalid_lark_app_id',
        });
      }
      expect(parseGroupShareLinkRequest('oc_ok', { validityPeriod: 'month' }, 'cli_val_bot')).toEqual({
        ok: false, status: 400, error: 'invalid_validity_period',
      });
      expect(parseGroupShareLinkRequest('oc_ok', { extra: true }, 'cli_val_bot')).toEqual({
        ok: false, status: 400, error: 'invalid_request',
      });
      expect(parseGroupCreateOptions({ ownerNotice: 'false' })).toEqual({
        ok: false, error: 'invalid_owner_notice',
      });

      const badTop = await fetch(`http://127.0.0.1:${handle.port}/api/groups/om_wrong/top-notice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'om_1' }),
      });
      expect(badTop.status).toBe(400);
      expect(await badTop.json()).toEqual({ ok: false, error: 'invalid_chat_id' });

      const nullShare = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_ok/share-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'null',
      });
      expect(nullShare.status).toBe(400);
      expect(await nullShare.json()).toEqual({ ok: false, error: 'bad_json' });

      const badPeriod = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_ok/share-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ validityPeriod: 'day' }),
      });
      expect(badPeriod.status).toBe(400);
      expect(await badPeriod.json()).toEqual({ ok: false, error: 'invalid_validity_period' });

      // Malformed percent-encoding in :chatId returns 400 invalid_url_encoding instead of 500.
      for (const [method, path, body] of [
        ['POST', '/api/groups/%ZZ/top-notice', JSON.stringify({ messageId: 'om_1' })],
        ['POST', '/api/groups/%E0%A4%A/share-link', '{}'],
        ['GET', '/api/groups/%ZZ/members-display', undefined],
      ] as const) {
        const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
          method,
          ...(body ? { headers: { 'content-type': 'application/json' }, body } : {}),
        });
        expect(res.status, `${method} ${path}`).toBe(400);
        expect(await res.json(), `${method} ${path}`).toEqual({ ok: false, error: 'invalid_url_encoding' });
      }

      expect(inChatSpy).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/groups/:chatId/members-display IPC pass-through & guarded self fallback', () => {
    it('preserves larkAppId on both self and peer bot rows and guards against same-name external bot collisions', async () => {
      registerBot({ larkAppId: 'cli_self_disp', larkAppSecret: 'sec', cliId: 'codex', workingDir: process.cwd() });
      getBot('cli_self_disp').botOpenId = 'ou_self_disp';
      setLarkAppId('cli_self_disp');

      const spy = vi.spyOn(groupsStore, 'listChatMemberDisplays').mockResolvedValue([
        { openId: 'ou_person', name: 'Operator', memberType: 'user' },
        { openId: 'ou_self_disp', name: 'Self Bot', memberType: 'bot', larkAppId: 'cli_self_disp' },
        { openId: 'ou_peer_disp', name: 'Peer Bot', memberType: 'bot', larkAppId: 'cli_peer_disp' },
        // Simulated same-name external bot carrying bound appId: must NOT be flagged self when selfOpenId is known.
        { openId: 'ou_ext_same_name', name: 'Self Bot', memberType: 'bot', larkAppId: 'cli_self_disp' },
        { openId: 'ou_ext_disp', name: 'External Bot', memberType: 'bot' },
      ]);

      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_disp/members-display`);
      expect(res.status).toBe(200);
      expect((await res.json()).members).toEqual([
        { openId: 'ou_person', name: 'Operator', memberType: 'user' },
        { openId: 'ou_self_disp', name: 'Self Bot', memberType: 'bot', larkAppId: 'cli_self_disp', self: true },
        { openId: 'ou_peer_disp', name: 'Peer Bot', memberType: 'bot', larkAppId: 'cli_peer_disp' },
        { openId: 'ou_ext_same_name', name: 'Self Bot', memberType: 'bot', larkAppId: 'cli_self_disp' },
        { openId: 'ou_ext_disp', name: 'External Bot', memberType: 'bot' },
      ]);

      // Startup window before selfOpenId resolves: unique larkAppId match is flagged self: true.
      getBot('cli_self_disp').botOpenId = undefined;
      spy.mockResolvedValueOnce([
        { openId: 'ou_self_disp', name: 'Self Bot', memberType: 'bot', larkAppId: 'cli_self_disp' },
        { openId: 'ou_peer_disp', name: 'Peer Bot', memberType: 'bot', larkAppId: 'cli_peer_disp' },
      ]);
      const startupRes = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_disp/members-display`);
      expect(startupRes.status).toBe(200);
      expect((await startupRes.json()).members).toEqual([
        { openId: 'ou_self_disp', name: 'Self Bot', memberType: 'bot', larkAppId: 'cli_self_disp', self: true },
        { openId: 'ou_peer_disp', name: 'Peer Bot', memberType: 'bot', larkAppId: 'cli_peer_disp' },
      ]);

      // Legacy fallback row where openId === larkAppId is flagged self: true even when selfOpenId is set to ou_.
      getBot('cli_self_disp').botOpenId = 'ou_self_disp';
      spy.mockResolvedValueOnce([
        { openId: 'cli_self_disp', name: 'Self Bot', memberType: 'bot', larkAppId: 'cli_self_disp' },
      ]);
      const fallbackRes = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_disp/members-display`);
      expect(fallbackRes.status).toBe(200);
      expect((await fallbackRes.json()).members).toEqual([
        { openId: 'cli_self_disp', name: 'Self Bot', memberType: 'bot', larkAppId: 'cli_self_disp', self: true },
      ]);
    });
  });

  describe('CLI `botmux create-group` subprocess e2e (--json-status shareLink/shareLinkError & --kickoff-bot larkAppId)', () => {
    it('emits shareLink and shareLinkError in --json-status, resolves --kickoff-bot by larkAppId without bots-info.json, and enforces CLI guards', () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-create-group-e2e-'));
      const botmuxDir = join(fakeHome, '.botmux');
      const dataDir = join(botmuxDir, 'data');
      mkdirSync(dataDir, { recursive: true });
      const botsConfigPath = join(botmuxDir, 'bots.json');
      writeFileSync(botsConfigPath, JSON.stringify([
        { larkAppId: 'cli_creator_cli', larkAppSecret: 'sec_a', cliId: 'claude-code', workingDir: fakeHome },
        { larkAppId: 'cli_peer_cli', larkAppSecret: 'sec_b', cliId: 'codex', workingDir: fakeHome },
        { larkAppId: 'cli_unselected_cli', larkAppSecret: 'sec_c', cliId: 'antigravity', workingDir: fakeHome },
      ], null, 2));
      // Pre-seed cross-ref for cli_creator_cli so listChatBotMembers marks cli_peer_cli mentionable.
      writeFileSync(join(dataDir, 'bot-openids-cli_creator_cli.json'), JSON.stringify({
        codex: 'ou_peer_obs',
      }));

      const baseEnv: Record<string, string> = {
        ...process.env as Record<string, string>,
        HOME: fakeHome,
        SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: botsConfigPath,
        BOTMUX_SESSION_ID: '',
        BOTMUX_CHAT_ID: '',
        BOTMUX_LARK_APP_ID: '',
        BOTMUX_WORKFLOW: '',
      };

      try {
        // 1. Happy path: --kickoff-bot cli_peer_cli (NO bots-info.json!) + --json-status emits shareLink & kickoffMessageId.
        const ok = spawnSyncTsScript(CREATE_GROUP_FIXTURE, [
          'create-group',
          '--bot', 'cli_creator_cli',
          '--bot', 'cli_peer_cli',
          '--name', 'CLI E2E',
          '--kickoff-bot', 'cli_peer_cli',
          '--kickoff-prompt', '- start review',
          '--json-status',
        ], { encoding: 'utf8', env: { ...baseEnv, BOTMUX_TEST_SHARE_LINK_MODE: 'ok' }, timeout: 20_000 });
        expect(ok.status, String(ok.stderr)).toBe(0);
        const lines = String(ok.stdout).trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(lines[0]).toBe('oc_cli_created');
        expect(JSON.parse(lines[1]!)).toMatchObject({
          success: true,
          chatCreated: true,
          chatId: 'oc_cli_created',
          shareLink: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=tok_cli',
          shareLinkError: null,
          kickoffRequested: true,
          kickoffAccepted: true,
          kickoffMessageId: 'om_cli_kickoff_1',
          kickoffError: null,
        });

        // 2. Best-effort shareLink error keeps success:true and exit 0, exposing shareLinkError.
        const linkErr = spawnSyncTsScript(CREATE_GROUP_FIXTURE, [
          'create-group', '--bot', 'cli_creator_cli', '--json-status',
        ], { encoding: 'utf8', env: { ...baseEnv, BOTMUX_TEST_SHARE_LINK_MODE: 'error' }, timeout: 20_000 });
        expect(linkErr.status, String(linkErr.stderr)).toBe(0);
        const linkErrLines = String(linkErr.stdout).trim().split('\n');
        expect(linkErrLines).toHaveLength(2);
        expect(JSON.parse(linkErrLines[1]!)).toMatchObject({
          success: true,
          chatId: 'oc_cli_created',
          shareLink: null,
          shareLinkError: 'permission_denied (code: 99991672)',
        });

        // 3. Default stdout without --json-status remains strictly 1 line (chatId only).
        const legacy = spawnSyncTsScript(CREATE_GROUP_FIXTURE, [
          'create-group', '--bot', 'cli_creator_cli',
        ], { encoding: 'utf8', env: { ...baseEnv, BOTMUX_TEST_SHARE_LINK_MODE: 'ok' }, timeout: 20_000 });
        expect(legacy.status, String(legacy.stderr)).toBe(0);
        expect(String(legacy.stdout).trim().split('\n')).toEqual(['oc_cli_created']);

        // 4. Distinguishes unselected configured larkAppId vs unknown larkAppId even without bots-info.json.
        const unselected = spawnSyncTsScript(CREATE_GROUP_FIXTURE, [
          'create-group', '--bot', 'cli_creator_cli', '--bot', 'cli_peer_cli',
          '--kickoff-bot', 'cli_unselected_cli', '--kickoff-prompt', 'hi',
        ], { encoding: 'utf8', env: baseEnv, timeout: 20_000 });
        expect(unselected.status).toBe(1);
        expect(String(unselected.stderr)).toContain('必须属于本次 --bot 列表');
        expect(String(unselected.stdout)).toBe('');

        const unknown = spawnSyncTsScript(CREATE_GROUP_FIXTURE, [
          'create-group', '--bot', 'cli_creator_cli', '--bot', 'cli_peer_cli',
          '--kickoff-bot', 'cli_nonexistent', '--kickoff-prompt', 'hi',
        ], { encoding: 'utf8', env: baseEnv, timeout: 20_000 });
        expect(unknown.status).toBe(1);
        expect(String(unknown.stderr)).toContain('未匹配到本机 bot');
        expect(String(unknown.stdout)).toBe('');

        // 5. Missing/blank/trailing-duplicate kickoff flags fail closed BEFORE createChat (stdout stays empty).
        for (const badArgs of [
          ['create-group', '--bot', 'cli_creator_cli', '--bot', 'cli_peer_cli', '--kickoff-bot', 'cli_peer_cli', '--kickoff-prompt', '--json-status'],
          ['create-group', '--bot', 'cli_creator_cli', '--bot', 'cli_peer_cli', '--kickoff-bot', ''],
          ['create-group', '--bot', 'cli_creator_cli', '--bot', 'cli_peer_cli', '--kickoff-bot', 'cli_peer_cli', '--kickoff-prompt', 'hi', '--kickoff-bot'],
          ['create-group', '--bot', 'cli_creator_cli', '--bot', 'cli_peer_cli', '--kickoff-bot', 'cli_peer_cli', '--kickoff-prompt', 'hi', '--kickoff-prompt'],
        ]) {
          const bad = spawnSyncTsScript(CREATE_GROUP_FIXTURE, badArgs, { encoding: 'utf8', env: baseEnv, timeout: 20_000 });
          expect(bad.status, badArgs.join(' ')).toBe(1);
          expect(String(bad.stdout), badArgs.join(' ')).toBe('');
        }
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
      }
    }, 60_000);
  });

  describe('CLI `botmux top-notice set --bot` headless subprocess e2e', () => {
    it('sets top notice without session context or bots.json via authenticated Daemon IPC, and fails closed on mismatch or missing secret', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-top-notice-home-'));
      const botmuxDir = join(fakeHome, '.botmux');
      const dataDir = join(botmuxDir, 'data');
      const daemonsDir = join(dataDir, 'dashboard-daemons');
      mkdirSync(daemonsDir, { recursive: true, mode: 0o700 });
      chmodSync(fakeHome, 0o700);
      chmodSync(botmuxDir, 0o700);

      const secret = 'Y2xpLXRvcC1ub3RpY2UtaGVhZGxlc3MtdGVzdC1zZWNyZXQ';
      const secretPath = join(botmuxDir, '.dashboard-secret');
      writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });

      try {
        setLarkAppId('cli_headless_bot');
        setIpcAuthSecret(secret);
        vi.spyOn(larkClient, 'isCurrentBotInChat').mockResolvedValue(true);
        const topSpy = vi.spyOn(chatTopNotice, 'putChatTopNotice').mockResolvedValue(undefined);

        handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });

        writeFileSync(join(daemonsDir, 'cli_headless_bot.json'), JSON.stringify({
          larkAppId: 'cli_headless_bot',
          ipcPort: handle.port,
          pid: process.pid,
          lastHeartbeat: Date.now(),
        }));
        writeFileSync(join(daemonsDir, 'cli_other_bot.json'), JSON.stringify({
          larkAppId: 'cli_other_bot',
          ipcPort: handle.port,
          pid: process.pid,
          lastHeartbeat: Date.now(),
        }));

        const cleanEnv: Record<string, string | undefined> = {
          HOME: fakeHome,
          SESSION_DATA_DIR: dataDir,
          BOTS_CONFIG: join(fakeHome, 'nonexistent-bots.json'),
          BOTMUX_SESSION_ID: '',
          BOTMUX_CHAT_ID: '',
          BOTMUX_LARK_APP_ID: '',
          BOTMUX_WORKFLOW: '',
        };

        const ok = await runCliAsync(
          ['top-notice', 'set', 'om_pin_1', '--bot', 'cli_headless_bot', '--chat-id', 'oc_target_1', '--json'],
          cleanEnv,
        );
        expect(ok.status).toBe(0);
        expect(JSON.parse(ok.stdout.trim())).toEqual({
          ok: true,
          action: 'set',
          messageId: 'om_pin_1',
          chatId: 'oc_target_1',
          larkAppId: 'cli_headless_bot',
        });
        expect(topSpy).toHaveBeenCalledWith('cli_headless_bot', 'oc_target_1', 'om_pin_1');

        topSpy.mockClear();
        const mismatch = await runCliAsync(
          ['top-notice', 'set', 'om_pin_2', '--bot', 'cli_other_bot', '--chat-id', 'oc_target_1', '--json'],
          cleanEnv,
        );
        expect(mismatch.status).toBe(1);
        expect(JSON.parse(mismatch.stdout.trim())).toEqual({
          ok: false,
          chatId: 'oc_target_1',
          larkAppId: 'cli_other_bot',
          error: 'bot_mismatch',
        });
        expect(topSpy).not.toHaveBeenCalled();

        rmSync(secretPath, { force: true });
        const noSecret = await runCliAsync(
          ['top-notice', 'set', 'om_pin_3', '--bot', 'cli_headless_bot', '--chat-id', 'oc_target_1', '--json'],
          cleanEnv,
        );
        expect(noSecret.status).toBe(1);
        expect(JSON.parse(noSecret.stdout.trim())).toMatchObject({
          ok: false,
          chatId: 'oc_target_1',
          larkAppId: 'cli_headless_bot',
        });
        expect(topSpy).not.toHaveBeenCalled();
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
      }
    }, 25_000);
  });
});
