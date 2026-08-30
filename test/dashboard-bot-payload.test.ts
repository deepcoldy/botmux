import { describe, expect, it } from 'vitest';
import { botDefaultsPayload, botSummaryPayload, brandMapByAppId } from '../src/dashboard/bot-payload.js';

describe('dashboard bot payload helpers', () => {
  it('keeps every editable Bot Defaults field in the aggregated /api/bots row', () => {
    const row = botDefaultsPayload(
      {
        larkAppId: 'app_contract',
        botName: 'BotContract',
        cliId: 'codex',
        cliRuntime: { id: 'vendor-codex', executable: 'vendor-codex' },
        model: 'gpt-5',
      },
      {},
    );
    const editableFields = [
      'agentSelectionKey', 'autoGrantRequestCards', 'autoStartOnGroupJoin',
      'autoStartOnGroupJoinPrompt', 'autoStartOnGroupJoinSeed', 'autoStartOnGroupJoinSeedDefault',
      'autoStartOnNewTopic', 'backendType',
      'botToBotSameDir', 'brandLabel', 'canTalkDaemonCommands', 'cliRuntime', 'codexAppCleanInput', 'codexAuthSync',
      'customPassthroughCommands', 'defaultOncall', 'defaultWorkingDir',
      'defaultWorkingDirAutoWorktree', 'disableStreamingCard', 'docSubscribeDefaultMode',
      'envelopeInjection', 'env', 'grantDefaultDurationMs', 'launchShell', 'maxLiveWorkers', 'messageQuotaDefaultLimit', 'model',
      'feedback',
      'overloadAlert', 'p2pMode', 'p2pOpen', 'privateCard', 'regularGroupMentionMode',
      'regularGroupReplyMode', 'restrictGrantCommands', 'riff', 'sandbox', 'sandboxPaths',
      'silentTurnReactions', 'skillInjection', 'startupCommands', 'substituteMode',
      'summaryMemory', 'summaryMemoryPath', 'summaryRange', 'senderTag', 'writableTerminalLinkInCard',
      'sessionOwnerReminder',
    ];
    expect(Object.keys(row)).toEqual(expect.arrayContaining(editableFields));
  });

  it('normalizes the Codex auth policy to the upgrade-compatible shared default', () => {
    expect(botDefaultsPayload({ larkAppId: 'app' }, {})).toMatchObject({ codexAuthSync: 'shared' });
    expect(botDefaultsPayload({ larkAppId: 'app' }, { codexAuthSync: 'isolated' }))
      .toMatchObject({ codexAuthSync: 'isolated' });
  });

  it('exposes feedback policy only in private Bot Defaults payloads', () => {
    const feedback = { enabled: true, audience: 'requester' };
    expect(botDefaultsPayload({ larkAppId: 'app' }, { feedback })).toMatchObject({ feedback });
    expect(botSummaryPayload({ larkAppId: 'app' })).not.toHaveProperty('feedback');
  });

  it('keeps executable runtime details out of public group roster summaries', () => {
    const cliRuntime = {
      id: 'vendor-codex',
      displayName: 'Vendor Codex',
      executable: 'vendor-codex',
      update: { provider: 'auto' as const },
    };
    expect(botSummaryPayload({
      larkAppId: 'cli_vendor',
      botName: 'Vendor Bot',
      botAvatarUrl: 'https://example.test/avatar.png',
      cliId: 'codex',
      cliRuntime,
      cliPathOverride: '/private/legacy/vendor-codex',
    })).toEqual({
      larkAppId: 'cli_vendor',
      botName: 'Vendor Bot',
      botAvatarUrl: 'https://example.test/avatar.png',
      cliId: 'codex',
    });
  });

  it('carries a legacy path only in the private Bot Defaults payload', () => {
    const daemon = {
      larkAppId: 'cli_legacy',
      cliId: 'codex',
      cliPathOverride: '/private/legacy/vendor-codex',
    };
    expect(botDefaultsPayload(daemon, {})).toMatchObject({
      cliPathOverride: '/private/legacy/vendor-codex',
    });
    expect(botSummaryPayload(daemon)).toEqual({
      larkAppId: 'cli_legacy',
      botName: undefined,
      cliId: 'codex',
    });
  });

  it('keeps cliRuntime in both success and degraded Bot Defaults rows', () => {
    const cliRuntime = { id: 'vendor-codex', executable: 'vendor-codex' };
    const daemon = { larkAppId: 'cli_vendor', cliId: 'codex', cliRuntime };
    expect(botDefaultsPayload(daemon, {})).toMatchObject({ cliRuntime });
    expect(botDefaultsPayload(daemon, undefined, 'offline')).toMatchObject({ cliRuntime, error: 'offline' });
  });

  it('includes authoritative cliId in /api/bots success and error rows', () => {
    const daemon = { larkAppId: 'cli_traex', botName: 'TraeX', cliId: 'traex', model: 'glm-5.1' };
    expect(botDefaultsPayload(daemon, { defaultOncall: { enabled: false } })).toMatchObject({
      larkAppId: 'cli_traex',
      botName: 'TraeX',
      cliId: 'traex',
      model: 'glm-5.1',
      online: true,
      defaultOncall: { enabled: false },
    });
    expect(botDefaultsPayload(daemon, undefined, 'http_503')).toMatchObject({
      larkAppId: 'cli_traex',
      botName: 'TraeX',
      cliId: 'traex',
      model: 'glm-5.1',
      online: true,
      error: 'http_503',
    });
  });

  it('passes through resident/dormant/logical session counts for the bot card', () => {
    const daemon = { larkAppId: 'app_a', botName: 'BotA', cliId: 'codex' };
    expect(botDefaultsPayload(daemon, {
      logicalSessionCount: 83,
      residentSessionCount: 29,
      dormantSessionCount: 54,
    })).toMatchObject({
      logicalSessionCount: 83,
      residentSessionCount: 29,
      dormantSessionCount: 54,
    });
    expect(botDefaultsPayload(daemon, {})).toMatchObject({
      logicalSessionCount: 0,
      residentSessionCount: 0,
      dormantSessionCount: 0,
    });
  });

  it('projects slash-command config fields (customPassthrough / canTalkDaemon) as strings, defaulting to empty', () => {
    const daemon = { larkAppId: 'app_slash', botName: 'BotS', cliId: 'claude-code' };
    // 上游 IPC 给的是 space-joined 字符串 → 原样带出供 Dashboard 输入框回填。
    expect(botDefaultsPayload(daemon, {
      customPassthroughCommands: '/goal /export',
      canTalkDaemonCommands: '/status /help',
    })).toMatchObject({
      customPassthroughCommands: '/goal /export',
      canTalkDaemonCommands: '/status /help',
    });
    // 缺省（未配置）→ 空串，输入框显示 placeholder，不会渲染成 undefined。
    expect(botDefaultsPayload(daemon, {})).toMatchObject({
      customPassthroughCommands: '',
      canTalkDaemonCommands: '',
    });
    // 非字符串（异常上游）→ 兜底空串，绝不把对象/数组塞进输入框。
    expect(botDefaultsPayload(daemon, {
      customPassthroughCommands: ['/goal'] as any,
      canTalkDaemonCommands: 42 as any,
    })).toMatchObject({
      customPassthroughCommands: '',
      canTalkDaemonCommands: '',
    });
  });

  it('projects launchShell so the dashboard preserves it after refresh', () => {
    const daemon = { larkAppId: 'app_shell', botName: 'BotShell', cliId: 'codex' };
    expect(botDefaultsPayload(daemon, { launchShell: '/usr/bin/zsh' })).toMatchObject({
      launchShell: '/usr/bin/zsh',
    });
    expect(botDefaultsPayload(daemon, {})).toMatchObject({ launchShell: '' });
    expect(botDefaultsPayload(daemon, { launchShell: ['zsh'] as any })).toMatchObject({
      launchShell: '',
    });
  });

  it('projects docSubscribeDefaultMode so the dashboard preserves it after refresh', () => {
    const daemon = { larkAppId: 'app_doc', botName: 'BotDoc', cliId: 'claude-code' };
    expect(botDefaultsPayload(daemon, { docSubscribeDefaultMode: 'all' })).toMatchObject({
      docSubscribeDefaultMode: 'all',
    });
    expect(botDefaultsPayload(daemon, {})).toMatchObject({
      docSubscribeDefaultMode: 'mention-only',
    });
    expect(botDefaultsPayload(daemon, { docSubscribeDefaultMode: 'invalid' })).toMatchObject({
      docSubscribeDefaultMode: 'mention-only',
    });
  });

  it('projects Codex App clean history mode as an explicit default-off boolean', () => {
    const daemon = { larkAppId: 'app_codex', botName: 'Codex', cliId: 'codex-app' };
    expect(botDefaultsPayload(daemon, {})).toMatchObject({ codexAppCleanInput: false });
    expect(botDefaultsPayload(daemon, { codexAppCleanInput: true }))
      .toMatchObject({ codexAppCleanInput: true });
  });

  it('projects hook envelope injection so the dashboard preserves it after refresh', () => {
    const daemon = { larkAppId: 'app_claude', botName: 'Claude', cliId: 'claude-code' };
    expect(botDefaultsPayload(daemon, {})).toMatchObject({ envelopeInjection: 'off' });
    expect(botDefaultsPayload(daemon, { envelopeInjection: 'auto' }))
      .toMatchObject({ envelopeInjection: 'auto' });
    expect(botDefaultsPayload(daemon, { envelopeInjection: 'invalid' }))
      .toMatchObject({ envelopeInjection: 'off' });
  });

  it('projects the usage-display mode, defaulting to streaming and honoring legacy/off', () => {
    const daemon = { larkAppId: 'app_usage', botName: 'Usage', cliId: 'codex' };
    expect(botDefaultsPayload(daemon, {})).toMatchObject({ usageDisplay: 'streaming' });
    expect(botDefaultsPayload(daemon, { usageDisplay: 'footer' }))
      .toMatchObject({ usageDisplay: 'footer' });
    expect(botDefaultsPayload(daemon, { usageDisplay: 'off' }))
      .toMatchObject({ usageDisplay: 'off' });
    // Legacy boolean projects to 'off'.
    expect(botDefaultsPayload(daemon, { showUsageInCardFooter: false }))
      .toMatchObject({ usageDisplay: 'off' });
  });

  it('projects sandboxPaths three tiers, defaulting to null when absent or malformed', () => {
    const daemon = { larkAppId: 'app_sbx', botName: 'Sbx', cliId: 'claude-code' };
    // Absent → null (pure deny-by-default baseline, no rules to render).
    expect(botDefaultsPayload(daemon, {})).toMatchObject({ sandboxPaths: null });
    // Present → normalized to three string arrays, non-strings filtered out.
    expect(botDefaultsPayload(daemon, {
      sandboxPaths: { readWrite: ['~/my-data', 123], readOnly: ['~/.claude'], deny: ['~/my-data/secrets'] },
    })).toMatchObject({
      sandboxPaths: { readWrite: ['~/my-data'], readOnly: ['~/.claude'], deny: ['~/my-data/secrets'] },
    });
    // Malformed (array instead of object) → null, never a crash.
    expect(botDefaultsPayload(daemon, { sandboxPaths: ['nope'] as any })).toMatchObject({ sandboxPaths: null });
  });

  it('derives agentSelectionKey from cliId + wrapperCli so the 修改CLI dropdown highlights wrapper gateways', () => {
    // 裸 CLI：选择键 = cliId。
    expect(botDefaultsPayload(
      { larkAppId: 'app_a', botName: 'BotA', cliId: 'claude-code' },
      { defaultOncall: { enabled: false } },
    )).toMatchObject({ cliId: 'claude-code', agentSelectionKey: 'claude-code' });

    // wrapper 网关：选择键 = 对应的 aiden×/ttadk×/cjadk× 选项键（而非裸 cliId），
    // 否则前端下拉高亮回落到裸 cliId，重载后 wrapper 丢失、再保存被剥掉。
    expect(botDefaultsPayload(
      { larkAppId: 'app_a', botName: 'BotA', cliId: 'claude-code', wrapperCli: 'aiden x claude' },
      { defaultOncall: { enabled: false } },
    )).toMatchObject({
      cliId: 'claude-code',
      wrapperCli: 'aiden x claude',
      agentSelectionKey: 'aiden-x-claude',
    });
    expect(botDefaultsPayload(
      { larkAppId: 'app_a', botName: 'BotA', cliId: 'codex', wrapperCli: 'ttadk codex' },
      { defaultOncall: { enabled: false } },
    )).toMatchObject({ agentSelectionKey: 'ttadk-x-codex' });
    expect(botDefaultsPayload(
      { larkAppId: 'app_a', botName: 'BotA', cliId: 'codex', wrapperCli: 'cjadk codex' },
      { defaultOncall: { enabled: false } },
    )).toMatchObject({ agentSelectionKey: 'cjadk-x-codex' });

    // 无 cliId（配置缺失）→ 不下发 agentSelectionKey，前端回落默认 claude-code。
    expect(botDefaultsPayload({ larkAppId: 'app_a' }, {}))
      .not.toHaveProperty('agentSelectionKey');
  });

  it('passes through displayName / larkBotName and normalizes missing to null', () => {
    const daemon = { larkAppId: 'app_a', botName: '小助手', cliId: 'codex' };
    expect(botDefaultsPayload(daemon, { displayName: '小助手', larkBotName: 'Claude' })).toMatchObject({
      displayName: '小助手',
      larkBotName: 'Claude',
    });
    // Unset custom name / probe not landed yet → both null.
    expect(botDefaultsPayload(daemon, {})).toMatchObject({ displayName: null, larkBotName: null });
    expect(botDefaultsPayload(daemon, { displayName: 42, larkBotName: {} })).toMatchObject({
      displayName: null,
      larkBotName: null,
    });
  });

  it('passes through defaultWorkingDir (string) and normalizes missing to null', () => {
    const daemon = { larkAppId: 'app_a', botName: 'BotA', cliId: 'codex' };
    expect(botDefaultsPayload(daemon, { defaultWorkingDir: '/root/iserver/botmux' })).toMatchObject({
      defaultWorkingDir: '/root/iserver/botmux',
    });
    // Missing / non-string → null (the "off" or "oncall" modes carry no defaultWorkingDir).
    expect(botDefaultsPayload(daemon, {}).defaultWorkingDir).toBeNull();
    expect(botDefaultsPayload(daemon, { defaultWorkingDir: 123 }).defaultWorkingDir).toBeNull();
  });

  it('passes through workingDir (string) and normalizes missing to null', () => {
    // 克隆弹窗靠这一行判断源 Bot 是 card 还是 fixed 目录形态。少了它，
    // 只有 workingDir 的源会被按 fixed 预填，目标带上 defaultWorkingDir:'~'，
    // 在后端 `defaultWorkingDir ?? workingDir` 里把源目录静默遮蔽掉。
    const daemon = { larkAppId: 'app_a', botName: 'BotA', cliId: 'codex' };
    expect(botDefaultsPayload(daemon, { workingDir: '/repo/my-project' })).toMatchObject({
      workingDir: '/repo/my-project',
    });
    // Missing / non-string → null（fixed 形态的 bot 不带 workingDir）。
    expect(botDefaultsPayload(daemon, {}).workingDir).toBeNull();
    expect(botDefaultsPayload(daemon, { workingDir: 123 }).workingDir).toBeNull();
  });

  it('defaults auto grant request cards on and preserves explicit off', () => {
    const daemon = { larkAppId: 'app_a', botName: 'BotA', cliId: 'codex' };
    expect(botDefaultsPayload(daemon, {})).toMatchObject({
      autoGrantRequestCards: true,
    });
    expect(botDefaultsPayload(daemon, { autoGrantRequestCards: false })).toMatchObject({
      autoGrantRequestCards: false,
    });
  });

  it('projects only supported default grant durations', () => {
    const daemon = { larkAppId: 'app_a', botName: 'BotA', cliId: 'codex' };
    expect(botDefaultsPayload(daemon, {})).toMatchObject({ grantDefaultDurationMs: null });
    expect(botDefaultsPayload(daemon, { grantDefaultDurationMs: 8 * 60 * 60 * 1000 })).toMatchObject({
      grantDefaultDurationMs: 8 * 60 * 60 * 1000,
    });
    expect(botDefaultsPayload(daemon, { grantDefaultDurationMs: 2 * 60 * 60 * 1000 })).toMatchObject({
      grantDefaultDurationMs: null,
    });
  });

  it('passes substituteMode through for bot defaults', () => {
    const daemon = { larkAppId: 'app_a', botName: 'BotA', cliId: 'codex' };
    const substituteMode = {
      enabled: true,
      targets: [{ userId: 'u_alice', name: 'Alice' }],
      disclosure: 'prefix',
      chats: ['oc_a', 'oc_b'],
    };
    expect(botDefaultsPayload(daemon, { substituteMode })).toMatchObject({
      substituteMode,
    });
    expect(botDefaultsPayload(daemon, {})).toMatchObject({
      substituteMode: null,
    });
  });

  it('projects dashboard summary range for /api/bots', () => {
    const daemon = { larkAppId: 'app_a', botName: 'BotA', cliId: 'codex' };
    expect(botDefaultsPayload(daemon, {})).toMatchObject({
      summaryMemory: false,
      summaryMemoryPath: 'summary.md',
      summaryRange: {
        limit: 50,
        sinceHours: 24,
      },
    });
    expect(botDefaultsPayload(daemon, {
      summaryRange: { limit: 12, sinceHours: 6 },
      summaryMemory: true,
      summaryMemoryPath: '/tmp/botmux-summary.md',
    })).toMatchObject({
      summaryMemory: true,
      summaryMemoryPath: '/tmp/botmux-summary.md',
      summaryRange: {
        limit: 12,
        sinceHours: 6,
      },
    });
    expect(botDefaultsPayload(daemon, {
      contentTriggers: [{
        name: 'dashboard-default-summary-trigger',
        enabled: true,
        scope: 'both',
        match: { type: 'keyword', pattern: '本次问题已解决', caseSensitive: false },
        history: {
          topic: { mode: 'current-thread' },
          regularGroup: { mode: 'recent-messages', limit: 0, sinceHours: 0 },
        },
        action: { type: 'start-or-wake-session', prompt: 'summary' },
      }],
    })).toMatchObject({
      summaryRange: {
        limit: 0,
        sinceHours: 0,
      },
    });
  });

  it('emits brand in the group roster summary only when set (so the console link picks the right host)', () => {
    // 国际版 lark bot：brand 带出,前端据此拼 open.larksuite.com/app/...。
    expect(botSummaryPayload({ larkAppId: 'cli_lark', botName: 'LarkBot', cliId: 'codex', brand: 'lark' }))
      .toMatchObject({ larkAppId: 'cli_lark', brand: 'lark' });
    // feishu bot(缺省)：不下发 brand,前端 normalizeBrand 兜底 feishu.cn。
    expect(botSummaryPayload({ larkAppId: 'cli_feishu', botName: 'FeishuBot', cliId: 'codex' }))
      .not.toHaveProperty('brand');
  });

  it('emits brand in Bot Defaults rows (success + degraded) so the config-page link picks the right host', () => {
    const lark = { larkAppId: 'cli_lark', botName: 'LarkBot', cliId: 'codex', brand: 'lark' };
    expect(botDefaultsPayload(lark, {})).toMatchObject({ brand: 'lark' });
    expect(botDefaultsPayload(lark, undefined, 'http_503')).toMatchObject({ brand: 'lark', error: 'http_503' });
    // feishu(缺省)：不带 brand,前端兜底 feishu。
    expect(botDefaultsPayload({ larkAppId: 'cli_feishu', botName: 'FeishuBot', cliId: 'codex' }, {}))
      .not.toHaveProperty('brand');
  });

  it('brandMapByAppId maps appId→brand and fails safe to an empty map when config is unreadable', () => {
    // 正常：按 appId 建 brand 映射（feishu bot 的 brand 为 undefined，仍入表）。
    const map = brandMapByAppId(() => [
      { larkAppId: 'cli_lark', brand: 'lark' },
      { larkAppId: 'cli_feishu' },
    ]);
    expect(map.get('cli_lark')).toBe('lark');
    expect(map.get('cli_feishu')).toBeUndefined();
    expect(map.size).toBe(2);

    // ⭐失败安全：loadBotConfigs 在 bots.json 未建 / 不可读 / BOTS_CONFIG 缺失时
    // 会抛——必须吞掉返回空 Map,让冷缓存 /api/groups 与 /api/bots 仍基于
    // DaemonRegistry 走降级 roster（前端 normalizeBrand 兜底 feishu),而非 500。
    const empty = brandMapByAppId(() => { throw new Error('bots.json not found'); });
    expect(empty.size).toBe(0);
    expect(empty.get('cli_anything')).toBeUndefined();
  });
});
