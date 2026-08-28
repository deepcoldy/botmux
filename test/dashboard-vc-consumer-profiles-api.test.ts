import { describe, expect, it, vi } from 'vitest';
import {
  buildVcMeetingAgentOptions,
  deriveVcMeetingPermissionPreset,
  handleVcMeetingConsumerProfilesGet,
  handleVcMeetingConsumerProfilesPut,
  vcMeetingConsumerProfileToDto,
  vcMeetingConsumerProfilesFromDtos,
} from '../src/dashboard/vc-consumer-profiles-api.js';
import type {
  VcMeetingConsumerProfileDto,
  VcMeetingConsumerProfilesApiDeps,
  VcMeetingPermissionPreset,
} from '../src/dashboard/vc-consumer-profiles-api.js';
import type { VcMeetingSharedConsumerProfile } from '../src/global-config.js';
import type {
  VcMeetingSharedConsumerCatalogSnapshot,
} from '../src/services/vc-meeting-shared-consumer-catalog-store.js';
import type { BotConfig } from '../src/bot-registry.js';

const READ = 'meeting.read';
const OUTPUT = 'meeting.output.request';
const LISTENER = 'listener.output.request';

/** 共享目录条目刻意**不带** `agentAppId`：执行方在读路径绑定为收到事件的 bot。 */
function canonical(over: Partial<VcMeetingSharedConsumerProfile> = {}): VcMeetingSharedConsumerProfile {
  return {
    id: 'minutes',
    role: 'minutes',
    responseMode: 'silent',
    capabilities: [READ],
    ...over,
  };
}

function dto(over: Partial<VcMeetingConsumerProfileDto> = {}): VcMeetingConsumerProfileDto {
  return {
    id: 'minutes',
    responseMode: 'silent',
    permissionPreset: 'observe_only',
    ...over,
  };
}

describe('deriveVcMeetingPermissionPreset', () => {
  const cases: Array<[VcMeetingPermissionPreset, VcMeetingSharedConsumerProfile]> = [
    ['observe_only', canonical()],
    ['observe_only', canonical({ responseMode: 'listener_thread', capabilities: [LISTENER, READ] })],
    ['meeting_text', canonical({ capabilities: [OUTPUT, READ], ownedSinks: ['meeting_text'] })],
    ['meeting_voice', canonical({ capabilities: [OUTPUT, READ], ownedSinks: ['meeting_voice'] })],
    ['meeting_text_voice', canonical({ capabilities: [OUTPUT, READ], ownedSinks: ['meeting_text', 'meeting_voice'] })],
    ['meeting_text', canonical({
      responseMode: 'listener_thread',
      capabilities: [LISTENER, OUTPUT, READ],
      ownedSinks: ['meeting_text'],
    })],
  ];
  it.each(cases)('maps canonical policy to %s', (preset, profile) => {
    expect(deriveVcMeetingPermissionPreset(profile)).toBe(preset);
  });

  it('sort/dup-insensitive: unsorted or duplicated lists still match a preset', () => {
    expect(deriveVcMeetingPermissionPreset(canonical({
      capabilities: [READ, OUTPUT, READ],
      ownedSinks: ['meeting_voice', 'meeting_text'],
    }))).toBe('meeting_text_voice');
  });

  it('falls back to custom on any extra/missing capability or sink mismatch', () => {
    // silent policy legitimately carrying listener.output.request (合法但非模板)
    expect(deriveVcMeetingPermissionPreset(canonical({
      capabilities: [LISTENER, OUTPUT, READ],
      ownedSinks: ['meeting_text'],
    }))).toBe('custom');
    // sinks 与模板对不上
    expect(deriveVcMeetingPermissionPreset(canonical({
      capabilities: [OUTPUT, READ],
      ownedSinks: [],
    }))).toBe('custom');
  });
});

describe('vcMeetingConsumerProfilesFromDtos ↔ vcMeetingConsumerProfileToDto', () => {
  it('round-trips every template preset in both response modes', () => {
    const presets: Array<Exclude<VcMeetingPermissionPreset, 'custom'>> = [
      'observe_only', 'meeting_text', 'meeting_voice', 'meeting_text_voice',
    ];
    for (const preset of presets) {
      for (const responseMode of ['silent', 'listener_thread'] as const) {
        const mapped = vcMeetingConsumerProfilesFromDtos(
          [dto({ permissionPreset: preset, responseMode })], [],
        );
        expect(mapped.ok).toBe(true);
        if (!mapped.ok) continue;
        const back = vcMeetingConsumerProfileToDto(mapped.profiles[0]);
        expect(back.permissionPreset).toBe(preset);
        expect(back.responseMode).toBe(responseMode);
      }
    }
  });

  it('listener_thread presets carry listener.output.request; silent presets do not', () => {
    const mapped = vcMeetingConsumerProfilesFromDtos([
      dto({ id: 'a', permissionPreset: 'meeting_text', responseMode: 'listener_thread' }),
      dto({ id: 'b', permissionPreset: 'meeting_text', responseMode: 'silent' }),
    ], []);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.profiles[0].capabilities).toEqual([LISTENER, OUTPUT, READ]);
    expect(mapped.profiles[0].ownedSinks).toEqual(['meeting_text']);
    expect(mapped.profiles[1].capabilities).toEqual([OUTPUT, READ]);
  });

  it('round-trips listener placement independently from response mode', () => {
    const mapped = vcMeetingConsumerProfilesFromDtos([
      dto({ responseMode: 'listener_thread', listenerPlacement: 'topic' }),
    ], []);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.profiles[0].listenerDelivery).toEqual({ placement: 'topic' });
    expect(vcMeetingConsumerProfileToDto(mapped.profiles[0]).listenerPlacement).toBe('topic');

    const legacy = vcMeetingConsumerProfilesFromDtos([dto()], []);
    expect(legacy.ok).toBe(true);
    if (legacy.ok) {
      expect(legacy.profiles[0]).not.toHaveProperty('listenerDelivery');
      expect(vcMeetingConsumerProfileToDto(legacy.profiles[0]).listenerPlacement).toBe('auto');
    }
  });

  // codex 指定用例：silent policy 合法携带 listener.output.request 时，
  // custom 的 no-op GET→PUT 往返不得丢字段（mode 未变 → 逐字复制）。
  it('no-op custom round-trip preserves capabilities verbatim (incl. listener cap on silent)', () => {
    const prior = canonical({
      role: 'note-taker',
      capabilities: [LISTENER, OUTPUT, READ],
      ownedSinks: ['meeting_text'],
    });
    const asDto = vcMeetingConsumerProfileToDto(prior);
    expect(asDto.permissionPreset).toBe('custom');
    const mapped = vcMeetingConsumerProfilesFromDtos([asDto], [prior]);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.profiles[0].capabilities).toEqual([LISTENER, OUTPUT, READ]);
    expect(mapped.profiles[0].ownedSinks).toEqual(['meeting_text']);
    expect(mapped.profiles[0].role).toBe('note-taker');
  });

  it('custom + real mode change only adds/removes listener.output.request', () => {
    const silentPrior = canonical({ capabilities: [OUTPUT, READ], ownedSinks: ['meeting_voice'] });
    const toListener = vcMeetingConsumerProfilesFromDtos(
      [dto({ permissionPreset: 'custom', responseMode: 'listener_thread' })], [silentPrior],
    );
    expect(toListener.ok).toBe(true);
    if (toListener.ok) {
      expect(toListener.profiles[0].capabilities).toEqual([LISTENER, OUTPUT, READ]);
      expect(toListener.profiles[0].ownedSinks).toEqual(['meeting_voice']);
    }

    const listenerPrior = canonical({
      responseMode: 'listener_thread',
      capabilities: [LISTENER, OUTPUT, READ],
      ownedSinks: ['meeting_voice'],
    });
    const toSilent = vcMeetingConsumerProfilesFromDtos(
      [dto({ permissionPreset: 'custom', responseMode: 'silent' })], [listenerPrior],
    );
    expect(toSilent.ok).toBe(true);
    if (toSilent.ok) {
      expect(toSilent.profiles[0].capabilities).toEqual([OUTPUT, READ]);
    }
  });

  it('custom with a new id is rejected (no prior policy to reuse)', () => {
    const mapped = vcMeetingConsumerProfilesFromDtos(
      [dto({ id: 'fresh', permissionPreset: 'custom' })], [],
    );
    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.fieldErrors).toEqual([
      expect.objectContaining({ path: 'profiles[0].permissionPreset' }),
    ]);
  });

  it('preserves prior role for existing ids and uses id as role for new ids', () => {
    const prior = canonical({ role: 'scribe-legacy' });
    const mapped = vcMeetingConsumerProfilesFromDtos([
      dto(),
      dto({ id: 'fresh', permissionPreset: 'meeting_text' }),
    ], [prior]);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.profiles[0].role).toBe('scribe-legacy');
    expect(mapped.profiles[1].role).toBe('fresh');
  });

  // 浏览器不能构造 raw capability：DTO 里夹带的 capabilities/ownedSinks
  // 一律忽略——模板档由服务端模板生成，custom 档只复用既有 policy。
  it('ignores injected raw capabilities/ownedSinks (no privilege escalation)', () => {
    const injected = {
      ...dto({ permissionPreset: 'observe_only' }),
      capabilities: ['root.everything', OUTPUT],
      ownedSinks: ['meeting_text', 'meeting_voice'],
    } as VcMeetingConsumerProfileDto;
    const templated = vcMeetingConsumerProfilesFromDtos([injected], []);
    expect(templated.ok).toBe(true);
    if (templated.ok) {
      expect(templated.profiles[0].capabilities).toEqual([READ]);
      expect(templated.profiles[0]).not.toHaveProperty('ownedSinks');
    }

    const prior = canonical({ capabilities: [READ] });
    const customInjected = {
      ...dto({ permissionPreset: 'custom' }),
      capabilities: ['root.everything'],
      ownedSinks: ['meeting_voice'],
    } as VcMeetingConsumerProfileDto;
    const reused = vcMeetingConsumerProfilesFromDtos([customInjected], [prior]);
    expect(reused.ok).toBe(true);
    if (reused.ok) {
      expect(reused.profiles[0].capabilities).toEqual([READ]);
      expect(reused.profiles[0]).not.toHaveProperty('ownedSinks');
    }
  });

  it('rejects non-object list elements instead of throwing', () => {
    const mapped = vcMeetingConsumerProfilesFromDtos(
      [null, 1, []] as unknown as VcMeetingConsumerProfileDto[], [],
    );
    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.fieldErrors.map(e => e.path)).toEqual(['profiles[0]', 'profiles[1]', 'profiles[2]']);
  });

  it('reports field-level errors with DTO paths', () => {
    const mapped = vcMeetingConsumerProfilesFromDtos([
      dto({ id: '  ' }),
      dto({ id: 'c', responseMode: 'broadcast' as never }),
      dto({ id: 'd', permissionPreset: 'root' as never }),
      dto({ id: 'e', activityTypes: ['transcript_received', 'nope'] }),
      dto({ id: 'f', instructions: 42 as never }),
      dto({ id: 'g', listenerPlacement: 'broadcast' as never }),
    ], []);
    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.fieldErrors.map(e => e.path)).toEqual([
      'profiles[0].id',
      'profiles[1].responseMode',
      'profiles[2].permissionPreset',
      'profiles[3].activityTypes',
      'profiles[4].instructions',
      'profiles[5].listenerPlacement',
    ]);
  });

  // 共享目录里没有执行方这一维：DTO 夹带 agentAppId 也不会被写进去。
  it('ignores an injected agentAppId — the shared catalog has no executor field', () => {
    const mapped = vcMeetingConsumerProfilesFromDtos(
      [{ ...dto(), agentAppId: 'app_other_bot' } as VcMeetingConsumerProfileDto], [],
    );
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.profiles[0]).not.toHaveProperty('agentAppId');
  });

  it('trims label/instructions, drops empties, sorts+dedups activityTypes', () => {
    const mapped = vcMeetingConsumerProfilesFromDtos([dto({
      label: '  会议纪要  ',
      instructions: '  盯住决议项  ',
      activityTypes: ['transcript_received', 'chat_received', 'transcript_received'],
    }), dto({ id: 'bare', label: '   ', instructions: '   ' })], []);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.profiles[0].label).toBe('会议纪要');
    expect(mapped.profiles[0].instructions).toBe('盯住决议项');
    expect(mapped.profiles[0].filter?.activityTypes).toEqual(['chat_received', 'transcript_received']);
    expect(mapped.profiles[1]).not.toHaveProperty('label');
    expect(mapped.profiles[1]).not.toHaveProperty('instructions');
    expect(mapped.profiles[1]).not.toHaveProperty('filter');
  });
});

function snapshot(
  over: Partial<VcMeetingSharedConsumerCatalogSnapshot> = {},
): VcMeetingSharedConsumerCatalogSnapshot {
  return {
    revision: 'sha256:rev1',
    catalogState: 'profiles',
    defaultMode: 'listenOnly',
    defaultConsumerIds: [],
    profiles: [canonical()],
    ...over,
  };
}

function makeDeps(over: Partial<VcMeetingConsumerProfilesApiDeps> = {}): VcMeetingConsumerProfilesApiDeps {
  const agentBot = {
    larkAppId: 'app_agent', name: 'agent-a', displayName: 'Agent A', cliId: 'claude',
  } as unknown as BotConfig;
  return {
    readCatalog: vi.fn(async () => snapshot()),
    updateCatalog: vi.fn(async input => ({
      ok: true as const,
      snapshot: snapshot({
        revision: 'sha256:rev2',
        defaultMode: input.defaultMode,
        defaultConsumerIds: input.defaultConsumerIds,
        profiles: input.profiles,
      }),
    })),
    loadBotConfigs: vi.fn(() => [agentBot]),
    effectiveDefaultWorkingDir: vi.fn(() => '/work'),
    onlineBotName: vi.fn(() => 'agent-online-name'),
    isOnline: vi.fn(() => true),
    adapterReliableTurnTerminal: vi.fn(() => true),
    managedSideEffectEligible: vi.fn(() => true),
    sandboxIsolated: vi.fn(() => true),
    reloadDaemons: vi.fn(async () => {}),
    applyBotOutputPolicy: vi.fn(async () => ({ ok: true })),
    ...over,
  };
}

const DEFAULT_POLICY_FIELDS = {
  // 缺省 = 接收会议事件：VC 对每个连着飞书的 bot 默认可用，enabled:false 才是退出。
  vcEnabled: true,
  vcEligible: true,
  textOutputPolicy: null,
  voiceOutputPolicy: null,
  // 实时语音能力默认开启（未显式配 = 开）；语音生效值随之默认 allow。
  realtimeVoiceEnabled: true,
  catalogDefaultConsumerId: null,
  effectiveTextOutputPolicy: 'allow',
  effectiveVoiceOutputPolicy: 'allow',
} as const;

function putRequest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expectedRevision: 'sha256:rev1',
    defaultMode: 'listenOnly',
    defaultConsumerIds: [],
    profiles: [dto()],
    ...over,
  };
}

describe('buildVcMeetingAgentOptions', () => {
  it('maps registry bots to the isolation-aware option DTO', () => {
    const deps = makeDeps();
    expect(buildVcMeetingAgentOptions(deps)).toEqual([{
      appId: 'app_agent',
      label: 'Agent A',
      cliId: 'claude',
      online: true,
      workingDirReady: true,
      reliableTurnTerminal: true,
      managedSideEffectEligible: true,
      sandboxIsolated: true,
      ...DEFAULT_POLICY_FIELDS,
    }]);
  });

  it('label falls back displayName → online botName → config name → appId', () => {
    const bot = { larkAppId: 'app_x', name: '' } as unknown as BotConfig;
    const deps = makeDeps({
      loadBotConfigs: vi.fn(() => [bot]),
      onlineBotName: vi.fn(() => undefined),
      isOnline: vi.fn(() => false),
      effectiveDefaultWorkingDir: vi.fn(() => undefined),
      adapterReliableTurnTerminal: vi.fn(() => false),
    });
    expect(buildVcMeetingAgentOptions(deps)).toEqual([{
      appId: 'app_x',
      label: 'app_x',
      online: false,
      workingDirReady: false,
      reliableTurnTerminal: false,
      managedSideEffectEligible: true,
      sandboxIsolated: true,
      ...DEFAULT_POLICY_FIELDS,
    }]);
  });

  it('shows an OFFLINE bot\'s persisted Feishu name (not the raw appId)', () => {
    // Regression: cli_xxx bots that are offline used to fall through to appId in
    // the dropdown. The dashboard now feeds onlineBotName from bots-info.json so
    // an offline bot keeps its friendly name. Here isOnline=false but the name
    // resolver still returns the persisted name.
    const bot = { larkAppId: 'cli_offline', name: '' } as unknown as BotConfig;
    const deps = makeDeps({
      loadBotConfigs: vi.fn(() => [bot]),
      onlineBotName: vi.fn(() => 'LastResort(Codex)'),
      isOnline: vi.fn(() => false),
    });
    const options = buildVcMeetingAgentOptions(deps);
    expect(options[0]?.label).toBe('LastResort(Codex)');
    expect(options[0]?.online).toBe(false);
  });

  it('returns [] when config loading throws (options degrade, not 500)', () => {
    const deps = makeDeps({ loadBotConfigs: vi.fn(() => { throw new Error('boom'); }) });
    expect(buildVcMeetingAgentOptions(deps)).toEqual([]);
  });

  it('sorts options by appId instead of inheriting bots.json order', () => {
    const bots = ['app_z', 'app_a', 'app_m'].map(larkAppId => ({
      larkAppId,
      cliId: 'claude',
    } as unknown as BotConfig));
    const deps = makeDeps({ loadBotConfigs: vi.fn(() => bots) });
    expect(buildVcMeetingAgentOptions(deps).map(option => option.appId))
      .toEqual(['app_a', 'app_m', 'app_z']);
  });

  // 每个 bot 一行开关取代了旧的「会议事件接收 Bot」单选：缺省接收，显式
  // enabled:false 才退出，apiOnly（无飞书连接）结构上不可能收会议事件。
  it('exposes the per-bot VC receive switch: default on, explicit off, apiOnly ineligible', () => {
    const bots = [
      { larkAppId: 'app_default', cliId: 'claude' },
      { larkAppId: 'app_off', cliId: 'claude', vcMeetingAgent: { enabled: false } },
      { larkAppId: 'app_api_only', cliId: 'claude', apiOnly: true },
      { larkAppId: 'app_on', cliId: 'claude', vcMeetingAgent: { enabled: true } },
    ] as unknown as BotConfig[];
    const deps = makeDeps({ loadBotConfigs: vi.fn(() => bots) });
    expect(buildVcMeetingAgentOptions(deps).map(o => [o.appId, o.vcEnabled, o.vcEligible])).toEqual([
      ['app_api_only', false, false],
      ['app_default', true, true],
      ['app_off', false, true],
      ['app_on', true, true],
    ]);
  });
});

describe('handleVcMeetingConsumerProfilesGet', () => {
  it('503 when the shared catalog is unreadable', async () => {
    expect((await handleVcMeetingConsumerProfilesGet(
      makeDeps({ readCatalog: vi.fn(async () => { throw new Error('io'); }) }),
    )).status).toBe(503);
  });

  it('200 returns DTO profiles + agentOptions + revision', async () => {
    const out = await handleVcMeetingConsumerProfilesGet(makeDeps());
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    expect(out.body.revision).toBe('sha256:rev1');
    expect(out.body.catalogState).toBe('profiles');
    expect(out.body.profiles).toEqual([dto({ listenerPlacement: 'auto' })]);
    expect(out.body.agentOptions[0]?.appId).toBe('app_agent');
    expect(out.body.templateCatalog).toMatchObject({
      schemaVersion: 1,
      templates: [
        { templateId: 'important-information-sync', version: 1, source: 'builtin' },
        { templateId: 'meeting-minutes', version: 2, source: 'builtin' },
        { templateId: 'meeting-facilitator', version: 2, source: 'builtin' },
        { templateId: 'solution-review-risk-challenge', version: 1, source: 'builtin' },
        { templateId: 'interview-requirement-insights', version: 1, source: 'builtin' },
      ],
    });
  });

  // 「从没配置过」也要有可跑的角色：Dashboard 直接展示内置默认目录，读路径不写盘。
  it('GET on a never-configured catalog exposes the built-in default without writing', async () => {
    const deps = makeDeps({
      readCatalog: vi.fn(async () => snapshot({
        catalogState: 'uninitialized',
        defaultMode: 'agents',
        defaultConsumerIds: ['minutes'],
      })),
    });
    const out = await handleVcMeetingConsumerProfilesGet(deps);
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    expect(out.body.catalogState).toBe('uninitialized');
    expect(out.body.defaultConsumerIds).toEqual(['minutes']);
    expect(deps.updateCatalog).not.toHaveBeenCalled();
  });
});

describe('handleVcMeetingConsumerProfilesPut', () => {
  it('400 on non-object payload / missing revision', async () => {
    const deps = makeDeps();
    for (const payload of [null, 'x', [1]]) {
      expect((await handleVcMeetingConsumerProfilesPut(payload, deps)).status).toBe(400);
    }
    expect((await handleVcMeetingConsumerProfilesPut(
      putRequest({ expectedRevision: undefined }), deps,
    )).body).toMatchObject({ error: 'expectedRevision_required' });
  });

  it('422 with pathed fieldErrors on malformed top-level fields', async () => {
    const deps = makeDeps();
    const cases: Array<[Record<string, unknown>, string]> = [
      [putRequest({ defaultMode: 'auto' }), 'defaultMode'],
      [putRequest({ defaultConsumerIds: 'minutes' }), 'defaultConsumerIds'],
      [putRequest({ defaultConsumerIds: [1] }), 'defaultConsumerIds'],
      [putRequest({ profiles: {} }), 'profiles'],
    ];
    for (const [payload, path] of cases) {
      const out = await handleVcMeetingConsumerProfilesPut(payload, deps);
      expect(out.status).toBe(422);
      expect(out.status === 422 && out.body.fieldErrors?.[0]?.path).toBe(path);
    }
    expect(deps.updateCatalog).not.toHaveBeenCalled();
  });

  it('422 on DTO mapping failure without touching the store', async () => {
    const deps = makeDeps();
    const out = await handleVcMeetingConsumerProfilesPut(
      putRequest({ profiles: [dto({ id: 'fresh', permissionPreset: 'custom' })] }), deps,
    );
    expect(out.status).toBe(422);
    expect(out.status === 422 && out.body.fieldErrors?.[0]?.path).toBe('profiles[0].permissionPreset');
    expect(deps.updateCatalog).not.toHaveBeenCalled();
  });

  it('custom reuse maps from the CURRENT stored policy of the same id', async () => {
    const stored = canonical({ capabilities: [LISTENER, OUTPUT, READ], ownedSinks: ['meeting_text'] });
    const deps = makeDeps({ readCatalog: vi.fn(async () => snapshot({ profiles: [stored] })) });
    const out = await handleVcMeetingConsumerProfilesPut(
      putRequest({ profiles: [dto({ permissionPreset: 'custom' })] }), deps,
    );
    expect(out.status).toBe(200);
    const sent = vi.mocked(deps.updateCatalog).mock.calls[0][0];
    expect(sent.profiles[0].capabilities).toEqual([LISTENER, OUTPUT, READ]);
    expect(sent.profiles[0].ownedSinks).toEqual(['meeting_text']);
  });

  it('passes defaultConsumerIds verbatim — no silent filtering (store is the authority)', async () => {
    const deps = makeDeps();
    await handleVcMeetingConsumerProfilesPut(
      putRequest({ defaultMode: 'agents', defaultConsumerIds: ['ghost', 'minutes'] }), deps,
    );
    expect(vi.mocked(deps.updateCatalog).mock.calls[0][0].defaultConsumerIds)
      .toEqual(['ghost', 'minutes']);
  });

  it('maps store outcomes: 409 conflict / 422 fieldErrors passthrough / 503', async () => {
    const failures: Array<[Parameters<typeof makeDeps>[0]['updateCatalog'], number]> = [
      [vi.fn(async () => ({ ok: false as const, reason: 'config_conflict' as const })), 409],
      [vi.fn(async () => ({
        ok: false as const,
        reason: 'validation_failed' as const,
        fieldErrors: [{ path: 'defaultConsumerIds', message: '未知 id' }],
      })), 422],
      [vi.fn(async () => ({ ok: false as const, reason: 'config_unavailable' as const })), 503],
    ];
    for (const [updateCatalog, status] of failures) {
      const deps = makeDeps({ updateCatalog });
      const out = await handleVcMeetingConsumerProfilesPut(putRequest(), deps);
      expect(out.status).toBe(status);
      if (status === 422 && out.status === 422) {
        expect(out.body.fieldErrors).toEqual([{ path: 'defaultConsumerIds', message: '未知 id' }]);
      }
      expect(deps.reloadDaemons).not.toHaveBeenCalled();
    }
  });

  // 共享目录走 daemon 侧 mtime 缓存的 live 读，下一个会议事件自然生效：
  // 只保存预设时不该给任何 daemon 发 reload。
  it('success returns the fresh snapshot and reloads nobody when only the catalog changed', async () => {
    const deps = makeDeps();
    const out = await handleVcMeetingConsumerProfilesPut(putRequest(), deps);
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    expect(out.body.revision).toBe('sha256:rev2');
    expect(deps.reloadDaemons).toHaveBeenCalledWith([]);
  });

  it('reload failure does not fail the PUT (config already persisted)', async () => {
    const deps = makeDeps({ reloadDaemons: vi.fn(async () => { throw new Error('ipc down'); }) });
    const out = await handleVcMeetingConsumerProfilesPut(putRequest(), deps);
    expect(out.status).toBe(200);
  });

  it('applies per-bot output-policy patches through the locked RMW dep and reloads those bots', async () => {
    const deps = makeDeps();
    const out = await handleVcMeetingConsumerProfilesPut(putRequest({
      botOutputPolicies: [{
        appId: 'app_agent',
        vcEnabled: false,
        textOutputPolicy: 'approval',
        voiceOutputPolicy: null,
        realtimeVoiceEnabled: true,
      }],
    }), deps);
    expect(out.status).toBe(200);
    expect(deps.applyBotOutputPolicy).toHaveBeenCalledWith({
      appId: 'app_agent',
      vcEnabled: false,
      textOutputPolicy: 'approval',
      voiceOutputPolicy: null,
      realtimeVoiceEnabled: true,
      catalogDefaultConsumerId: null,
    });
    expect(deps.reloadDaemons).toHaveBeenCalledWith(['app_agent']);
  });

  // 老客户端不发 vcEnabled：缺省必须是「保持接收」，绝不能被解释成关掉这个 bot。
  it('defaults a missing vcEnabled to true instead of silently disabling the bot', async () => {
    const deps = makeDeps();
    await handleVcMeetingConsumerProfilesPut(putRequest({
      botOutputPolicies: [{
        appId: 'app_agent',
        textOutputPolicy: null,
        voiceOutputPolicy: null,
        realtimeVoiceEnabled: false,
      }],
    }), deps);
    expect(deps.applyBotOutputPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app_agent', vcEnabled: true }),
    );
  });

  it('422 rejects a non-boolean vcEnabled before writing anything', async () => {
    const deps = makeDeps();
    const out = await handleVcMeetingConsumerProfilesPut(putRequest({
      botOutputPolicies: [{
        appId: 'app_agent',
        vcEnabled: 'yes',
        textOutputPolicy: null,
        voiceOutputPolicy: null,
        realtimeVoiceEnabled: false,
      }],
    }), deps);
    expect(out.status).toBe(422);
    if (out.status !== 422) return;
    expect(out.body.fieldErrors?.map(err => err.path)).toEqual(['botOutputPolicies[0].vcEnabled']);
    expect(deps.updateCatalog).not.toHaveBeenCalled();
    expect(deps.applyBotOutputPolicy).not.toHaveBeenCalled();
  });

  it('422 rejects unknown appId / bad policy values in botOutputPolicies before writing anything', async () => {
    const deps = makeDeps();
    const out = await handleVcMeetingConsumerProfilesPut(putRequest({
      botOutputPolicies: [
        { appId: 'app_ghost', textOutputPolicy: 'allow', voiceOutputPolicy: null, realtimeVoiceEnabled: false },
        { appId: 'app_agent', textOutputPolicy: 'shout', voiceOutputPolicy: null, realtimeVoiceEnabled: false },
      ],
    }), deps);
    expect(out.status).toBe(422);
    if (out.status !== 422) return;
    expect(out.body.fieldErrors?.map(err => err.path)).toEqual([
      'botOutputPolicies[0].appId',
      'botOutputPolicies[1].textOutputPolicy',
    ]);
    expect(deps.updateCatalog).not.toHaveBeenCalled();
    expect(deps.applyBotOutputPolicy).not.toHaveBeenCalled();
  });

  it('503 bot_policy_write_failed when the locked RMW write fails (snapshot already committed, UI re-GETs)', async () => {
    const deps = makeDeps({
      applyBotOutputPolicy: vi.fn(async () => ({ ok: false, reason: 'bot_not_in_config' })),
    });
    const out = await handleVcMeetingConsumerProfilesPut(putRequest({
      botOutputPolicies: [{
        appId: 'app_agent',
        vcEnabled: true,
        textOutputPolicy: null,
        voiceOutputPolicy: 'deny',
        realtimeVoiceEnabled: false,
      }],
    }), deps);
    expect(out.status).toBe(503);
    if (out.status !== 503) return;
    expect(out.body.error).toBe('bot_policy_write_failed');
    // Reload still ran so daemons converge on whatever actually landed.
    expect(deps.reloadDaemons).toHaveBeenCalledWith(['app_agent']);
  });

  it('agent options expose configured + effective output policies (realtime voice on by default)', () => {
    const bot = {
      larkAppId: 'app_agent',
      cliId: 'claude',
      vcMeetingAgent: {
        meetingConsumer: { textOutputPolicy: 'approval' },
        realtimeVoice: { enabled: true },
      },
    } as unknown as BotConfig;
    const deps = makeDeps({ loadBotConfigs: vi.fn(() => [bot]) });
    const [option] = buildVcMeetingAgentOptions(deps);
    expect(option).toMatchObject({
      textOutputPolicy: 'approval',
      voiceOutputPolicy: null,
      realtimeVoiceEnabled: true,
      effectiveTextOutputPolicy: 'approval',
      effectiveVoiceOutputPolicy: 'allow',
    });
  });

  it('an explicit realtimeVoice.enabled=false opts a bot out (voice denied)', () => {
    const bot = {
      larkAppId: 'app_agent',
      cliId: 'claude',
      vcMeetingAgent: { realtimeVoice: { enabled: false } },
    } as unknown as BotConfig;
    const deps = makeDeps({ loadBotConfigs: vi.fn(() => [bot]) });
    const [option] = buildVcMeetingAgentOptions(deps);
    expect(option).toMatchObject({
      realtimeVoiceEnabled: false,
      effectiveVoiceOutputPolicy: 'deny',
    });
  });
});
