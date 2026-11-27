/**
 * The WeCom card has no form for per-conversation feedback rules
 * (`chatFeedbackPolicies`) or feedback webhooks (`feedbackWebhooks`): like
 * Feishu, they live in the configuration file only. Saving anything else on the
 * card must keep both exactly as they were, and must not write back the native
 * keys or the `business` section this version retired. Real card, real
 * configuration service, real file.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOT_PROFILE_SHARED_PARTS } from '../src/dashboard/web/bot-defaults-page.js';
import { WecomBotDefaultsCard } from '../src/dashboard/web/wecom-bot-defaults-card.js';
import { WecomDashboardConfig } from '../src/dashboard/wecom/config.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { parseWecomConfig } from '../src/im/wecom/config/config.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** `native` keys earlier versions wrote, with values they once accepted. */
const RETIRED = {
  terminalBaseUrl: 'https://terminal.example.invalid',
  repositories: { app: '/workspace/app' },
  console: 'https://work.weixin.qq.com/wework_admin/',
  substitutePrompt: 'draft',
  feedbackButtonAlign: 'native',
  peerTrust: [],
  grantDelegateBots: ['b'.repeat(64)],
  approverUsers: ['approver'],
  restrictGrantCommands: false,
  replyDelivery: 'send',
  autoStartOnGroupJoin: true,
  autoStartOnGroupJoinPrompt: 'hello',
  autoStartOnGroupJoinSeed: 'seed',
  groupJoinCommandEnabled: true,
  groupJoinCommand: '/status',
  autoStartExcludedChats: ['chat-x'],
  regularGroupMentionMode: 'command',
  slashCommands: { enabled: false },
  privateCard: true,
  replyCardNativeCot: true,
  replyStyle: { theme: 'success', layout: 'notice' },
  askOptionLayout: 'vertical',
};

let renderer: TestRenderer.ReactTestRenderer | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('keeps per-conversation feedback rules and feedback webhooks through every native save on the card, and drops the retired keys', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wecom-native-kept-'));
  dirs.push(root);
  const file = join(root, 'config.json');
  const feedback = {
    chatFeedbackPolicies: { 'chat-a': { enabled: false }, 'chat-b': { enabled: true, audience: 'reviewers', reviewers: ['bob'], allowReselect: true } },
    feedbackWebhooks: [{ id: 'hook-a', url: 'https://hook.example.invalid/endpoint', enabled: true, eventTypes: ['turn.completed'], secretRef: 'feedback-webhook:ref-a' }],
  };
  const base = {
    botId: 'native-kept',
    secretEnv: 'FAKE_WECOM_SECRET',
    allowedUsers: ['owner'],
    coreUrl: 'http://127.0.0.1:19445',
    managedCore: { botId: 'local_kept', cli: 'codex', backend: 'pty', workingDirectory: root, stateDir: join(root, 'core'), port: 19445 },
  };
  // The two keys as this version stores them (the parser normalizes the rules).
  const kept = parseWecomConfig({ ...base, native: feedback }).native!;
  writeFileSync(file, JSON.stringify({
    ...base,
    native: { ...kept, ...RETIRED },
    business: { chatManagerEnabled: true, steward: { enabled: true, chatId: 'steward' } },
  }));
  const service = new WecomDashboardConfig(root);
  const id = wecomConfigId(file);
  const writes: any[] = [];
  const failures: string[] = [];
  vi.stubGlobal('fetch', async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    let status = 200;
    let body: any;
    try {
      if (method === 'PATCH') {
        const patch = JSON.parse(init.body);
        body = await service.patch(id, patch);
        writes.push(patch);
      } else if (url.endsWith('/config')) body = service.get(id);
      else if (url.endsWith('/environment')) body = service.environment(id);
      else if (url.includes('/command-triggers')) body = service.commandTriggers(id);
      else if (url.endsWith('/codex-profiles')) body = { connectionId: id, status: 'empty', candidates: [] };
      else body = { status: 'unknown', models: [] };
    } catch (error) {
      status = 409;
      body = { error: String(error) };
      failures.push(String(error));
    }
    return { ok: status === 200, status, json: async () => body };
  });
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(WecomBotDefaultsCard, {
      shared: BOT_PROFILE_SHARED_PARTS,
      connection: { id, label: 'WeCom', configuration: 'ready', ownership: 'dashboard', gateway: 'stopped' } as any,
      cliState: { options: [{ id: 'codex', label: 'Codex' }] } as any,
      activeTab: 'common',
      onTabChange: vi.fn(),
      onRefresh: vi.fn(),
      onAction: vi.fn(),
    }));
  });
  // Every WeCom-only native tile on every tab (the panels are all mounted).
  const actions = [...new Set(renderer!.root
    .findAll(node => node.type === 'button' && /^save-wecom-(core|platform)-/.test(String(node.props['data-action'] ?? '')))
    .map(node => String(node.props['data-action'])))];
  // 授权与额度、可操作终端、额度耗尽交接、对话权限用户可用的命令、/summary 总结范围。
  expect(actions.length).toBeGreaterThanOrEqual(5);
  for (const action of actions) {
    const count = writes.length + 1;
    await act(async () => {
      renderer!.root.findByProps({ 'data-action': action }).props.onClick();
      const deadline = Date.now() + 2000;
      while (writes.length < count && !failures.length && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
    });
    expect(writes, JSON.stringify({ action, failures })).toHaveLength(count);
  }
  const written = JSON.parse(readFileSync(file, 'utf8')).native;
  expect(written.chatFeedbackPolicies).toEqual(kept.chatFeedbackPolicies);
  expect(written.feedbackWebhooks).toEqual(kept.feedbackWebhooks);
  for (const key of Object.keys(RETIRED)) {
    expect(written, key).not.toHaveProperty(key);
    expect(writes.some(write => write.native && key in write.native), key).toBe(false);
  }
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  expect(saved).not.toHaveProperty('business');
  // The retired approver list is not lost: its user is an allowed user in the file now.
  expect(saved.allowedUsers).toEqual(['owner', 'approver']);
});
