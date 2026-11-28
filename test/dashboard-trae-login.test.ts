import { describe, expect, it, vi } from 'vitest';
import { handleDashboardCommand } from '../src/core/dashboard-command/index.js';
import { resolveTraeLoginTarget } from '../src/core/dashboard-command/trae-login.js';
import { classifySlash } from '../src/core/command-router.js';
import type { BotConfig } from '../src/bot-registry.js';
import type { LarkMessage } from '../src/types.js';
import type { CommandHandlerDeps } from '../src/core/command-handler.js';
import type { TraeLoginManager } from '../src/services/trae-login.js';
import { parseEventMessage, stripLeadingMentions } from '../src/im/lark/message-parser.js';
import { redactTraeLoginCommand } from '../src/services/trae-login.js';
import { logger } from '../src/utils/logger.js';

const admin = 'ou_admin'; const appId = 'cli_test';
const cfg = { cliId: 'traex', backendType: 'tmux', env: { TRAE_HOME: '/private/trae' } } as BotConfig;
function setup(over: Partial<LarkMessage> = {}) {
  const message = { messageId: 'om_test', rootId: 'om_root', content: '/dashboard trae-login',
    senderId: admin, senderType: 'user', chatId: 'oc_group', chatType: 'group', ...over } as LarkMessage;
  const deps = { sessionReply: vi.fn(async () => 'om_reply') } as unknown as CommandHandlerDeps;
  const manager = {
    begin: vi.fn(async () => ({ id: 'request-id', state: 'pending', expiresAt: 10_000, url: 'https://console.enterprise.trae.cn/authorization?secret=synthetic' })),
    status: vi.fn(() => ({ id: 'request-id', state: 'succeeded' })),
    cancel: vi.fn(async () => {}), cancelRequest: vi.fn(async () => {}), complete: vi.fn(async () => ({ state: 'verifying' })),
  } as unknown as TraeLoginManager;
  const send = vi.fn(async () => 'om_dm');
  const getConfig = vi.fn(() => cfg);
  const seams = { getDashboardAdminOpenIds: () => [admin], sendUserMessage: send,
    traeLogin: { manager, getConfig, deviceIsolated: () => false, platform: 'linux' as const, resolveBin: () => '/native/traecli' } };
  return { message, deps, manager, send, getConfig, seams };
}
describe('TRAE login through the sessionless administrator command', () => {
  it('keeps rich-text callback credentials out of parser debug logs', () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const enabled = vi.spyOn(logger, 'isDebug').mockReturnValue(true);
    try {
      parseEventMessage({ sender: { sender_id: { open_id: admin }, sender_type: 'user' }, message: {
        message_id: 'om_callback', chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'post', create_time: '100',
        content: JSON.stringify({ zh_cn: { title: '', content: [[
          { tag: 'text', text: '/dashboard trae-login comp' },
          { tag: 'text', text: 'lete request ' },
          { tag: 'a', text: 'http://127.0.0.1:1234/authorize?token=PARSER_PRIVATE_SECRET',
            href: 'http://127.0.0.1:1234/authorize?token=PARSER_PRIVATE_SECRET' },
        ]] } }),
      } });
      expect(debug).toHaveBeenCalled();
      expect(JSON.stringify(debug.mock.calls)).not.toContain('PARSER_PRIVATE_SECRET');
    } finally { debug.mockRestore(); enabled.mockRestore(); }
  });
  it('redacts parsed callback content after resolving a mention whose name contains spaces', () => {
    const { parsed } = parseEventMessage({ sender: { sender_id: { open_id: admin }, sender_type: 'user' }, message: {
      message_id: 'om_callback', chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'text', create_time: '100',
      mentions: [{ key: '@_user_1', name: 'Claude Code', id: { open_id: 'ou_bot' } }],
      content: JSON.stringify({ text: '@_user_1 /dashboard trae-login complete request http://127.0.0.1:1234/authorize?token=SPACED_NAME_SECRET' }),
    } });
    expect(redactTraeLoginCommand(parsed.content, stripLeadingMentions(parsed.content, parsed.mentions))).not.toContain('SPACED_NAME_SECRET');
  });
  it('keeps malformed callback URLs on the control path instead of forwarding them to a model', () => {
    expect(classifySlash({ text: '/dashboard trae-login complete\nrequest <http://127.0.0.1:1234/authorize?token=synthetic>',
      context: 'thread', phase: 'closed', passthrough: new Set(), coldStartPassthrough: new Set(),
      senderIsBot: false, acceptSlashFromBots: false,
    })).toMatchObject({ kind: 'daemon', cmd: '/dashboard', sessionPolicy: 'sessionless' });
  });
  it.each(['none', 'closed', 'dormant', 'running'] as const)('does not depend on a model in phase %s', phase => {
    expect(classifySlash({ text: '/dashboard trae-login', context: 'thread', phase,
      passthrough: new Set(), coldStartPassthrough: new Set(), senderIsBot: false, acceptSlashFromBots: false,
    })).toMatchObject({ kind: 'daemon', cmd: '/dashboard', sessionPolicy: 'sessionless' });
  });
  it('delivers the challenge only to the invoking administrator', async () => {
    const a = setup(); await handleDashboardCommand(a.message, 'trae-login', 'om_root', 'oc_group', a.deps, appId, a.seams);
    expect(a.manager.begin).toHaveBeenCalledOnce();
    expect(a.send).toHaveBeenCalledWith(appId, admin, expect.stringContaining('secret=synthetic'));
    expect(JSON.stringify(vi.mocked(a.deps.sessionReply).mock.calls)).not.toContain('synthetic');
  });
  it.each([{ senderId: 'ou_other' }, { senderType: 'app' }])('refuses an unauthorized sender before touching login state: %j', async over => {
    const a = setup(over); await handleDashboardCommand(a.message, 'trae-login', 'om_root', 'oc_group', a.deps, appId, a.seams);
    expect(a.getConfig).not.toHaveBeenCalled(); expect(a.manager.begin).not.toHaveBeenCalled(); expect(a.send).not.toHaveBeenCalled();
  });
  it('cancels after a DM delivery failure and never publishes the authorization URL', async () => {
    const a = setup(); a.send.mockRejectedValueOnce(new Error('delivery failure'));
    await handleDashboardCommand(a.message, 'trae-login', 'om_root', 'oc_group', a.deps, appId, a.seams);
    expect(a.manager.cancelRequest).toHaveBeenCalledWith({ appId, openId: admin }, 'request-id');
    expect(JSON.stringify(vi.mocked(a.deps.sessionReply).mock.calls)).not.toContain('synthetic');
  });
  it('refuses a public callback and accepts it only through the same bot\'s DM', async () => {
    const a = setup(); const args = 'trae-login complete request-id http://127.0.0.1:43210/authorize?token=synthetic';
    await handleDashboardCommand(a.message, args, 'om_root', 'oc_group', a.deps, appId, a.seams);
    expect(a.manager.complete).not.toHaveBeenCalled(); expect(a.getConfig).not.toHaveBeenCalled();
    await handleDashboardCommand({ ...a.message, chatType: 'p2p' }, args, 'om_dm', 'oc_dm', a.deps, appId, a.seams);
    expect(a.manager.complete).toHaveBeenCalledWith(expect.objectContaining({ root: '/private/trae' }),
      { appId, openId: admin }, 'request-id', 'http://127.0.0.1:43210/authorize?token=synthetic');
  });
  it.each([
    { cliId: 'codex' }, { backendType: 'riff' }, { wrapperCli: 'custom wrapper' },
    { cliLaunchMode: 'forge' }, { sandbox: true }, { sandbox: 'scratch' }, { readIsolation: true },
  ])('does not update host credentials for another credential domain: %j', over => {
    const resolveBin = vi.fn(); expect(resolveTraeLoginTarget({ ...cfg, ...over } as BotConfig,
      { resolveBin, deviceIsolated: () => false })).toBeUndefined(); expect(resolveBin).not.toHaveBeenCalled();
  });
  it('refuses device-isolated machines before resolving any login executable', () => {
    const resolveBin = vi.fn(); expect(resolveTraeLoginTarget(cfg, { resolveBin, deviceIsolated: () => true })).toBeUndefined();
    expect(resolveBin).not.toHaveBeenCalled();
  });
});
