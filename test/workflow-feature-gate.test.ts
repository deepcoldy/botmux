/**
 * Machine-wide v3 Workflow kill-switch (global-config `workflow.enabled` /
 * `BOTMUX_WORKFLOW_ENABLED`, accessor `isWorkflowFeatureEnabled`).
 *
 * These tests pin the OBSERVABLE effects of the switch across the layers a
 * "disable workflow" feature has to cover:
 *   - the prompt skill catalog (builtinSkillEntries) — never carries the
 *     workflow family, ON or OFF (it is read on demand) — and `botmux skill
 *     show` content resolution (builtinSkillContent), which is the on-demand
 *     path and is gated by the switch
 *   - the off-mode help pointer (builtinSkillHelpPointer)
 *   - the routing Workflow-discovery hint (shell + system-prompt), whose
 *     on-demand command must actually resolve the skill
 *   - the residue cleaner (removeWorkflowSkills)
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
import { removeWorkflowSkills } from '../src/skills/installer.js';
import { WORKFLOW_FEATURE_SKILL_NAMES } from '../src/skills/definitions.js';
import {
  buildBotmuxShellHints,
  buildBotmuxSystemPromptText,
} from '../src/adapters/cli/shared-hints.js';
import { isWorkflowFeatureEnabled } from '../src/global-config.js';

const WF = WORKFLOW_FEATURE_SKILL_NAMES; // [botmux-workflow-create, botmux-workflow, botmux-goal-ask]

describe('workflow feature gate — prompt skill catalog (builtinSkillEntries)', () => {
  afterEach(() => { delete process.env.BOTMUX_WORKFLOW_ENABLED; });

  it('never advertises the workflow family, ON or OFF — it is read on demand', () => {
    process.env.BOTMUX_WORKFLOW_ENABLED = 'true';
    const on = builtinSkillEntries({ asksViaHook: false }).map((e) => e.name);
    process.env.BOTMUX_WORKFLOW_ENABLED = 'false';
    const off = builtinSkillEntries({ asksViaHook: false }).map((e) => e.name);
    for (const name of WF) {
      expect(on).not.toContain(name);
      expect(off).not.toContain(name);
    }
    // The switch no longer changes what every session is told up front.
    expect(on).toEqual(off);
    // botmux-orchestrate is NOT part of the workflow family — present either way.
    expect(on).toContain('botmux-orchestrate');
  });
});

describe('workflow feature gate — botmux skill show content resolution', () => {
  const ORCHESTRATION = ['botmux-workflow', 'botmux-workflow-create'];
  const NODE_ONLY = ['botmux-goal-ask'];

  it('an ordinary session can show the orchestration skills but not the goal-worker ask protocol', () => {
    process.env.BOTMUX_WORKFLOW_ENABLED = 'true';
    try {
      for (const name of ORCHESTRATION) expect(builtinSkillContent(name, {})).toContain(`name: ${name}`);
      for (const name of NODE_ONLY) expect(builtinSkillContent(name, {})).toBeUndefined();
    } finally {
      delete process.env.BOTMUX_WORKFLOW_ENABLED;
    }
  });

  it('a workflow sub-session (goal worker / Architect) can show only botmux-goal-ask', () => {
    process.env.BOTMUX_WORKFLOW_ENABLED = 'true';
    try {
      for (const env of [{ BOTMUX_V3_GOAL: '1' }, { BOTMUX_WORKFLOW: '1' }]) {
        for (const name of NODE_ONLY) expect(builtinSkillContent(name, env)).toContain(`name: ${name}`);
        for (const name of ORCHESTRATION) expect(builtinSkillContent(name, env)).toBeUndefined();
        // ordinary built-ins are unaffected
        expect(builtinSkillContent('botmux-send', env)).toContain('name: botmux-send');
      }
    } finally {
      delete process.env.BOTMUX_WORKFLOW_ENABLED;
    }
  });

  it('resolves no workflow skill at all while the feature is disabled', () => {
    // The accessor is env-driven here so we do not need a config file on disk.
    process.env.BOTMUX_WORKFLOW_ENABLED = 'true';
    try {
      // A non-gated skill always resolves.
      expect(builtinSkillContent('botmux-orchestrate')).toContain('name: botmux-orchestrate');
    } finally {
      delete process.env.BOTMUX_WORKFLOW_ENABLED;
    }

    process.env.BOTMUX_WORKFLOW_ENABLED = 'false';
    try {
      for (const name of WF) {
        expect(builtinSkillContent(name, {})).toBeUndefined();
        expect(builtinSkillContent(name, { BOTMUX_V3_GOAL: '1' })).toBeUndefined();
      }
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

  it('the hint\'s on-demand command resolves the workflow skill while ON (zh/en, both injection paths)', () => {
    process.env.BOTMUX_WORKFLOW_ENABLED = 'true';
    const texts = [
      ...buildBotmuxShellHints('zh'),
      ...buildBotmuxShellHints('en'),
      buildBotmuxSystemPromptText({ locale: 'zh' }),
      buildBotmuxSystemPromptText({ locale: 'en' }),
    ].filter((text) => /Workflow[：:]/.test(text));
    expect(texts.length).toBeGreaterThanOrEqual(4);
    for (const text of texts) {
      const shown = [...text.matchAll(/botmux skill show ([a-z0-9-]+)/g)].map((m) => m[1]!);
      // The hint is the ONLY resident workflow text, so it must tell the model
      // how to load the skill — and that command must really resolve it.
      expect(shown).toContain('botmux-workflow');
      for (const name of shown) expect(builtinSkillContent(name)).toContain(`name: ${name}`);
    }
  });

  it('a workflow sub-session (goal worker / Architect) never gets the discovery hint, even when ON', () => {
    process.env.BOTMUX_WORKFLOW_ENABLED = 'true';
    for (const marker of ['BOTMUX_V3_GOAL', 'BOTMUX_WORKFLOW'] as const) {
      process.env[marker] = '1';
      try {
        expect(buildBotmuxShellHints('zh').some((l) => l.startsWith('Workflow：'))).toBe(false);
        expect(buildBotmuxShellHints('en').some((l) => l.startsWith('Workflow:'))).toBe(false);
        expect(buildBotmuxSystemPromptText({ locale: 'zh' })).not.toContain('Workflow：');
        expect(buildBotmuxSystemPromptText({ locale: 'en' })).not.toContain('Workflow:');
        // the rest of routing is intact
        expect(buildBotmuxSystemPromptText({ locale: 'zh' })).toContain('</botmux_routing>');
      } finally {
        delete process.env[marker];
      }
    }
    // paired: an ordinary session on the same host still gets it
    expect(buildBotmuxShellHints('zh').some((l) => l.startsWith('Workflow：'))).toBe(true);
  });

  it('injectsSessionContext system routing carries the Workflow line only when ON', () => {
    process.env.BOTMUX_WORKFLOW_ENABLED = 'true';
    const on = buildBotmuxSystemPromptText({ locale: 'zh' });
    expect(on).toContain('Workflow：多步目标');
    // still inside the routing block, not leaked after it
    expect(on.indexOf('Workflow：')).toBeLessThan(on.indexOf('</botmux_routing>'));

    process.env.BOTMUX_WORKFLOW_ENABLED = 'false';
    const off = buildBotmuxSystemPromptText({ locale: 'zh' });
    expect(off).not.toContain('Workflow：');
    // the block is still well-formed
    expect(off).toContain('<botmux_routing>');
    expect(off).toContain('</botmux_routing>');
  });
});

describe('workflow feature gate — resident copies are cleaned (removeWorkflowSkills)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wf-skills-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function seedWorkflowSkills(): void {
    for (const name of WF) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, 'SKILL.md'), 'stale', 'utf-8');
    }
  }

  it('removes copies an earlier version installed into a shared skills / plugin dir', () => {
    seedWorkflowSkills();
    removeWorkflowSkills('claude-code', dir);
    for (const name of WF) expect(existsSync(join(dir, name))).toBe(false);
    // idempotent
    expect(() => removeWorkflowSkills('claude-code', dir)).not.toThrow();
  });

  it('never touches botmux-orchestrate or unrelated user skills', () => {
    for (const name of ['botmux-orchestrate', 'my-own-skill']) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, 'SKILL.md'), 'keep', 'utf-8');
    }
    seedWorkflowSkills();
    removeWorkflowSkills('claude-code', dir);
    expect(readFileSync(join(dir, 'botmux-orchestrate', 'SKILL.md'), 'utf-8')).toBe('keep');
    expect(readFileSync(join(dir, 'my-own-skill', 'SKILL.md'), 'utf-8')).toBe('keep');
  });

  it('is a no-op with an undefined skills dir', () => {
    expect(() => removeWorkflowSkills('claude-code', undefined)).not.toThrow();
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
