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
  VcMeetingAgentOptionDto,
  VcMeetingConsumerProfileDto,
  VcMeetingConsumerProfilesApiDeps,
  VcMeetingPermissionPreset,
} from '../src/dashboard/vc-consumer-profiles-api.js';
import {
  seedVcMeetingDefaultConsumerProfile,
  selectVcMeetingDefaultConsumerAgent,
} from '../src/services/vc-meeting-consumer-profile-bootstrap.js';
import type { VcMeetingConsumerProfileConfig } from '../src/types.js';
import type { VcMeetingConsumerProfilesSnapshot } from '../src/services/vc-meeting-consumer-profile-store.js';
import type { BotConfig } from '../src/bot-registry.js';

const READ = 'meeting.read';
const OUTPUT = 'meeting.output.request';
const LISTENER = 'listener.output.request';

function canonical(over: Partial<VcMeetingConsumerProfileConfig> = {}): VcMeetingConsumerProfileConfig {
  return {
    id: 'minutes',
    agentAppId: 'app_agent',
    role: 'minutes',
    responseMode: 'silent',
    capabilities: [READ],
    ...over,
  };
}

function dto(over: Partial<VcMeetingConsumerProfileDto> = {}): VcMeetingConsumerProfileDto {
  return {
    id: 'minutes',
    agentAppId: 'app_agent',
    responseMode: 'silent',
    permissionPreset: 'observe_only',
    ...over,
  };
}

describe('deriveVcMeetingPermissionPreset', () => {
  const cases: Array<[VcMeetingPermissionPreset, VcMeetingConsumerProfileConfig]> = [
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
      dto({ id: 'b', agentAppId: '' }),
      dto({ id: 'c', responseMode: 'broadcast' as never }),
      dto({ id: 'd', permissionPreset: 'root' as never }),
      dto({ id: 'e', activityTypes: ['transcript_received', 'nope'] }),
      dto({ id: 'f', instructions: 42 as never }),
    ], []);
    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.fieldErrors.map(e => e.path)).toEqual([
      'profiles[0].id',
      'profiles[1].agentAppId',
      'profiles[2].responseMode',
      'profiles[3].permissionPreset',
      'profiles[4].activityTypes',
      'profiles[5].instructions',
    ]);
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

function snapshot(over: Partial<VcMeetingConsumerProfilesSnapshot> = {}): VcMeetingConsumerProfilesSnapshot {
  return {
    listenerBotAppId: 'app_listener',
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
    readSnapshot: vi.fn(async () => snapshot()),
    updateSnapshot: vi.fn(async (_id, input) => ({
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
    managedSideEffectIsolation: vi.fn(() => true),
    reloadDaemons: vi.fn(async () => {}),
    ...over,
  };
}

function putRequest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listenerBotAppId: 'app_listener',
    expectedRevision: 'sha256:rev1',
    defaultMode: 'listenOnly',
    defaultConsumerIds: [],
    profiles: [dto()],
    ...over,
  };
}

describe('buildVcMeetingAgentOptions', () => {
  it('maps registry bots to the isolation-aware option DTO (listener not excluded)', () => {
    const deps = makeDeps();
    expect(buildVcMeetingAgentOptions(deps)).toEqual([{
      appId: 'app_agent',
      label: 'Agent A',
      cliId: 'claude',
      online: true,
      workingDirReady: true,
      reliableTurnTerminal: true,
      managedSideEffectIsolation: true,
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
      managedSideEffectIsolation: true,
    }]);
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
});

function agentOption(
  appId: string,
  over: Partial<VcMeetingAgentOptionDto> = {},
): VcMeetingAgentOptionDto {
  return {
    appId,
    label: appId,
    online: true,
    workingDirReady: true,
    reliableTurnTerminal: true,
    managedSideEffectIsolation: true,
    ...over,
  };
}

describe('default VC consumer profile bootstrap', () => {
  it('selects an eligible explicit preference, then listener self, then lexical external fallback', () => {
    const options = [agentOption('app_z'), agentOption('app_listener'), agentOption('app_a')];
    expect(selectVcMeetingDefaultConsumerAgent('app_listener', options, ['app_z'])?.appId).toBe('app_z');
    expect(selectVcMeetingDefaultConsumerAgent('app_listener', options)?.appId).toBe('app_listener');
    expect(selectVcMeetingDefaultConsumerAgent('missing_listener', options)?.appId).toBe('app_a');
  });

  it('requires structural readiness but ignores transient online state', () => {
    const options = [
      agentOption('app_no_dir', { workingDirReady: false }),
      agentOption('app_no_terminal', { reliableTurnTerminal: false }),
      agentOption('app_no_isolation', { managedSideEffectIsolation: false }),
      agentOption('app_offline_ready', { online: false }),
    ];
    expect(selectVcMeetingDefaultConsumerAgent('app_no_dir', options)?.appId)
      .toBe('app_offline_ready');
    expect(selectVcMeetingDefaultConsumerAgent('x', options.slice(0, 3))).toBeUndefined();
  });

  it('seeds a visible full-capability minutes profile on the first enable', () => {
    const meetingConsumer: Record<string, unknown> = {
      enabled: true,
      injectIntervalMs: 30_000,
    };
    expect(seedVcMeetingDefaultConsumerProfile(
      meetingConsumer,
      'app_listener',
      [agentOption('app_z'), agentOption('app_listener')],
    )).toBe(true);
    expect(meetingConsumer).toMatchObject({
      enabled: true,
      injectIntervalMs: 30_000,
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes'],
      consumerProfiles: [{
        id: 'minutes',
        agentAppId: 'app_listener',
        label: '会议纪要',
        role: 'minutes',
        responseMode: 'listener_thread',
        capabilities: ['listener.output.request', 'meeting.output.request', 'meeting.read'],
        ownedSinks: ['meeting_text', 'meeting_voice'],
      }],
    });
    expect((meetingConsumer.consumerProfiles as Array<Record<string, unknown>>)[0]?.instructions)
      .toContain('无实质增量时保持静默');
    expect(meetingConsumer.defaultProfileBootstrap).toMatchObject({
      generatorVersion: 2,
      profileId: 'minutes',
    });
  });

  it('does not seed without a structurally eligible agent', () => {
    const meetingConsumer: Record<string, unknown> = { enabled: true };
    expect(seedVcMeetingDefaultConsumerProfile(
      meetingConsumer,
      'app_listener',
      [agentOption('app_listener', { reliableTurnTerminal: false })],
    )).toBe(false);
    expect(meetingConsumer).toEqual({ enabled: true });
  });

  it.each([
    ['an explicit empty catalog', { consumerProfiles: [] }],
    ['an existing catalog', { consumerProfiles: [{ id: 'existing' }] }],
    ['legacy defaultAgentAppId', { defaultAgentAppId: 'app_old' }],
    ['legacy defaultAgent alias', { defaultAgent: 'app_old' }],
    ['legacy candidate list', { agentCandidates: [] }],
    ['legacy agents alias', { agents: [] }],
    ['legacy agent mode', { defaultMode: 'agent' }],
    ['an explicit listen-only mode', { defaultMode: 'listenOnly' }],
    ['an incomplete profile default', { defaultMode: 'agents' }],
    ['explicit profile ids', { defaultConsumerIds: [] }],
  ])('preserves %s instead of implicitly migrating it', (_name, existing) => {
    const meetingConsumer: Record<string, unknown> = { enabled: true, ...existing };
    const before = structuredClone(meetingConsumer);
    expect(seedVcMeetingDefaultConsumerProfile(
      meetingConsumer,
      'app_listener',
      [agentOption('app_listener')],
    )).toBe(false);
    expect(meetingConsumer).toEqual(before);
  });
});

describe('handleVcMeetingConsumerProfilesGet', () => {
  it('400 on empty listenerBotAppId', async () => {
    const out = await handleVcMeetingConsumerProfilesGet('  ', makeDeps());
    expect(out.status).toBe(400);
  });

  it('404 when bot missing, 503 when config unreadable', async () => {
    expect((await handleVcMeetingConsumerProfilesGet(
      'x', makeDeps({ readSnapshot: vi.fn(async () => undefined) }),
    )).status).toBe(404);
    expect((await handleVcMeetingConsumerProfilesGet(
      'x', makeDeps({ readSnapshot: vi.fn(async () => { throw new Error('io'); }) }),
    )).status).toBe(503);
  });

  it('200 returns DTO profiles + agentOptions + revision', async () => {
    const out = await handleVcMeetingConsumerProfilesGet('app_listener', makeDeps());
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    expect(out.body.revision).toBe('sha256:rev1');
    expect(out.body.catalogState).toBe('profiles');
    expect(out.body.profiles).toEqual([dto()]);
    expect(out.body.agentOptions[0]?.appId).toBe('app_agent');
  });

  it('GET exposes an explicit legacy-seed migration offer without mutating config', async () => {
    const deps = makeDeps({
      readSnapshot: vi.fn(async () => snapshot({
        migrationOffer: 'enable_seeded_minutes_default',
      })),
    });
    const out = await handleVcMeetingConsumerProfilesGet('app_listener', deps);
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    expect(out.body.migrationOffer).toBe('enable_seeded_minutes_default');
    expect(deps.updateSnapshot).not.toHaveBeenCalled();
  });
});

describe('handleVcMeetingConsumerProfilesPut', () => {
  it('400 on non-object payload / missing appId / missing revision', async () => {
    const deps = makeDeps();
    for (const payload of [null, 'x', [1]]) {
      expect((await handleVcMeetingConsumerProfilesPut(payload, deps)).status).toBe(400);
    }
    expect((await handleVcMeetingConsumerProfilesPut(
      putRequest({ listenerBotAppId: ' ' }), deps,
    )).body).toMatchObject({ error: 'listenerBotAppId_required' });
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
    expect(deps.updateSnapshot).not.toHaveBeenCalled();
  });

  it('422 on DTO mapping failure without touching the store', async () => {
    const deps = makeDeps();
    const out = await handleVcMeetingConsumerProfilesPut(
      putRequest({ profiles: [dto({ id: 'fresh', permissionPreset: 'custom' })] }), deps,
    );
    expect(out.status).toBe(422);
    expect(out.status === 422 && out.body.fieldErrors?.[0]?.path).toBe('profiles[0].permissionPreset');
    expect(deps.updateSnapshot).not.toHaveBeenCalled();
  });

  it('custom reuse maps from the CURRENT stored policy of the same id', async () => {
    const stored = canonical({ capabilities: [LISTENER, OUTPUT, READ], ownedSinks: ['meeting_text'] });
    const deps = makeDeps({ readSnapshot: vi.fn(async () => snapshot({ profiles: [stored] })) });
    const out = await handleVcMeetingConsumerProfilesPut(
      putRequest({ profiles: [dto({ permissionPreset: 'custom' })] }), deps,
    );
    expect(out.status).toBe(200);
    const sent = vi.mocked(deps.updateSnapshot).mock.calls[0][1];
    expect(sent.profiles[0].capabilities).toEqual([LISTENER, OUTPUT, READ]);
    expect(sent.profiles[0].ownedSinks).toEqual(['meeting_text']);
  });

  it('passes defaultConsumerIds verbatim — no silent filtering (store is the authority)', async () => {
    const deps = makeDeps();
    await handleVcMeetingConsumerProfilesPut(
      putRequest({ defaultMode: 'agents', defaultConsumerIds: ['ghost', 'minutes'] }), deps,
    );
    expect(vi.mocked(deps.updateSnapshot).mock.calls[0][1].defaultConsumerIds)
      .toEqual(['ghost', 'minutes']);
  });

  it('maps store outcomes: 409 conflict / 422 fieldErrors passthrough / 404 / 503', async () => {
    const failures: Array<[Parameters<typeof makeDeps>[0]['updateSnapshot'], number]> = [
      [vi.fn(async () => ({ ok: false as const, reason: 'config_conflict' as const })), 409],
      [vi.fn(async () => ({
        ok: false as const,
        reason: 'validation_failed' as const,
        fieldErrors: [{ path: 'defaultConsumerIds', message: '未知 id' }],
      })), 422],
      [vi.fn(async () => ({ ok: false as const, reason: 'bot_not_in_config' as const })), 404],
      [vi.fn(async () => ({ ok: false as const, reason: 'config_unavailable' as const })), 503],
    ];
    for (const [updateSnapshot, status] of failures) {
      const deps = makeDeps({ updateSnapshot });
      const out = await handleVcMeetingConsumerProfilesPut(putRequest(), deps);
      expect(out.status).toBe(status);
      if (status === 422 && out.status === 422) {
        expect(out.body.fieldErrors).toEqual([{ path: 'defaultConsumerIds', message: '未知 id' }]);
      }
      expect(deps.reloadDaemons).not.toHaveBeenCalled();
    }
  });

  it('success returns the fresh snapshot and hot-reloads the listener daemon', async () => {
    const deps = makeDeps();
    const out = await handleVcMeetingConsumerProfilesPut(putRequest(), deps);
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    expect(out.body.revision).toBe('sha256:rev2');
    expect(deps.reloadDaemons).toHaveBeenCalledWith(['app_listener']);
  });

  it('reload failure does not fail the PUT (config already persisted)', async () => {
    const deps = makeDeps({ reloadDaemons: vi.fn(async () => { throw new Error('ipc down'); }) });
    const out = await handleVcMeetingConsumerProfilesPut(putRequest(), deps);
    expect(out.status).toBe(200);
  });
});
