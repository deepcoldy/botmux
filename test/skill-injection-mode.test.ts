import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { globalConfigPath, invalidateGlobalConfigCache } from '../src/global-config.js';
import {
  resolveSkillInjectionMode,
  globalBuiltinSkillInjectionDefault,
  resolveSkillInjectionModeForApp,
  shouldInstallGlobalSkills,
  resolveSkillInjectionSupport,
  builtinSkillEntries,
  builtinSkillContent,
  buildBuiltinSkillCatalogBlock,
  builtinSkillHelpPointer,
  builtinSkillBlockForInjectsSessionContext,
  isSkillInjectionMode,
} from '../src/skills/injection-mode.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { buildNewTopicPrompt } from '../src/core/session-manager.js';
import { runSkillsAdminCommand } from '../src/core/skills/cli-admin-command.js';
import { readFileSync } from 'node:fs';
import { invalidateCustomizationCache, setSkillOverrideBody } from '../src/services/customization-store.js';

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

    it('zero-injection bots do not install global skills, while another bot sharing the directory still can', () => {
      const sub = { larkAppId: 'sub', larkAppSecret: 'secret', cliId: 'traex', promptInjection: 'none', skillInjection: 'global' };
      const lead = { larkAppId: 'lead', larkAppSecret: 'secret', cliId: 'coco', skillInjection: 'global' };
      const skillsDir = createCliAdapterSync('traex').skillsDir!;
      writeBots([sub], home);
      expect(shouldInstallGlobalSkills(skillsDir)).toBe(false);
      writeBots([sub, lead], home);
      expect(shouldInstallGlobalSkills(skillsDir)).toBe(true);
      writeBots([sub, { ...lead, skillInjection: 'prompt' }], home);
      expect(shouldInstallGlobalSkills(skillsDir)).toBe(false);
    });

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
      expect(shouldInstallGlobalSkills(join(home, '.config', 'opencode', 'skills'))).toBe(false);
    });
  });
});

describe('resolveSkillInjectionSupport (dashboard control class)', () => {
  it('classifies the whole CLI matrix by capability', () => {
    // claude-family (incl. the relay/seed forks), cursor, pi, oh-my-pi → dynamic --plugin-dir / --skill injection
    for (const id of ['claude-code', 'seed', 'relay', 'cursor', 'pi', 'oh-my-pi'] as const) {
      expect(resolveSkillInjectionSupport(id)).toBe('dynamic');
    }
    // global skills-dir CLIs → the global|prompt|off knob applies
    for (const id of ['codex', 'opencode', 'coco', 'traex', 'mtr', 'kiro-cli', 'genius', 'grok', 'antigravity'] as const) {
      expect(resolveSkillInjectionSupport(id)).toBe('global');
    }
    // no skill mechanism → control hidden
    for (const id of ['aiden', 'hermes', 'ebsd', 'mir', 'mira', 'codex-app'] as const) {
      expect(resolveSkillInjectionSupport(id)).toBe('none');
    }
  });
});

describe('built-in skill catalog', () => {
  function innerText(block: string): string {
    const match = block.match(/^<botmux_builtin_skills>\n([\s\S]*)\n<\/botmux_builtin_skills>$/);
    expect(match).not.toBeNull();
    return match![1];
  }

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

  it('excludeRoutingCovered keeps complex send discoverable but drops fully covered comms skills', () => {
    const names = builtinSkillEntries({ asksViaHook: false, excludeRoutingCovered: true }).map((e) => e.name);
    expect(names).toContain('botmux-send');
    for (const comms of ['botmux-history', 'botmux-quoted', 'botmux-bots']) {
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
    expect(block).toContain('botmux skill show &lt;name&gt;');
    expect(block).toContain('- botmux-send:');
    expect(block).toContain('首次复杂飞书发送前读取');
    expect(block).toContain('JSON.stringify');
    expect(block).toContain('JSON 转义产生的 \\n 当字面量');
    // The compact prompt description must not replace the full/native metadata.
    expect(entries.find((e) => e.name === 'botmux-send')?.description).toContain('向飞书发送消息');
  });

  it('compacts shipped descriptions while retaining every available entry and full on-demand content', () => {
    const entries = builtinSkillEntries({ asksViaHook: false, whiteboardEnabled: true, excludeRoutingCovered: true });
    const block = buildBuiltinSkillCatalogBlock(entries);
    const fullDescriptionChars = entries.reduce((sum, entry) => sum + entry.description.length, 0);
    expect(block.length).toBeLessThan(fullDescriptionChars);
    for (const entry of entries) {
      expect(block).toContain(`- ${entry.name}:`);
      expect(builtinSkillContent(entry.name)).toContain(`name: ${entry.name}`);
    }
    for (const name of ['botmux-schedule', 'botmux-ask', 'botmux-handoff']) {
      const entry = entries.find((entry) => entry.name === name)!;
      expect(block).not.toContain(entry.description);
      expect(entry.content).toContain(entry.description);
    }
  });

  it('adds the persistent-schedule boundary only to Remote Runner catalogs', () => {
    const entries = builtinSkillEntries({ asksViaHook: false, whiteboardEnabled: false });
    const remote = buildBuiltinSkillCatalogBlock(entries, 'en', { remoteRunner: true });
    const local = buildBuiltinSkillCatalogBlock(entries, 'en');

    expect(remote).toContain('temporary Remote Runner environment');
    expect(remote).toContain('MUST use the persistent `botmux schedule`');
    expect(remote).toContain('cron_create');
    expect(local).not.toContain('temporary Remote Runner environment');
    expect(local).not.toContain('cron_create');
  });

  it('keeps catalog prose as escaped text instead of nested XML-like tags', () => {
    for (const locale of [undefined, 'en'] as const) {
      const block = buildBuiltinSkillCatalogBlock([{
        name: 'botmux-fixture',
        description: 'Use <fixture> & keep going.',
        content: '',
      }], locale);

      expect(innerText(block)).not.toMatch(/[<>]/);
      expect(block).toContain('&lt;botmux_routing&gt;');
      expect(block).toContain('botmux skill show &lt;name&gt;');
      expect(block).toContain('Use &lt;fixture&gt; &amp; keep going.');
    }
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

  it('keeps prompt/off help prose as escaped text instead of nested XML-like tags', () => {
    const zh = builtinSkillHelpPointer();
    const en = builtinSkillHelpPointer('en');

    expect(innerText(zh)).not.toMatch(/[<>]/);
    expect(innerText(en)).not.toMatch(/[<>]/);
    expect(zh).toContain('&lt;botmux_routing&gt;');
    expect(zh).toContain('botmux &lt;子命令&gt; --help');
    expect(en).toContain('&lt;botmux_routing&gt;');
    expect(en).toContain('botmux &lt;cmd&gt; --help');
  });
});

describe('compact catalog with user skill overrides', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-catalog-override-'));
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
    invalidateCustomizationCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateCustomizationCache();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it.each(['botmux-send', 'botmux-schedule', 'botmux-handoff'])('preserves the explicit %s description', (name) => {
    const description = 'CUSTOM_TRIGGER <fixture> & explicit user rules';
    setSkillOverrideBody(name, `---\nname: ${name}\ndescription: ${description}\n---\nUSER_BODY`);
    const entries = builtinSkillEntries({ asksViaHook: false, excludeRoutingCovered: true });
    const block = buildBuiltinSkillCatalogBlock(entries);
    expect(block).toContain('CUSTOM_TRIGGER &lt;fixture&gt; &amp; explicit user rules');
    expect(builtinSkillContent(name)).toContain('USER_BODY');
  });
});

describe('buildNewTopicPrompt built-in skill delivery (antigravity)', () => {
  // agy 1.5.x loads ~/.gemini/config/skills; before, agy sessions got no
  // built-in skill at all — not even the botmux-ask fallback for when its
  // ask_question hook cannot take a question.
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-prompt-mode-agy-'));
    vi.stubEnv('HOME', home);
    invalidateGlobalConfigCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    rmSync(home, { recursive: true, force: true });
  });

  it('prompt mode (default) advertises botmux-ask and the other built-ins', () => {
    const p = buildNewTopicPrompt('hi', 'sess-agy', 'antigravity');
    expect(p).toContain('<botmux_builtin_skills>');
    expect(p).toContain('- botmux-ask:');
    expect(p).toContain('- botmux-schedule:');
  });

  it('global mode installs into the directory agy reads instead of inlining', () => {
    writeConfig({ skills: { builtinInjection: 'global' } });
    expect(buildNewTopicPrompt('hi', 'sess-agy', 'antigravity')).not.toContain('<botmux_builtin_skills>');
    writeBots([{ larkAppId: 'cli_app_agy', larkAppSecret: 's', cliId: 'antigravity' }], home);
    expect(shouldInstallGlobalSkills(join(home, '.gemini', 'config', 'skills'))).toBe(true);
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
  const remotePrompt = () => buildNewTopicPrompt(
    'hi', 'sess-remote', 'remote-runner', undefined, undefined, undefined, undefined, undefined,
    { name: 'Bot', openId: 'ou_bot' }, 'en', undefined,
    { larkAppId: APP, chatId: 'oc_remote', sessionBackendType: 'remote-runner' },
  );

  it('prompt mode (default) inlines complex send discovery plus additional skills', () => {
    const p = prompt();
    expect(p).toContain('<botmux_builtin_skills>');
    expect(p).toContain('botmux skill show &lt;name&gt;');
    expect(p).toContain('- botmux-schedule:');
    expect(p).toContain('- botmux-send:');
    expect(p).toContain('首次复杂飞书发送前读取');
    expect(p).not.toContain('- botmux-history:');
    expect(p).not.toContain('botmux --help');
  });

  it('prompt mode exposes the same compact send trigger on genius/grok system-prompt path', () => {
    const block = builtinSkillBlockForInjectsSessionContext(undefined, 'en');
    expect(block).toContain('- botmux-send:');
    expect(block).toContain('Read once before the first complex Lark send');
    expect(block).toContain('JSON.stringify');
    expect(block).toContain('JSON-escaped \\n as literal text');
  });

  it('off mode wraps the help pointer in the same block, no skill list', () => {
    writeConfig({ skills: { builtinInjection: 'off' } });
    const p = prompt();
    expect(p).toContain('<botmux_builtin_skills>');    // XML-wrapped, not a bare line
    expect(p).toContain('botmux --help');
    expect(p).not.toContain('- botmux-schedule:');     // no catalog list in off mode
    expect(p).not.toContain('- botmux-send:');
  });

  it('global mode injects neither catalog nor help pointer (native install handles it)', () => {
    writeConfig({ skills: { builtinInjection: 'global' } });
    const p = prompt();
    expect(p).not.toContain('<botmux_builtin_skills>');
    expect(p).not.toContain('botmux --help');
    expect(p).not.toContain('- botmux-send:');
  });

  it.each(['off', 'global'] as const)(
    'Remote Runner forces only the schedule metadata even when builtin injection is %s',
    mode => {
      writeConfig({ skills: { builtinInjection: mode } });
      const p = remotePrompt();
      expect(p).toContain('- botmux-schedule:');
      expect(p).toContain('temporary Remote Runner environment');
      expect(p).not.toContain('- botmux-send:');
      expect(p).not.toContain('- botmux-ask:');
    },
  );
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
