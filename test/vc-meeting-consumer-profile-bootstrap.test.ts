import { describe, expect, it } from 'vitest';

import { isLegacyVcMeetingDefaultConsumerSeedCandidate } from '../src/services/vc-meeting-consumer-profile-bootstrap.js';

/**
 * 「启动时给本 bot 播种默认预设」已退役（改成 fleet 共享目录 + 读路径内置默认），
 * 这里只剩对磁盘上历史播种残留的**识别**：识别成功才向操作者提议迁移，所以近似
 * 形状必须一律判否——那可能是操作者自己写的配置。
 */
describe('legacy VC default consumer seed detection', () => {
  const legacySeed = () => ({
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
  });

  it('recognizes the exact pre-provenance generated seed', () => {
    expect(isLegacyVcMeetingDefaultConsumerSeedCandidate(legacySeed())).toBe(true);
  });

  it.each([
    ['non-object', 'nope'],
    ['array', []],
    ['null', null],
  ])('rejects %s', (_name, value) => {
    expect(isLegacyVcMeetingDefaultConsumerSeedCandidate(value)).toBe(false);
  });

  it('rejects every near miss', () => {
    for (const mutate of [
      (value: any) => { value.defaultMode = 'agents'; },
      (value: any) => { value.defaultConsumerIds = undefined; },
      (value: any) => { value.defaultProfileBootstrap = undefined; },
      (value: any) => { value.defaultAgentAppId = 'legacy-agent'; },
      (value: any) => { value.defaultAgent = 'legacy-agent'; },
      (value: any) => { value.agentCandidates = ['legacy-agent']; },
      (value: any) => { value.agents = ['legacy-agent']; },
      (value: any) => { value.consumerProfiles = []; },
      (value: any) => { value.consumerProfiles.push(structuredClone(value.consumerProfiles[0])); },
      (value: any) => { value.consumerProfiles[0].agentAppId = '  '; },
      (value: any) => { value.consumerProfiles[0].id = 'notes'; },
      (value: any) => { value.consumerProfiles[0].label = '自定义纪要'; },
      (value: any) => { value.consumerProfiles[0].role = 'assistant'; },
      (value: any) => { value.consumerProfiles[0].responseMode = 'listener_thread'; },
      (value: any) => { value.consumerProfiles[0].instructions += ' changed'; },
      (value: any) => { value.consumerProfiles[0].capabilities = ['meeting.read', 'listener.output.request']; },
      (value: any) => { value.consumerProfiles[0].filter = { activityTypes: ['speech'] }; },
      (value: any) => { value.consumerProfiles[0].ownedSinks = ['meeting.text']; },
      (value: any) => { value.consumerProfiles[0].extra = true; },
    ]) {
      const nearMiss = legacySeed();
      mutate(nearMiss);
      expect(isLegacyVcMeetingDefaultConsumerSeedCandidate(nearMiss)).toBe(false);
    }
  });
});
