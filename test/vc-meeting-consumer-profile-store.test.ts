import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class FakeClient {},
}));

async function freshModules() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const store = await import('../src/services/vc-meeting-consumer-profile-store.js');
  registry.loadBotConfigs();
  return { registry, store };
}

describe('vc meeting consumer profile store', () => {
  let configPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-vc-profile-store-'));
    configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
  });

  afterEach(() => {
    delete process.env.BOTS_CONFIG;
  });

  function writeConfig(entry: Record<string, unknown> = {}): void {
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'cli_listener',
      larkAppSecret: 'keep-secret',
      cliId: 'claude-code',
      workingDir: '/tmp',
      marker: { keep: true },
      vcMeetingAgent: {
        enabled: true,
        larkCliProfile: 'listener-profile',
        meetingConsumer: {
          enabled: true,
          injectIntervalMs: 30_000,
        },
      },
      ...entry,
    }], null, 2), 'utf8');
  }

  function readRaw(): any {
    return JSON.parse(readFileSync(configPath, 'utf8'))[0];
  }

  function minutesProfile(instructions = '只记录明确决策。') {
    return {
      id: 'minutes',
      agentAppId: 'cli_agent',
      label: '会议纪要',
      role: 'minutes',
      instructions,
      responseMode: 'listener_thread' as const,
      capabilities: ['meeting.read', 'listener.output.request'],
    };
  }

  it('reads a never-initialized config separately from an explicit empty catalog', async () => {
    writeConfig();
    const { store } = await freshModules();
    const snapshot = await store.readVcMeetingConsumerProfiles('cli_listener');
    expect(snapshot).toMatchObject({
      listenerBotAppId: 'cli_listener',
      catalogState: 'uninitialized',
      defaultMode: 'listenOnly',
      defaultConsumerIds: [],
      profiles: [],
    });
    expect(snapshot?.revision).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('treats an explicitly persisted listen-only mode as operator-owned state', async () => {
    writeConfig({
      vcMeetingAgent: {
        enabled: true,
        meetingConsumer: {
          enabled: true,
          defaultMode: 'listenOnly',
        },
      },
    });
    const { store } = await freshModules();
    expect(await store.readVcMeetingConsumerProfiles('cli_listener')).toMatchObject({
      catalogState: 'legacy_or_partial',
      defaultMode: 'listenOnly',
      defaultConsumerIds: [],
      profiles: [],
    });
  });

  it('atomically enters profile mode while preserving secrets and unrelated VC fields', async () => {
    writeConfig({
      vcMeetingAgent: {
        enabled: true,
        larkCliProfile: 'listener-profile',
        meetingConsumer: {
          enabled: true,
          injectIntervalMs: 30_000,
          defaultMode: 'agent',
          defaultAgentAppId: 'cli_old',
          agentCandidates: ['cli_old'],
        },
      },
    });
    const { store } = await freshModules();
    const before = await store.readVcMeetingConsumerProfiles('cli_listener');
    expect(before).toBeDefined();
    const result = await store.updateVcMeetingConsumerProfiles('cli_listener', {
      expectedRevision: before!.revision,
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes'],
      profiles: [minutesProfile('  第一行\r\n第二行  ')],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.profiles[0]?.instructions).toBe('第一行\n第二行');
    expect(result.snapshot.defaultMode).toBe('agents');
    const raw = readRaw();
    expect(raw.larkAppSecret).toBe('keep-secret');
    expect(raw.marker).toEqual({ keep: true });
    expect(raw.vcMeetingAgent.larkCliProfile).toBe('listener-profile');
    expect(raw.vcMeetingAgent.meetingConsumer.injectIntervalMs).toBe(30_000);
    expect(raw.vcMeetingAgent.meetingConsumer.defaultAgentAppId).toBeUndefined();
    expect(raw.vcMeetingAgent.meetingConsumer.agentCandidates).toBeUndefined();
  });

  it('detects a hand edit through the canonical expected revision', async () => {
    writeConfig();
    const { store } = await freshModules();
    const before = await store.readVcMeetingConsumerProfiles('cli_listener');
    const raw = readRaw();
    raw.vcMeetingAgent.meetingConsumer.injectIntervalMs = 45_000;
    writeFileSync(configPath, JSON.stringify([raw], null, 2), 'utf8');
    const result = await store.updateVcMeetingConsumerProfiles('cli_listener', {
      expectedRevision: before!.revision,
      defaultMode: 'listenOnly',
      defaultConsumerIds: [],
      profiles: [minutesProfile()],
    });
    expect(result).toEqual({ ok: false, reason: 'config_conflict' });
  });

  it('detects a concurrent raw-only legacy opt-out that normalization would drop', async () => {
    writeConfig();
    const { store } = await freshModules();
    const before = await store.readVcMeetingConsumerProfiles('cli_listener');
    const raw = readRaw();
    raw.vcMeetingAgent.meetingConsumer.agentCandidates = [];
    writeFileSync(configPath, JSON.stringify([raw], null, 2), 'utf8');

    const result = await store.updateVcMeetingConsumerProfiles('cli_listener', {
      expectedRevision: before!.revision,
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes'],
      profiles: [minutesProfile()],
    });
    expect(result).toEqual({ ok: false, reason: 'config_conflict' });
    expect(readRaw().vcMeetingAgent.meetingConsumer.agentCandidates).toEqual([]);
  });

  it('clears generator provenance on an explicit profile save', async () => {
    const profile = minutesProfile();
    writeConfig({
      vcMeetingAgent: {
        enabled: true,
        meetingConsumer: {
          enabled: true,
          defaultMode: 'agents',
          defaultConsumerIds: ['minutes'],
          consumerProfiles: [profile],
          defaultProfileBootstrap: {
            generatorVersion: 1,
            profileId: 'minutes',
            configHash: `sha256:${'a'.repeat(64)}`,
          },
        },
      },
    });
    const { store } = await freshModules();
    const before = await store.readVcMeetingConsumerProfiles('cli_listener');
    expect(before?.defaultProfileBootstrap?.profileId).toBe('minutes');
    const result = await store.updateVcMeetingConsumerProfiles('cli_listener', {
      expectedRevision: before!.revision,
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes'],
      profiles: [profile],
    });
    expect(result.ok).toBe(true);
    expect(readRaw().vcMeetingAgent.meetingConsumer.defaultProfileBootstrap).toBeUndefined();
    if (result.ok) expect(result.snapshot.defaultProfileBootstrap).toBeUndefined();
  });

  it('offers an explicit default activation only for the exact legacy generated seed', async () => {
    const legacyProfile = {
      id: 'minutes',
      agentAppId: 'cli_agent',
      label: '会议纪要',
      role: 'minutes',
      instructions: '持续整理会议纪要，重点记录已确认的决策、待办事项（含负责人和截止时间）以及未解决风险；字幕修订时更新已有条目，不重复记录同一事项。',
      responseMode: 'silent',
      capabilities: ['meeting.read'],
    };
    writeConfig({
      vcMeetingAgent: {
        enabled: true,
        meetingConsumer: {
          enabled: true,
          injectIntervalMs: 30_000,
          defaultMode: 'listenOnly',
          consumerProfiles: [legacyProfile],
        },
      },
    });
    const { store } = await freshModules();
    expect((await store.readVcMeetingConsumerProfiles('cli_listener'))?.migrationOffer)
      .toBe('enable_seeded_minutes_default');

    const raw = readRaw();
    raw.vcMeetingAgent.meetingConsumer.consumerProfiles[0].label = '我的纪要';
    writeFileSync(configPath, JSON.stringify([raw], null, 2), 'utf8');
    expect((await store.readVcMeetingConsumerProfiles('cli_listener'))?.migrationOffer)
      .toBeUndefined();
  });

  it('returns a DTO field path for invalid instructions and does not write', async () => {
    writeConfig();
    const { store } = await freshModules();
    const before = await store.readVcMeetingConsumerProfiles('cli_listener');
    const result = await store.updateVcMeetingConsumerProfiles('cli_listener', {
      expectedRevision: before!.revision,
      defaultMode: 'listenOnly',
      defaultConsumerIds: [],
      profiles: [minutesProfile('bad\u0000prompt')],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('validation_failed');
    expect(result.fieldErrors?.[0]?.path).toBe('profiles[0].instructions');
    expect(readRaw().vcMeetingAgent.meetingConsumer.consumerProfiles).toBeUndefined();
  });

  it('validates conflicts in the default selection but permits alternatives in the catalog', async () => {
    writeConfig();
    const { store } = await freshModules();
    const before = await store.readVcMeetingConsumerProfiles('cli_listener');
    const speakers = ['speaker-a', 'speaker-b'].map((id, index) => ({
      id,
      agentAppId: `cli_speaker_${index}`,
      role: id,
      responseMode: 'silent' as const,
      capabilities: ['meeting.read', 'meeting.output.request'],
      ownedSinks: ['meeting_text' as const],
    }));
    const alternatives = await store.updateVcMeetingConsumerProfiles('cli_listener', {
      expectedRevision: before!.revision,
      defaultMode: 'listenOnly',
      defaultConsumerIds: [],
      profiles: speakers,
    });
    expect(alternatives.ok).toBe(true);
    if (!alternatives.ok) return;
    const conflict = await store.updateVcMeetingConsumerProfiles('cli_listener', {
      expectedRevision: alternatives.snapshot.revision,
      defaultMode: 'agents',
      defaultConsumerIds: ['speaker-a', 'speaker-b'],
      profiles: speakers,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.reason).toBe('validation_failed');
      expect(conflict.fieldErrors?.[0]?.path).toBe('defaultConsumerIds');
    }
  });

  it('keeps an explicit empty catalog in listen-only mode', async () => {
    writeConfig();
    const { store } = await freshModules();
    const before = await store.readVcMeetingConsumerProfiles('cli_listener');
    const result = await store.updateVcMeetingConsumerProfiles('cli_listener', {
      expectedRevision: before!.revision,
      defaultMode: 'listenOnly',
      defaultConsumerIds: [],
      profiles: [],
    });
    expect(result.ok).toBe(true);
    expect(readRaw().vcMeetingAgent.meetingConsumer.consumerProfiles).toEqual([]);
    expect(readRaw().vcMeetingAgent.meetingConsumer.defaultMode).toBe('listenOnly');
    if (result.ok) expect(result.snapshot.catalogState).toBe('explicit_empty');
  });

  it.each([
    ['empty legacy alias', { agentCandidates: [] }],
    ['legacy default', { defaultAgentAppId: 'cli_agent' }],
    ['legacy mode', { defaultMode: 'agent' }],
    ['partial profile ids', { defaultConsumerIds: [] }],
    ['partial agents mode', { defaultMode: 'agents' }],
  ])('classifies %s from raw own-properties', async (_name, policy) => {
    writeConfig({
      vcMeetingAgent: {
        enabled: true,
        meetingConsumer: { enabled: true, ...policy },
      },
    });
    const { store } = await freshModules();
    expect((await store.readVcMeetingConsumerProfiles('cli_listener'))?.catalogState)
      .toBe('legacy_or_partial');
  });

  it.each([
    {
      name: 'unknown default id',
      defaultConsumerIds: ['missing'],
      profiles: [] as ReturnType<typeof minutesProfile>[],
    },
    {
      name: 'duplicate default id',
      defaultConsumerIds: ['minutes', 'minutes'],
      profiles: [minutesProfile()],
    },
    {
      name: 'empty agents default',
      defaultConsumerIds: [],
      profiles: [minutesProfile()],
    },
  ])('rejects $name instead of silently changing the submitted policy', async ({ defaultConsumerIds, profiles }) => {
    writeConfig();
    const { store } = await freshModules();
    const before = await store.readVcMeetingConsumerProfiles('cli_listener');
    const result = await store.updateVcMeetingConsumerProfiles('cli_listener', {
      expectedRevision: before!.revision,
      defaultMode: 'agents',
      defaultConsumerIds,
      profiles,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('validation_failed');
    expect(readRaw().vcMeetingAgent.meetingConsumer.consumerProfiles).toBeUndefined();
  });
});
