import { describe, expect, it } from 'vitest';
import { vcMeetingConsumerProfilesFromDtos } from '../src/dashboard/vc-consumer-profiles-api.js';
import { VC_MEETING_CONSUMER_PROFILE_TEMPLATE_CATALOG } from '../src/services/vc-meeting-consumer-profile-templates.js';

describe('VC meeting consumer profile template catalog', () => {
  it('ships a versioned, stable, telemetry-free built-in catalog', () => {
    const catalog = VC_MEETING_CONSUMER_PROFILE_TEMPLATE_CATALOG;
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.templates.map(template => template.templateId)).toEqual([
      'important-information-sync',
      'meeting-minutes',
      'meeting-facilitator',
      'solution-review-risk-challenge',
      'interview-requirement-insights',
    ]);
    expect(new Set(catalog.templates.map(template => template.suggestedProfileId)).size)
      .toBe(catalog.templates.length);
    for (const template of catalog.templates) {
      expect(template.version).toBeGreaterThan(0);
      expect(template.source).toBe('builtin');
      expect(template).not.toHaveProperty('usageCount');
      expect(template).not.toHaveProperty('popularity');
      expect(template).not.toHaveProperty('endpoint');
    }
  });

  it('maps every template copy through the existing canonical profile policy', () => {
    const mapped = vcMeetingConsumerProfilesFromDtos(
      VC_MEETING_CONSUMER_PROFILE_TEMPLATE_CATALOG.templates.map(template => ({
        id: template.suggestedProfileId,
        label: template.profileLabel.zh,
        agentAppId: 'app_agent',
        instructions: template.instructions.zh,
        activityTypes: [...template.activityTypes],
        responseMode: template.responseMode,
        listenerPlacement: template.listenerPlacement,
        permissionPreset: template.permissionPreset,
      })),
      [],
    );
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.profiles).toHaveLength(5);
    expect(mapped.profiles[0]).toMatchObject({
      id: 'important-sync',
      responseMode: 'listener_thread',
      listenerDelivery: { placement: 'topic' },
      capabilities: ['listener.output.request', 'meeting.read'],
    });
    expect(mapped.profiles.slice(2).every(profile => profile.responseMode === 'silent')).toBe(true);
    expect(mapped.profiles.find(profile => profile.id === 'facilitator')).toMatchObject({
      responseMode: 'silent',
      capabilities: ['meeting.output.request', 'meeting.read'],
      ownedSinks: ['meeting_text', 'meeting_voice'],
    });
    expect(mapped.profiles.find(profile => profile.id === 'interview-insights')).toMatchObject({
      responseMode: 'silent',
      capabilities: ['meeting.output.request', 'meeting.read'],
      ownedSinks: ['meeting_text', 'meeting_voice'],
    });
  });

  it('ships distinct general-purpose roles and passes agenda through per-meeting context', () => {
    const templates = VC_MEETING_CONSUMER_PROFILE_TEMPLATE_CATALOG.templates;
    expect(templates.find(template => template.templateId === 'meeting-minutes')).toMatchObject({
      version: 2,
      title: { zh: '会议纪要与行动项' },
    });
    expect(templates.find(template => template.templateId === 'meeting-facilitator')?.instructions.zh)
      .toContain('本次会议补充说明');
    expect(templates.find(template => template.templateId === 'solution-review-risk-challenge')?.instructions.zh)
      .toContain('失败路径');
    expect(templates.find(template => template.templateId === 'interview-requirement-insights')?.instructions.zh)
      .toContain('不诱导');
  });

  it('makes corrections explicit without adding fingerprint or cadence configuration', () => {
    const important = VC_MEETING_CONSUMER_PROFILE_TEMPLATE_CATALOG.templates[0];
    expect(important.instructions.zh).toContain('修正必须视为新信息');
    expect(important.instructions.en).toContain('are new information');
    const serialized = JSON.stringify(VC_MEETING_CONSUMER_PROFILE_TEMPLATE_CATALOG).toLowerCase();
    expect(serialized).not.toContain('fingerprint');
    expect(serialized).not.toContain('debounce');
    expect(serialized).not.toContain('intervalms');
    expect(serialized).not.toContain('incident');
  });
});
