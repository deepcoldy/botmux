import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharedBotSandboxAdvice } from '../src/dashboard/web/bot-defaults-page.js';
import type { BotDefaultsRow } from '../src/dashboard/web/bot-defaults.js';

const shared = {
  larkAppId: 'cli_demo', cliId: 'claude-code', sandboxMode: 'off',
  oncallSharedChatCount: 2, allowedUsersCount: 3,
  localSandboxApplies: true, sandboxCapable: true, sandboxNetworkPolicyPlatform: 'linux',
} as unknown as BotDefaultsRow;

const render = (bot: Partial<BotDefaultsRow>) =>
  renderToStaticMarkup(createElement(SharedBotSandboxAdvice, { bot: { ...shared, ...bot } as BotDefaultsRow }));

describe('Dashboard shared-bot sandbox advice', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders in the browser bundle, where there is no `process`', () => {
    // The page bundle has no Node globals: reading process.platform there threw
    // and took the whole sandbox section down for every shared bot.
    vi.stubGlobal('process', undefined);
    expect(render({ cliId: 'codex-app', sandboxNetworkPolicyPlatform: 'linux' })).toContain('data-shared-sandbox-advice="unsupported"');
    expect(render({ cliId: 'codex-app', sandboxNetworkPolicyPlatform: 'darwin' })).toContain('data-shared-sandbox-advice="unverified"');
    expect(render({ cliId: 'claude-code' })).toContain('data-shared-sandbox-advice="verified"');
  });

  it('is short lines, one fact each, with the verified list folded away', () => {
    const html = render({ cliId: 'claude-code' });
    // Deterministic markup: assert the exact paragraphs (no tag stripping, which
    // also trips CodeQL's incomplete-sanitization rule on this test file).
    expect(html).toContain('<p><strong>⚠️ 建议开启白名单隔离</strong></p>');
    expect(html).toContain('<p>这个 bot 被多人使用，群成员可以通过 agent 读到本机凭证。</p>');
    expect(html).toContain('<p>原因：开了 Oncall 值班模式、allowedUsers 有多人</p>');
    expect(html).toMatch(/<p>开启：在下方选「[^」]+」，新会话生效。<\/p>/);
    expect(html).toContain('<p>当前 CLI：Claude，已验证可用。</p>');
    // Folded: a closed <details> holding the matrix list, literal order.
    expect(html).toMatch(/<details><summary>已验证可用的 CLI（Linux 实测）<\/summary><p>Claude、Codex、Antigravity、OpenCode、Pi、Oh My Pi、Grok Build、Kimi<\/p><\/details>/);
    expect(html).not.toMatch(/<details open/);
  });

  it('says nothing for a bot only its owner uses, or one already isolated', () => {
    expect(render({ oncallSharedChatCount: 0, allowedUsersCount: 1 })).toBe('');
    expect(render({ effectiveSandboxMode: 'oncall' } as Partial<BotDefaultsRow>)).toBe('');
  });

  it('wires the allowedChatGroups reason through from the daemon payload', () => {
    // Leaving this prop unconnected must be visible: it is the leg added for
    // whole-group talk-open bots.
    const html = render({ oncallSharedChatCount: 0, allowedUsersCount: 1, allowedChatGroupsCount: 2 });
    expect(html).toContain('原因：allowedChatGroups 授权了整群发言');
    expect(html).toContain('data-shared-sandbox-advice="verified"');
  });

  it('renders the wrapper / custom-runtime caveat states from the daemon payload', () => {
    const wrapperHtml = render({ cliId: 'claude-code', wrapperCli: 'aiden --' });
    expect(wrapperHtml).toContain('data-shared-sandbox-advice="wrapper"');
    // Post-#2548 the wrapper runs INSIDE the sandbox; the copy must not say it is
    // skipped/dropped (which would scare wrapper users off enabling isolation).
    expect(wrapperHtml).toContain('wrapper 仍在沙盒内运行');
    expect(wrapperHtml).not.toContain('跳过 wrapper');
    expect(render({ cliId: 'claude-code', cliRuntime: { id: 'r', executable: '/x' } as BotDefaultsRow['cliRuntime'] }))
      .toContain('data-shared-sandbox-advice="unverified"');
  });

  it('stays silent for a remote backend where no local sandbox can engage', () => {
    // riff / remote-runner execute off this host; the toggle cannot apply there.
    expect(render({ localSandboxApplies: false })).toBe('');
    // Old daemons do not report the flag: null falls back to the historical
    // local-bot behaviour, so the advice still renders.
    expect(render({ localSandboxApplies: null })).not.toBe('');
  });

  it('points to tmux/pty (not "turn it on below") when the local backend refuses a sandbox', () => {
    const html = render({ cliId: 'claude-code', sandboxCapable: false });
    expect(html).toContain('data-shared-sandbox-advice="blocked"');
    expect(html).toContain('当前会话后端不支持文件沙盒');
    // No "pick oncall below" action line and no verified-list fold for this state.
    expect(html).not.toContain('在下方选');
    expect(html).not.toContain('<details');
  });
});
