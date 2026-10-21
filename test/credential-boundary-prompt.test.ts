/**
 * The credential-boundary prompt block.
 *
 * This release ships trigger-user auth WITHOUT kernel-level isolation, so this
 * block is the only thing standing between an agent and another person's token
 * file. That makes two properties worth pinning:
 *
 *   1. It reaches BOTH prompt paths. Claude-family adapters build their own
 *      system prompt; codex/gemini get an inline one. A block present in only
 *      one is a silent hole in whichever CLI the operator happens to run.
 *   2. It says what not to do AND what to do instead. "Don't read those files"
 *      alone leaves an agent debugging an auth failure with no alternative —
 *      which is exactly the situation that makes it go looking.
 *
 * Run:  npx vitest run --project unit test/credential-boundary-prompt.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildCredentialBoundaryBlock,
  buildBotmuxSystemPromptText,
} from '../src/adapters/cli/shared-hints.js';
import { buildNewTopicPrompt } from '../src/core/session-manager.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { parseTriggerUserAuthConfig } from '../src/services/trigger-user-auth.js';

const policy = parseTriggerUserAuthConfig({ enabled: true })!;

/** Stub only getBot: the credential block is gated on this bot's config, and
 *  everything else session-manager imports from the registry must stay real. */
const stubbedBots = new Map<string, unknown>();
const stubbedSessions = new Map<string, unknown>();
vi.mock('../src/bot-registry.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBot: (id: string) => {
    if (stubbedBots.has(id)) return stubbedBots.get(id);
    throw new Error(`unknown bot ${id}`);
  },
}));
vi.mock('../src/services/session-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSession: (id: string) => stubbedSessions.get(id),
}));

afterEach(() => stubbedSessions.clear());

describe('buildCredentialBoundaryBlock', () => {
  it.each(['zh', 'en'] as const)('names the governed tools and configured git host in %s', (locale) => {
    const lark = buildCredentialBoundaryBlock({ ...policy, tools: ['lark-cli'], gitHost: 'code.example.com' }, locale);
    expect(lark).toContain(locale === 'zh' ? '已为 lark-cli 启用' : 'credentials for lark-cli.');
    expect(lark).not.toContain('code.example.com');
    expect(lark).not.toContain('/login bytedcli');

    const byted = buildCredentialBoundaryBlock({ ...policy, tools: ['bytedcli'] }, locale);
    expect(byted).toContain(locale === 'zh' ? '已为 bytedcli 启用' : 'credentials for bytedcli.');
    expect(byted).not.toContain('git');
    expect(byted).not.toContain('missing_scope');
    expect(byted).toContain(locale === 'zh' ? 'stderr 已附授权链接' : 'If stderr carries an authorization link');
    expect(byted).toContain(locale === 'zh' ? '只需授权一次、自动续期' : 'authorize just once, it renews automatically');
    // The Feishu-specific failure flow must follow the same gate as lark-cli.
    // Discriminate on that line itself: on_auth_link is emitted for every tool
    // and also mentions `botmux auth request`, so the shared phrase cannot tell
    // the two branches apart.
    const feishuFailureLine = locale === 'zh' ? '遇到飞书鉴权失败' : 'On a Feishu auth failure';
    expect(byted).not.toContain(feishuFailureLine);
    expect(lark).toContain(feishuFailureLine);

    const git = buildCredentialBoundaryBlock({ ...policy, gitHost: 'code.example.com' }, locale);
    expect(git).toContain('git');
    expect(git).toContain('code.example.com');
  });

  it('omits the block for disabled or empty policies', () => {
    expect(buildCredentialBoundaryBlock(undefined, 'en')).toBe('');
    expect(buildCredentialBoundaryBlock({ ...policy, enabled: false }, 'en')).toBe('');
    expect(buildCredentialBoundaryBlock({ ...policy, tools: [] }, 'en')).toBe('');
  });

  it('names the exact files an agent must not read', () => {
    const zh = buildCredentialBoundaryBlock(policy, 'zh');
    // A vague "don't touch credentials" is unactionable; the path is what makes
    // the rule checkable by the agent itself.
    expect(zh).toContain('user-token-');
    expect(zh).toContain('~/.botmux/data/');
  });

  it('tells the agent what to do instead of hunting for credentials', () => {
    const zh = buildCredentialBoundaryBlock(policy, 'zh');
    expect(zh).toContain('/login');
  });

  it.each(['zh', 'en'] as const)('bundles only the planned task permissions after missing_scope in %s', locale => {
    const prompt = buildCredentialBoundaryBlock({ ...policy, tools: ['lark-cli'] }, locale);
    expect(prompt).not.toContain('base:field:read base:record:read');
    // The contributor guide does not ship in the npm package, so the injected
    // prompt must not point users at a path they cannot open.
    expect(prompt).not.toContain('docs/guide/lark-device-authorization.md');
    expect(prompt).toContain(locale === 'zh' ? '不要重跑普通 /login' : 'do not repeat ordinary /login');
    expect(prompt).toContain(locale === 'zh' ? '一次合并所需权限' : 'request them together');
    expect(prompt).toContain(locale === 'zh' ? '不申请无关或未经核实的权限' : 'never request unrelated or unverified scopes');
    expect(prompt).toContain('botmux auth wait --request-id &lt;requestId&gt; --json');
  });

  it('covers forwarding, not just reading', () => {
    // Reading is one leak path; pasting a token the agent legitimately holds
    // into a message or a commit is another, and far easier to do by accident.
    const en = buildCredentialBoundaryBlock(policy, 'en');
    expect(en.toLowerCase()).toContain('commit');
    expect(en.toLowerCase()).toContain('log');
  });

  it('is wrapped in one tagged block so it reads as policy, not prose', () => {
    const zh = buildCredentialBoundaryBlock(policy, 'zh');
    expect(zh.startsWith('<botmux_credentials>')).toBe(true);
    expect(zh.trimEnd().endsWith('</botmux_credentials>')).toBe(true);
  });

  it('renders in both locales', () => {
    for (const locale of ['zh', 'en'] as const) {
      expect(buildCredentialBoundaryBlock(policy, locale)).toContain('user-token-');
    }
  });
});

describe('buildBotmuxSystemPromptText — claude-family path', () => {
  it.each(['claude-code', 'genius', 'grok'] as const)('%s forwards the selected tools into its system prompt', (cli) => {
    const args = createCliAdapterSync(cli).buildArgs({
      sessionId: 'sess-cred', resume: false, locale: 'en',
      triggerUserAuth: { ...policy, tools: ['bytedcli'], gitHost: 'code.example.com' },
    });
    const text = args.find(arg => arg.includes('<botmux_credentials>'))!;
    expect(text).toContain('credentials for bytedcli.');
    expect(text).toContain('code.example.com');
    expect(text).not.toContain('missing_scope');
  });

  it('adds the block when trigger-user auth is on', () => {
    const text = buildBotmuxSystemPromptText({ locale: 'zh', triggerUserAuth: { ...policy, tools: ['lark-cli'] } });
    expect(text).toContain('<botmux_credentials>');
    expect(text).toContain('user-token-');
    expect(text).not.toContain('/login bytedcli');
  });

  // A bot that never enabled the feature must not pay for prompt text about a
  // boundary it does not have.
  it('adds nothing when the feature is off', () => {
    const off = buildBotmuxSystemPromptText({ locale: 'zh' });
    expect(off).not.toContain('<botmux_credentials>');
    expect(off).not.toContain('user-token-');
  });

  it('keeps the block for a no-transport session', () => {
    // No Feishu channel does not mean no credentials: the CLI still runs as a
    // person and the token store still holds everyone else's files.
    const text = buildBotmuxSystemPromptText({
      locale: 'zh', triggerUserAuth: policy, noTransport: true,
    });
    expect(text).toContain('<botmux_credentials>');
  });

  it('emits the block exactly once', () => {
    const text = buildBotmuxSystemPromptText({
      locale: 'zh', botName: 'b', botOpenId: 'ou_x', triggerUserAuth: policy,
    });
    expect(text.match(/<botmux_credentials>/g)).toHaveLength(1);
  });

  it.each(['claude-code', 'genius', 'grok', 'pi', 'oh-my-pi'] as const)(
    '%s describes a managed lark-cli as bot-default without changing bytedcli identity',
    (cli) => {
      const env: Record<string, string> = {};
      const args = createCliAdapterSync(cli).buildArgs({
        sessionId: 'sess-bound', resume: false, locale: 'zh', larkAppId: 'cli_current',
        triggerUserAuth: { ...policy, tools: ['lark-cli', 'bytedcli'] },
        larkToolAppId: 'cli_current',
        env,
      });
      const text = cli === 'pi' || cli === 'oh-my-pi'
        ? env.BOTMUX_APPEND_SYSTEM_PROMPT
        : args.find(arg => arg.includes('<botmux_lark_tool>'));
      expect(text).toContain('lark-cli 固定使用当前机器人的应用 cli_current');
      expect(text).toContain('默认以 bot 身份调用');
      expect(text).toContain('--as user');
      expect(text).toContain('已为 bytedcli 启用按当前消息发起人身份注入授权');
      expect(text).not.toContain('已为 lark-cli / bytedcli 启用');
      expect(text).not.toContain('已为 lark-cli 启用按当前消息发起人身份注入授权');
    },
  );

  it('keeps managed lark-cli guidance when trigger-user auth is off', () => {
    const text = buildBotmuxSystemPromptText({
      locale: 'zh', larkToolAppId: 'cli_current',
    });
    expect(text).toContain('<botmux_lark_tool>');
    expect(text).toContain('默认以 bot 身份调用');
    expect(text).not.toContain('<botmux_credentials>');
  });

  it.each(['codex-app', 'dsh', 'mir'] as const)(
    '%s does not duplicate the managed lark app on argv',
    (cli) => {
      const args = createCliAdapterSync(cli).buildArgs({
        sessionId: 'sess-bound', resume: false, locale: 'zh', larkToolAppId: 'cli_current',
      });
      expect(args).not.toContain('--lark-tool-app-id');
    },
  );

  it('includes managed local guidance for Codex but excludes cloud Mira', () => {
    const appId = 'cli_mira_control';
    stubbedBots.set(appId, {
      config: {
        larkAppId: appId,
        larkToolBinding: true,
        triggerUserAuth: { enabled: true, tools: ['lark-cli'], fallback: 'bot-identity' },
      },
    });
    try {
      const opening = (cliId: 'codex' | 'mira') => buildNewTopicPrompt(
        'read the linked doc', `sess-${cliId}`, cliId, undefined, undefined, undefined,
        undefined, undefined, { name: 'Bot', openId: 'ou_bot' }, 'zh', undefined,
        { larkAppId: appId, chatId: 'oc_chat', larkToolResume: false },
      );
      expect(opening('codex')).toContain('<botmux_lark_tool>');
      expect(opening('mira')).not.toContain('<botmux_lark_tool>');
    } finally {
      stubbedBots.delete(appId);
    }
  });
});

/**
 * The INLINE prompt path — the half this file's header always claimed but never
 * covered.
 *
 * The claude-family assertions above go through buildBotmuxSystemPromptText.
 * codex/gemini/… never call it: they get the block inline, from
 * buildNewTopicPrompt. Until this suite existed, deleting the inline push left
 * every test green — and the inline CLIs then ran with no credential constraint
 * at all, which in a release with no kernel-level isolation is the whole
 * protection gone.
 *
 * Also pinned here: the block must survive HOOK mode. #998 splits opening blocks
 * into a hook envelope and PTY text by key; `credentials` is deliberately NOT in
 * ENVELOPE_KEYS, so it stays in the PTY text both ways. An agent that cannot
 * read the envelope must still see the boundary.
 */
describe('buildNewTopicPrompt — inline prompt path', () => {
  const inlineCli = 'codex';
  const APP = 'cli_credboundary';

  function withTriggerUserAuth(enabled: boolean, run: () => void, tools = ['lark-cli'], larkToolBinding = true): void {
    stubbedBots.set(APP, {
      config: {
        larkAppId: APP,
        larkToolBinding,
        ...(enabled
          ? { triggerUserAuth: { enabled: true, tools, fallback: 'bot-identity' } }
          : {}),
      },
    });
    try { run(); } finally { stubbedBots.delete(APP); }
  }

  const opening = (larkAppId?: string) => buildNewTopicPrompt(
    'read the linked doc', 'sess-cred', inlineCli, undefined, undefined, undefined,
    undefined, undefined, { name: 'Bot', openId: 'ou_bot' }, 'zh', undefined,
    larkAppId ? { larkAppId } : {},
  );
  const boundOpening = () => buildNewTopicPrompt(
    'read the linked doc', 'sess-bound', inlineCli, undefined, undefined, undefined,
    undefined, undefined, { name: 'Bot', openId: 'ou_bot' }, 'zh', undefined,
    { larkAppId: APP, chatId: 'oc_chat', larkToolResume: false },
  );

  it('includes the credential boundary when the policy is on', () => {
    withTriggerUserAuth(true, () => {
      const text = opening(APP);
      expect(text).toContain('<botmux_credentials>');
      expect(text).not.toContain('/login bytedcli');
    });
  });

  it('omits it when the policy is off', () => {
    withTriggerUserAuth(false, () => {
      expect(opening(APP)).not.toContain('<botmux_credentials>');
    });
  });

  it('omits it when no bot is named (uncertain answer must not claim a boundary)', () => {
    withTriggerUserAuth(true, () => {
      expect(opening(undefined)).not.toContain('<botmux_credentials>');
    });
  });

  it('uses managed bot-default identity and preserves only other trigger-user tools', () => {
    withTriggerUserAuth(true, () => {
      const text = boundOpening();
      expect(text).toContain('<botmux_lark_tool>');
      expect(text).toContain('lark-cli 固定使用当前机器人的应用 cli_credboundary');
      expect(text).toContain('默认以 bot 身份调用');
      expect(text).toContain('--as user');
      expect(text).toContain('已为 bytedcli 启用按当前消息发起人身份注入授权');
      expect(text).not.toContain('已为 lark-cli / bytedcli 启用');
      expect(text).not.toContain('已为 lark-cli 启用按当前消息发起人身份注入授权');
    }, ['lark-cli', 'bytedcli']);
  });

  it('keeps common credential safety rules for managed lark-only policy', () => {
    withTriggerUserAuth(true, () => {
      const text = boundOpening();
      expect(text).toContain('不得读取、列举、复制或输出');
      expect(text).toContain('不得把任何 token、JWT、access key');
      expect(text).not.toContain('已为 lark-cli 启用按当前消息发起人身份注入授权');
    });
  });

  it('still explains managed lark-cli when trigger-user auth is off', () => {
    withTriggerUserAuth(false, () => {
      const text = boundOpening();
      expect(text).toContain('<botmux_lark_tool>');
      expect(text).toContain('默认以 bot 身份调用');
      expect(text).not.toContain('<botmux_credentials>');
    });
  });

  it.each([
    ['an adopted session', { adoptedFrom: { cwd: '/tmp' } }],
    ['an external app-server session', { existingAppServerEndpoint: 'http://127.0.0.1:3000' }],
    ['a remote backend session', { backendType: 'riff' }],
  ])('does not claim managed lark identity for %s without a binding', (_name, session) => {
    withTriggerUserAuth(true, () => {
      stubbedSessions.set('sess-bound', session);
      const text = boundOpening();
      expect(text).not.toContain('<botmux_lark_tool>');
      expect(text).toContain('已为 lark-cli 启用按当前消息发起人身份注入授权');
    });
  });

  it('keeps managed identity on a fresh retry even when lastCliInput was pre-persisted', () => {
    withTriggerUserAuth(true, () => {
      stubbedSessions.set('sess-bound', { lastCliInput: 'pre-persisted before failed first spawn' });
      const text = boundOpening();
      expect(text).toContain('<botmux_lark_tool>');
      expect(text).not.toContain('已为 lark-cli 启用按当前消息发起人身份注入授权');
    });
  });

  it('omits managed lark identity when larkToolBinding is off even if triggerUserAuth is on', () => {
    withTriggerUserAuth(true, () => {
      const text = boundOpening();
      expect(text).not.toContain('<botmux_lark_tool>');
      expect(text).toContain('已为 lark-cli 启用按当前消息发起人身份注入授权');
    }, ['lark-cli'], false);
  });

  it('does not claim managed lark identity inside workflow workers', () => {
    withTriggerUserAuth(true, () => {
      process.env.BOTMUX_WORKFLOW = '1';
      try {
        const text = boundOpening();
        expect(text).not.toContain('<botmux_lark_tool>');
        expect(text).toContain('已为 lark-cli 启用按当前消息发起人身份注入授权');
      } finally {
        delete process.env.BOTMUX_WORKFLOW;
      }
    });
  });
});
