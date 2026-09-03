/**
 * Machine-wide v3 Workflow kill-switch (global-config `workflow.enabled` /
 * `BOTMUX_WORKFLOW_ENABLED`, accessor `isWorkflowFeatureEnabled`).
 *
 * These tests pin the OBSERVABLE effects of the switch across the layers a
 * "disable workflow" feature has to cover:
 *   - the prompt skill catalog (builtinSkillEntries) + `botmux skill show`
 *     content resolution (builtinSkillContent)
 *   - the off-mode help pointer (builtinSkillHelpPointer)
 *   - the always-on routing Workflow-discovery hint (shell + system-prompt)
 *   - the conditional skill installer (ensureWorkflowSkills)
 *
 * Every "disabled" assertion is paired with an "enabled" one so removing a gate
 * makes a test fail in BOTH directions (reverse-mutation discipline): a gate
 * that never fires and a gate that always fires are both caught.
 *
 * The v3 Workflow family is `botmux-workflow`, `botmux-workflow-create`,
 * `botmux-goal-ask`. `botmux-orchestrate` is deliberately NOT gated.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  builtinSkillEntries,
  builtinSkillContent,
  builtinSkillHelpPointer,
} from '../src/skills/injection-mode.js';
import { ensureWorkflowSkills } from '../src/skills/installer.js';
import { WORKFLOW_FEATURE_SKILL_NAMES } from '../src/skills/definitions.js';
import {
  buildBotmuxShellHints,
  buildBotmuxSystemPromptText,
} from '../src/adapters/cli/shared-hints.js';
import { isWorkflowFeatureEnabled } from '../src/global-config.js';

const WF = WORKFLOW_FEATURE_SKILL_NAMES; // [botmux-workflow-create, botmux-workflow, botmux-goal-ask]

describe('workflow feature gate — prompt skill catalog (builtinSkillEntries)', () => {
  it('advertises the whole workflow family when ON, drops it (only) when OFF', () => {
    const on = builtinSkillEntries({ asksViaHook: false, workflowEnabled: true }).map((e) => e.name);
    const off = builtinSkillEntries({ asksViaHook: false, workflowEnabled: false }).map((e) => e.name);
    for (const name of WF) {
      expect(on).toContain(name);
      expect(off).not.toContain(name);
    }
    // botmux-orchestrate is NOT part of the workflow switch — present either way.
    expect(on).toContain('botmux-orchestrate');
    expect(off).toContain('botmux-orchestrate');
    // Nothing else is disturbed: the OFF list equals the ON list minus the family.
    expect(off).toEqual(on.filter((n) => !WF.includes(n)));
  });

  it('keeps the ENABLED catalog order byte-identical to the historical layout', () => {
    // Workflow family sits right after botmux-handoff, before botmux-orchestrate.
    const names = builtinSkillEntries({ asksViaHook: true, workflowEnabled: true }).map((e) => e.name);
    const handoff = names.indexOf('botmux-handoff');
    expect(handoff).toBeGreaterThanOrEqual(0);
    expect(names.slice(handoff + 1, handoff + 1 + WF.length)).toEqual([
      'botmux-workflow-create',
      'botmux-workflow',
      'botmux-goal-ask',
    ]);
    expect(names[handoff + 1 + WF.length]).toBe('botmux-orchestrate');
  });
});

describe('workflow feature gate — botmux skill show content resolution', () => {
  it('resolves workflow skill bodies only while the feature is enabled', () => {
    // The accessor is env-driven here so we do not need a config file on disk.
    process.env.BOTMUX_WORKFLOW_ENABLED = 'true';
    try {
      for (const name of WF) expect(builtinSkillContent(name)).toContain(`name: ${name}`);
      // A non-gated skill always resolves.
      expect(builtinSkillContent('botmux-orchestrate')).toContain('name: botmux-orchestrate');
    } finally {
      delete process.env.BOTMUX_WORKFLOW_ENABLED;
    }

    process.env.BOTMUX_WORKFLOW_ENABLED = 'false';
    try {
      for (const name of WF) expect(builtinSkillContent(name)).toBeUndefined();
      // A disabled host must still resolve non-workflow skills.
      expect(builtinSkillContent('botmux-orchestrate')).toContain('name: botmux-orchestrate');
      expect(builtinSkillContent('botmux-send')).toContain('name: botmux-send');
    } finally {
      delete process.env.BOTMUX_WORKFLOW_ENABLED;
    }
  });
});

describe('workflow feature gate — off-mode help pointer', () => {
  it('mentions `workflow` among capabilities only when enabled (zh/en, both layouts)', () => {
    for (const locale of ['zh', 'en'] as const) {
      for (const hasRoutingBlock of [true, false]) {
        const on = builtinSkillHelpPointer(locale, { hasRoutingBlock, workflowEnabled: true });
        const off = builtinSkillHelpPointer(locale, { hasRoutingBlock, workflowEnabled: false });
        expect(on).toContain('workflow');
        expect(off).not.toContain('workflow');
        // The pointer itself is still emitted when disabled (just without workflow).
        expect(off).toContain('<botmux_builtin_skills>');
        expect(off.toLowerCase()).toContain('botmux --help');
      }
    }
  });
});

describe('workflow feature gate — routing Workflow-discovery hint', () => {
  afterEach(() => { delete process.env.BOTMUX_WORKFLOW_ENABLED; });

  it('shell hints carry the Workflow line when ON and omit it when OFF', () => {
    process.env.BOTMUX_WORKFLOW_ENABLED = 'true';
    expect(buildBotmuxShellHints('zh').some((l) => l.startsWith('Workflow：'))).toBe(true);
    expect(buildBotmuxShellHints('en').some((l) => l.startsWith('Workflow:'))).toBe(true);

    process.env.BOTMUX_WORKFLOW_ENABLED = 'false';
    expect(buildBotmuxShellHints('zh').some((l) => l.startsWith('Workflow：'))).toBe(false);
    expect(buildBotmuxShellHints('en').some((l) => l.startsWith('Workflow:'))).toBe(false);
    // The rest of the routing hints survive (the gate is surgical).
    expect(buildBotmuxShellHints('zh').length).toBeGreaterThan(3);
  });

  it('injectsSessionContext system routing carries the Workflow line only when ON', () => {
    process.env.BOTMUX_WORKFLOW_ENABLED = 'true';
    const on = buildBotmuxSystemPromptText({ locale: 'zh' });
    expect(on).toContain('Workflow：有界的多步目标');
    // still inside the routing block, not leaked after it
    expect(on.indexOf('Workflow：')).toBeLessThan(on.indexOf('</botmux_routing>'));

    process.env.BOTMUX_WORKFLOW_ENABLED = 'false';
    const off = buildBotmuxSystemPromptText({ locale: 'zh' });
    expect(off).not.toContain('Workflow：有界的多步目标');
    // the block is still well-formed
    expect(off).toContain('<botmux_routing>');
    expect(off).toContain('</botmux_routing>');
  });
});

describe('workflow feature gate — conditional installer (ensureWorkflowSkills)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wf-skills-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function seedWorkflowSkills(): void {
    for (const name of WF) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, 'SKILL.md'), 'stale', 'utf-8');
    }
  }

  it('install=true writes every workflow SKILL.md; install=false removes them', () => {
    ensureWorkflowSkills('claude-code', dir, true);
    for (const name of WF) {
      const file = join(dir, name, 'SKILL.md');
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, 'utf-8')).toContain(`name: ${name}`);
    }

    ensureWorkflowSkills('claude-code', dir, false);
    for (const name of WF) expect(existsSync(join(dir, name))).toBe(false);
  });

  it('install=false cleans up a stale copy left by an earlier enabled run', () => {
    seedWorkflowSkills();
    ensureWorkflowSkills('claude-code', dir, false);
    for (const name of WF) expect(existsSync(join(dir, name))).toBe(false);
  });

  it('never touches botmux-orchestrate (not part of the workflow family)', () => {
    mkdirSync(join(dir, 'botmux-orchestrate'), { recursive: true });
    writeFileSync(join(dir, 'botmux-orchestrate', 'SKILL.md'), 'keep', 'utf-8');
    ensureWorkflowSkills('claude-code', dir, false);
    expect(existsSync(join(dir, 'botmux-orchestrate'))).toBe(true);
  });

  it('is a no-op with an undefined skills dir', () => {
    expect(() => ensureWorkflowSkills('claude-code', undefined, true)).not.toThrow();
    expect(() => ensureWorkflowSkills('claude-code', undefined, false)).not.toThrow();
  });
});

describe('workflow feature gate — accessor smoke (default OFF, no config/env)', () => {
  it('defaults to disabled when neither env nor config forces it', () => {
    // Guard: the test process must not be leaking an override.
    if (process.env.BOTMUX_WORKFLOW_ENABLED == null) {
      expect(isWorkflowFeatureEnabled()).toBe(false);
    }
  });
});
