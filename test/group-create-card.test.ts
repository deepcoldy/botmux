import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockedCreateSlashGroup = vi.fn();
const mockedReplyMessage = vi.fn(async () => 'om_fallback');
const mockedDeleteMessage = vi.fn(async () => true);
const mockedIsValidBranchName = vi.fn(async (name: string) => !name.includes('..') && !name.includes(' '));

vi.mock('../src/core/command-handler.js', () => ({
  configWriteFailureText: vi.fn((e: unknown) => String(e)),
  handleCommand: vi.fn(),
  createSlashGroup: (...args: any[]) => mockedCreateSlashGroup(...args),
  slashGroupReceiptText: (result: any) => (result.ok ? `TEXT_OK:${result.name}:${result.link}` : `TEXT_ERR:${result.error}`),
}));

vi.mock('../src/im/lark/client.js', async (orig) => {
  const actual = await orig<typeof import('../src/im/lark/client.js')>();
  return {
    ...actual,
    replyMessage: (...args: any[]) => mockedReplyMessage(...args),
    deleteMessage: (...args: any[]) => mockedDeleteMessage(...args),
  };
});

vi.mock('../src/services/git-worktree.js', async (orig) => {
  const actual = await orig<typeof import('../src/services/git-worktree.js')>();
  return {
    ...actual,
    isValidBranchName: (name: string) => mockedIsValidBranchName(name),
  };
});

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    botName: 'Claude',
    resolvedAllowedUsers: ['ou_owner'],
    config: { larkAppId: 'app-1', larkAppSecret: 's', cliId: 'claude-code', locale: 'zh' },
  })),
  getAllBots: vi.fn(() => []),
  getOwnerOpenId: vi.fn(() => 'ou_owner'),
  effectiveDefaultWorkingDir: vi.fn(() => undefined),
}));

import {
  GROUP_CREATE_DIR_ACTION,
  GROUP_CREATE_SUBMIT_ACTION,
  buildGroupCreateCard,
  buildGroupCreatedCard,
  buildGroupErrorCard,
  consumeGroupCreateForm,
  formatGroupCreateDirLabels,
  getGroupCreateForm,
  openGroupCreateForm,
  resetGroupCreateForms,
  selectGroupCreateDir,
} from '../src/core/group-create-card.js';
import { handleCardAction, type CardHandlerDeps } from '../src/im/lark/card-handler.js';

let tmpRoot = '';

function makeDir(name: string): string {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeDeps(): CardHandlerDeps {
  return {
    activeSessions: new Map(),
    sessionReply: vi.fn(async () => 'om_card_reply'),
    lastRepoScan: new Map(),
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'botmux-group-create-card-'));
  resetGroupCreateForms();
  mockedCreateSlashGroup.mockReset();
  mockedReplyMessage.mockClear();
  mockedDeleteMessage.mockClear();
  mockedIsValidBranchName.mockClear();
});

afterEach(() => {
  resetGroupCreateForms();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('group-create-card form lifecycle & rendering', () => {
  it('enforces owner-only access, TTL expiry, and single-use consumption', () => {
    const t0 = 1_000_000;
    const form = openGroupCreateForm({
      creatorAppId: 'app-1',
      senderOpenId: 'ou_owner',
      larkAppIdsForGroup: ['app-1'],
      groupArgs: { name: '', body: '' },
      appIdToName: {},
      rootId: 'om_root',
    }, t0);

    expect(getGroupCreateForm(form.id, 'ou_other', t0)).toEqual({ ok: false, reason: 'not_owner' });
    expect(getGroupCreateForm(form.id, undefined, t0)).toEqual({ ok: false, reason: 'not_owner' });
    expect(getGroupCreateForm(form.id, 'ou_owner', t0)).toEqual({ ok: true, form });

    selectGroupCreateDir(form, '/work/repo-a');
    expect(getGroupCreateForm(form.id, 'ou_owner', t0)).toMatchObject({ ok: true, form: { selectedDir: '/work/repo-a' } });

    expect(getGroupCreateForm(form.id, 'ou_owner', t0 + 31 * 60_000)).toEqual({ ok: false, reason: 'expired' });

    const form2 = openGroupCreateForm({
      creatorAppId: 'app-1',
      senderOpenId: 'ou_owner',
      larkAppIdsForGroup: ['app-1'],
      groupArgs: { name: '', body: '' },
      appIdToName: {},
      rootId: 'om_root',
    }, t0);
    consumeGroupCreateForm(form2);
    expect(getGroupCreateForm(form2.id, 'ou_owner', t0)).toEqual({ ok: false, reason: 'expired' });
  });

  it('shortens dropdown directory labels to last 2 segments and disambiguates collisions', () => {
    expect(formatGroupCreateDirLabels([
      '/data00/home/user',
      '/data00/home/user/agentctl',
      '/data00/home/user/lark_sce/commerce_sale',
      '/data00/home/user/code/commerce_sale',
      '/work/short',
      '/',
    ])).toEqual([
      'home/user',
      'user/agentctl',
      'lark_sce/commerce_sale',
      'code/commerce_sale',
      '/work/short',
      '/',
    ]);

    expect(formatGroupCreateDirLabels([
      '/data00/a/code/app',
      '/data00/b/code/app',
      '/data00/a/other/repo',
    ])).toEqual([
      'a/code/app',
      'b/code/app',
      'other/repo',
    ]);
  });

  it('builds a form card with prefilled name/dir/branch and renders result & error cards', () => {
    const form = openGroupCreateForm({
      creatorAppId: 'app-1',
      senderOpenId: 'ou_owner',
      larkAppIdsForGroup: ['app-1'],
      groupArgs: { name: '发布群', body: '发布群', workingDir: '/work/a', branch: 'feat/rel' },
      appIdToName: {},
      rootId: 'om_root',
      selectedDir: '/work/a',
    });

    const card = JSON.parse(buildGroupCreateCard(form, ['/work/a', '/work/b'], 'zh'));
    expect(card.header.template).toBe('blue');
    const dropdown = card.elements[1].actions[0];
    expect(dropdown.tag).toBe('select_static');
    expect(dropdown.initial_option).toBe('/work/a');
    const formEl = card.elements[2];
    expect(formEl.tag).toBe('form');
    expect(formEl.elements[0].default_value).toBe('发布群');
    expect(formEl.elements[1].default_value).toBeUndefined(); // matched dropdown option
    expect(formEl.elements[2].default_value).toBe('feat/rel');

    const okCard = JSON.parse(buildGroupCreatedCard({
      ok: true,
      name: '发布群',
      link: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1',
      workingDir: '/work/a',
      branch: 'feat/rel',
      hints: ['🤖 群内机器人：Claude、Codex'],
    }, 'zh'));
    expect(okCard.header.template).toBe('green');
    expect(okCard.elements[0].text.content).toContain('/work/a');
    expect(okCard.elements[0].text.content).toContain('feat/rel');
    expect(okCard.elements[1].actions[0].multi_url.url).toContain('oc_1');

    const errCard = JSON.parse(buildGroupErrorCard('建群参数无效：bad', 'zh'));
    expect(errCard.header.template).toBe('red');
    expect(errCard.elements[0].text.content).toContain('建群参数无效：bad');
  });
});

describe('card-handler group_create callbacks', () => {
  it('records dropdown dir selection, allows blank name on submit, sends result card and withdraws form', async () => {
    const repoDir = makeDir('repo-a');
    const form = openGroupCreateForm({
      creatorAppId: 'app-1',
      senderOpenId: 'ou_owner',
      larkAppIdsForGroup: ['app-1', 'app-2'],
      groupArgs: { name: '', body: '', avatar: 'name' },
      appIdToName: { 'app-1': 'Claude', 'app-2': 'Codex' },
      rootId: 'om_root',
    });
    const deps = makeDeps();

    // Non-owner cannot interact.
    const denied = await handleCardAction({
      operator: { open_id: 'ou_intruder' },
      action: { value: { action: GROUP_CREATE_DIR_ACTION, form: form.id }, option: repoDir },
      context: { open_message_id: 'om_form_card' },
    }, deps, 'app-1');
    expect(denied.toast.type).toBe('error');

    // Owner selects directory from dropdown.
    const picked = await handleCardAction({
      operator: { open_id: 'ou_owner' },
      action: { value: { action: GROUP_CREATE_DIR_ACTION, form: form.id }, option: repoDir },
      context: { open_message_id: 'om_form_card' },
    }, deps, 'app-1');
    expect(picked.toast.type).toBe('success');

    // Owner submits with blank name (auto-title allowed) and branch.
    mockedCreateSlashGroup.mockResolvedValueOnce({
      ok: true,
      name: '新会话 11/26 01:00',
      link: 'https://feishu.cn/oc_created',
      workingDir: repoDir,
      branch: 'feat/card',
      hints: [],
    });
    const submitted = await handleCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: { action: GROUP_CREATE_SUBMIT_ACTION, form: form.id },
        form_value: { group_name: '   ', group_dir: '', group_branch: 'feat/card' },
      },
      context: { open_message_id: 'om_form_card' },
    }, deps, 'app-1');
    expect(submitted.toast.type).toBe('info');
    expect(typeof submitted.afterAck).toBe('function');
    // Form was consumed immediately so a double-click cannot create two groups.
    expect(getGroupCreateForm(form.id, 'ou_owner')).toEqual({ ok: false, reason: 'expired' });

    await submitted.afterAck!();
    expect(mockedCreateSlashGroup).toHaveBeenCalledWith(expect.objectContaining({
      creatorAppId: 'app-1',
      senderOpenId: 'ou_owner',
      larkAppIdsForGroup: ['app-1', 'app-2'],
      groupArgs: expect.objectContaining({ name: '', workingDir: repoDir, branch: 'feat/card', avatar: 'name' }),
    }));
    expect(deps.sessionReply).toHaveBeenCalledWith('om_root', expect.stringContaining('https://feishu.cn/oc_created'), 'interactive', 'app-1');
  });

  it('rejects branch without directory or invalid branch name without consuming the form', async () => {
    const repoDir = makeDir('repo-b');
    const form = openGroupCreateForm({
      creatorAppId: 'app-1',
      senderOpenId: 'ou_owner',
      larkAppIdsForGroup: ['app-1'],
      groupArgs: { name: '', body: '' },
      appIdToName: {},
      rootId: 'om_root',
    });
    const deps = makeDeps();

    const noDir = await handleCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: { action: GROUP_CREATE_SUBMIT_ACTION, form: form.id },
        form_value: { group_name: '测试群', group_dir: '', group_branch: 'feat/a' },
      },
      context: { open_message_id: 'om_form_card' },
    }, deps, 'app-1');
    expect(noDir.toast.type).toBe('error');
    expect(getGroupCreateForm(form.id, 'ou_owner').ok).toBe(true);

    const badBranch = await handleCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: { action: GROUP_CREATE_SUBMIT_ACTION, form: form.id },
        form_value: { group_name: '测试群', group_dir: repoDir, group_branch: 'bad..branch' },
      },
      context: { open_message_id: 'om_form_card' },
    }, deps, 'app-1');
    expect(badBranch.toast.type).toBe('error');
    expect(getGroupCreateForm(form.id, 'ou_owner').ok).toBe(true);
  });

  it('falls back to text reply when result card send fails', async () => {
    const form = openGroupCreateForm({
      creatorAppId: 'app-1',
      senderOpenId: 'ou_owner',
      larkAppIdsForGroup: ['app-1'],
      groupArgs: { name: '', body: '' },
      appIdToName: {},
      rootId: 'om_root',
    });
    const deps = makeDeps();
    vi.mocked(deps.sessionReply).mockRejectedValueOnce(new Error('card_failed'));
    mockedCreateSlashGroup.mockResolvedValueOnce({
      ok: true,
      name: 'Fallback Group',
      link: 'https://feishu.cn/oc_fb',
      hints: [],
    });

    const submitted = await handleCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: { action: GROUP_CREATE_SUBMIT_ACTION, form: form.id },
        form_value: { group_name: 'Fallback Group' },
      },
      context: { open_message_id: 'om_form_card' },
    }, deps, 'app-1');
    await submitted.afterAck!();

    expect(mockedReplyMessage).toHaveBeenCalledWith('app-1', 'om_form_card', 'TEXT_OK:Fallback Group:https://feishu.cn/oc_fb', 'text', false);
  });
});
