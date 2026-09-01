/**
 * Unit tests for bot-registry: loadBotConfigs, registerBot, getBot, getAllBots.
 *
 * Run:  pnpm vitest run test/bot-registry.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────

// Mock @larksuiteoapi/node-sdk — we don't want real Lark connections.
// The Client constructor just stores whatever it receives.
vi.mock('@larksuiteoapi/node-sdk', () => {
  // Mirror the real SDK's separable http instance so the upload-client path is
  // exercised (create() → own instance + copyable interceptor registry).
  const makeInstance = (): any => ({
    defaults: { timeout: 0 },
    create: (cfg: { timeout?: number }) => {
      const inst = makeInstance();
      if (cfg?.timeout !== undefined) inst.defaults.timeout = cfg.timeout;
      return inst;
    },
    interceptors: {
      request: { handlers: [], use(this: any, f: any, r: any) { this.handlers.push({ fulfilled: f, rejected: r }); } },
      response: { handlers: [], use(this: any, f: any, r: any) { this.handlers.push({ fulfilled: f, rejected: r }); } },
    },
  });
  const sharedDefault = makeInstance();
  class FakeClient {
    opts: Record<string, unknown>;
    httpInstance: any;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      // Real Client: `params.httpInstance || defaultHttpInstance`.
      this.httpInstance = (opts?.httpInstance as any) ?? sharedDefault;
    }
  }
  return { Client: FakeClient, defaultHttpInstance: sharedDefault };
});

// Mock node:fs so loadBotConfigs doesn't touch real disk.
vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return {
    ...orig,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    statSync: vi.fn(() => ({ mtimeMs: 0 })),
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Fresh-import the module so the internal `bots` Map is empty each time. */
async function freshImport() {
  // resetModules causes vitest to re-evaluate the module (new Map instance)
  vi.resetModules();
  return await import('../src/bot-registry.js');
}

function makeCfg(overrides: Record<string, unknown> = {}) {
  return {
    larkAppId: 'app_test_001',
    larkAppSecret: 'secret_001',
    cliId: 'claude-code' as const,
    ...overrides,
  };
}

// ─── registerBot ──────────────────────────────────────────────────────────

describe('registerBot', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;

  beforeEach(async () => {
    mod = await freshImport();
  });

  it('should return a BotState with the provided config', () => {
    const cfg = makeCfg();
    const state = mod.registerBot(cfg);
    expect(state.config).toBe(cfg);
  });

  it('should create a Lark Client with appId and appSecret', () => {
    const cfg = makeCfg();
    const state = mod.registerBot(cfg);
    // FakeClient stores opts
    const client = state.client as unknown as { opts: Record<string, unknown> };
    expect(client.opts.appId).toBe('app_test_001');
    expect(client.opts.appSecret).toBe('secret_001');
  });

  it('bounds the SDK HTTP transport timeout when the client exposes axios defaults', () => {
    const client = { httpInstance: { defaults: { timeout: 0 } } };
    mod.configureLarkClientHttpTimeout(client);
    expect(client.httpInstance.defaults.timeout).toBe(mod.LARK_REQUEST_TIMEOUT_MS);
  });

  it('gives media uploads a dedicated http instance with the looser upload timeout', () => {
    const state = mod.registerBot(makeCfg());
    const interactive = state.client as unknown as { httpInstance?: { defaults?: { timeout?: number } } };
    const upload = state.uploadClient as unknown as { httpInstance?: { defaults?: { timeout?: number } } };
    // Interactive client keeps the tight bound; upload client is separate + looser.
    expect(interactive.httpInstance?.defaults?.timeout).toBe(mod.LARK_REQUEST_TIMEOUT_MS);
    expect(upload.httpInstance?.defaults?.timeout).toBe(mod.LARK_UPLOAD_TIMEOUT_MS);
    expect(state.uploadClient).not.toBe(state.client);
    expect(mod.getBotUploadClient('app_test_001')).toBe(state.uploadClient);
    // The shared SDK default must NOT be mutated to the upload bound.
    expect(mod.LARK_UPLOAD_TIMEOUT_MS).toBeGreaterThan(mod.LARK_REQUEST_TIMEOUT_MS);
  });

  it('does NOT construct a Lark Client for an apiOnly bot (empty secret would throw in the real SDK)', () => {
    // Regression (riff clean-sandbox boot): apiOnly bots have appSecret='' and the
    // real Lark SDK ctor throws "appSecret or clientAssertionProvider is required",
    // fataling core-only at boot. registerBot must skip construction entirely — the
    // client is null and never used (getBotClient throws LarkTransportDisabledError,
    // getAllBotClients filters apiOnly). NOTE the suite's FakeClient never throws, so
    // this asserts the SKIP (client===null), which is what makes the real SDK safe.
    const state = mod.registerBot({ larkAppId: 'local_riff', larkAppSecret: '', apiOnly: true, cliId: 'codex-app' } as any);
    expect(state.client).toBeNull();
    // getBotClient still fail-closes for apiOnly (never returns the null).
    expect(() => mod.getBotClient('local_riff')).toThrow(/LarkTransportDisabled|core-only|apiOnly|transport/i);
  });

  it('should default the SDK Client domain to feishu when brand is unset', () => {
    const state = mod.registerBot(makeCfg());
    const client = state.client as unknown as { opts: Record<string, unknown> };
    expect(client.opts.domain).toBe('https://open.feishu.cn');
  });

  it('should point the SDK Client domain at larksuite.com when brand is lark', () => {
    const state = mod.registerBot(makeCfg({ brand: 'lark' }));
    const client = state.client as unknown as { opts: Record<string, unknown> };
    expect(client.opts.domain).toBe('https://open.larksuite.com');
  });

  it('should set resolvedAllowedUsers from config.allowedUsers', () => {
    const cfg = makeCfg({ allowedUsers: ['u1', 'u2'] });
    const state = mod.registerBot(cfg);
    expect(state.resolvedAllowedUsers).toEqual(['u1', 'u2']);
  });

  it('should default resolvedAllowedUsers to empty array when allowedUsers is undefined', () => {
    const cfg = makeCfg();
    const state = mod.registerBot(cfg);
    expect(state.resolvedAllowedUsers).toEqual([]);
  });

  it('should make the bot retrievable by appId', () => {
    const cfg = makeCfg();
    mod.registerBot(cfg);
    const retrieved = mod.getBot('app_test_001');
    expect(retrieved.config.larkAppId).toBe('app_test_001');
  });

  it('should overwrite a previous registration with the same appId', () => {
    mod.registerBot(makeCfg({ larkAppSecret: 'old' }));
    mod.registerBot(makeCfg({ larkAppSecret: 'new' }));
    const state = mod.getBot('app_test_001');
    expect(state.config.larkAppSecret).toBe('new');
    expect(mod.getAllBots()).toHaveLength(1);
  });
});

// ─── brand parsing ──────────────────────────────────────────────────────────

describe('parseBotConfigsFromText — brand', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;

  beforeEach(async () => {
    mod = await freshImport();
  });

  it('keeps brand "lark" when configured', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's', brand: 'lark' },
    ]));
    expect(cfg.brand).toBe('lark');
  });

  it('leaves brand undefined when unset (defaults to feishu downstream)', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's' },
    ]));
    expect(cfg.brand).toBeUndefined();
  });

  it('drops bogus brand values to undefined', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's', brand: 'wechat' },
    ]));
    expect(cfg.brand).toBeUndefined();
  });

  it('keeps a positive-integer maxLiveWorkers cap', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's', maxLiveWorkers: 8 },
    ]));
    expect(cfg.maxLiveWorkers).toBe(8);
  });

  it('leaves maxLiveWorkers undefined (= unlimited) when unset', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's' },
    ]));
    expect(cfg.maxLiveWorkers).toBeUndefined();
  });

  it('drops ≤0 / fractional / non-numeric maxLiveWorkers to undefined', () => {
    for (const bad of [0, -2, 1.5, '4', null] as const) {
      const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
        { larkAppId: 'a', larkAppSecret: 's', maxLiveWorkers: bad },
      ]));
      expect(cfg.maxLiveWorkers).toBeUndefined();
    }
  });

  // allowArbitraryMention is a SAFETY switch (gates whether an agent may @
  // arbitrary group members via email). Default MUST be off, and only a literal
  // boolean `true` may turn it on — a mutation that flips normalization to
  // `!== false` (default-open) or accepts the string "true" must fail here.
  it('sets allowArbitraryMention only for a literal boolean true', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's', allowArbitraryMention: true },
    ]));
    expect(cfg.allowArbitraryMention).toBe(true);
  });

  it('defaults allowArbitraryMention to NOT-true (undefined) when unset', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's' },
    ]));
    expect(cfg.allowArbitraryMention).not.toBe(true);
    expect(cfg.allowArbitraryMention).toBeUndefined();
  });

  it('keeps allowArbitraryMention NOT-true for false / "true" / 1 / {} (never default-open)', () => {
    for (const val of [false, 'true', 1, {}] as const) {
      const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
        { larkAppId: 'a', larkAppSecret: 's', allowArbitraryMention: val },
      ]));
      expect(cfg.allowArbitraryMention).not.toBe(true);
    }
  });

  it('keeps only a valid sessionOwnerReminder configuration', () => {
    const reminder = {
      enabled: true,
      intervalMinutes: 45,
      text: '请处理当前会话。',
      states: ['idle', 'agent_attention'],
    };
    const [valid] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's', sessionOwnerReminder: reminder },
    ]));
    expect(valid.sessionOwnerReminder).toEqual(reminder);

    const [invalid] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'b', larkAppSecret: 's', sessionOwnerReminder: { ...reminder, intervalMinutes: 0 } },
    ]));
    expect(invalid.sessionOwnerReminder).toBeUndefined();
  });

  it('keeps a trimmed displayName and drops blank/non-string values', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's', displayName: '  小助手  ' },
    ]));
    expect(cfg.displayName).toBe('小助手');
    for (const bad of [undefined, '', '   ', 42, null] as const) {
      const [c] = mod.parseBotConfigsFromText(JSON.stringify([
        { larkAppId: 'a', larkAppSecret: 's', displayName: bad },
      ]));
      expect(c.displayName).toBeUndefined();
    }
  });

  it('requires a persisted downgrade shadow for cliRuntime configs', () => {
    expect(() => mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'runtime-without-shadow-app',
        larkAppSecret: 's',
        cliId: 'codex',
        cliRuntime: {
          id: 'vendor-codex',
          executable: 'vendor-codex',
        },
      },
    ]))).toThrow(/cliPathOverride is required as an exact downgrade shadow/);
  });

  it('normalizes cliRuntime with its persisted legacy path shadow', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'runtime-app',
        larkAppSecret: 's',
        cliId: 'codex',
        cliPathOverride: 'vendor-codex',
        cliRuntime: {
          id: 'vendor-codex',
          displayName: 'VendorCodex',
          executable: 'vendor-codex',
          update: { provider: 'auto' },
        },
      },
    ]));

    expect(cfg.cliRuntime).toMatchObject({
      id: 'vendor-codex',
      displayName: 'VendorCodex',
      executable: 'vendor-codex',
      update: { provider: 'auto' },
    });
    expect(cfg.cliPathOverride).toBe('vendor-codex');
  });

  it('keeps legacy cliPathOverride configs unchanged when cliRuntime is absent', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'legacy-runtime-app',
        larkAppSecret: 's',
        cliId: 'codex',
        cliPathOverride: '/opt/custom/codex',
      },
    ]));
    expect(cfg.cliRuntime).toBeUndefined();
    expect(cfg.cliPathOverride).toBe('/opt/custom/codex');
  });

  it('accepts only an exactly-equal persisted downgrade shadow', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'shadowed-runtime-app',
        larkAppSecret: 's',
        cliId: 'codex',
        cliPathOverride: 'vendor-codex',
        cliRuntime: {
          id: 'vendor-codex',
          executable: 'vendor-codex',
          update: { provider: 'none' },
        },
      },
    ]));
    expect(cfg.cliRuntime?.id).toBe('vendor-codex');
    expect(cfg.cliPathOverride).toBe('vendor-codex');

    expect(() => mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'conflicting-runtime-app',
        larkAppSecret: 's',
        cliId: 'codex',
        cliPathOverride: '/opt/custom/codex',
        cliRuntime: {
          id: 'vendor-codex',
          executable: 'vendor-codex',
          update: { provider: 'none' },
        },
      },
    ]))).toThrow(/must exactly match cliRuntime\.executable/);
  });

  it('rejects cliRuntime outside the plain Codex adapter contract', () => {
    const runtime = { id: 'vendor-codex', executable: 'vendor-codex' };
    expect(() => mod.parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'wrong-adapter-runtime-app',
      larkAppSecret: 's',
      cliId: 'claude-code',
      cliRuntime: runtime,
    }]))).toThrow(/only for cliId "codex"/);
    expect(() => mod.parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'wrapped-runtime-app',
      larkAppSecret: 's',
      cliId: 'codex',
      wrapperCli: 'gateway codex',
      cliRuntime: runtime,
    }]))).toThrow(/cannot be combined with wrapperCli/);
  });

  it('accepts existingAppServer on a Codex App bot but rejects unrelated CLIs', () => {
    const endpoint = 'unix:///home/testuser/.codex/app-server-control/app-server-control.sock';
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'codex-app-share',
      larkAppSecret: 's',
      cliId: 'codex-app',
      existingAppServer: { endpoint },
    }]));
    expect(cfg.cliId).toBe('codex-app');
    expect(cfg.existingAppServer).toEqual({ endpoint });

    expect(() => mod.parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'wrong-app-server-cli',
      larkAppSecret: 's',
      cliId: 'claude-code',
      existingAppServer: { endpoint },
    }]))).toThrow(/only for cliId "codex" or "codex-app"/);
  });

  it('keeps the Codex browser bridge opt-in and restricted to owned Codex App sessions', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'codex-app-browser',
      larkAppSecret: 's',
      cliId: 'codex-app',
      codexBrowser: true,
    }]));
    expect(cfg.codexBrowser).toEqual({ enabled: true, family: 'chrome' });

    expect(() => mod.parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'wrong-browser-cli',
      larkAppSecret: 's',
      cliId: 'codex',
      codexBrowser: true,
    }]))).toThrow(/only for cliId "codex-app"/);
    expect(() => mod.parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'isolated-browser',
      larkAppSecret: 's',
      cliId: 'codex-app',
      codexBrowser: true,
      sandbox: true,
    }]))).toThrow(/sandbox or readIsolation/);
  });

  it('strictly validates a configured cliRuntime instead of silently dropping malformed input', () => {
    expect(() => mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'invalid-runtime-app',
        larkAppSecret: 's',
        cliId: 'codex',
        cliRuntime: { id: 'vendor-codex' },
      },
    ]))).toThrow(/cliRuntime|executable/);
  });

  it('effectiveBotDisplayName prefers displayName > probed botName > larkAppId', () => {
    const state = mod.registerBot({ larkAppId: 'app_x', larkAppSecret: 's', cliId: 'claude-code' } as any);
    expect(mod.effectiveBotDisplayName(state)).toBe('app_x');
    state.botName = 'Claude';
    expect(mod.effectiveBotDisplayName(state)).toBe('Claude');
    state.config.displayName = '小助手';
    expect(mod.effectiveBotDisplayName(state)).toBe('小助手');
  });

  it('normalizes per-chat messageListeners without enabling them by default', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'a',
        larkAppSecret: 's',
        messageListeners: {
          oc_chat: {
            enabled: true,
            name: '告警监听',
            replyCardTitle: '  告警自动分析  ',
            prompt: '只分析告警消息',
            senderPolicy: {
              includeSenderOpenIds: [' ou_user ', 'ou_user'],
              excludeSenderOpenIds: ['ou_noise'],
              includeSenderTypes: ['user', 'app', 'junk'],
              excludeSelf: false,
            },
            messagePolicy: {
              includeMsgTypes: ['text', 'post', 'text'],
            },
          },
          oc_disabled: {
            enabled: false,
            prompt: 'draft',
          },
          oc_bad: {
            enabled: true,
            prompt: '   ',
          },
        },
      },
    ]));

    expect(cfg.messageListeners?.oc_chat).toEqual({
      enabled: true,
      name: '告警监听',
      replyCardTitle: '告警自动分析',
      prompt: '只分析告警消息',
      senderPolicy: {
        includeSenderOpenIds: ['ou_user'],
        excludeSenderOpenIds: ['ou_noise'],
        includeSenderTypes: ['user', 'bot'],
        excludeSelf: false,
      },
      messagePolicy: {
        includeMsgTypes: ['text', 'post'],
        scope: 'top_level',
      },
      replyPolicy: { mode: 'thread', sessionMode: 'per_message' },
    });
    expect(cfg.messageListeners?.oc_disabled.enabled).toBe(false);
    expect(cfg.messageListeners?.oc_bad).toBeUndefined();
  });

  it('normalizes startupCommands (adds leading /, keeps args, dedupes)', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's', startupCommands: ['effort ultracode', '/model opus', '/effort ultracode', '', 7] },
    ]));
    expect(cfg.startupCommands).toEqual(['/effort ultracode', '/model opus']);
  });

  it('leaves startupCommands undefined when unset / empty / non-array', () => {
    for (const val of [undefined, [], '/effort ultracode', ['', '   ']] as const) {
      const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
        { larkAppId: 'a', larkAppSecret: 's', startupCommands: val },
      ]));
      expect(cfg.startupCommands).toBeUndefined();
    }
  });

  it('normalizes vcMeetingAgent.realtimeVoice without enabling it by default', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'a',
        larkAppSecret: 's',
        vcMeetingAgent: {
          enabled: true,
          realtimeVoice: {
            enabled: true,
            sampleRate: 24000,
            channels: 1,
            frameMs: 20,
            testSpeakOnStartText: '测试语音',
          },
        },
      },
    ]));
    expect(cfg.vcMeetingAgent?.realtimeVoice).toEqual({
      enabled: true,
      sampleRate: 24000,
      channels: 1,
      frameMs: 20,
      testSpeakOnStartText: '测试语音',
    });

    const [defaultCfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'b', larkAppSecret: 's', vcMeetingAgent: { enabled: true } },
    ]));
    expect(defaultCfg.vcMeetingAgent?.realtimeVoice).toBeUndefined();
  });

  it('normalizes vcMeetingAgent.meetingConsumer from bots.json', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'a',
        larkAppSecret: 's',
        vcMeetingAgent: {
          enabled: true,
          meetingConsumer: {
            enabled: true,
            defaultMode: 'agent',
            defaultAgent: 'cli_agent_default',
            selectionTimeoutMs: 20_000,
            injectIntervalMs: 60_000,
            minBatchChars: 500,
            minBatchItems: 10,
            maxInjectIntervalMs: 180_000,
            agentCandidates: [
              { larkAppId: 'cli_agent_default', label: 'Claude' },
              'cli_agent_codex',
              { appId: 'cli_agent_default', label: 'Duplicate' },
              { larkAppId: '   ' },
              42,
            ],
          },
        },
      },
    ]));
    expect(cfg.vcMeetingAgent?.meetingConsumer).toEqual({
      enabled: true,
      defaultMode: 'agent',
      defaultAgentAppId: 'cli_agent_default',
      selectionTimeoutMs: 20_000,
      injectIntervalMs: 60_000,
      minBatchChars: 500,
      minBatchItems: 10,
      maxInjectIntervalMs: 180_000,
      agentCandidates: [
        { larkAppId: 'cli_agent_default', label: 'Claude' },
        { larkAppId: 'cli_agent_codex' },
      ],
    });
  });

  it('parses meetingConsumer in/out policies', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'a',
        larkAppSecret: 's',
        vcMeetingAgent: {
          enabled: true,
          realtimeVoice: { enabled: true },
          meetingConsumer: {
            enabled: true,
            defaultMode: 'agents',
            textOutputPolicy: 'approval',
            voiceOutputPolicy: 'allow',
          },
        },
      },
    ]));
    expect(cfg.vcMeetingAgent?.meetingConsumer?.textOutputPolicy).toBe('approval');
    expect(cfg.vcMeetingAgent?.meetingConsumer?.voiceOutputPolicy).toBe('allow');
  });

  it('drops invalid in/out policy values', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'a',
        larkAppSecret: 's',
        vcMeetingAgent: {
          enabled: true,
          meetingConsumer: {
            enabled: true,
            defaultMode: 'agents',
            textOutputPolicy: 'sometimes', // invalid → dropped
            voiceOutputPolicy: 42, // invalid → dropped
          },
        },
      },
    ]));
    expect(cfg.vcMeetingAgent?.meetingConsumer?.textOutputPolicy).toBeUndefined();
    expect(cfg.vcMeetingAgent?.meetingConsumer?.voiceOutputPolicy).toBeUndefined();
  });

  it('keeps meetingConsumer disabled/listenOnly configuration explicit', () => {    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'a',
        larkAppSecret: 's',
        vcMeetingAgent: {
          enabled: true,
          meetingConsumer: {
            enabled: false,
            defaultMode: 'listenOnly',
            defaultAgentAppId: '',
            agentCandidates: [],
          },
        },
      },
    ]));
    expect(cfg.vcMeetingAgent?.meetingConsumer).toEqual({
      enabled: false,
      defaultMode: 'listenOnly',
    });
  });

  it('canonicalizes strict multi-consumer profiles and defaults', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'a',
        larkAppSecret: 's',
        vcMeetingAgent: {
          enabled: true,
          meetingConsumer: {
            enabled: true,
            defaultMode: 'agents',
            defaultConsumerIds: ['minutes', 'speaker'],
            consumerProfiles: [
              {
                id: ' minutes ',
                agentAppId: ' cli_minutes ',
                label: ' 会议纪要 ',
                role: ' minutes ',
                instructions: '  维护决策和待办。\r\n\t标记负责人。  ',
                filter: { activityTypes: ['transcript_received', 'chat_received'] },
                responseMode: 'silent',
                listenerDelivery: { placement: 'topic' },
                capabilities: ['meeting.read'],
              },
              {
                id: 'speaker',
                agentAppId: 'cli_speaker',
                role: 'speaker',
                responseMode: 'silent',
                capabilities: ['meeting.read', 'meeting.output.request'],
                ownedSinks: ['meeting_text', 'meeting_voice'],
              },
            ],
          },
        },
      },
    ]));

    expect(cfg.vcMeetingAgent?.meetingConsumer).toEqual({
      enabled: true,
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes', 'speaker'],
      consumerProfiles: [
        {
          id: 'minutes',
          agentAppId: 'cli_minutes',
          label: '会议纪要',
          role: 'minutes',
          instructions: '维护决策和待办。\n\t标记负责人。',
          filter: { activityTypes: ['transcript_received', 'chat_received'] },
          responseMode: 'silent',
          listenerDelivery: { placement: 'topic' },
          capabilities: ['meeting.read'],
        },
        {
          id: 'speaker',
          agentAppId: 'cli_speaker',
          role: 'speaker',
          responseMode: 'silent',
          capabilities: ['meeting.read', 'meeting.output.request'],
          ownedSinks: ['meeting_text', 'meeting_voice'],
        },
      ],
    });
  });

  it('normalizes default-profile bootstrap provenance and rejects malformed markers', () => {
    const base = {
      enabled: true,
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes'],
      consumerProfiles: [{
        id: 'minutes',
        agentAppId: 'cli_minutes',
        role: 'minutes',
        responseMode: 'silent',
        capabilities: ['meeting.read'],
      }],
    };
    const parse = (marker: unknown) => mod.parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'a',
      larkAppSecret: 's',
      vcMeetingAgent: {
        enabled: true,
        meetingConsumer: { ...base, defaultProfileBootstrap: marker },
      },
    }]))[0].vcMeetingAgent?.meetingConsumer;
    expect(parse({
      generatorVersion: 1,
      profileId: 'minutes',
      configHash: `sha256:${'a'.repeat(64)}`,
    })?.defaultProfileBootstrap).toEqual({
      generatorVersion: 1,
      profileId: 'minutes',
      configHash: `sha256:${'a'.repeat(64)}`,
    });
    expect(() => parse({ generatorVersion: 0, profileId: 'minutes', configHash: `sha256:${'a'.repeat(64)}` }))
      .toThrow(/generatorVersion/);
    expect(() => parse({ generatorVersion: 1, profileId: 'minutes', configHash: 'bad' }))
      .toThrow(/configHash/);
    expect(() => parse({
      generatorVersion: 1,
      profileId: 'minutes',
      configHash: `sha256:${'a'.repeat(64)}`,
      extra: true,
    })).toThrow(/unknown field/);
  });

  it('lets consumerProfiles win without mixing legacy candidates/defaults', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'a',
        larkAppSecret: 's',
        vcMeetingAgent: {
          enabled: true,
          meetingConsumer: {
            enabled: true,
            defaultMode: 'agent',
            defaultAgentAppId: 'legacy_default',
            agentCandidates: ['legacy_default'],
            consumerProfiles: [],
          },
        },
      },
    ]));

    expect(cfg.vcMeetingAgent?.meetingConsumer).toEqual({
      enabled: true,
      consumerProfiles: [],
    });
  });

  it('rejects invalid profile identities and defaults instead of silently dropping them', () => {
    const baseProfile = {
      id: 'minutes',
      agentAppId: 'cli_minutes',
      role: 'minutes',
      responseMode: 'silent',
      capabilities: ['meeting.read'],
    };
    const parse = (meetingConsumer: Record<string, unknown>) => mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'a',
        larkAppSecret: 's',
        vcMeetingAgent: { enabled: true, meetingConsumer },
      },
    ]));

    expect(() => parse({
      consumerProfiles: [baseProfile, { ...baseProfile, agentAppId: 'cli_other' }],
    })).toThrow(/duplicates "minutes"/);
    expect(() => parse({
      defaultMode: 'agents',
      defaultConsumerIds: ['missing'],
      consumerProfiles: [baseProfile],
    })).toThrow(/references unknown profile "missing"/);
    expect(() => parse({
      defaultMode: 'agents',
      consumerProfiles: [baseProfile],
    })).toThrow(/requires at least one defaultConsumerId/);
  });

  it('restricts profile ids to safe stable member/object-key tokens', () => {
    const parseId = (id: string) => mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'a',
        larkAppSecret: 's',
        vcMeetingAgent: {
          enabled: true,
          meetingConsumer: {
            consumerProfiles: [{
              id,
              agentAppId: 'cli_worker',
              role: 'worker',
              responseMode: 'silent',
              capabilities: ['meeting.read'],
            }],
          },
        },
      },
    ]));

    expect(() => parseId('minutes.v2-prod')).not.toThrow();
    for (const id of ['_hidden', 'bad/id', 'x'.repeat(65)]) {
      expect(() => parseId(id)).toThrow(/must match \[A-Za-z0-9\]/);
    }
    for (const id of ['__proto__', 'prototype', 'constructor']) {
      expect(() => parseId(id)).toThrow(/is reserved/);
    }
  });

  it('strictly validates filters, reserved/unsupported sinks, and sink capabilities', () => {
    const parseProfile = (overrides: Record<string, unknown>) => mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'a',
        larkAppSecret: 's',
        vcMeetingAgent: {
          enabled: true,
          meetingConsumer: {
            consumerProfiles: [{
              id: 'worker',
              agentAppId: 'cli_worker',
              role: 'worker',
              responseMode: 'silent',
              capabilities: ['meeting.read'],
              ...overrides,
            }],
          },
        },
      },
    ]));

    expect(() => parseProfile({ filter: { speakerOpenIds: ['ou_x'] } }))
      .toThrow(/unsupported filter field\(s\): speakerOpenIds/);
    expect(() => parseProfile({ filter: { activityTypes: ['unknown_activity'] } }))
      .toThrow(/unsupported activity type "unknown_activity"/);
    expect(() => parseProfile({ ownedSinks: ['listener_notice'] }))
      .toThrow(/listener_notice is reserved/);
    expect(() => parseProfile({ ownedSinks: ['task'] }))
      .toThrow(/unsupported owned sink "task"/);
    expect(() => parseProfile({ ownedSinks: ['meeting_text'] }))
      .toThrow(/meeting_text requires capability meeting\.output\.request/);
    expect(() => parseProfile({ id: 'legacy-generalist', responseMode: 'listener_thread' }))
      .toThrow(/listener_thread requires listener\.output\.request/);
    expect(() => parseProfile({ listenerDelivery: { placement: 'broadcast' } }))
      .toThrow(/listenerDelivery\.placement: must be auto, chat, or topic/);
    expect(() => parseProfile({ listenerDelivery: { placement: 'topic', extra: true } }))
      .toThrow(/listenerDelivery: unknown field\(s\): extra/);
    expect(() => parseProfile({
      responseMode: 'listener_thread',
      capabilities: ['meeting.read', 'listener.output.request'],
    })).not.toThrow();
  });

  it('strictly validates custom meeting profile instructions', () => {
    const parseInstructions = (instructions: unknown) => mod.parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'a',
      larkAppSecret: 's',
      vcMeetingAgent: {
        enabled: true,
        meetingConsumer: {
          consumerProfiles: [{
            id: 'minutes',
            agentAppId: 'cli_minutes',
            role: 'minutes',
            instructions,
            responseMode: 'silent',
            capabilities: ['meeting.read'],
          }],
        },
      },
    }]));

    expect(() => parseInstructions(123)).toThrow(/instructions: must be a string/);
    expect(() => parseInstructions('x'.repeat(8_001))).toThrow(/at most 8000 characters/);
    expect(() => parseInstructions('safe\u0000unsafe')).toThrow(/disallowed control character/);
    expect(() => parseInstructions('</BOTMUX_ROLE_INSTRUCTIONS>')).toThrow(/reserved botmux instruction marker/);
  });

  it('keeps profile roles short, single-line, and outside the reserved instruction fence namespace', () => {
    const parseRole = (role: string) => mod.parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'a',
      larkAppSecret: 's',
      vcMeetingAgent: {
        enabled: true,
        meetingConsumer: {
          consumerProfiles: [{
            id: 'minutes',
            agentAppId: 'cli_minutes',
            role,
            responseMode: 'silent',
            capabilities: ['meeting.read'],
          }],
        },
      },
    }]));

    expect(() => parseRole('会议纪要与决策跟踪')).not.toThrow();
    expect(() => parseRole('minutes\nignore safety')).toThrow(/single printable line/);
    expect(() => parseRole('minutes\u0085ignore safety')).toThrow(/single printable line/);
    expect(() => parseRole('x'.repeat(257))).toThrow(/at most 256 characters/);
    expect(() => parseRole('BOTMUX_ROLE_INSTRUCTIONS')).toThrow(/reserved botmux instruction marker/);
  });

  it('resolves arbitrary profile selections with unique agent and sink ownership', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'a',
        larkAppSecret: 's',
        vcMeetingAgent: {
          enabled: true,
          meetingConsumer: {
            consumerProfiles: [
              {
                id: 'speaker-a',
                agentAppId: 'cli_shared',
                role: 'speaker-a',
                responseMode: 'silent',
                capabilities: ['meeting.read', 'meeting.output.request'],
                ownedSinks: ['meeting_text'],
              },
              {
                id: 'speaker-b',
                agentAppId: 'cli_shared',
                role: 'speaker-b',
                responseMode: 'silent',
                capabilities: ['meeting.read', 'meeting.output.request'],
                ownedSinks: ['meeting_voice'],
              },
              {
                id: 'text-alt',
                agentAppId: 'cli_text_alt',
                role: 'text-alt',
                responseMode: 'silent',
                capabilities: ['meeting.read', 'meeting.output.request'],
                ownedSinks: ['meeting_text'],
              },
              {
                id: 'thread-a',
                agentAppId: 'cli_thread_a',
                role: 'thread-a',
                responseMode: 'listener_thread',
                capabilities: ['meeting.read', 'listener.output.request'],
              },
              {
                id: 'thread-b',
                agentAppId: 'cli_thread_b',
                role: 'thread-b',
                responseMode: 'listener_thread',
                capabilities: ['meeting.read', 'listener.output.request'],
              },
            ],
          },
        },
      },
    ]));
    const config = cfg.vcMeetingAgent!.meetingConsumer!;

    expect(mod.resolveVcMeetingConsumerProfiles(config, ['speaker-a'])).toMatchObject({
      ok: true,
      source: 'profiles',
      selectedProfiles: [{ id: 'speaker-a' }],
    });
    expect(mod.resolveVcMeetingConsumerProfiles(config, ['speaker-a', 'speaker-b'])).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('share agentAppId')],
    });
    expect(mod.resolveVcMeetingConsumerProfiles(config, ['speaker-a', 'text-alt'])).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('both own sink "meeting_text"')],
    });
    expect(mod.resolveVcMeetingConsumerProfiles(config, ['thread-a', 'thread-b'])).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('both use responseMode "listener_thread"')],
    });
    expect(mod.resolveVcMeetingConsumerProfiles(config, ['missing'])).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('unknown profile "missing"')],
    });
  });

  it('allows conflicting catalog alternatives but rejects a hand-edited conflicting default selection', () => {
    const alternatives = [
      {
        id: 'speaker-a',
        agentAppId: 'cli_speaker_a',
        role: 'speaker-a',
        responseMode: 'silent' as const,
        capabilities: ['meeting.read', 'meeting.output.request'],
        ownedSinks: ['meeting_text' as const],
      },
      {
        id: 'speaker-b',
        agentAppId: 'cli_speaker_b',
        role: 'speaker-b',
        responseMode: 'silent' as const,
        capabilities: ['meeting.read', 'meeting.output.request'],
        ownedSinks: ['meeting_text' as const],
      },
    ];

    // The catalog is a menu: mutually exclusive alternatives are valid while
    // no conflicting combination is selected.
    expect(mod.resolveVcMeetingConsumerProfiles({
      defaultMode: 'listenOnly',
      consumerProfiles: alternatives,
    })).toMatchObject({ ok: true, source: 'profiles', selectedProfiles: [] });

    // Runtime/default resolution is the authority even if a caller bypasses
    // Dashboard validation and constructs the config object directly.
    expect(mod.resolveVcMeetingConsumerProfiles({
      defaultMode: 'agents',
      defaultConsumerIds: ['speaker-a', 'speaker-b'],
      consumerProfiles: alternatives,
    })).toMatchObject({
      ok: false,
      source: 'profiles',
      errors: [expect.stringContaining('both own sink "meeting_text"')],
    });

    // A literal bots.json edit is rejected by the same canonical resolver at
    // load time instead of silently picking a last writer.
    expect(() => mod.parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'a',
      larkAppSecret: 's',
      vcMeetingAgent: {
        enabled: true,
        meetingConsumer: {
          enabled: true,
          defaultMode: 'agents',
          defaultConsumerIds: ['speaker-a', 'speaker-b'],
          consumerProfiles: alternatives,
        },
      },
    }]))).toThrow(/both own sink "meeting_text"/);
  });

  it('keeps the resolver on the untouched legacy path for old configs', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'a',
        larkAppSecret: 's',
        vcMeetingAgent: {
          enabled: true,
          meetingConsumer: {
            defaultMode: 'agent',
            defaultAgentAppId: 'cli_agent',
            agentCandidates: ['cli_agent'],
          },
        },
      },
    ]));

    expect(mod.resolveVcMeetingConsumerProfiles(cfg.vcMeetingAgent!.meetingConsumer!)).toEqual({
      ok: true,
      source: 'legacy',
      profiles: [],
      selectedProfiles: [],
    });
  });
});

// ─── parseBotConfigsFromText — autoStartOnGroupJoinSeed ────────────────────

describe('parseBotConfigsFromText — autoStartOnGroupJoinSeed', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;

  beforeEach(async () => {
    mod = await freshImport();
  });

  it('keeps a configured seed verbatim', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's', autoStartOnGroupJoinSeed: '👋 已到岗，待命中' },
    ]));
    expect(cfg.autoStartOnGroupJoinSeed).toBe('👋 已到岗，待命中');
  });

  it('normalizes blank seed to undefined (falls back to built-in i18n text)', () => {
    for (const bad of ['', '   ', 42, null] as const) {
      const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
        { larkAppId: 'a', larkAppSecret: 's', autoStartOnGroupJoinSeed: bad },
      ]));
      expect(cfg.autoStartOnGroupJoinSeed).toBeUndefined();
    }
  });

  it('leaves seed undefined when unset', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's' },
    ]));
    expect(cfg.autoStartOnGroupJoinSeed).toBeUndefined();
  });
});

describe('parseBotConfigsFromText — replyStyle', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;

  beforeEach(async () => {
    mod = await freshImport();
  });

  it('keeps a normalized sparse replyStyle without freezing theme defaults', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'a',
      larkAppSecret: 's',
      replyStyle: {
        recipes: false,
        layout: true,
        theme: 'vivid',
        recipePrompt: '  自定义配方  ',
        layoutColors: { progress: 'wathet', handoff: 'grey' },
        layoutTags: { result: '', blocked: '  等你拍板  ' },
      },
    }]));

    expect(cfg.replyStyle).toEqual({
      recipes: false,
      layout: true,
      theme: 'vivid',
      recipePrompt: '自定义配方',
      layoutColors: { progress: 'wathet' },
      layoutTags: { result: '', blocked: '等你拍板' },
    });
  });

  it('drops malformed replyStyle fields independently instead of rejecting the bot', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'a',
      larkAppSecret: 's',
      replyStyle: {
        recipes: 'yes',
        layout: false,
        theme: 'rainbow',
        layoutColors: { risk: 'not-a-color', progress: 'blue' },
        layoutTags: { blocked: 1, risk: '需要你' },
      },
    }]));

    expect(cfg.replyStyle).toEqual({
      layout: false,
      layoutColors: { progress: 'blue' },
      layoutTags: { risk: '需要你' },
    });
  });
});

// ─── parseBotConfigsFromText — apiOnly (core-only / headless) ──────────────

describe('parseBotConfigsFromText — apiOnly', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;

  beforeEach(async () => {
    mod = await freshImport();
  });

  it('allows an apiOnly bot to omit larkAppSecret (no Feishu connection)', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'local_riff', apiOnly: true, cliId: 'codex-app' },
    ]));
    expect(cfg.apiOnly).toBe(true);
    expect(cfg.larkAppId).toBe('local_riff');
    // Secret falls back to '' so downstream env plumbing stays a string.
    expect(cfg.larkAppSecret).toBe('');
    expect(cfg.cliId).toBe('codex-app');
  });

  it('preserves an explicit secret on an apiOnly bot if provided', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'local_x', larkAppSecret: 'kept', apiOnly: true },
    ]));
    expect(cfg.apiOnly).toBe(true);
    expect(cfg.larkAppSecret).toBe('kept');
  });

  it('throws if an apiOnly bot provides a non-string larkAppSecret (type hole guard)', () => {
    // "may be omitted; if present must be a string" — a number/object/array/false
    // must NOT slip into the string-typed field via the exemption.
    for (const bad of [42, {}, [], false] as const) {
      expect(() => mod.parseBotConfigsFromText(JSON.stringify([
        { larkAppId: 'local_x', apiOnly: true, larkAppSecret: bad },
      ])), `secret=${JSON.stringify(bad)}`).toThrow(/larkAppSecret must be a string when provided/);
    }
  });

  it('STILL throws for a normal (non-apiOnly) bot missing larkAppSecret', () => {
    // Guard: the secret exemption must be scoped to apiOnly only. A normal
    // Feishu bot with no secret is a misconfig, not a headless bot.
    expect(() => mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'app_normal' },
    ]))).toThrow(/larkAppSecret is required/);
  });

  it('still throws for an apiOnly bot missing larkAppId', () => {
    // larkAppId stays mandatory in every mode — it is the daemon identity,
    // dashboard routing key, and cachedLarkAppId gate.
    expect(() => mod.parseBotConfigsFromText(JSON.stringify([
      { apiOnly: true, cliId: 'codex-app' },
    ]))).toThrow(/larkAppId is required/);
  });

  it('leaves apiOnly undefined (not false) for normal bots — keeps bots.json clean', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's' },
    ]));
    expect(cfg.apiOnly).toBeUndefined();
  });

  it('coerces a truthy-but-non-true apiOnly to undefined (strict === true)', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's', apiOnly: 'yes' },
    ]));
    expect(cfg.apiOnly).toBeUndefined();
  });
});

// ─── pricing / budget (cost governance wiring) ───────────────────────────────
// 这两块是「成本金额化 + 月度预算」功能的入口：不在这里解析，daemon 的
// pricingResolver / budget sink 就永远拿不到配置，金额与告警静默失效（且
// 因为字段缺省是合法状态，不会有任何报错）。所以解析这一步必须有回归网。

describe('parseBotConfigsFromText — pricing / budget', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;

  beforeEach(async () => {
    mod = await freshImport();
  });

  it('parses a pricing block (usdCny + per-model overrides) onto the config', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'a',
        larkAppSecret: 's',
        pricing: { usdCny: 7.3, models: { 'claude-sonnet-4': { input: 3, output: 15 } } },
      },
    ]));
    expect(cfg.pricing).toEqual({
      usdCny: 7.3,
      models: { 'claude-sonnet-4': { input: 3, output: 15 } },
    });
  });

  it('parses a budget block and fills the threshold/hardStop defaults', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's', budget: { monthlyCny: 200 } },
    ]));
    expect(cfg.budget).toEqual({
      monthlyCny: 200,
      alertThresholdPercent: [80],
      hardStop: false,
    });
  });

  it('keeps explicit budget thresholds and hardStop', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'a',
        larkAppSecret: 's',
        budget: { monthlyCny: 500, alertThresholdPercent: [50, 90], hardStop: true },
      },
    ]));
    expect(cfg.budget).toEqual({
      monthlyCny: 500,
      alertThresholdPercent: [50, 90],
      hardStop: true,
    });
  });

  it('leaves both undefined when unconfigured (cost estimation stays off)', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's' },
    ]));
    expect(cfg.pricing).toBeUndefined();
    expect(cfg.budget).toBeUndefined();
  });

  it('drops garbage blocks instead of throwing (feature off, never crash startup)', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'a',
        larkAppSecret: 's',
        // pricing 非对象 → undefined；budget 缺 monthlyCny → null → undefined
        pricing: 'nope',
        budget: { alertThresholdPercent: [80] },
      },
    ]));
    expect(cfg.pricing).toBeUndefined();
    expect(cfg.budget).toBeUndefined();
  });

  it('normalizes budget: undefined (not null) so the field is omitted downstream', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's', budget: { monthlyCny: -5 } },
    ]));
    // parseBudgetConfig returns null for a non-positive budget; the registry
    // must map that to undefined so `bot.config.budget` is falsy-and-absent
    // rather than a null that a `?? {}` style read could mistake for config.
    expect(cfg.budget).toBeUndefined();
    expect('budget' in cfg ? cfg.budget : undefined).toBeUndefined();
  });
});

// ─── core-only synthesis (BOTMUX_CORE_ONLY) ─────────────────────────────────

describe('loadBotConfigs — core-only synthesis (BOTMUX_CORE_ONLY=1)', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;
  let fsMock: { existsSync: ReturnType<typeof vi.fn>; readFileSync: ReturnType<typeof vi.fn>; statSync: ReturnType<typeof vi.fn> };
  const saved: Record<string, string | undefined> = {};
  const CORE_KEYS = ['BOTMUX_CORE_ONLY', 'BOTS_CONFIG', 'BOTMUX_API_ONLY_BOT', 'BOTMUX_CORE_CLI', 'BOTMUX_CORE_WORKING_DIR', 'BOTMUX_CORE_MODEL'];

  beforeEach(async () => {
    mod = await freshImport();
    fsMock = (await import('node:fs')) as any;
    for (const k of CORE_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of CORE_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  it('synthesizes ONE apiOnly bot from env with no bots.json / no creds', () => {
    fsMock.existsSync.mockReturnValue(false); // no ~/.botmux/bots.json on disk
    process.env.BOTMUX_CORE_ONLY = '1';
    process.env.BOTMUX_API_ONLY_BOT = 'local_riff';
    process.env.BOTMUX_CORE_CLI = 'codex-app';
    const cfgs = mod.loadBotConfigs();
    expect(cfgs).toHaveLength(1);
    expect(cfgs[0].larkAppId).toBe('local_riff');
    expect(cfgs[0].apiOnly).toBe(true);
    expect(cfgs[0].cliId).toBe('codex-app');
    expect(cfgs[0].larkAppSecret).toBe(''); // never a real Feishu secret
  });

  it('is AUTHORITATIVE: ignores an ambient ~/.botmux/bots.json (never boots a real fleet bot)', () => {
    // The bug the smoke test caught: core-only on a host WITH a real bots.json
    // must NOT fall through and load the real (transport-enabled) fleet bot.
    fsMock.existsSync.mockReturnValue(true); // a real bots.json exists on disk...
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppId: 'cli_real_fleet', larkAppSecret: 'REAL_SECRET', cliId: 'claude-code' },
    ]));
    process.env.BOTMUX_CORE_ONLY = '1';
    process.env.BOTMUX_API_ONLY_BOT = 'local_riff';
    const cfgs = mod.loadBotConfigs();
    expect(cfgs).toHaveLength(1);
    expect(cfgs[0].larkAppId).toBe('local_riff'); // synthetic, NOT cli_real_fleet
    expect(cfgs[0].apiOnly).toBe(true);
    expect(cfgs[0].larkAppSecret).toBe(''); // the REAL_SECRET is never read
  });

  it('IGNORES an ambient BOTS_CONFIG too (codex P1-2: authoritative, no file override in core-only)', () => {
    // A leaked/inherited BOTS_CONFIG must NOT boot a file-defined (possibly real
    // Feishu) bot in core-only — identity is exactly the env-synthesized apiOnly one.
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppId: 'cli_real_via_bots_config', larkAppSecret: 'SECRET', cliId: 'claude-code' },
    ]));
    process.env.BOTMUX_CORE_ONLY = '1';
    process.env.BOTS_CONFIG = '/tmp/leaked-bots.json';
    process.env.BOTMUX_API_ONLY_BOT = 'local_riff';
    const cfgs = mod.loadBotConfigs();
    expect(cfgs).toHaveLength(1);
    expect(cfgs[0].larkAppId).toBe('local_riff'); // synthetic, NOT the BOTS_CONFIG bot
    expect(cfgs[0].apiOnly).toBe(true);
    expect(cfgs[0].larkAppSecret).toBe('');
  });

  it('defaults the synthetic id to local_riff and cli to codex-app', () => {
    fsMock.existsSync.mockReturnValue(false);
    process.env.BOTMUX_CORE_ONLY = '1';
    const [cfg] = mod.loadBotConfigs();
    expect(cfg.larkAppId).toBe('local_riff');
    expect(cfg.cliId).toBe('codex-app');
  });

  it('rejects a non-local_ synthetic id (identity must be a synthetic local slug)', () => {
    fsMock.existsSync.mockReturnValue(false);
    process.env.BOTMUX_CORE_ONLY = '1';
    process.env.BOTMUX_API_ONLY_BOT = 'cli_pretending_real';
    expect(() => mod.loadBotConfigs()).toThrow(/must match local_<slug>/);
  });

  it('does nothing when BOTMUX_CORE_ONLY is unset (normal file path)', () => {
    fsMock.existsSync.mockReturnValue(false); // no file → normal path throws
    expect(() => mod.loadBotConfigs()).toThrow(/No bot configuration found/);
  });
});


// ─── getBot / getBotClient ────────────────────────────────────────────────

describe('getBot / getBotClient', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;

  beforeEach(async () => {
    mod = await freshImport();
  });

  it('should throw for an unknown appId', () => {
    expect(() => mod.getBot('no_such_app')).toThrow('Bot not registered: no_such_app');
  });

  it('should return the correct bot when multiple are registered', () => {
    mod.registerBot(makeCfg({ larkAppId: 'app_a', larkAppSecret: 'sa' }));
    mod.registerBot(makeCfg({ larkAppId: 'app_b', larkAppSecret: 'sb' }));
    expect(mod.getBot('app_a').config.larkAppSecret).toBe('sa');
    expect(mod.getBot('app_b').config.larkAppSecret).toBe('sb');
  });

  it('getBotClient should return the Client instance', () => {
    mod.registerBot(makeCfg());
    const client = mod.getBotClient('app_test_001');
    expect(client).toBeDefined();
    const opts = (client as unknown as { opts: Record<string, unknown> }).opts;
    expect(opts.appId).toBe('app_test_001');
  });

  it('getBotClient should throw for unknown appId', () => {
    expect(() => mod.getBotClient('missing')).toThrow('Bot not registered: missing');
  });
});

describe('resolveBrandLabel — sandbox env-first (footer role name fix)', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;
  const saved = {
    session: process.env.BOTMUX_SESSION_ID,
    app: process.env.BOTMUX_LARK_APP_ID,
    brand: process.env.BOTMUX_BRAND_LABEL,
    usageDisplay: process.env.BOTMUX_USAGE_DISPLAY,
    replyStyle: process.env.BOTMUX_REPLY_STYLE,
  };
  beforeEach(async () => { mod = await freshImport(); });
  afterEach(() => {
    if (saved.session === undefined) delete process.env.BOTMUX_SESSION_ID;
    else process.env.BOTMUX_SESSION_ID = saved.session;
    if (saved.app === undefined) delete process.env.BOTMUX_LARK_APP_ID; else process.env.BOTMUX_LARK_APP_ID = saved.app;
    if (saved.brand === undefined) delete process.env.BOTMUX_BRAND_LABEL; else process.env.BOTMUX_BRAND_LABEL = saved.brand;
    if (saved.usageDisplay === undefined) delete process.env.BOTMUX_USAGE_DISPLAY;
    else process.env.BOTMUX_USAGE_DISPLAY = saved.usageDisplay;
    if (saved.replyStyle === undefined) delete process.env.BOTMUX_REPLY_STYLE;
    else process.env.BOTMUX_REPLY_STYLE = saved.replyStyle;
  });

  it('returns the injected env brandLabel for the own appId WITHOUT reading bots.json (the sandbox path)', () => {
    process.env.BOTMUX_LARK_APP_ID = 'app_sbx';
    process.env.BOTMUX_BRAND_LABEL = '[{cwdName}]({cwdUrl})';
    // No bot registered, no config path — old code would return undefined; env wins.
    expect(mod.resolveBrandLabel('app_sbx')).toBe('[{cwdName}]({cwdUrl})');
  });

  it('present-but-empty env brandLabel means suppress (returns "")', () => {
    process.env.BOTMUX_LARK_APP_ID = 'app_sbx';
    process.env.BOTMUX_BRAND_LABEL = '';
    expect(mod.resolveBrandLabel('app_sbx')).toBe('');
  });

  it('ignores env when the appId is NOT the current process bot (no cross-bot bleed)', () => {
    process.env.BOTMUX_LARK_APP_ID = 'app_self';
    process.env.BOTMUX_BRAND_LABEL = '[self]()';
    expect(mod.resolveBrandLabel('app_other')).toBeUndefined();
  });

  it('resolves the usage-display mode from registry or sandbox env (default streaming)', () => {
    expect(mod.resolveUsageDisplay('app_default')).toBe('streaming');

    mod.registerBot(makeCfg({
      larkAppId: 'app_registered_footer',
      usageDisplay: 'footer',
    }));
    expect(mod.resolveUsageDisplay('app_registered_footer')).toBe('footer');

    mod.registerBot(makeCfg({
      larkAppId: 'app_registered_off',
      usageDisplay: 'off',
    }));
    expect(mod.resolveUsageDisplay('app_registered_off')).toBe('off');

    process.env.BOTMUX_LARK_APP_ID = 'app_sbx';
    process.env.BOTMUX_USAGE_DISPLAY = 'footer';
    expect(mod.resolveUsageDisplay('app_sbx')).toBe('footer');
    expect(mod.resolveUsageDisplay('app_other')).toBe('streaming');
  });

  it('reads a legacy showUsageInCardFooter:false as off', () => {
    mod.registerBot(makeCfg({
      larkAppId: 'app_legacy_off',
      // legacy field, no usageDisplay set
      showUsageInCardFooter: false,
    } as any));
    expect(mod.resolveUsageDisplay('app_legacy_off')).toBe('off');
  });

  it('prefers freshly loaded registry config over a frozen pane env for the same app', () => {
    process.env.BOTMUX_LARK_APP_ID = 'app_hot';
    process.env.BOTMUX_USAGE_DISPLAY = 'streaming';
    mod.registerBot(makeCfg({
      larkAppId: 'app_hot',
      usageDisplay: 'off',
    }));
    expect(mod.resolveUsageDisplay('app_hot')).toBe('off');

    process.env.BOTMUX_USAGE_DISPLAY = 'off';
    mod.registerBot(makeCfg({ larkAppId: 'app_hot' }));
    expect(mod.resolveUsageDisplay('app_hot')).toBe('streaming');
  });

  it('prefers the frozen replyStyle env for its own app but never leaks it across apps', () => {
    process.env.BOTMUX_SESSION_ID = 'session_frozen';
    process.env.BOTMUX_LARK_APP_ID = 'app_frozen';
    process.env.BOTMUX_REPLY_STYLE = JSON.stringify({ layout: false, theme: 'minimal' });
    mod.registerBot(makeCfg({
      larkAppId: 'app_frozen',
      replyStyle: { layout: true, theme: 'vivid' },
    }));
    mod.registerBot(makeCfg({
      larkAppId: 'app_other',
      replyStyle: { recipes: false },
    }));

    expect(mod.resolveReplyStyleConfig('app_frozen')).toEqual({
      layout: false,
      theme: 'minimal',
    });
    expect(mod.resolveReplyStyleConfig('app_other')).toEqual({ recipes: false });
  });

  it('uses the live registry when an adopt/global send has no worker snapshot', () => {
    delete process.env.BOTMUX_SESSION_ID;
    delete process.env.BOTMUX_LARK_APP_ID;
    delete process.env.BOTMUX_REPLY_STYLE;
    mod.registerBot(makeCfg({
      larkAppId: 'app_adopt_live',
      replyStyle: { layout: true, theme: 'vivid' },
    }));
    expect(mod.resolveReplyStyleConfig('app_adopt_live')).toEqual({
      layout: true,
      theme: 'vivid',
    });

    mod.registerBot(makeCfg({
      larkAppId: 'app_adopt_live',
      replyStyle: { layout: false, theme: 'minimal' },
    }));
    expect(mod.resolveReplyStyleConfig('app_adopt_live')).toEqual({
      layout: false,
      theme: 'minimal',
    });
  });

  it('ignores stale ambient style outside a BotMux session and uses live config', () => {
    delete process.env.BOTMUX_SESSION_ID;
    process.env.BOTMUX_LARK_APP_ID = 'app_adopt_live';
    process.env.BOTMUX_REPLY_STYLE = JSON.stringify({ layout: false, theme: 'minimal' });
    mod.registerBot(makeCfg({
      larkAppId: 'app_adopt_live',
      replyStyle: { layout: true, theme: 'vivid' },
    }));
    expect(mod.resolveReplyStyleConfig('app_adopt_live')).toEqual({
      layout: true,
      theme: 'vivid',
    });
  });

  it('fails soft to the default replyStyle when the injected snapshot is malformed', () => {
    process.env.BOTMUX_SESSION_ID = 'session_frozen';
    process.env.BOTMUX_LARK_APP_ID = 'app_frozen';
    process.env.BOTMUX_REPLY_STYLE = '{broken';
    expect(mod.resolveReplyStyleConfig('app_frozen')).toBeUndefined();
  });
});

// ─── getAllBots ────────────────────────────────────────────────────────────

describe('getAllBots', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;

  beforeEach(async () => {
    mod = await freshImport();
  });

  it('should return an empty array when nothing is registered', () => {
    expect(mod.getAllBots()).toEqual([]);
  });

  it('should return all registered bots', () => {
    mod.registerBot(makeCfg({ larkAppId: 'a1', larkAppSecret: 's1' }));
    mod.registerBot(makeCfg({ larkAppId: 'a2', larkAppSecret: 's2' }));
    mod.registerBot(makeCfg({ larkAppId: 'a3', larkAppSecret: 's3' }));
    const all = mod.getAllBots();
    expect(all).toHaveLength(3);
    const ids = all.map(b => b.config.larkAppId).sort();
    expect(ids).toEqual(['a1', 'a2', 'a3']);
  });
});


// ─── isChatOncallBoundForAnyBot ───────────────────────────────────────────

describe('isChatOncallBoundForAnyBot', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;
  let fsMock: { existsSync: ReturnType<typeof vi.fn>; readFileSync: ReturnType<typeof vi.fn>; statSync: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    mod = await freshImport();
    const fs = await import('node:fs');
    fsMock = {
      existsSync: fs.existsSync as unknown as ReturnType<typeof vi.fn>,
      readFileSync: fs.readFileSync as unknown as ReturnType<typeof vi.fn>,
      statSync: fs.statSync as unknown as ReturnType<typeof vi.fn>,
    };
    fsMock.existsSync.mockReset();
    fsMock.readFileSync.mockReset();
    fsMock.statSync.mockReset();
    delete process.env.BOTS_CONFIG;
  });

  it('sees oncall chats bound to a sibling bot in the shared config file', () => {
    process.env.BOTS_CONFIG = '/tmp/bots.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.statSync.mockReturnValue({ mtimeMs: 100 });
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppId: 'app_a', larkAppSecret: 'sa' },
      { larkAppId: 'app_b', larkAppSecret: 'sb', oncallChats: [{ chatId: 'oc_oncall', workingDir: '/repo' }] },
    ]));

    const configs = mod.loadBotConfigs();
    mod.registerBot(configs[0]);

    expect(mod.findOncallChat('app_a', 'oc_oncall')).toBeUndefined();
    expect(mod.isChatOncallBoundForAnyBot('oc_oncall')).toBe(true);
    expect(mod.findOncallChatForAnyBot('oc_oncall')).toEqual({ chatId: 'oc_oncall', workingDir: '/repo' });
    expect(mod.isChatOncallBoundForAnyBot('oc_other')).toBe(false);
  });

  it('refreshes the sibling oncall cache when bots.json mtime changes', () => {
    process.env.BOTS_CONFIG = '/tmp/bots.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.statSync
      .mockReturnValueOnce({ mtimeMs: 1 })
      .mockReturnValueOnce({ mtimeMs: 2 })
      .mockReturnValueOnce({ mtimeMs: 2 });
    fsMock.readFileSync.mockReturnValueOnce(JSON.stringify([{ larkAppId: 'app_a', larkAppSecret: 'sa' }]));

    const configs = mod.loadBotConfigs();
    mod.registerBot(configs[0]);

    // First lookup builds a negative cache from the original file content.
    fsMock.readFileSync.mockReturnValueOnce(JSON.stringify([{ larkAppId: 'app_a', larkAppSecret: 'sa' }]));
    expect(mod.isChatOncallBoundForAnyBot('oc_new')).toBe(false);

    // A later mtime causes the cache to refresh and pick up sibling bindings.
    fsMock.readFileSync.mockReturnValueOnce(JSON.stringify([
      { larkAppId: 'app_a', larkAppSecret: 'sa' },
      { larkAppId: 'app_b', larkAppSecret: 'sb', oncallChats: [{ chatId: 'oc_new', workingDir: '/repo' }] },
    ]));
    expect(mod.isChatOncallBoundForAnyBot('oc_new')).toBe(true);
    expect(mod.findOncallChatForAnyBot('oc_new')?.workingDir).toBe('/repo');
  });
});

// ─── loadBotConfigs ───────────────────────────────────────────────────────

describe('loadBotConfigs', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;
  let fsMock: { existsSync: ReturnType<typeof vi.fn>; readFileSync: ReturnType<typeof vi.fn>; statSync: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    mod = await freshImport();
    // Grab mocked fs functions
    const fs = await import('node:fs');
    fsMock = {
      existsSync: fs.existsSync as unknown as ReturnType<typeof vi.fn>,
      readFileSync: fs.readFileSync as unknown as ReturnType<typeof vi.fn>,
      statSync: fs.statSync as unknown as ReturnType<typeof vi.fn>,
    };
    fsMock.existsSync.mockReset();
    fsMock.readFileSync.mockReset();
    fsMock.statSync.mockReset();
    fsMock.statSync.mockReturnValue({ mtimeMs: 0 });
    // Clean env
    delete process.env.BOTS_CONFIG;
    delete process.env.BOTMUX_MANAGED_ACTIVATION_APP_ID;
    delete process.env.BOTMUX_MANAGED_ACTIVATION_JOB_ID;
  });

  it('should throw when no config source is available', () => {
    fsMock.existsSync.mockReturnValue(false);
    expect(() => mod.loadBotConfigs()).toThrow('No bot configuration found');
  });

  it('should throw when BOTS_CONFIG env points to a missing file', () => {
    process.env.BOTS_CONFIG = '/tmp/nowhere/bots.json';
    fsMock.existsSync.mockReturnValue(false);
    expect(() => mod.loadBotConfigs()).toThrow('BOTS_CONFIG file not found');
  });

  it('should load config from BOTS_CONFIG env var', () => {
    process.env.BOTS_CONFIG = '/tmp/bots.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppId: 'env_app', larkAppSecret: 'env_secret' },
    ]));

    const configs = mod.loadBotConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0].larkAppId).toBe('env_app');
    expect(configs[0].larkAppSecret).toBe('env_secret');
    expect(configs[0].cliId).toBe('claude-code'); // default
  });

  it('does not register activation-pending bots before their critical scopes are ready', () => {
    process.env.BOTS_CONFIG = '/tmp/bots.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      {
        larkAppId: 'pending_app',
        larkAppSecret: 'pending_secret',
        activationPending: true,
      },
      {
        larkAppId: 'ready_app',
        larkAppSecret: 'ready_secret',
      },
    ]));

    const configs = mod.loadBotConfigs();
    expect(configs.map(config => config.larkAppId)).toEqual(['ready_app']);
  });

  it('loads an activating raw slot only for its exact managed daemon identity', () => {
    process.env.BOTS_CONFIG = '/tmp/bots.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'activating_app',
      larkAppSecret: 'activating_secret',
      activationStarting: { appId: 'activating_app', jobId: 'bot_activation' },
    }]));

    expect(mod.loadBotConfigs()).toEqual([]);
    expect(() => mod.loadBotConfigAtIndex(0)).toThrow('activation pending');
    process.env.BOTMUX_MANAGED_ACTIVATION_APP_ID = 'activating_app';
    process.env.BOTMUX_MANAGED_ACTIVATION_JOB_ID = 'bot_activation';
    expect(mod.loadBotConfigAtIndex(0).larkAppId).toBe('activating_app');
    expect(mod.isManagedActivationStartingAtIndex(0, 'activating_app', 'bot_activation')).toBe(true);
  });

  it('loads a committed raw slot only for the same managed activation receipt', () => {
    process.env.BOTS_CONFIG = '/tmp/bots.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'committed_app',
      larkAppSecret: 'committed_secret',
      activationCommitted: { appId: 'committed_app', jobId: 'bot_committed' },
    }]));

    expect(mod.loadBotConfigs()).toEqual([]);
    expect(() => mod.loadBotConfigAtIndex(0)).toThrow('activation pending');
    process.env.BOTMUX_MANAGED_ACTIVATION_APP_ID = 'committed_app';
    process.env.BOTMUX_MANAGED_ACTIVATION_JOB_ID = 'wrong_job';
    expect(() => mod.loadBotConfigAtIndex(0)).toThrow('activation pending');
    process.env.BOTMUX_MANAGED_ACTIVATION_JOB_ID = 'bot_committed';
    expect(mod.loadBotConfigAtIndex(0).larkAppId).toBe('committed_app');
  });

  it('rejects a deactivating slot even if a corrupted config lost activationPending', () => {
    process.env.BOTS_CONFIG = '/tmp/bots.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'deactivating_app',
      larkAppSecret: 'deactivating_secret',
      activationDeactivating: { appId: 'deactivating_app', jobId: 'bot_deactivating' },
    }]));

    expect(mod.loadBotConfigs()).toEqual([]);
    expect(() => mod.loadBotConfigAtIndex(0)).toThrow('activation pending');
  });

  it('keeps daemon slot indexes stable when an earlier bot is activation-pending', () => {
    process.env.BOTS_CONFIG = '/tmp/bots.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      {
        larkAppId: 'pending_app',
        larkAppSecret: 'pending_secret',
        activationPending: true,
      },
      {
        larkAppId: 'ready_app',
        larkAppSecret: 'ready_secret',
      },
    ]));

    expect(() => mod.loadBotConfigAtIndex(0)).toThrow('activation pending');
    expect(mod.loadBotConfigAtIndex(1).larkAppId).toBe('ready_app');
  });

  it('should fall back to ~/.botmux/bots.json when BOTS_CONFIG is not set', () => {
    // No BOTS_CONFIG env var
    // existsSync: first call (for BOTS_CONFIG) won't happen since env isn't set,
    // second call for default path should return true
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppId: 'default_app', larkAppSecret: 'default_secret', cliId: 'aiden' },
    ]));

    const configs = mod.loadBotConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0].larkAppId).toBe('default_app');
    expect(configs[0].cliId).toBe('aiden');
  });

  it('should throw on invalid JSON', () => {
    process.env.BOTS_CONFIG = '/tmp/bad.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue('not valid json {{{');

    expect(() => mod.loadBotConfigs()).toThrow('Invalid JSON in bot config file');
  });

  it('should throw when JSON is not an array', () => {
    process.env.BOTS_CONFIG = '/tmp/obj.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ larkAppId: 'x', larkAppSecret: 'y' }));

    expect(() => mod.loadBotConfigs()).toThrow('must contain a JSON array');
  });

  it('should throw when larkAppId is missing', () => {
    process.env.BOTS_CONFIG = '/tmp/noid.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppSecret: 'secret' },
    ]));

    expect(() => mod.loadBotConfigs()).toThrow('Bot config [0]: larkAppId is required');
  });

  it('should throw when larkAppSecret is missing', () => {
    process.env.BOTS_CONFIG = '/tmp/nosecret.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppId: 'app1' },
    ]));

    expect(() => mod.loadBotConfigs()).toThrow('Bot config [0]: larkAppSecret is required');
  });

  it('should throw when larkAppId is not a string', () => {
    process.env.BOTS_CONFIG = '/tmp/badtype.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppId: 123, larkAppSecret: 'secret' },
    ]));

    expect(() => mod.loadBotConfigs()).toThrow('Bot config [0]: larkAppId is required and must be a string');
  });

  it('should report correct index for validation errors in second entry', () => {
    process.env.BOTS_CONFIG = '/tmp/idx.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppId: 'ok', larkAppSecret: 'ok' },
      { larkAppId: 'also_ok' }, // missing secret
    ]));

    expect(() => mod.loadBotConfigs()).toThrow('Bot config [1]: larkAppSecret is required');
  });

  it('should parse all optional fields', () => {
    process.env.BOTS_CONFIG = '/tmp/full.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'app_full',
      larkAppSecret: 'secret_full',
      name: 'codex-main',
      cliId: 'gemini',
      cliPathOverride: '/usr/local/bin/gemini',
      disableCliBypass: true,
      sandbox: true,
      sandboxHidePaths: ['~/.ssh', '', 42, '/etc/secret'],
      sandboxReadonlyPaths: ['/srv/source-a-readonly', '  /srv/source-b-readonly  ', null],
      sandboxNetwork: false,
      backendType: 'tmux',
      workingDir: '/home/user/project',
      allowedUsers: ['alice', 'bob'],
      allowedChatGroups: ['oc_team', 'oc_project'],
    }]));

    const configs = mod.loadBotConfigs();
    expect(configs).toHaveLength(1);
    const c = configs[0];
    expect(c.name).toBe('codex-main');
    expect(c.cliId).toBe('gemini');
    expect(c.cliPathOverride).toBe('/usr/local/bin/gemini');
    expect(c.disableCliBypass).toBe(true);
    expect(c.sandbox).toBe(true);
    expect(c.sandboxHidePaths).toEqual(['~/.ssh', '/etc/secret']);
    expect(c.sandboxReadonlyPaths).toEqual(['/srv/source-a-readonly', '/srv/source-b-readonly']);
    expect(c.sandboxNetwork).toBe(false);
    expect(c.backendType).toBe('tmux');
    expect(c.workingDir).toBe('/home/user/project');
    expect(c.allowedUsers).toEqual(['alice', 'bob']);
    expect(c.allowedChatGroups).toEqual(['oc_team', 'oc_project']);
  });

  it('defaults disableCliBypass to false when omitted', () => {
    process.env.BOTS_CONFIG = '/tmp/no-disable-cli-bypass.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'app',
      larkAppSecret: 'secret',
    }]));

    const configs = mod.loadBotConfigs();
    expect(configs[0].disableCliBypass).toBe(false);
  });

  it('should split comma-separated workingDir into workingDirs', () => {
    process.env.BOTS_CONFIG = '/tmp/dirs.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'app_dirs',
      larkAppSecret: 'secret_dirs',
      workingDir: '/proj/a, /proj/b, /proj/c',
    }]));

    const configs = mod.loadBotConfigs();
    const c = configs[0];
    expect(c.workingDirs).toEqual(['/proj/a', '/proj/b', '/proj/c']);
    expect(c.workingDir).toBe('/proj/a'); // first element
  });

  it('should preserve explicit workingDirs over workingDir splitting', () => {
    process.env.BOTS_CONFIG = '/tmp/explicit.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'app_explicit',
      larkAppSecret: 'secret_explicit',
      workingDir: '/old/single',
      workingDirs: ['/new/a', '/new/b'],
    }]));

    const configs = mod.loadBotConfigs();
    const c = configs[0];
    expect(c.workingDirs).toEqual(['/new/a', '/new/b']);
    expect(c.workingDir).toBe('/new/a'); // first from workingDirs
  });

  it('should handle multiple bot entries', () => {
    process.env.BOTS_CONFIG = '/tmp/multi.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppId: 'bot1', larkAppSecret: 's1', cliId: 'claude-code' },
      { larkAppId: 'bot2', larkAppSecret: 's2', cliId: 'aiden' },
      { larkAppId: 'bot3', larkAppSecret: 's3', cliId: 'coco' },
    ]));

    const configs = mod.loadBotConfigs();
    expect(configs).toHaveLength(3);
    expect(configs.map(c => c.larkAppId)).toEqual(['bot1', 'bot2', 'bot3']);
    expect(configs.map(c => c.cliId)).toEqual(['claude-code', 'aiden', 'coco']);
  });

  it('should parse defaultWorkingDir as an optional string', () => {
    process.env.BOTS_CONFIG = '/tmp/defwd.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppId: 'a1', larkAppSecret: 's1', defaultWorkingDir: '~/projects/foo' },
      { larkAppId: 'a2', larkAppSecret: 's2' },                      // unset → undefined
      { larkAppId: 'a3', larkAppSecret: 's3', defaultWorkingDir: '' },  // empty → undefined
      { larkAppId: 'a4', larkAppSecret: 's4', defaultWorkingDir: '   ' }, // whitespace → undefined
      { larkAppId: 'a5', larkAppSecret: 's5', defaultWorkingDir: 42 }, // non-string → undefined
      { larkAppId: 'a6', larkAppSecret: 's6', defaultWorkingDir: '  /repos/bar  ' }, // trimmed
    ]));

    const configs = mod.loadBotConfigs();
    expect(configs[0].defaultWorkingDir).toBe('~/projects/foo');
    expect(configs[1].defaultWorkingDir).toBeUndefined();
    expect(configs[2].defaultWorkingDir).toBeUndefined();
    expect(configs[3].defaultWorkingDir).toBeUndefined();
    expect(configs[4].defaultWorkingDir).toBeUndefined();
    expect(configs[5].defaultWorkingDir).toBe('/repos/bar');
  });

  it('should handle empty workingDir string gracefully', () => {
    process.env.BOTS_CONFIG = '/tmp/empty_wd.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'app_empty_wd',
      larkAppSecret: 'secret',
      workingDir: '',
    }]));

    const configs = mod.loadBotConfigs();
    // Empty string is falsy so the comma-split path is never taken;
    // workingDirs stays undefined, workingDir falls through to the raw value.
    expect(configs[0].workingDirs).toBeUndefined();
    expect(configs[0].workingDir).toBe('');
  });

  it('should return empty array for an empty JSON array', () => {
    process.env.BOTS_CONFIG = '/tmp/empty_arr.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue('[]');

    const configs = mod.loadBotConfigs();
    expect(configs).toEqual([]);
  });

  // ── defaultOncall parsing ────────────────────────────────────────────────

  it('should parse a fully-formed defaultOncall entry', () => {
    process.env.BOTS_CONFIG = '/tmp/default_oncall.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'app_d',
      larkAppSecret: 's',
      defaultOncall: { enabled: true, workingDir: '/projects/x', since: 1700000000000 },
      defaultOncallAutoboundChats: ['oc_one', 'oc_two'],
    }]));

    const c = mod.loadBotConfigs()[0];
    expect(c.defaultOncall).toEqual({
      enabled: true,
      workingDir: '/projects/x',
      since: 1700000000000,
    });
    expect(c.defaultOncallAutoboundChats).toEqual(['oc_one', 'oc_two']);
  });

  it('should coerce defaultOncall.enabled=true to false when workingDir is blank', () => {
    // Hand-edited configs can be inconsistent: enabled but no dir. Treat as
    // off so we never auto-bind into a blank path.
    process.env.BOTS_CONFIG = '/tmp/default_oncall_blank.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'app_d',
      larkAppSecret: 's',
      defaultOncall: { enabled: true, workingDir: '', since: 100 },
    }]));

    const c = mod.loadBotConfigs()[0];
    expect(c.defaultOncall?.enabled).toBe(false);
    expect(c.defaultOncall?.workingDir).toBe('');
  });

  it('should leave defaultOncall undefined when the field is absent', () => {
    process.env.BOTS_CONFIG = '/tmp/no_default.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'app_d', larkAppSecret: 's',
    }]));

    const c = mod.loadBotConfigs()[0];
    expect(c.defaultOncall).toBeUndefined();
    expect(c.defaultOncallAutoboundChats).toBeUndefined();
  });

  it('should drop non-string entries from defaultOncallAutoboundChats', () => {
    process.env.BOTS_CONFIG = '/tmp/autobound_mixed.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'app_d',
      larkAppSecret: 's',
      defaultOncallAutoboundChats: ['oc_ok', 42, null, 'oc_also'],
    }]));

    const c = mod.loadBotConfigs()[0];
    expect(c.defaultOncallAutoboundChats).toEqual(['oc_ok', 'oc_also']);
  });
});

// ─── vcMeetingAgentConfigActive — apiOnly VC fail-close (codex #668 round-2 B2) ───

describe('vcMeetingAgentConfigActive — apiOnly bots never attend VC meetings', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;
  beforeEach(async () => { mod = await freshImport(); });

  const enabledVc = { enabled: true, listenerChatId: 'oc_listener' } as any;

  it('returns the config for a NORMAL bot with enabled VC (unchanged behavior)', () => {
    expect(mod.vcMeetingAgentConfigActive({ vcMeetingAgent: enabledVc }))
      .toEqual(enabledVc);
  });

  it('returns undefined for an apiOnly bot EVEN WHEN vcMeetingAgent.enabled is true', () => {
    // The core B2 invariant: a migrated bots.json (normal VC bot flipped to apiOnly,
    // leaving enabled:true) must NOT yield an active VC config — otherwise the boot
    // restore path would spawn `lark-cli vc +meeting-events --as bot`, breaking the
    // zero-Feishu-network contract. apiOnly short-circuits BEFORE the enabled check.
    expect(mod.vcMeetingAgentConfigActive({ apiOnly: true, vcMeetingAgent: enabledVc }))
      .toBeUndefined();
  });

  it('is active by default for a Feishu bot; only enabled:false opts out', () => {
    // Bot-agnostic join: any invited Feishu bot should join, so VC is active
    // unless explicitly disabled. enabled:false is the per-bot opt-out.
    expect(mod.vcMeetingAgentConfigActive({ vcMeetingAgent: { enabled: false } as any }))
      .toBeUndefined();
    // Unset enabled / no vcMeetingAgent block → active with an effective config
    // (empty object is fine; downstream reads fall back to their own defaults).
    expect(mod.vcMeetingAgentConfigActive({ vcMeetingAgent: {} as any })).toEqual({});
    expect(mod.vcMeetingAgentConfigActive({})).toEqual({});
    expect(mod.vcMeetingAgentConfigActive(undefined)).toBeUndefined();
  });

  it('apiOnly wins over enabled regardless of field order / extra keys (fail-closed)', () => {
    expect(mod.vcMeetingAgentConfigActive({ vcMeetingAgent: enabledVc, apiOnly: true }))
      .toBeUndefined();
  });

  // 回归(PR#916 codex阻断①):VC/实时语音默认开翻转后,enabled:false 是显式退出,
  // 必须能 round-trip 存活。这里**过真实 parseBotConfigsFromText → vcMeetingAgentConfigActive**
  // (而不是手搓对象喂 active),否则 normalizer 丢 false 的 bug 会被假绿掩盖。
  it('a persisted vcMeetingAgent.enabled:false round-trips through parse and stays opted out', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'cli_off', larkAppSecret: 's', vcMeetingAgent: { enabled: false } },
    ]));
    expect(cfg.vcMeetingAgent?.enabled).toBe(false);
    expect(mod.vcMeetingAgentConfigActive(cfg)).toBeUndefined();
  });

  it('a persisted realtimeVoice.enabled:false round-trips through parse (voice stays off)', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'cli_v', larkAppSecret: 's', vcMeetingAgent: { realtimeVoice: { enabled: false } } },
    ]));
    // 顶层不 enabled:false → bot 仍接收会议事件,但实时语音显式关闭必须保留。
    expect(cfg.vcMeetingAgent?.realtimeVoice?.enabled).toBe(false);
  });
});

// ─── bots.json unreadable (sandbox read isolation) ────────────────────────

/**
 * Regression (2026-08-03, fleet P0): every botmux subcommand died inside a
 * sandboxed bot with `EPERM: operation not permitted, open '~/.botmux/bots.json'`.
 *
 * Shape of the bug: Seatbelt allows the METADATA read but denies the CONTENT
 * read, so resolveBotConfigPath()'s existsSync() passes (the graceful "no config
 * file" branch is never taken) and parseBotConfigFile()'s readFileSync throws.
 * The isolated bot's own identity comes from send-cred.json, so disk returning
 * nothing is the correct answer there — but ONLY there.
 */
describe('loadBotConfigs when bots.json exists but is unreadable', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;
  let fs: typeof import('node:fs');
  const savedEnv = { ...process.env };

  const eperm = () => Object.assign(new Error("EPERM: operation not permitted, open '/h/.botmux/bots.json'"), { code: 'EPERM' });

  beforeEach(async () => {
    delete process.env.BOTS_CONFIG;      // force the ~/.botmux/bots.json branch
    delete process.env.BOTMUX_CORE_ONLY; // not the synthesized core-only path
    mod = await freshImport();
    fs = await import('node:fs');
    vi.mocked(fs.existsSync).mockReturnValue(true);       // metadata read allowed
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw eperm(); }); // content denied
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('' as never);
  });

  it('degrades to an empty list under read isolation (identity comes from send-cred.json)', () => {
    process.env.BOTMUX_READ_ISOLATION = '1';
    expect(mod.loadBotConfigs()).toEqual([]);
  });

  it('does NOT degrade for an ordinary worker CLI (same env vars, no cred file)', () => {
    // The regression this guards: an env-only isolation check matches every
    // worker-spawned CLI, so a genuinely unreadable bots.json on a normal host
    // would silently become "there are no bots".
    delete process.env.BOTMUX_READ_ISOLATION;
    process.env.SESSION_DATA_DIR = '/h/.botmux/data';
    process.env.BOTMUX_LARK_APP_ID = 'cli_plain';
    expect(() => mod.loadBotConfigs()).toThrow(/EPERM/);
  });

  it('still throws OUTSIDE read isolation — an unreadable bots.json is a real fault there', () => {
    delete process.env.SESSION_DATA_DIR;
    delete process.env.BOTMUX_LARK_APP_ID;
    // Swallowing here would silently boot a zero-bot process: no bot answers and
    // nothing anywhere says why. Crashing loudly is the correct behaviour.
    expect(() => mod.loadBotConfigs()).toThrow(/EPERM/);
  });

  it('still throws when only ONE isolation marker is present (half-configured is not isolation)', () => {
    delete process.env.BOTMUX_READ_ISOLATION;
    process.env.SESSION_DATA_DIR = '/h/.botmux/data';
    delete process.env.BOTMUX_LARK_APP_ID;
    expect(() => mod.loadBotConfigs()).toThrow(/EPERM/);
  });

  it('still throws for a NON-permission read error even under isolation (only EPERM/EACCES are expected)', () => {
    process.env.BOTMUX_READ_ISOLATION = '1';
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    });
    expect(() => mod.loadBotConfigs()).toThrow(/EIO/);
  });
});

describe('normalizeTurnTimeoutMs / MAX_TURN_TIMEOUT_MS', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;

  beforeEach(async () => {
    mod = await freshImport();
  });

  it('keeps positive integers within the arm-able bound and rejects everything else', () => {
    expect(mod.normalizeTurnTimeoutMs(1_800_000)).toBe(1_800_000);
    expect(mod.normalizeTurnTimeoutMs(90_001)).toBe(90_001); // legal non-whole-minute value
    expect(mod.normalizeTurnTimeoutMs(mod.MAX_TURN_TIMEOUT_MS)).toBe(mod.MAX_TURN_TIMEOUT_MS);
    // Rejected: non-positive, non-integer, over-bound, non-number, absent.
    expect(mod.normalizeTurnTimeoutMs(0)).toBeUndefined();
    expect(mod.normalizeTurnTimeoutMs(-5)).toBeUndefined();
    expect(mod.normalizeTurnTimeoutMs(1.5)).toBeUndefined();
    expect(mod.normalizeTurnTimeoutMs(mod.MAX_TURN_TIMEOUT_MS + 1)).toBeUndefined();
    expect(mod.normalizeTurnTimeoutMs('1800000')).toBeUndefined();
    expect(mod.normalizeTurnTimeoutMs(undefined)).toBeUndefined();
  });

  it('parseBotConfigsFromText drops an over-bound turnTimeoutMs', () => {
    const [ok] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's', cliId: 'dsh', turnTimeoutMs: 90_001 },
    ]));
    expect(ok.turnTimeoutMs).toBe(90_001);
    const [over] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'b', larkAppSecret: 's', cliId: 'dsh', turnTimeoutMs: mod.MAX_TURN_TIMEOUT_MS + 1 },
    ]));
    expect(over.turnTimeoutMs).toBeUndefined();
  });

  it('the dashboard UI mirror of the bound stays equal to the shared constant', async () => {
    const { DASHBOARD_MAX_TURN_TIMEOUT_MS } = await import('../src/dashboard/web/bot-defaults-page.js');
    expect(DASHBOARD_MAX_TURN_TIMEOUT_MS).toBe(mod.MAX_TURN_TIMEOUT_MS);
  });
});
