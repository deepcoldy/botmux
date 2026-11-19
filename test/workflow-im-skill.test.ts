import { describe, expect, it } from 'vitest';
import { builtinSkillContent } from '../src/skills/injection-mode.js';

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

  it('builds a prompt whose on-demand skill command really resolves the workflow skill', () => {
    const prompt = buildWorkflowGrillPrompt('调研三家竞品');
    expect(prompt).toContain('调研三家竞品');
    // The workflow skill is no longer resident in the session, so the rewritten
    // `/workflow` prompt is the only thing that can lead the agent to it.
    const shown = [...prompt.matchAll(/botmux skill show ([a-z0-9-]+)/g)].map((m) => m[1]!);
    expect(shown).toEqual(['botmux-workflow']);
    process.env.BOTMUX_WORKFLOW_ENABLED = 'true';
    try {
      expect(builtinSkillContent(shown[0]!)).toContain('name: botmux-workflow');
    } finally {
      delete process.env.BOTMUX_WORKFLOW_ENABLED;
    }
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
