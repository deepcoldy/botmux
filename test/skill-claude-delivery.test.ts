import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { prepareClaudeSkillPlugin } from '../src/core/skills/claude-plugin-delivery.js';
import { prepareSkillDelivery } from '../src/core/skills/delivery.js';
import type { SessionSkillManifest } from '../src/core/skills/types.js';
import { snapshotSessionSkills, type SkillSnapshotTrust } from '../src/core/skills/snapshot.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('Claude scoped skill delivery', () => {
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-skill-plugin-'));
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-data-'));
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('materializes selected skills into a Claude plugin root', () => {
    write(join(root, 'deploy', 'SKILL.md'), '# Deploy');
    const manifest: SessionSkillManifest = {
      sessionId: 's1',
      cliId: 'claude-code',
      workingDir: '/repo',
      policyMode: 'priority',
      prioritySkills: [{
        id: 'deploy',
        name: 'deploy',
        tags: [],
        rootDir: join(root, 'deploy'),
        entrypoint: 'SKILL.md',
        source: { type: 'user', root: join(root, 'deploy') },
        priorityReason: 'bot:include',
      }],
      diagnostics: [],
      generatedAt: '2026-06-14T00:00:00.000Z',
    };

    const prepared = prepareClaudeSkillPlugin(manifest);

    expect(readFileSync(join(prepared.pluginDir, '.claude-plugin', 'plugin.json'), 'utf-8')).toContain('"name": "botmux-session-skills"');
    expect(readFileSync(join(prepared.pluginDir, 'skills', 'deploy', 'SKILL.md'), 'utf-8')).toContain('# Deploy');
  });

  it('Claude adapter appends the session skill plugin dir without replacing botmux plugin dir', () => {
    const adapter = createCliAdapterSync('claude-code');
    const args = adapter.buildArgs({ sessionId: 's1', resume: false, skillPluginDir: '/tmp/session-plugin' });
    const pluginDirs = args.flatMap((arg, index) => arg === '--plugin-dir' ? [args[index + 1]] : []);

    expect(pluginDirs).toContain('/tmp/session-plugin');
    expect(pluginDirs.length).toBeGreaterThan(1);
  });

  it('fails native delivery explicitly when the CLI has no scoped native support', () => {
    write(join(root, 'deploy', 'SKILL.md'), '# Deploy');
    const manifest: SessionSkillManifest = {
      sessionId: 's1',
      cliId: 'codex',
      workingDir: '/repo',
      policyMode: 'priority',
      prioritySkills: [{
        id: 'deploy',
        name: 'deploy',
        tags: [],
        rootDir: join(root, 'deploy'),
        entrypoint: 'SKILL.md',
        source: { type: 'user', root: join(root, 'deploy') },
        priorityReason: 'bot:include',
      }],
      diagnostics: [],
      generatedAt: '2026-06-14T00:00:00.000Z',
    };

    const prepared = prepareSkillDelivery(createCliAdapterSync('codex'), manifest, 'native');

    expect(prepared.fatal).toBe(true);
    expect(prepared.diagnostics).toContain('native_skill_delivery_not_supported');
  });
});

describe('Pi scoped skill delivery', () => {
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-pi-skill-'));
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-data-'));
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('materializes selected skills into a Pi skill root and passes to prepareSkillDelivery', () => {
    write(join(root, 'deploy', 'SKILL.md'), '# Deploy');
    const manifest: SessionSkillManifest = {
      sessionId: 'pi-sess-1',
      cliId: 'pi',
      workingDir: '/repo',
      policyMode: 'priority',
      prioritySkills: [{
        id: 'deploy',
        name: 'deploy',
        tags: [],
        rootDir: join(root, 'deploy'),
        entrypoint: 'SKILL.md',
        source: { type: 'user', root: join(root, 'deploy') },
        priorityReason: 'bot:include',
      }],
      diagnostics: [],
      generatedAt: '2026-06-14T00:00:00.000Z',
    };

    const prepared = prepareSkillDelivery(createCliAdapterSync('pi'), manifest, 'native');
    expect(prepared.fatal).toBeFalsy();
    expect(prepared.pluginDir).toBeDefined();
    expect(readFileSync(join(prepared.pluginDir!, 'deploy', 'SKILL.md'), 'utf-8')).toContain('# Deploy');

    const args = createCliAdapterSync('pi').buildArgs({
      sessionId: 'pi-sess-1',
      resume: false,
      skillPluginDir: prepared.pluginDir,
    });
    const skillDirs = args.flatMap((arg, index) => arg === '--skill' ? [args[index + 1]] : []);
    expect(skillDirs).toContain(prepared.pluginDir);
  });
});

// Under sandbox=true the in-sandbox reader (`botmux skill show/read/resources`)
// resolves `realpath(skill.rootDir)`, which the session snapshot points at this
// session's own `runtime-skills/<sid>/snapshot`. Delivery hands the sandbox that
// snapshot root (plus any native copy dir) — never a host source dir.
describe('skill delivery read-only roots for the sandboxed reader', () => {
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-skill-roots-')));
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-data-'));
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  // `root/src` plays the botmux skill store (the only snapshotted source kind).
  const trust = (): SkillSnapshotTrust => ({
    storeDir: join(root, 'src'), pluginsDir: join(root, 'plugins'),
    sessionDataDir: dataDir, botsDirs: [], workingDir: join(root, 'proj'),
  });

  function snapshotManifest(sessionId: string, cliId: SessionSkillManifest['cliId'], names: string[]): SessionSkillManifest {
    for (const name of [...names, 'not-enabled']) write(join(root, 'src', name, 'SKILL.md'), `# ${name}`);
    return snapshotSessionSkills({
      sessionId,
      cliId,
      workingDir: '/repo',
      policyMode: 'priority',
      prioritySkills: names.map((name) => ({
        id: name,
        name,
        tags: [],
        rootDir: join(root, 'src', name),
        entrypoint: 'SKILL.md',
        source: { type: 'local-copy' as const, originalPath: join(root, 'src', name) },
        priorityReason: 'bot:include',
      })),
      diagnostics: [],
      generatedAt: '2026-06-14T00:00:00.000Z',
    }, { trust: trust() }).manifest;
  }

  const snapshotRoot = (sessionId: string) => realpathSync(join(dataDir, 'runtime-skills', sessionId, 'snapshot'));

  it('prompt delivery grants exactly this session\'s snapshot root — no source dir, no shared parent', () => {
    const manifest = snapshotManifest('s-prompt', 'claude-code', ['deploy', 'review']);
    const prepared = prepareSkillDelivery(createCliAdapterSync('claude-code'), manifest, 'prompt');
    expect(prepared.readonlyRoots).toEqual([snapshotRoot('s-prompt')]);
    for (const forbidden of [join(root, 'src'), join(root, 'src', 'deploy'), join(root, 'src', 'not-enabled')]) {
      expect(prepared.readonlyRoots).not.toContain(forbidden);
    }
    expect(readFileSync(join(snapshotRoot('s-prompt'), 'deploy', 'SKILL.md'), 'utf-8')).toBe('# deploy');
  });

  it('auto on a CLI without native delivery (codex) falls back to prompt and grants the snapshot root', () => {
    const prepared = prepareSkillDelivery(createCliAdapterSync('codex'), snapshotManifest('s-codex', 'codex', ['deploy']), 'auto');
    expect(prepared.prompt).toBe(true);
    expect(prepared.pluginDir).toBeUndefined();
    expect(prepared.readonlyRoots).toEqual([snapshotRoot('s-codex')]);
  });

  it('claude-plugin delivery grants its copy dir AND the snapshot root (`botmux skill show` reads the snapshot)', () => {
    const prepared = prepareSkillDelivery(createCliAdapterSync('claude-code'), snapshotManifest('s-claude', 'claude-code', ['deploy']), 'auto');
    expect(prepared.pluginDir).toBe(join(dataDir, 'runtime-skills', 's-claude', 'claude-plugin'));
    expect(prepared.readonlyRoots).toEqual([prepared.pluginDir, snapshotRoot('s-claude')]);
  });

  it('skill-root delivery (pi) grants its copy dir AND the snapshot root', () => {
    const prepared = prepareSkillDelivery(createCliAdapterSync('pi'), snapshotManifest('s-pi', 'pi', ['deploy']), 'native');
    expect(prepared.pluginDir).toBe(join(dataDir, 'runtime-skills', 's-pi', 'skills'));
    expect(prepared.readonlyRoots).toEqual([prepared.pluginDir, snapshotRoot('s-pi')]);
  });

  it('never grants a skill rootDir that is not this session\'s own snapshot (un-snapshotted, foreign or forged entries)', () => {
    const manifest = snapshotManifest('s-own', 'codex', ['deploy']);
    write(join(root, 'src', 'raw', 'SKILL.md'), '# raw');
    manifest.prioritySkills.push(
      // not snapshotted (no snapshotOf): a live source dir
      { ...manifest.prioritySkills[0], id: 'raw', name: 'raw', rootDir: join(root, 'src', 'raw'), snapshotOf: undefined },
      // claims to be a snapshot but lives elsewhere
      { ...manifest.prioritySkills[0], id: 'forged', name: 'forged', rootDir: join(root, 'src', 'not-enabled'), snapshotOf: '/x' },
    );
    expect(prepareSkillDelivery(createCliAdapterSync('codex'), manifest, 'prompt').readonlyRoots)
      .toEqual([snapshotRoot('s-own')]);
    expect(prepareSkillDelivery(createCliAdapterSync('codex'), { ...manifest, prioritySkills: [] }, 'prompt').readonlyRoots)
      .toEqual([]);
    expect(prepareSkillDelivery(createCliAdapterSync('codex'), null, 'prompt').readonlyRoots).toEqual([]);
  });

  it('a fatal native request grants nothing (the spawn aborts)', () => {
    const prepared = prepareSkillDelivery(createCliAdapterSync('codex'), snapshotManifest('s-fatal', 'codex', ['deploy']), 'native');
    expect(prepared.fatal).toBe(true);
    expect(prepared.readonlyRoots).toEqual([]);
  });
});
