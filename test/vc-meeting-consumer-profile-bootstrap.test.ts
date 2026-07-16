import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class FakeClient {},
}));

const structuralDeps = {
  workingDirReady: (bot: { workingDir?: string }) => !!bot.workingDir,
  reliableTurnTerminal: (bot: { cliId?: string }) => bot.cliId === 'claude-code',
  managedSideEffectIsolation: () => true,
};

async function freshModules() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const bootstrap = await import('../src/services/vc-meeting-consumer-profile-bootstrap.js');
  registry.loadBotConfigs();
  return { registry, bootstrap };
}

function bot(
  larkAppId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    larkAppId,
    larkAppSecret: `secret-${larkAppId}`,
    cliId: 'claude-code',
    workingDir: `/work/${larkAppId}`,
    ...over,
  };
}

describe('lock-protected default VC consumer profile bootstrap', () => {
  let configDir: string;
  let configPath: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'botmux-vc-profile-bootstrap-'));
    configPath = join(configDir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
  });

  afterEach(() => {
    delete process.env.BOTS_CONFIG;
    rmSync(configDir, { recursive: true, force: true });
  });

  function writeConfig(entries: Record<string, unknown>[]): void {
    writeFileSync(configPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  }

  function readConfig(): any[] {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  }

  function listener(consumer: Record<string, unknown> = { enabled: true }): Record<string, unknown> {
    return bot('listener', {
      vcMeetingAgent: {
        enabled: true,
        larkCliProfile: 'listener',
        meetingConsumer: consumer,
      },
    });
  }

  it('materializes an enabled minutes default on the eligible listener and remains parser-valid', async () => {
    writeConfig([listener({ enabled: true, injectIntervalMs: 30_000 }), bot('agent_z'), bot('agent_a')]);
    const { registry, bootstrap } = await freshModules();

    const first = await bootstrap.bootstrapVcMeetingDefaultConsumerProfile('listener', structuralDeps);
    expect(first).toEqual({ ok: true, seeded: true, agentAppId: 'listener' });
    const raw = readConfig();
    expect(raw[0].vcMeetingAgent.meetingConsumer).toMatchObject({
      enabled: true,
      injectIntervalMs: 30_000,
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes'],
      defaultProfileBootstrap: {
        generatorVersion: 2,
        profileId: 'minutes',
        configHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
      consumerProfiles: [{
        id: 'minutes',
        agentAppId: 'listener',
        label: '会议纪要',
        role: 'minutes',
        responseMode: 'listener_thread',
        capabilities: ['listener.output.request', 'meeting.output.request', 'meeting.read'],
        ownedSinks: ['meeting_text', 'meeting_voice'],
      }],
    });
    expect(raw[0].vcMeetingAgent.meetingConsumer.consumerProfiles[0].instructions)
      .toContain('无实质增量时保持静默');
    const consumer = raw[0].vcMeetingAgent.meetingConsumer;
    expect(consumer.defaultProfileBootstrap.configHash).toBe(
      bootstrap.computeVcMeetingDefaultConsumerProfileConfigHash({
        defaultMode: consumer.defaultMode,
        defaultConsumerIds: consumer.defaultConsumerIds,
        profile: consumer.consumerProfiles[0],
      }),
    );
    expect(bootstrap.isVcMeetingDefaultConsumerProfileBootstrapIntact(consumer)).toBe(true);
    expect(registry.loadBotConfigs()[0].vcMeetingAgent?.meetingConsumer?.consumerProfiles?.[0]?.agentAppId)
      .toBe('listener');
    expect(registry.loadBotConfigs()[0].vcMeetingAgent?.meetingConsumer?.defaultConsumerIds)
      .toEqual(['minutes']);
    expect(registry.loadBotConfigs()[0].vcMeetingAgent?.meetingConsumer?.defaultProfileBootstrap)
      .toEqual(consumer.defaultProfileBootstrap);

    const second = await bootstrap.bootstrapVcMeetingDefaultConsumerProfile('listener', structuralDeps);
    expect(second).toEqual({ ok: true, seeded: false, reason: 'already_initialized' });
    expect(readConfig()).toEqual(raw);
  });

  it('detects generator-owned drift while ignoring operator-owned fields', async () => {
    writeConfig([listener()]);
    const { bootstrap } = await freshModules();
    expect(await bootstrap.bootstrapVcMeetingDefaultConsumerProfile('listener', structuralDeps))
      .toMatchObject({ ok: true, seeded: true });
    const consumer = readConfig()[0].vcMeetingAgent.meetingConsumer;

    const operatorOnlyChange = structuredClone(consumer);
    operatorOnlyChange.injectIntervalMs = 45_000;
    expect(bootstrap.isVcMeetingDefaultConsumerProfileBootstrapIntact(operatorOnlyChange)).toBe(true);

    for (const mutate of [
      (value: any) => { value.defaultMode = 'listenOnly'; },
      (value: any) => { value.defaultConsumerIds = []; },
      (value: any) => { value.consumerProfiles[0].instructions += ' changed'; },
      (value: any) => { value.defaultProfileBootstrap.generatorVersion = 1; },
    ]) {
      const changed = structuredClone(consumer);
      mutate(changed);
      expect(bootstrap.isVcMeetingDefaultConsumerProfileBootstrapIntact(changed)).toBe(false);
    }
  });

  it('upgrades an untouched single-profile v1 seed in place and preserves its agent', async () => {
    writeConfig([listener()]);
    const { bootstrap } = await freshModules();
    const profileV1 = {
      id: 'minutes',
      agentAppId: 'retained-agent',
      label: '会议纪要',
      role: 'minutes',
      instructions: '持续整理会议纪要，重点记录已确认的决策、待办事项（含负责人和截止时间）以及未解决风险；字幕修订时更新已有条目，不重复记录同一事项。',
      responseMode: 'silent',
      capabilities: ['meeting.read'],
    };
    const consumerV1 = {
      enabled: true,
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes'],
      consumerProfiles: [profileV1],
      defaultProfileBootstrap: {
        generatorVersion: 1,
        profileId: 'minutes',
        configHash: bootstrap.computeVcMeetingDefaultConsumerProfileConfigHash({
          defaultMode: 'agents',
          defaultConsumerIds: ['minutes'],
          profile: profileV1,
        }),
      },
    };
    writeConfig([listener(consumerV1)]);

    expect(await bootstrap.bootstrapVcMeetingDefaultConsumerProfile('listener', structuralDeps))
      .toEqual({ ok: true, seeded: true, agentAppId: 'retained-agent' });
    const upgraded = readConfig()[0].vcMeetingAgent.meetingConsumer;
    expect(upgraded.defaultProfileBootstrap.generatorVersion).toBe(2);
    expect(upgraded.consumerProfiles).toEqual([expect.objectContaining({
      id: 'minutes',
      agentAppId: 'retained-agent',
      responseMode: 'listener_thread',
      capabilities: ['listener.output.request', 'meeting.output.request', 'meeting.read'],
      ownedSinks: ['meeting_text', 'meeting_voice'],
    })]);
    expect(bootstrap.isVcMeetingDefaultConsumerProfileBootstrapIntact(upgraded)).toBe(true);
    const afterUpgrade = readConfig();
    expect(await bootstrap.bootstrapVcMeetingDefaultConsumerProfile('listener', structuralDeps))
      .toEqual({ ok: true, seeded: false, reason: 'already_initialized' });
    expect(readConfig()).toEqual(afterUpgrade);
  });

  it('does not auto-escalate a v1 marker with drift or extra operator profiles', async () => {
    writeConfig([listener()]);
    const { bootstrap } = await freshModules();
    const profileV1 = {
      id: 'minutes',
      agentAppId: 'listener',
      label: '会议纪要',
      role: 'minutes',
      instructions: '持续整理会议纪要，重点记录已确认的决策、待办事项（含负责人和截止时间）以及未解决风险；字幕修订时更新已有条目，不重复记录同一事项。',
      responseMode: 'silent',
      capabilities: ['meeting.read'],
    };
    const base = {
      enabled: true,
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes'],
      consumerProfiles: [profileV1],
      defaultProfileBootstrap: {
        generatorVersion: 1,
        profileId: 'minutes',
        configHash: bootstrap.computeVcMeetingDefaultConsumerProfileConfigHash({
          defaultMode: 'agents',
          defaultConsumerIds: ['minutes'],
          profile: profileV1,
        }),
      },
    };
    const cases = [
      { ...structuredClone(base), consumerProfiles: [{ ...profileV1, instructions: `${profileV1.instructions} 用户修改` }] },
      {
        ...structuredClone(base),
        consumerProfiles: [profileV1, {
          id: 'observer',
          agentAppId: 'other-agent',
          role: 'observer',
          responseMode: 'silent',
          capabilities: ['meeting.read'],
        }],
      },
    ];
    for (const consumer of cases) {
      writeConfig([listener(consumer)]);
      const before = readConfig();
      expect(await bootstrap.bootstrapVcMeetingDefaultConsumerProfile('listener', structuralDeps))
        .toEqual({ ok: true, seeded: false, reason: 'already_initialized' });
      expect(readConfig()).toEqual(before);
    }
  });

  it('strictly recognizes only the exact pre-provenance generated seed', async () => {
    writeConfig([listener()]);
    const { bootstrap } = await freshModules();
    const legacySeed = {
      enabled: true,
      injectIntervalMs: 30_000,
      defaultMode: 'listenOnly',
      consumerProfiles: [{
        id: 'minutes',
        agentAppId: 'any-agent',
        label: '会议纪要',
        role: 'minutes',
        instructions: '持续整理会议纪要，重点记录已确认的决策、待办事项（含负责人和截止时间）以及未解决风险；字幕修订时更新已有条目，不重复记录同一事项。',
        responseMode: 'silent',
        capabilities: ['meeting.read'],
      }],
    };
    expect(bootstrap.isLegacyVcMeetingDefaultConsumerSeedCandidate(legacySeed)).toBe(true);

    for (const mutate of [
      (value: any) => { value.defaultMode = 'agents'; },
      (value: any) => { value.defaultConsumerIds = undefined; },
      (value: any) => { value.defaultProfileBootstrap = undefined; },
      (value: any) => { value.defaultAgentAppId = 'legacy-agent'; },
      (value: any) => { value.consumerProfiles.push(structuredClone(value.consumerProfiles[0])); },
      (value: any) => { value.consumerProfiles[0].agentAppId = '  '; },
      (value: any) => { value.consumerProfiles[0].label = '自定义纪要'; },
      (value: any) => { value.consumerProfiles[0].instructions += ' changed'; },
      (value: any) => { value.consumerProfiles[0].capabilities = ['meeting.read', 'listener.output.request']; },
      (value: any) => { value.consumerProfiles[0].filter = { activityTypes: ['speech'] }; },
      (value: any) => { value.consumerProfiles[0].ownedSinks = ['meeting.text']; },
      (value: any) => { value.consumerProfiles[0].extra = true; },
    ]) {
      const nearMiss = structuredClone(legacySeed);
      mutate(nearMiss);
      expect(bootstrap.isLegacyVcMeetingDefaultConsumerSeedCandidate(nearMiss)).toBe(false);
    }
  });

  it('falls back to the lexical external agent when listener self is ineligible', async () => {
    writeConfig([
      bot('listener', {
        cliId: 'unknown',
        vcMeetingAgent: {
          enabled: true,
          larkCliProfile: 'listener',
          meetingConsumer: { enabled: true },
        },
      }),
      bot('agent_z'),
      bot('agent_a'),
    ]);
    const { bootstrap } = await freshModules();
    expect(await bootstrap.bootstrapVcMeetingDefaultConsumerProfile('listener', structuralDeps))
      .toEqual({ ok: true, seeded: true, agentAppId: 'agent_a' });
  });

  it('never resurrects an explicit empty catalog', async () => {
    writeConfig([listener({ enabled: true, consumerProfiles: [], defaultMode: 'listenOnly' })]);
    const before = readConfig();
    const { bootstrap } = await freshModules();
    expect(await bootstrap.bootstrapVcMeetingDefaultConsumerProfile('listener', structuralDeps))
      .toEqual({ ok: true, seeded: false, reason: 'already_initialized' });
    expect(readConfig()).toEqual(before);
  });

  it.each([
    ['defaultAgentAppId', { defaultAgentAppId: 'agent_old' }],
    ['defaultAgent alias', { defaultAgent: 'agent_old' }],
    ['agentCandidates', { agentCandidates: ['agent_old'] }],
    ['agents alias', { agents: ['agent_old'] }],
    ['agent mode', { defaultMode: 'agent' }],
    ['explicit listen-only mode', { defaultMode: 'listenOnly' }],
    ['profile ids without a catalog', { defaultConsumerIds: [] }],
  ])('leaves legacy/partial policy %s untouched', async (_name, policy) => {
    writeConfig([listener({ enabled: true, ...policy }), bot('agent_old')]);
    const before = readConfig();
    const { bootstrap } = await freshModules();
    expect(await bootstrap.bootstrapVcMeetingDefaultConsumerProfile('listener', structuralDeps))
      .toEqual({ ok: true, seeded: false, reason: 'legacy_config' });
    expect(readConfig()).toEqual(before);
  });

  it('requires both listener and consumer enabled, and does not write without an eligible agent', async () => {
    for (const entries of [
      [bot('listener', { vcMeetingAgent: { enabled: false, meetingConsumer: { enabled: true } } })],
      [listener({ enabled: false })],
      [bot('listener', {
        cliId: 'unknown',
        workingDir: undefined,
        vcMeetingAgent: { enabled: true, meetingConsumer: { enabled: true } },
      })],
    ]) {
      writeConfig(entries);
      const before = readConfig();
      const { bootstrap } = await freshModules();
      const result = await bootstrap.bootstrapVcMeetingDefaultConsumerProfile('listener', structuralDeps);
      expect(result).toMatchObject({ ok: true, seeded: false });
      expect(readConfig()).toEqual(before);
    }
  });

  it('does not seed a receiver that lacks managed side-effect isolation', async () => {
    writeConfig([listener()]);
    const before = readConfig();
    const { bootstrap } = await freshModules();
    const result = await bootstrap.bootstrapVcMeetingDefaultConsumerProfile('listener', {
      ...structuralDeps,
      managedSideEffectIsolation: () => false,
    });
    expect(result).toEqual({ ok: true, seeded: false, reason: 'no_eligible_agent' });
    expect(readConfig()).toEqual(before);
  });

  it('serializes concurrent bootstraps so exactly one write wins', async () => {
    writeConfig([listener(), bot('agent')]);
    const { bootstrap } = await freshModules();
    const results = await Promise.all([
      bootstrap.bootstrapVcMeetingDefaultConsumerProfile('listener', structuralDeps),
      bootstrap.bootstrapVcMeetingDefaultConsumerProfile('listener', structuralDeps),
    ]);
    expect(results.filter(result => result.ok && result.seeded)).toHaveLength(1);
    expect(readConfig()[0].vcMeetingAgent.meetingConsumer.consumerProfiles).toHaveLength(1);
  });
});
