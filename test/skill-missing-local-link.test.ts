import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { prepareCliPluginGeneration } from '../src/core/plugins/cli-generation.js';
import { isVersionedPluginCachePath } from '../src/core/skills/cache-path.js';
import { prepareClaudeSkillPlugin } from '../src/core/skills/claude-plugin-delivery.js';
import { runSkillsAdminCommand } from '../src/core/skills/cli-admin-command.js';
import { runSkillSessionCommand } from '../src/core/skills/cli-session-command.js';
import { prepareSkillDelivery } from '../src/core/skills/delivery.js';
import { readSessionSkillManifest, writeSessionSkillManifest } from '../src/core/skills/manifest-store.js';
import { prepareSessionSkillPrompt } from '../src/core/skills/session-runtime.js';
import { prepareSkillRootDelivery } from '../src/core/skills/skill-root-delivery.js';
import {
  classifyMaterializationCopyError,
  formatSkillMaterializationError,
  inspectSkillSourceHealth,
} from '../src/core/skills/source-health.js';
import type { SessionSkillManifest } from '../src/core/skills/types.js';
import { installLocalSkill, installLocalSkillCopies, readSkillRegistry } from '../src/services/skill-registry-store.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('missing local-link skill resilience (#3966)', () => {
  let home: string;
  let dataDir: string;
  let cacheRoot: string;
  let storeSrc: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-3966-home-')));
    dataDir = join(home, '.botmux', 'data');
    cacheRoot = join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'superpowers', '7.0.0', 'skills');
    storeSrc = join(home, 'local-src');
    vi.stubEnv('HOME', home);
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('skips a single missing local-link skill on Claude cold start, delivers intact skills, and emits actionable diagnostics + warning', () => {
    const brokenSkillDir = join(cacheRoot, 'writing-skills');
    const intactCopyDir = join(storeSrc, 'deploy');
    write(join(brokenSkillDir, 'SKILL.md'), '---\nname: writing-skills\ndescription: Author skills\n---\n# Writing');
    write(join(intactCopyDir, 'SKILL.md'), '---\nname: deploy\ndescription: Deploy services\n---\n# Deploy');
    installLocalSkill(brokenSkillDir, { link: true });
    installLocalSkill(intactCopyDir, { link: false });

    // Simulate Claude plugin upgrade removing old 7.0.0 cache directory.
    rmSync(join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'superpowers', '7.0.0'), {
      recursive: true,
      force: true,
    });

    const result = prepareCliPluginGeneration({
      sessionId: 'claude-single-missing',
      bot: {
        larkAppId: 'app-claude',
        skills: { include: ['skill:writing-skills', 'skill:deploy'] },
      },
      global: { plugins: [] },
      dataDir,
      cliId: 'claude-code',
      adapter: createCliAdapterSync('claude-code'),
      workingDir: join(home, 'repo'),
      prompt: 'hello',
      replacesPriorGeneration: false,
      locale: 'zh',
    });

    expect(result.fatal).toBeFalsy();
    expect(result.skillPluginDir).toBeDefined();
    expect(existsSync(join(result.skillPluginDir!, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(readFileSync(join(result.skillPluginDir!, 'skills', 'deploy', 'SKILL.md'), 'utf-8')).toContain('# Deploy');
    expect(existsSync(join(result.skillPluginDir!, 'skills', 'writing-skills'))).toBe(false);

    // Prompt catalog and persisted manifest advertise only the intact skill.
    expect(result.prompt).toContain('botmux skill show deploy');
    expect(result.prompt).not.toContain('writing-skills');
    const manifest = readSessionSkillManifest('claude-single-missing');
    expect(manifest?.prioritySkills.map(s => s.name)).toEqual(['deploy']);
    expect(manifest?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: 'warn',
        code: 'skill_source_missing',
        skillName: 'writing-skills',
      }),
    ]));

    // Structured unavailable list, worker diagnostics, and user-facing warning
    // all name the skill, missing path, and copy-mode reinstall fix.
    expect(result.unavailableSkills).toEqual([
      expect.objectContaining({
        name: 'writing-skills',
        sourceType: 'local-link',
        sourcePath: brokenSkillDir,
        reason: 'missing_root',
      }),
    ]);
    expect(result.diagnostics.join('\n')).toContain('writing-skills');
    expect(result.diagnostics.join('\n')).toContain(brokenSkillDir);
    expect(result.diagnostics.join('\n')).toContain('botmux skills install');
    expect(result.userWarnings).toHaveLength(1);
    expect(result.userWarnings![0]).toContain('writing-skills');
    expect(result.userWarnings![0]).toContain(brokenSkillDir);
    expect(result.userWarnings![0]).toContain('botmux skills install');
    expect(result.userWarnings![0]).toContain('botmux skills doctor');

    // Querying the skipped skill inside the session explains why it was skipped.
    const showSkipped = runSkillSessionCommand(['show', 'writing-skills'], {
      BOTMUX_SESSION_ID: 'claude-single-missing',
    });
    expect(showSkipped.code).toBe(1);
    expect(showSkipped.stderr).toContain('writing-skills');
    expect(showSkipped.stderr).toContain(brokenSkillDir);
  });

  it('collects all 15 broken local-link skills without stopping at the first, both with and without intact siblings', () => {
    const brokenNames = Array.from({ length: 15 }, (_, index) => `superpower-${String(index + 1).padStart(2, '0')}`);
    for (const name of brokenNames) {
      const dir = join(cacheRoot, name);
      write(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n# ${name}`);
      installLocalSkill(dir, { link: true });
    }
    const intactLinkDir = join(home, '.claude', 'skills', 'stable-helper');
    write(join(intactLinkDir, 'SKILL.md'), '---\nname: stable-helper\n---\n# Stable');
    installLocalSkill(intactLinkDir, { link: true });

    // Remove the entire versioned cache directory, breaking all 15 links at once.
    rmSync(join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'superpowers', '7.0.0'), {
      recursive: true,
      force: true,
    });

    // Case 1: 15 broken + 1 intact local-link.
    const mixed = prepareCliPluginGeneration({
      sessionId: 'claude-15-mixed',
      bot: {
        larkAppId: 'app-claude',
        skills: { include: [...brokenNames.map(n => `skill:${n}` as const), 'skill:stable-helper'] },
      },
      global: { plugins: [] },
      dataDir,
      cliId: 'claude-code',
      adapter: createCliAdapterSync('claude-code'),
      workingDir: join(home, 'repo'),
      prompt: 'run check',
      replacesPriorGeneration: false,
      locale: 'en',
    });

    expect(mixed.fatal).toBeFalsy();
    expect(mixed.unavailableSkills?.map(item => item.name)).toEqual(brokenNames);
    expect(mixed.skillPluginDir).toBeDefined();
    expect(readFileSync(join(mixed.skillPluginDir!, 'skills', 'stable-helper', 'SKILL.md'), 'utf-8')).toContain('# Stable');
    expect(mixed.userWarnings).toHaveLength(1);
    expect(mixed.userWarnings![0]).toContain('15');
    for (const name of brokenNames) {
      expect(mixed.userWarnings![0]).toContain(name);
    }
    expect(mixed.userWarnings![0]).toContain(join(cacheRoot, 'superpower-01'));
    expect(mixed.userWarnings![0]).toContain('botmux skills install');

    // Case 2: all 15 broken, 0 intact → session still starts cleanly with no broken plugin dir or stale manifest.
    const allBroken = prepareCliPluginGeneration({
      sessionId: 'claude-15-all-broken',
      bot: {
        larkAppId: 'app-claude',
        skills: { include: brokenNames.map(n => `skill:${n}` as const) },
      },
      global: { plugins: [] },
      dataDir,
      cliId: 'claude-code',
      adapter: createCliAdapterSync('claude-code'),
      workingDir: join(home, 'repo'),
      prompt: 'run check',
      replacesPriorGeneration: false,
    });

    expect(allBroken.fatal).toBeFalsy();
    expect(allBroken.prompt).toBe('run check');
    expect(allBroken.skillPluginDir).toBeUndefined();
    expect(allBroken.skillReadonlyRoots).toBeUndefined();
    expect(readSessionSkillManifest('claude-15-all-broken')).toBeNull();
    expect(allBroken.unavailableSkills?.map(item => item.name)).toEqual(brokenNames);
    expect(allBroken.userWarnings).toHaveLength(1);
    for (const name of brokenNames) {
      expect(allBroken.userWarnings![0]).toContain(name);
    }
  });

  it('defends direct prepareClaudeSkillPlugin, prepareSkillRootDelivery (Pi), and Codex prompt delivery against missing sources', () => {
    const goodDir = join(storeSrc, 'good');
    const missingDirA = join(cacheRoot, 'gone-a');
    const missingDirB = join(cacheRoot, 'gone-b');
    const noEntryDir = join(cacheRoot, 'no-entry');
    const fileAsRoot = join(cacheRoot, 'file-root');
    const danglingLinkDir = join(cacheRoot, 'dangling-link');
    write(join(goodDir, 'SKILL.md'), '---\nname: good\n---\n# Good');
    mkdirSync(noEntryDir, { recursive: true });
    write(fileAsRoot, 'not a directory');
    symlinkSync(join(cacheRoot, 'target-deleted'), danglingLinkDir);

    const makeManifest = (sessionId: string, cliId: SessionSkillManifest['cliId']): SessionSkillManifest => ({
      sessionId,
      cliId,
      workingDir: join(home, 'repo'),
      policyMode: 'priority',
      prioritySkills: [
        { id: 'gone-a', name: 'gone-a', tags: [], rootDir: missingDirA, entrypoint: 'SKILL.md', source: { type: 'local-link', path: missingDirA }, priorityReason: 'bot:include' },
        { id: 'no-entry', name: 'no-entry', tags: [], rootDir: noEntryDir, entrypoint: 'SKILL.md', source: { type: 'local-link', path: noEntryDir }, priorityReason: 'bot:include' },
        { id: 'file-root', name: 'file-root', tags: [], rootDir: fileAsRoot, entrypoint: 'SKILL.md', source: { type: 'local-link', path: fileAsRoot }, priorityReason: 'bot:include' },
        { id: 'dangling-link', name: 'dangling-link', tags: [], rootDir: danglingLinkDir, entrypoint: 'SKILL.md', source: { type: 'local-link', path: danglingLinkDir }, priorityReason: 'bot:include' },
        { id: 'good', name: 'good', tags: [], rootDir: goodDir, entrypoint: 'SKILL.md', source: { type: 'local-copy', originalPath: goodDir }, priorityReason: 'bot:include' },
        { id: 'gone-b', name: 'gone-b', tags: [], rootDir: missingDirB, entrypoint: 'SKILL.md', source: { type: 'local-link', path: missingDirB }, priorityReason: 'bot:include' },
      ],
      diagnostics: [],
      generatedAt: '2026-11-28T00:00:00.000Z',
    });

    // Direct prepareClaudeSkillPlugin call (e.g. bypassing session-runtime or TOCTOU).
    const claudePrepared = prepareClaudeSkillPlugin(makeManifest('direct-claude', 'claude-code'));
    expect(claudePrepared.deliveredSkills).toEqual(['good']);
    expect(claudePrepared.skippedSkills.map(item => [item.name, item.reason])).toEqual([
      ['gone-a', 'missing_root'],
      ['no-entry', 'missing_entrypoint'],
      ['file-root', 'root_not_directory'],
      ['dangling-link', 'missing_root'],
      ['gone-b', 'missing_root'],
    ]);
    expect(readFileSync(join(claudePrepared.pluginDir, 'skills', 'good', 'SKILL.md'), 'utf-8')).toContain('# Good');
    expect(claudePrepared.diagnostics).toHaveLength(5);

    // Direct Pi skill-root delivery via prepareSkillDelivery + prepareSkillRootDelivery.
    const piDelivered = prepareSkillDelivery(createCliAdapterSync('pi'), makeManifest('direct-pi', 'pi'), 'native');
    expect(piDelivered.fatal).toBeFalsy();
    expect(piDelivered.pluginDir).toBeDefined();
    expect(readFileSync(join(piDelivered.pluginDir!, 'good', 'SKILL.md'), 'utf-8')).toContain('# Good');
    expect(piDelivered.skippedSkills?.map(item => item.name)).toEqual(['gone-a', 'no-entry', 'file-root', 'dangling-link', 'gone-b']);

    // When every skill in a direct delivery call is missing, no empty pluginDir is exposed or left on disk.
    const allMissingManifest: SessionSkillManifest = {
      ...makeManifest('direct-all-missing', 'claude-code'),
      prioritySkills: makeManifest('direct-all-missing', 'claude-code').prioritySkills.filter(s => s.name !== 'good'),
    };
    const emptyClaudeDelivery = prepareSkillDelivery(createCliAdapterSync('claude-code'), allMissingManifest, 'auto');
    expect(emptyClaudeDelivery.fatal).toBeFalsy();
    expect(emptyClaudeDelivery.pluginDir).toBeUndefined();
    expect(emptyClaudeDelivery.skippedSkills).toHaveLength(5);
    expect(existsSync(join(dataDir, 'runtime-skills', 'direct-all-missing', 'claude-plugin'))).toBe(false);

    const directPiRoot = prepareSkillRootDelivery(allMissingManifest);
    expect(directPiRoot.deliveredSkills).toEqual([]);
    expect(directPiRoot.skippedSkills).toHaveLength(5);

    // Codex (prompt-only) also filters missing links out of manifest and catalog during preflight.
    const codexMissing = join(cacheRoot, 'codex-gone');
    write(join(codexMissing, 'SKILL.md'), '---\nname: codex-gone\n---\n# Gone');
    installLocalSkill(codexMissing, { link: true });
    installLocalSkill(goodDir, { link: false });
    rmSync(codexMissing, { recursive: true, force: true });

    const codexPrepared = prepareSessionSkillPrompt({
      sessionId: 'codex-preflight',
      cliId: 'codex',
      workingDir: join(home, 'repo'),
      prompt: 'task',
      botPolicy: { include: ['skill:codex-gone', 'skill:good'] },
    });
    expect(codexPrepared.prompt).toContain('botmux skill show good');
    expect(codexPrepared.prompt).not.toContain('codex-gone');
    expect(codexPrepared.unavailableSkills?.map(item => item.name)).toEqual(['codex-gone']);
  });

  it('keeps intact local-link and local-copy delivery working with zero regressions and preserves sandbox readonly root boundaries', () => {
    const linkedDir = join(home, '.claude', 'skills', 'intact-link');
    const copyDir = join(storeSrc, 'intact-copy');
    write(join(linkedDir, 'SKILL.md'), '---\nname: intact-link\ndescription: Linked\n---\n# Linked');
    write(join(linkedDir, 'references', 'guide.md'), '# Guide');
    write(join(copyDir, 'SKILL.md'), '---\nname: intact-copy\ndescription: Copied\n---\n# Copied');

    installLocalSkill(linkedDir, { link: true });
    installLocalSkill(copyDir, { link: false });

    const result = prepareCliPluginGeneration({
      sessionId: 'claude-intact',
      bot: {
        larkAppId: 'app-claude',
        skills: { include: ['skill:intact-link', 'skill:intact-copy'] },
      },
      global: { plugins: [] },
      dataDir,
      cliId: 'claude-code',
      adapter: createCliAdapterSync('claude-code'),
      workingDir: join(home, 'repo'),
      prompt: 'work',
      replacesPriorGeneration: false,
    });

    expect(result.fatal).toBeFalsy();
    expect(result.unavailableSkills).toBeUndefined();
    expect(result.userWarnings).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
    expect(result.skillPluginDir).toBeDefined();
    expect(readFileSync(join(result.skillPluginDir!, 'skills', 'intact-link', 'SKILL.md'), 'utf-8')).toContain('# Linked');
    expect(readFileSync(join(result.skillPluginDir!, 'skills', 'intact-link', 'references', 'guide.md'), 'utf-8')).toContain('# Guide');
    expect(readFileSync(join(result.skillPluginDir!, 'skills', 'intact-copy', 'SKILL.md'), 'utf-8')).toContain('# Copied');

    // Sandbox boundary: readonlyRoots only contains session-owned runtime dirs, never host linked dir.
    expect(result.skillReadonlyRoots).toContain(result.skillPluginDir);
    expect(result.skillReadonlyRoots).not.toContain(linkedDir);
    expect(result.skillReadonlyRoots).not.toContain(dirname(linkedDir));
  });

  it('keeps non-source materialization errors fail-closed with actionable diagnostics and preserves native-delivery fatal behavior', () => {
    const goodDir = join(storeSrc, 'healthy');
    write(join(goodDir, 'SKILL.md'), '---\nname: healthy\n---\n# Healthy');
    const healthySkill = {
      name: 'healthy',
      rootDir: goodDir,
      entrypoint: 'SKILL.md',
      source: { type: 'local-copy' as const, originalPath: goodDir },
    };
    const destParent = join(dataDir, 'runtime-skills', 's-err', 'claude-plugin', 'skills');
    mkdirSync(destParent, { recursive: true });

    expect(inspectSkillSourceHealth(healthySkill)).toEqual({ ok: true });
    // Disk-full (ENOSPC) and destination-side permission errors must NOT be swallowed as missing source.
    expect(classifyMaterializationCopyError(Object.assign(new Error('no space'), { code: 'ENOSPC' }), healthySkill, destParent)).toBeNull();
    expect(classifyMaterializationCopyError(
      Object.assign(new Error('dest denied'), { code: 'EACCES', path: join(destParent, 'healthy') }),
      healthySkill,
      destParent,
    )).toBeNull();
    const wrapped = formatSkillMaterializationError(healthySkill, new Error('ENOSPC: no space left on device'));
    expect(wrapped.message).toContain('healthy');
    expect(wrapped.message).toContain(goodDir);
    expect(wrapped.message).toContain('botmux skills doctor');

    // Existing fail-closed contract: `delivery: 'native'` on a CLI without native support stays fatal.
    installLocalSkill(goodDir, { link: false });
    const fatalResult = prepareSkillDelivery(
      createCliAdapterSync('codex'),
      prepareSessionSkillPrompt({
        sessionId: 'codex-native-fatal',
        cliId: 'codex',
        workingDir: join(home, 'repo'),
        prompt: 'hello',
        botPolicy: { include: ['skill:healthy'] },
      }).manifest,
      'native',
    );
    expect(fatalResult.fatal).toBe(true);
    expect(fatalResult.diagnostics).toContain('native_skill_delivery_not_supported');
  });

  it('emits user_notify from worker refreshCliPluginGeneration when skills are skipped without blocking startup', () => {
    const sent: any[] = [];
    const logs: string[] = [];
    const scope = {
      lastInitConfig: undefined,
      traexAutoModelRuntimeEligible: () => false,
      deliveredPluginSkillCatalogFingerprint: undefined,
      deferredPluginSkillCatalog: null,
      deferredPluginSkillCatalogDigest: undefined,
      deferredPluginSkillCatalogFingerprint: undefined,
      resolvePluginGenerationBot: () => ({ larkAppId: 'app-claude' }),
      readGlobalConfig: () => ({}),
      prepareCliPluginGeneration: vi.fn(() => ({
        pluginManifest: { pluginIds: [] },
        prompt: 'hello',
        skillPluginDir: '/tmp/session-plugin',
        skillReadonlyRoots: ['/tmp/session-plugin'],
        diagnostics: ['skill_source:skill "writing-skills" (local-link) skipped: missing_root'],
        userWarnings: ['⚠️ 已跳过 1 个源路径失效的 Skill：writing-skills'],
      })),
      config: { session: { dataDir } },
      codexRpcEligible: () => false,
      sandboxEnabled: () => false,
      log: (msg: string) => logs.push(msg),
      send: (msg: any) => sent.push(msg),
    };
    const cfg: any = {
      sessionId: 's-worker-warn',
      cliId: 'claude-code',
      workingDir: join(home, 'repo'),
      prompt: 'hello',
      turnId: 'turn-1',
      locale: 'zh',
    };

    loadWorkerFunction<(cfg: any, adapter: any) => void>('refreshCliPluginGeneration', scope)(
      cfg,
      { id: 'claude-code' },
    );

    expect(cfg.skillPluginDir).toBe('/tmp/session-plugin');
    expect(logs.some(line => line.includes('writing-skills'))).toBe(true);
    expect(sent).toEqual([
      {
        type: 'user_notify',
        message: '⚠️ 已跳过 1 个源路径失效的 Skill：writing-skills',
        turnId: 'turn-1',
      },
    ]);
  });

  it('explains post-start disappearance of a non-sandboxed local-link skill in `botmux skill show`', () => {
    const linkedDir = join(cacheRoot, 'vanished-later');
    write(join(linkedDir, 'SKILL.md'), '---\nname: vanished-later\n---\n# Later');
    writeSessionSkillManifest({
      sessionId: 's-vanished-later',
      cliId: 'claude-code',
      workingDir: join(home, 'repo'),
      policyMode: 'priority',
      prioritySkills: [{
        id: 'vanished-later',
        name: 'vanished-later',
        tags: [],
        rootDir: linkedDir,
        entrypoint: 'SKILL.md',
        source: { type: 'local-link', path: linkedDir },
        priorityReason: 'bot:include',
      }],
      diagnostics: [],
      generatedAt: '2026-11-28T00:00:00.000Z',
    });
    rmSync(linkedDir, { recursive: true, force: true });

    const res = runSkillSessionCommand(['show', 'vanished-later'], {
      BOTMUX_SESSION_ID: 's-vanished-later',
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('vanished-later');
    expect(res.stderr).toContain(linkedDir);
    expect(res.stderr).toContain('botmux skills install');
  });

  it('warns on CLI --link into versioned plugin cache and supports batch copy registration into the managed store', () => {
    const skillA = join(cacheRoot, 'writing-skills');
    const skillB = join(cacheRoot, 'debugging');
    write(join(skillA, 'SKILL.md'), '---\nname: writing-skills\n---\n# Writing');
    write(join(skillB, 'SKILL.md'), '---\nname: debugging\n---\n# Debugging');

    expect(isVersionedPluginCachePath(skillA)).toBe(true);
    expect(isVersionedPluginCachePath('C:\\Users\\me\\.claude\\plugins\\cache\\mkt\\p\\1.0\\skills\\x')).toBe(true);
    expect(isVersionedPluginCachePath(join(home, '.claude', 'skills', 'stable'))).toBe(false);
    expect(isVersionedPluginCachePath(join(home, '.claude', 'plugins', 'marketplaces', 'mp', 'skills', 'pdf'))).toBe(false);
    expect(isVersionedPluginCachePath('/repo/plugins/cache-helper/skills/foo')).toBe(false);

    // CLI `--link` still succeeds (backward compatible) but warns on stderr.
    const linked = runSkillsAdminCommand(['install', skillA, '--link']);
    expect(linked.code).toBe(0);
    expect(linked.stdout).toContain('installed writing-skills');
    expect(linked.stderr).toContain('versioned plugin cache');
    expect(linked.stderr).toContain('writing-skills');

    // Batch copy registration copies skills into ~/.botmux/skills/store so removing
    // the plugin cache version later does NOT break session startup.
    const copied = installLocalSkillCopies([skillA, skillB]);
    expect(copied.map(pkg => [pkg.name, pkg.source.type])).toEqual([
      ['writing-skills', 'local-copy'],
      ['debugging', 'local-copy'],
    ]);
    expect(readSkillRegistry().skills['writing-skills'].rootDir).toContain(join('.botmux', 'skills', 'store', 'writing-skills'));

    rmSync(join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'superpowers', '7.0.0'), {
      recursive: true,
      force: true,
    });

    const afterCleanup = prepareCliPluginGeneration({
      sessionId: 'claude-after-copy',
      bot: {
        larkAppId: 'app-claude',
        skills: { include: ['skill:writing-skills', 'skill:debugging'] },
      },
      global: { plugins: [] },
      dataDir,
      cliId: 'claude-code',
      adapter: createCliAdapterSync('claude-code'),
      workingDir: join(home, 'repo'),
      prompt: 'ready',
      replacesPriorGeneration: false,
    });
    expect(afterCleanup.fatal).toBeFalsy();
    expect(afterCleanup.unavailableSkills).toBeUndefined();
    expect(readFileSync(join(afterCleanup.skillPluginDir!, 'skills', 'writing-skills', 'SKILL.md'), 'utf-8')).toContain('# Writing');
    expect(readFileSync(join(afterCleanup.skillPluginDir!, 'skills', 'debugging', 'SKILL.md'), 'utf-8')).toContain('# Debugging');
  });
});
