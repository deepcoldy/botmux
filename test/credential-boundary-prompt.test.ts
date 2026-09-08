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
import { describe, it, expect, vi } from 'vitest';
import {
  buildCredentialBoundaryBlock,
  buildBotmuxSystemPromptText,
} from '../src/adapters/cli/shared-hints.js';
import { buildNewTopicPrompt } from '../src/core/session-manager.js';

/** Stub only getBot: the credential block is gated on this bot's config, and
 *  everything else session-manager imports from the registry must stay real. */
const stubbedBots = new Map<string, unknown>();
vi.mock('../src/bot-registry.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBot: (id: string) => {
    if (stubbedBots.has(id)) return stubbedBots.get(id);
    throw new Error(`unknown bot ${id}`);
  },
}));

describe('buildCredentialBoundaryBlock', () => {
  it('names the exact files an agent must not read', () => {
    const zh = buildCredentialBoundaryBlock('zh');
    // A vague "don't touch credentials" is unactionable; the path is what makes
    // the rule checkable by the agent itself.
    expect(zh).toContain('user-token-');
    expect(zh).toContain('~/.botmux/data/');
  });

  it('tells the agent what to do instead of hunting for credentials', () => {
    const zh = buildCredentialBoundaryBlock('zh');
    expect(zh).toContain('/login');
  });

  it('covers forwarding, not just reading', () => {
    // Reading is one leak path; pasting a token the agent legitimately holds
    // into a message or a commit is another, and far easier to do by accident.
    const en = buildCredentialBoundaryBlock('en');
    expect(en.toLowerCase()).toContain('commit');
    expect(en.toLowerCase()).toContain('log');
  });

  it('is wrapped in one tagged block so it reads as policy, not prose', () => {
    const zh = buildCredentialBoundaryBlock('zh');
    expect(zh.startsWith('<botmux_credentials>')).toBe(true);
    expect(zh.trimEnd().endsWith('</botmux_credentials>')).toBe(true);
  });

  it('renders in both locales', () => {
    for (const locale of ['zh', 'en'] as const) {
      expect(buildCredentialBoundaryBlock(locale)).toContain('user-token-');
    }
  });
});

describe('buildBotmuxSystemPromptText — claude-family path', () => {
  it('adds the block when trigger-user auth is on', () => {
    const text = buildBotmuxSystemPromptText({ locale: 'zh', triggerUserAuth: true });
    expect(text).toContain('<botmux_credentials>');
    expect(text).toContain('user-token-');
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
      locale: 'zh', triggerUserAuth: true, noTransport: true,
    });
    expect(text).toContain('<botmux_credentials>');
  });

  it('emits the block exactly once', () => {
    const text = buildBotmuxSystemPromptText({
      locale: 'zh', botName: 'b', botOpenId: 'ou_x', triggerUserAuth: true,
    });
    expect(text.match(/<botmux_credentials>/g)).toHaveLength(1);
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

  function withTriggerUserAuth(enabled: boolean, run: () => void): void {
    stubbedBots.set(APP, {
      config: {
        larkAppId: APP,
        ...(enabled
          ? { triggerUserAuth: { enabled: true, tools: ['lark-cli'], fallback: 'bot-identity' } }
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

  it('includes the credential boundary when the policy is on', () => {
    withTriggerUserAuth(true, () => {
      expect(opening(APP)).toContain('<botmux_credentials>');
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
});
