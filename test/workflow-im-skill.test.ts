import { describe, expect, it } from 'vitest';

import {
  buildWorkflowGrillPrompt,
  isLegacyTemplateCommand,
  LEGACY_TEMPLATE_RETIRED_MESSAGE,
  parseWorkflowGrillTrigger,
} from '../src/im/lark/workflow-slash-command.js';

describe('v3 /workflow grill entry', () => {
  it('accepts explicit and natural-language goals', () => {
    expect(parseWorkflowGrillTrigger('/workflow new 调研三家竞品')).toEqual({
      kind: 'goal',
      goal: '调研三家竞品',
    });
    expect(parseWorkflowGrillTrigger('/workflow 把日志分析后出图')).toEqual({
      kind: 'goal',
      goal: '把日志分析后出图',
    });
  });

  it('returns usage for an empty goal', () => {
    expect(parseWorkflowGrillTrigger('/workflow')).toEqual({ kind: 'usage' });
    expect(parseWorkflowGrillTrigger('/workflow new')).toEqual({ kind: 'usage' });
  });

  it('does not swallow reserved v3 verbs or lookalike commands', () => {
    for (const verb of ['run', 'save', 'list', 'show', 'cancel', 'resume']) {
      expect(parseWorkflowGrillTrigger(`/workflow ${verb} value`)).toBeNull();
    }
    expect(parseWorkflowGrillTrigger('/workflowfoo goal')).toBeNull();
    expect(parseWorkflowGrillTrigger('/template run old')).toBeNull();
  });

  it('builds the skill-directed prompt', () => {
    const prompt = buildWorkflowGrillPrompt('调研三家竞品');
    expect(prompt).toContain('botmux-workflow');
    expect(prompt).toContain('调研三家竞品');
  });
});

describe('/template retirement tombstone', () => {
  it('recognizes the namespace without matching lookalikes', () => {
    expect(isLegacyTemplateCommand('/template')).toBe(true);
    expect(isLegacyTemplateCommand('/template run old')).toBe(true);
    expect(isLegacyTemplateCommand('/templatefoo run old')).toBe(false);
  });

  it('provides an actionable stable retirement message', () => {
    expect(LEGACY_TEMPLATE_RETIRED_MESSAGE).toContain('v2 workflow 已下线');
    expect(LEGACY_TEMPLATE_RETIRED_MESSAGE).toContain('botmux template migrate-v3');
    expect(LEGACY_TEMPLATE_RETIRED_MESSAGE).toContain('/workflow run');
  });
});
