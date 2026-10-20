import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CliAdapter } from '../src/adapters/cli/types.js';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { prepareCliPluginGeneration } from '../src/core/plugins/cli-generation.js';
import {
  readSessionMcpRuntimeManifest,
  sessionMcpRuntimeHostOnlyPaths,
  sessionMcpRuntimeManifestPath,
} from '../src/core/plugins/mcp/session-runtime.js';
import { pluginMcpPrivatePath } from '../src/core/plugins/paths.js';
import { readSessionPluginManifest } from '../src/core/plugins/session-manifest.js';
import { readSessionSkillManifest, sessionSkillManifestPath } from '../src/core/skills/manifest-store.js';
import { installLocalSkill } from '../src/services/skill-registry-store.js';
import { accessForPath, buildFsPolicy } from '../src/adapters/cli/fs-policy.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('CLI plugin generation', () => {
  let home: string;
  let dataDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-plugin-generation-'));
    dataDir = join(home, '.botmux', 'data');
    vi.stubEnv('HOME', home);
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('zero injection emits no replacement or deferred skill catalog on resume', () => {
    for (const prompt of ['', '只运行测试']) {
      const result = prepareCliPluginGeneration({ sessionId: 'zero', bot: { larkAppId: 'sub' },
        cliId: 'claude-code', adapter: { id: 'claude-code' } as CliAdapter,
        workingDir: home, dataDir, global: { plugins: [] }, prompt,
        replacesPriorGeneration: true, promptInjection: 'none' });
      expect(result.prompt).toBe(prompt);
      expect(result.skillCatalog).toBeUndefined();
      expect(result.skillPluginDir).toBeUndefined();
      expect(result.deferredSkillCatalog).toBeUndefined();
      expect(readSessionSkillManifest('zero')).toBeNull();
    }
  });

  it('protects shared global skills for every CLI using the common spawn preparation', () => {
    const skillsDir = join(home, '.shared', 'skills');
    const shared = join(skillsDir, 'botmux-send', 'SKILL.md');
    const user = join(skillsDir, 'user-skill', 'SKILL.md');
    write(shared, 'shared rules');
    write(user, 'native user skill');
    const opts = { sessionId: 'sub', bot: { larkAppId: 'sub' }, cliId: 'traex' as const,
      adapter: { id: 'traex', skillsDir } as CliAdapter, workingDir: home,
      dataDir, global: { plugins: [] }, prompt: 'task', replacesPriorGeneration: false,
      promptInjection: 'none' as const };
    expect(() => prepareCliPluginGeneration(opts)).toThrow('全局 botmux 技能');
    expect(existsSync(shared)).toBe(true);
    expect(existsSync(user)).toBe(true);
    rmSync(join(skillsDir, 'botmux-send'), { recursive: true });
    expect(prepareCliPluginGeneration(opts).prompt).toBe('task');
    expect(existsSync(user)).toBe(true);
  });

  it('replaces Skills and MCP plugin bindings when the same session starts a new CLI process', () => {
    const source = join(home, 'demo-source');
    write(join(source, 'package.json'), JSON.stringify({
      name: '@botmux-ai/plugin-demo',
      version: '0.1.0',
      keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id: 'demo' },
    }));
    write(join(source, 'dist', 'skills', 'browser', 'SKILL.md'), [
      '---',
      'name: browser',
      'description: Browser tools',
      '---',
      '# Browser',
    ].join('\n'));
    write(join(source, 'dist', 'mcp', 'index.json'), JSON.stringify({
      transport: 'stdio',
      command: ['./mcp/server.mjs'],
    }));
    write(join(source, 'dist', 'mcp', 'server.mjs'), 'process.exit(0);\n');
    installLocalPlugin(source);
    const adapter = { id: 'codex' } as CliAdapter;

    const first = prepareCliPluginGeneration({
      sessionId: 'same-session',
      bot: { larkAppId: 'app-1', plugins: ['demo'] },
      global: { plugins: [] },
      dataDir,
      cliId: 'codex',
      adapter,
      workingDir: '/repo',
      prompt: 'first turn',
      replacesPriorGeneration: false,
      now: () => '2026-07-12T00:00:00.000Z',
    });
    expect(first.pluginManifest.pluginIds).toEqual(['demo']);
    expect(first.prompt).toContain('botmux skill show browser');
    expect(first.skillCatalog).toContain('botmux skill show browser');
    expect(readSessionSkillManifest('same-session')?.prioritySkills.map(skill => skill.name)).toEqual(['browser']);
    const firstMcpRuntime = readSessionMcpRuntimeManifest('same-session', dataDir);
    expect(firstMcpRuntime).toMatchObject({
      sessionId: 'same-session',
      pluginIds: ['demo'],
      entries: [{
        pluginId: 'demo',
        server: { transport: 'stdio', command: ['./mcp/server.mjs'] },
      }],
    });
    if (!firstMcpRuntime) throw new Error('expected session MCP runtime manifest');
    expect(sessionMcpRuntimeHostOnlyPaths(firstMcpRuntime, dataDir)).toEqual([
      sessionMcpRuntimeManifestPath('same-session', dataDir),
      pluginMcpPrivatePath('demo'),
      join(home, '.botmux', 'plugins', 'demo', 'dist', 'mcp', 'index.json'),
    ]);
    expect('mcpReadonlyRoots' in first).toBe(false);
    expect('mcpHidePaths' in first).toBe(false);

    const refreshed = prepareCliPluginGeneration({
      sessionId: 'same-session',
      bot: { larkAppId: 'app-1', plugins: [] },
      global: { plugins: [] },
      dataDir,
      cliId: 'codex',
      adapter,
      workingDir: '/repo',
      prompt: 'after restart',
      replacesPriorGeneration: true,
      now: () => '2026-07-12T01:00:00.000Z',
    });
    expect(refreshed.pluginManifest.pluginIds).toEqual([]);
    expect(refreshed.prompt).toContain('<botmux_skills_refresh>');
    expect(refreshed.skillCatalog).toContain('<botmux_skills_refresh>');
    expect(refreshed.prompt).toContain('Skills not listed here are no longer available');
    expect(readSessionPluginManifest('same-session', dataDir)?.pluginIds).toEqual([]);
    expect(readSessionSkillManifest('same-session')).toBeNull();
    expect(readSessionMcpRuntimeManifest('same-session', dataDir)).toMatchObject({
      pluginIds: [],
      entries: [],
    });
    const refreshedMcpRuntime = readSessionMcpRuntimeManifest('same-session', dataDir);
    if (!refreshedMcpRuntime) throw new Error('expected refreshed session MCP runtime manifest');
    expect(sessionMcpRuntimeHostOnlyPaths(refreshedMcpRuntime, dataDir)).toEqual([
      sessionMcpRuntimeManifestPath('same-session', dataDir),
    ]);
  });
  it('hands the sandbox only this session\'s snapshot of exactly the enabled skills', () => {
    // Two installed skills; the bot enables one. Under sandbox=true the worker
    // feeds skillReadonlyRoots into fs-policy's sessionOwnedReadonlyRoots: it
    // must be the session's own snapshot root — never the store or a skill dir.
    const src = join(home, 'skill-src');
    for (const name of ['deploy', 'payroll']) {
      write(join(src, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}`);
      installLocalSkill(join(src, name), { link: false });
    }
    for (const [cliId, adapter] of [
      ['codex', { id: 'codex' } as CliAdapter],
      ['claude-code', { id: 'claude-code', skillDelivery: { nativeKind: 'claude-plugin' } } as CliAdapter],
    ] as const) {
      const result = prepareCliPluginGeneration({
        sessionId: 'roots',
        bot: { larkAppId: 'app-1', skills: { include: ['skill:deploy'] } },
        global: { plugins: [] },
        dataDir,
        cliId,
        adapter,
        workingDir: join(home, 'proj'),
        prompt: 'task',
        replacesPriorGeneration: false,
      });
      const snapshot = realpathSync(join(dataDir, 'runtime-skills', 'roots', 'snapshot'));
      const storeRoot = realpathSync(join(home, '.botmux', 'skills', 'store'));
      expect(result.skillReadonlyRoots).toContain(snapshot);
      for (const forbidden of [storeRoot, join(storeRoot, 'deploy'), join(storeRoot, 'payroll')]) {
        expect(result.skillReadonlyRoots).not.toContain(forbidden);
      }
      expect(readdirSync(snapshot)).toEqual(['deploy']);
      const manifest = readSessionSkillManifest('roots');
      expect(manifest?.prioritySkills.map(skill => [skill.name, skill.rootDir, skill.snapshotOf]))
        .toEqual([['deploy', join(snapshot, 'deploy'), join(storeRoot, 'deploy')]]);
      expect(existsSync(sessionSkillManifestPath('roots', dataDir))).toBe(true);
    }
    // workingDir = ~ (the default when a bot configures none) contains the
    // store, but it is no credential location: the store skill still snapshots.
    const wide = prepareCliPluginGeneration({
      sessionId: 'wide', bot: { larkAppId: 'app-1', skills: { include: ['skill:deploy'] } },
      global: { plugins: [] }, dataDir, cliId: 'codex', adapter: { id: 'codex' } as CliAdapter,
      workingDir: home, prompt: 'task', replacesPriorGeneration: false,
    });
    const wideSnapshot = realpathSync(join(dataDir, 'runtime-skills', 'wide', 'snapshot'));
    expect(wide.skillReadonlyRoots).toEqual([wideSnapshot]);
    expect(readdirSync(wideSnapshot)).toEqual(['deploy']);
    expect(readSessionSkillManifest('wide')?.diagnostics).toEqual([]);
    expect(wide.diagnostics.join('\n')).not.toContain('skill_snapshot');
  });

  it('review repros: only the store skill is snapshotted — linked skills (sibling bot home, host ~/.claude, aliased ~/.ssh, working-dir link) are never copied and no credential is in reach (generation → fs-policy)', () => {
    const realHome = realpathSync(home);
    const botmux = join(realHome, '.botmux');
    const sibling = join(botmux, 'bots', 'cli_sibling');
    write(join(sibling, 'send-cred.json'), '{"appSecret":"SIBLING-SECRET"}');
    write(join(sibling, 'SKILL.md'), '---\nname: sibhome\n---\n# planted in the sibling home');
    write(join(realHome, '.claude', '.credentials.json'), '{"token":"HOST-CLAUDE-SECRET"}');
    write(join(realHome, '.claude', 'SKILL.md'), '---\nname: hostclaude\n---\n# root');
    write(join(realHome, 'proj', '.shared', 'wd', 'SKILL.md'), '---\nname: wdlink\n---\n# agent-writable');
    write(join(realHome, 'skill-src', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\n# Deploy');
    installLocalSkill(join(realHome, 'skill-src', 'deploy'), { link: false });
    // The alias target lives OUTSIDE home, like a real `~/.ssh -> /vault/ssh`.
    const vault = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-vault-')));
    try {
      write(join(vault, 'ssh', 'id_rsa'), 'PRIVATE-KEY-SECRET');
      write(join(vault, 'ssh', 'SKILL.md'), '---\nname: vaultssh\n---\n# planted');
      symlinkSync(join(vault, 'ssh'), join(realHome, '.ssh'));
      for (const dir of [sibling, join(realHome, '.claude'), join(vault, 'ssh'), join(realHome, 'proj', '.shared', 'wd')]) {
        installLocalSkill(dir, { link: true });
      }
      const result = prepareCliPluginGeneration({
        sessionId: 'linked',
        bot: { larkAppId: 'cli_self', skills: { include: ['skill:deploy', 'skill:sibhome', 'skill:hostclaude', 'skill:vaultssh', 'skill:wdlink'] } },
        global: { plugins: [] },
        dataDir,
        cliId: 'codex',
        adapter: { id: 'codex' } as CliAdapter,
        workingDir: join(realHome, 'proj'),
        prompt: 'task',
        replacesPriorGeneration: false,
      });
      const manifest = readSessionSkillManifest('linked');
      const snapshot = realpathSync(join(dataDir, 'runtime-skills', 'linked', 'snapshot'));
      // Catalog unchanged; only the store skill points into the snapshot.
      expect(manifest?.prioritySkills.map(skill => [skill.name, !!skill.snapshotOf]).sort()).toEqual([
        ['deploy', true], ['hostclaude', false], ['sibhome', false], ['vaultssh', false], ['wdlink', false],
      ]);
      expect(readdirSync(snapshot)).toEqual(['deploy']);
      const contents = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
        .flatMap(e => e.isDirectory() ? contents(join(dir, e.name)) : [readFileSync(join(dir, e.name), 'utf-8')]);
      expect(contents(join(dataDir, 'runtime-skills', 'linked')).join('\n')).not.toMatch(/SECRET|agent-writable|planted/);
      // Only the session snapshot reaches the sandbox, so the credentials stay
      // unreachable under the real policy, with or without a Lark transport…
      const roots = result.skillReadonlyRoots ?? [];
      expect(roots).toEqual([snapshot]);
      for (const larkTransportEnabled of [true, false]) {
        const policy = buildFsPolicy({
          platform: 'linux', homeDir: realHome, botmuxHome: botmux, sessionDataDir: realpathSync(dataDir),
          sessionId: 'linked', workingDir: join(realHome, 'proj'), currentAppId: 'cli_self',
          botHome: join(botmux, 'bots', 'cli_self'), redirectedCliData: true, larkTransportEnabled,
          sessionOwnedReadonlyRoots: roots,
        });
        for (const secret of [join(sibling, 'send-cred.json'), join(realHome, '.claude', '.credentials.json'),
          join(vault, 'ssh', 'id_rsa'), join(realHome, '.ssh', 'id_rsa')]) {
          expect(accessForPath(policy.rules, secret).access, `${secret} transport=${larkTransportEnabled}`).not.toMatch(/readOnly|readWrite/);
        }
        expect(accessForPath(policy.rules, join(snapshot, 'deploy', 'SKILL.md')).access).toBe('readOnly');
      }
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
