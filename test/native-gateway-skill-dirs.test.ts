// Must stay the first import: the spawn path below writes under HOME / the data dir.
import './helpers/require-fenced-data-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ensureCliEnv, sweepGlobalBotmuxSkills } from '../src/core/worker-pool.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';

/**
 * The skill dirs botmux materialises are keyed by HOME, so the Feishu fleet and
 * a native IM gateway's dedicated core on the same host share them. That core
 * must leave them exactly as the fleet left them, and must not point its CLIs
 * at them. A bare core-only service (no native gateway) keeps today's behaviour,
 * which is what makes the fixtures below sensitive at all.
 */
const APP = 'local_wecom_skilldirs';

function enter(mode: 'native' | 'bare-core', cli: string): void {
  vi.stubEnv('BOTMUX_CORE_ONLY', '1');
  vi.stubEnv('BOTMUX_API_ONLY_BOT', APP);
  vi.stubEnv('BOTMUX_CORE_BOT_CONFIG', '{}');
  vi.stubEnv('BOTMUX_CORE_CLI', cli);
  vi.stubEnv('BOTMUX_CORE_SKIP_DOTENV', '1');
  if (mode === 'native') vi.stubEnv('BOTMUX_NATIVE_GATEWAY_CORE', '1');
}

let codexHome: string;
const pluginDir = () => join(homedir(), '.botmux', 'claude-plugin');
const sharedDirs = () => [pluginDir(), join(homedir(), '.claude', 'skills'), join(codexHome, 'skills')];

function seedSkill(dir: string, name: string, body = 'fixture'): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${body}\n---\n${body}\n`);
}

/** Every file under the shared dirs: relative path -> sha256. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (root: string, dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(root, p);
      else out[`${root}:${relative(root, p)}`] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  for (const root of sharedDirs()) walk(root, root);
  return out;
}

beforeEach(() => {
  codexHome = mkdtempSync(join(tmpdir(), 'botmux-native-skills-codex-'));
  vi.stubEnv('CODEX_HOME', codexHome);
  for (const root of sharedDirs()) rmSync(root, { recursive: true, force: true });
  // What a Feishu fleet leaves behind: a fleet-only skill in the plugin dir, a
  // body the fleet customised, botmux skills of a global-mode codex bot, a
  // botmux leftover in ~/.claude/skills, and user skills.
  seedSkill(join(pluginDir(), 'skills'), 'botmux-chat-manager', 'fleet enabled this');
  seedSkill(join(pluginDir(), 'skills'), 'botmux-history', 'fleet customised body');
  seedSkill(join(homedir(), '.claude', 'skills'), 'botmux-legacy-leftover');
  seedSkill(join(homedir(), '.claude', 'skills'), 'my-claude-skill');
  seedSkill(join(codexHome, 'skills'), 'botmux-send', 'fleet global mode');
  seedSkill(join(codexHome, 'skills'), 'my-codex-skill');
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of sharedDirs()) rmSync(root, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
});

describe('shared skill dirs across a native gateway core spawn', () => {
  it.each(['claude-code', 'codex'])('a native core spawn of %s leaves them byte-identical', (cli) => {
    enter('native', cli);
    const before = snapshot();
    ensureCliEnv(cli as any);
    sweepGlobalBotmuxSkills();
    expect(snapshot()).toEqual(before);
  });

  it.each(['claude-code', 'codex'])('a bare core spawn of %s still rewrites or prunes them (fixture is sensitive)', (cli) => {
    enter('bare-core', cli);
    const before = snapshot();
    ensureCliEnv(cli as any);
    sweepGlobalBotmuxSkills();
    expect(snapshot()).not.toEqual(before);
  });
});

describe('built-in skill dirs on the spawn argv', () => {
  const argv = (cli: string, skillPluginDir?: string) => createCliAdapterSync(cli as any).buildArgs({
    sessionId: '00000000-0000-4000-8000-000000000001', resume: false, workingDir: tmpdir(),
    botName: APP, botOpenId: `bot_${APP}`, larkAppId: APP, noTransport: true, locale: 'zh',
    promptInjection: 'default', hideLocalAddresses: false, disableCliBypass: false, skillPluginDir,
  } as any) as string[];
  const valuesOf = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  const shared = (dir: string) => dir.startsWith(join(homedir(), '.botmux'));

  it.each([
    ['claude-code', '--plugin-dir'],
    ['cursor', '--plugin-dir'],
    ['oh-my-pi', '--plugin-dir'],
    ['pi', '--skill'],
  ])('%s gets no shared built-in dir in a native core, only the bot\'s own skills', (cli, flag) => {
    const own = join(tmpdir(), 'bot-own-skills');
    enter('bare-core', cli);
    expect(valuesOf(argv(cli, own), flag).some(shared)).toBe(true);
    enter('native', cli);
    const native = valuesOf(argv(cli, own), flag);
    expect(native.some(shared)).toBe(false);
    expect(native).toContain(own);
  });
});
