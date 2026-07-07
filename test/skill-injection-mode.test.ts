import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { globalConfigPath, invalidateGlobalConfigCache } from '../src/global-config.js';
import {
  DEFAULT_BUILTIN_SKILL_INJECTION,
  resolveSkillInjectionMode,
  globalBuiltinSkillInjectionDefault,
  resolveSkillInjectionModeForApp,
  shouldInstallGlobalSkills,
  resolveSkillInjectionSupport,
  builtinSkillEntries,
  builtinSkillContent,
  buildBuiltinSkillCatalogBlock,
  builtinSkillHelpPointer,
  isSkillInjectionMode,
} from '../src/skills/injection-mode.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { buildNewTopicPrompt } from '../src/core/session-manager.js';
import { runSkillsAdminCommand } from '../src/core/skills/cli-admin-command.js';
import { readFileSync } from 'node:fs';

const APP = 'cli_app_codex';

function writeConfig(obj: unknown): void {
  mkdirSync(dirname(globalConfigPath()), { recursive: true });
  writeFileSync(globalConfigPath(), JSON.stringify(obj));
  invalidateGlobalConfigCache();
}

function writeBots(entries: unknown[], home: string): void {
  const p = join(home, 'bots.json');
  writeFileSync(p, JSON.stringify(entries));
  vi.stubEnv('BOTS_CONFIG', p);
}

function codexBot(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { larkAppId: APP, larkAppSecret: 'secret', cliId: 'codex', ...extra };
}

describe('skill injection-mode resolution', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-skill-mode-'));
    vi.stubEnv('HOME', home);
    // Keep codex's skillsDir at <home>/.codex/skills (not a stray CODEX_HOME).
    vi.stubEnv('CODEX_HOME', '');
    invalidateGlobalConfigCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    rmSync(home, { recursive: true, force: true });
  });

  it('defaults to prompt when nothing is configured', () => {
    expect(DEFAULT_BUILTIN_SKILL_INJECTION).toBe('prompt');
    expect(globalBuiltinSkillInjectionDefault()).toBe('prompt');
    expect(resolveSkillInjectionMode(undefined)).toBe('prompt');
  });

  it('machine-wide skills.builtinInjection overrides the default', () => {
    writeConfig({ skills: { builtinInjection: 'global' } });
    expect(globalBuiltinSkillInjectionDefault()).toBe('global');
    expect(resolveSkillInjectionMode(undefined)).toBe('global');
  });

  it('ignores a bogus machine-wide value and keeps prompt', () => {
    writeConfig({ skills: { builtinInjection: 'nonsense' } });
    expect(globalBuiltinSkillInjectionDefault()).toBe('prompt');
  });

  it('per-bot override beats the machine default', () => {
    writeConfig({ skills: { builtinInjection: 'global' } });
    expect(resolveSkillInjectionMode('off')).toBe('off');
    expect(resolveSkillInjectionMode('prompt')).toBe('prompt');
    // unrecognised per-bot value falls back to the machine default (global here)
    expect(resolveSkillInjectionMode('bogus')).toBe('global');
  });

  it('isSkillInjectionMode narrows the three valid values only', () => {
    expect(isSkillInjectionMode('global')).toBe(true);
    expect(isSkillInjectionMode('prompt')).toBe(true);
    expect(isSkillInjectionMode('off')).toBe(true);
    expect(isSkillInjectionMode('native')).toBe(false);
    expect(isSkillInjectionMode(undefined)).toBe(false);
  });

  it('resolveSkillInjectionModeForApp reads the bot override by larkAppId', () => {
    writeBots([codexBot({ skillInjection: 'off' })], home);
    expect(resolveSkillInjectionModeForApp(APP)).toBe('off');
    // unknown app → machine default
    expect(resolveSkillInjectionModeForApp('cli_unknown')).toBe('prompt');
    // no app id → machine default
    expect(resolveSkillInjectionModeForApp(undefined)).toBe('prompt');
  });

  describe('shouldInstallGlobalSkills (per shared dir, union across bots)', () => {
    const codexSkillsDir = () => createCliAdapterSync('codex').skillsDir!;

    it('false when every bot on the dir is prompt/off', () => {
      writeBots([codexBot({ skillInjection: 'prompt' })], home);
      expect(shouldInstallGlobalSkills(codexSkillsDir())).toBe(false);
    });

    it('true when some bot on the dir resolves to global (explicit override)', () => {
      writeBots([codexBot({ skillInjection: 'global' })], home);
      expect(shouldInstallGlobalSkills(codexSkillsDir())).toBe(true);
    });

    it('true when the machine default is global and the bot has no override', () => {
      writeConfig({ skills: { builtinInjection: 'global' } });
      writeBots([codexBot()], home);
      expect(shouldInstallGlobalSkills(codexSkillsDir())).toBe(true);
    });

    it('false for an unrelated dir even if a codex bot wants global', () => {
      writeBots([codexBot({ skillInjection: 'global' })], home);
      expect(shouldInstallGlobalSkills(join(home, '.gemini', 'skills'))).toBe(false);
    });
  });
});

describe('resolveSkillInjectionSupport (dashboard control class)', () => {
  it('classifies the whole CLI matrix by capability', () => {
    // claude-family (incl. the relay/seed forks) → dynamic --plugin-dir injection
    for (const id of ['claude-code', 'seed', 'relay'] as const) {
      expect(resolveSkillInjectionSupport(id)).toBe('dynamic');
    }
    // global skills-dir CLIs → the global|prompt|off knob applies
    for (const id of ['codex', 'gemini', 'opencode', 'cursor', 'coco', 'traex', 'pi', 'oh-my-pi', 'mtr', 'genius'] as const) {
      expect(resolveSkillInjectionSupport(id)).toBe('global');
    }
    // no skill mechanism → control hidden
    for (const id of ['antigravity', 'aiden', 'hermes', 'mir', 'mira', 'codex-app'] as const) {
      expect(resolveSkillInjectionSupport(id)).toBe('none');
    }
  });
});

describe('built-in skill catalog', () => {
  it('lists the unconditional built-ins plus ask when the CLI has no hook', () => {
    const entries = builtinSkillEntries({ asksViaHook: false, whiteboardEnabled: false });
    const names = entries.map((e) => e.name);
    expect(names).toContain('botmux-send');
    expect(names).toContain('botmux-schedule');
    expect(names).toContain('botmux-ask');          // no hook → ask fallback advertised
    expect(names).not.toContain('botmux-whiteboard'); // feature off
    // every entry carries a non-empty description parsed from frontmatter
    expect(entries.every((e) => e.description.length > 0)).toBe(true);
  });

  it('drops the ask skill when the CLI takes over via hook, and adds whiteboard when enabled', () => {
    const entries = builtinSkillEntries({ asksViaHook: true, whiteboardEnabled: true });
    const names = entries.map((e) => e.name);
    expect(names).not.toContain('botmux-ask');
    expect(names).toContain('botmux-whiteboard');
  });

  it('excludeRoutingCovered drops the comms skills already in <botmux_routing>', () => {
    const names = builtinSkillEntries({ asksViaHook: false, excludeRoutingCovered: true }).map((e) => e.name);
    for (const comms of ['botmux-send', 'botmux-history', 'botmux-quoted', 'botmux-bots']) {
      expect(names).not.toContain(comms);
    }
    // additional capabilities remain
    expect(names).toContain('botmux-schedule');
    expect(names).toContain('botmux-ask');
    // but they are still resolvable via `botmux skill show` (content map is unfiltered)
    expect(builtinSkillContent('botmux-send')).toContain('name: botmux-send');
  });

  it('builds a <botmux_builtin_skills> block that points at `botmux skill show`', () => {
    const entries = builtinSkillEntries({ asksViaHook: false, whiteboardEnabled: false });
    const block = buildBuiltinSkillCatalogBlock(entries);
    expect(block.startsWith('<botmux_builtin_skills>')).toBe(true);
    expect(block.trimEnd().endsWith('</botmux_builtin_skills>')).toBe(true);
    expect(block).toContain('botmux skill show <name>');
    expect(block).toContain('- botmux-send:');
  });

  it('renders an empty block for no entries', () => {
    expect(buildBuiltinSkillCatalogBlock([])).toBe('');
  });

  it('builtinSkillContent resolves known names (incl. conditional ask) and rejects unknown', () => {
    expect(builtinSkillContent('botmux-send')).toContain('name: botmux-send');
    expect(builtinSkillContent('botmux-ask')).toContain('name: botmux-ask');
    expect(builtinSkillContent('botmux-whiteboard')).toContain('name: botmux-whiteboard');
    expect(builtinSkillContent('nope')).toBeUndefined();
  });

  it('help pointer is XML-wrapped and names the CLI help entry point', () => {
    const zh = builtinSkillHelpPointer();
    expect(zh.startsWith('<botmux_builtin_skills>')).toBe(true);
    expect(zh.trimEnd().endsWith('</botmux_builtin_skills>')).toBe(true);
    expect(zh).toContain('botmux --help');
    expect(builtinSkillHelpPointer('en')).toContain('botmux --help');
  });
});

describe('buildNewTopicPrompt built-in skill delivery (codex)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-prompt-mode-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('CODEX_HOME', '');
    invalidateGlobalConfigCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    rmSync(home, { recursive: true, force: true });
  });

  const prompt = () => buildNewTopicPrompt('hi', 'sess-1', 'codex');

  it('prompt mode (default) inlines the catalog with the additional skills only', () => {
    const p = prompt();
    expect(p).toContain('<botmux_builtin_skills>');
    expect(p).toContain('botmux skill show <name>');
    expect(p).toContain('- botmux-schedule:');        // additional capability listed
    expect(p).not.toContain('- botmux-send:');         // comms skill left to <botmux_routing>
    expect(p).not.toContain('- botmux-history:');
    expect(p).not.toContain('botmux --help');
  });

  it('off mode wraps the help pointer in the same block, no skill list', () => {
    writeConfig({ skills: { builtinInjection: 'off' } });
    const p = prompt();
    expect(p).toContain('<botmux_builtin_skills>');    // XML-wrapped, not a bare line
    expect(p).toContain('botmux --help');
    expect(p).not.toContain('- botmux-schedule:');     // no catalog list in off mode
  });

  it('global mode injects neither catalog nor help pointer (native install handles it)', () => {
    writeConfig({ skills: { builtinInjection: 'global' } });
    const p = prompt();
    expect(p).not.toContain('<botmux_builtin_skills>');
    expect(p).not.toContain('botmux --help');
  });
});

describe('botmux skills injection (machine-wide setter)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-inj-cmd-'));
    vi.stubEnv('HOME', home);
    invalidateGlobalConfigCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    rmSync(home, { recursive: true, force: true });
  });

  it('no arg prints the current default (prompt when unset)', () => {
    expect(runSkillsAdminCommand(['injection']).stdout).toBe('builtinInjection: prompt\n');
  });

  it('sets, reads back, and persists to config.json', () => {
    expect(runSkillsAdminCommand(['injection', 'global']).code).toBe(0);
    expect(runSkillsAdminCommand(['injection']).stdout).toBe('builtinInjection: global\n');
    const cfg = JSON.parse(readFileSync(globalConfigPath(), 'utf-8'));
    expect(cfg.skills.builtinInjection).toBe('global');
  });

  it('preserves sibling skills keys when setting', () => {
    writeConfig({ skills: { delivery: 'prompt', trustProjectSkills: 'all' } });
    runSkillsAdminCommand(['injection', 'off']);
    const cfg = JSON.parse(readFileSync(globalConfigPath(), 'utf-8'));
    expect(cfg.skills).toEqual({ delivery: 'prompt', trustProjectSkills: 'all', builtinInjection: 'off' });
  });

  it('unset clears the key and reverts to prompt', () => {
    runSkillsAdminCommand(['injection', 'global']);
    expect(runSkillsAdminCommand(['injection', 'unset']).code).toBe(0);
    expect(runSkillsAdminCommand(['injection']).stdout).toBe('builtinInjection: prompt\n');
  });

  it('rejects a bogus mode with exit 2', () => {
    const r = runSkillsAdminCommand(['injection', 'bogus']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('global|prompt|off');
  });
});
