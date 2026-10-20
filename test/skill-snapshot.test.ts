import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  __testOnly_setSnapshotRaceHook,
  defaultSkillSnapshotTrust,
  plausibleConfiguredBotmuxHome,
  removeSessionSkillRuntime,
  resolveManagedSkillSource,
  sessionSkillSnapshotRoot,
  snapshotSessionSkills,
  type SkillSnapshotTrust,
} from '../src/core/skills/snapshot.js';
import { readSessionSkillManifest, sessionSkillManifestPath, writeSessionSkillManifest } from '../src/core/skills/manifest-store.js';
import { runSkillSessionCommand } from '../src/core/skills/cli-session-command.js';
import type { ResolvedSkill, SessionSkillManifest } from '../src/core/skills/types.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Every regular file's content under `dir` (snapshot leak checks). */
function contents(dir: string): string {
  if (!existsSync(dir)) return '';
  return readdirSync(dir, { withFileTypes: true })
    .map(e => (e.isDirectory() ? contents(join(dir, e.name)) : readFileSync(join(dir, e.name), 'utf-8')))
    .join('\n');
}

describe('session skill snapshots (botmux-managed sources only)', () => {
  let root: string;
  let home: string;
  let dataDir: string;
  let workingDir: string;
  let trust: SkillSnapshotTrust;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-skill-snapshot-')));
    home = join(root, 'home');
    dataDir = join(home, '.botmux', 'data');
    workingDir = join(root, 'proj');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(join(home, '.botmux', 'skills', 'store'), { recursive: true });
    mkdirSync(join(home, '.botmux', 'plugins'), { recursive: true });
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
    trust = {
      storeDir: join(home, '.botmux', 'skills', 'store'),
      pluginsDir: join(home, '.botmux', 'plugins'),
      sessionDataDir: dataDir,
      botsDirs: [join(home, '.botmux', 'bots')],
      workingDir,
      botmuxRoots: [join(home, '.botmux')],
      protectedPaths: [join(home, '.ssh'), join(home, '.aws')],
    };
  });

  afterEach(() => {
    __testOnly_setSnapshotRaceHook(undefined);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const skill = (name: string, rootDir: string, source: ResolvedSkill['source'] = { type: 'local-copy', originalPath: rootDir }): ResolvedSkill => ({
    id: name, name, tags: [], rootDir, entrypoint: 'SKILL.md', source, priorityReason: 'bot:include',
  });
  const manifestOf = (sessionId: string, skills: ResolvedSkill[]): SessionSkillManifest => ({
    sessionId, cliId: 'codex', workingDir, policyMode: 'priority',
    prioritySkills: skills, diagnostics: [], generatedAt: '2026-10-19T00:00:00.000Z',
  });
  const store = (name: string) => join(home, '.botmux', 'skills', 'store', name);
  const snapRoot = (sessionId: string) => sessionSkillSnapshotRoot(sessionId, dataDir);
  const snap = (sessionId: string) => realpathSync(snapRoot(sessionId));

  it('copies exactly the enabled store skills (content, nesting, exec bit) and points the manifest at the snapshot', () => {
    write(join(store('deploy'), 'SKILL.md'), '# Deploy');
    write(join(store('deploy'), 'references', 'release.md'), '# Release');
    write(join(store('deploy'), 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n');
    chmodSync(join(store('deploy'), 'scripts', 'run.sh'), 0o755);
    write(join(store('payroll'), 'SKILL.md'), '# Payroll');

    const { manifest, diagnostics } = snapshotSessionSkills(manifestOf('s1', [skill('deploy', store('deploy'))]), { trust, dataDir });

    expect(diagnostics).toEqual([]);
    expect(readdirSync(snap('s1'))).toEqual(['deploy']);
    expect(readFileSync(join(snap('s1'), 'deploy', 'SKILL.md'), 'utf-8')).toBe('# Deploy');
    expect(readFileSync(join(snap('s1'), 'deploy', 'references', 'release.md'), 'utf-8')).toBe('# Release');
    expect(statSync(join(snap('s1'), 'deploy', 'scripts', 'run.sh')).mode & 0o111).not.toBe(0);
    expect(manifest.prioritySkills[0].rootDir).toBe(join(snap('s1'), 'deploy'));
    expect(manifest.prioritySkills[0].snapshotOf).toBe(store('deploy'));
  });

  it('snapshots plugin bundle skills (plugins/<id>/dist/…) too', () => {
    const pluginSkill = join(home, '.botmux', 'plugins', 'demo', 'dist', 'skills', 'browser');
    write(join(pluginSkill, 'SKILL.md'), '# Browser');
    const { manifest } = snapshotSessionSkills(manifestOf('s-plugin', [
      skill('browser', pluginSkill, { type: 'plugin', pluginId: 'demo', root: join(home, '.botmux', 'plugins', 'demo', 'dist') }),
    ]), { trust, dataDir });
    expect(manifest.prioritySkills[0].rootDir).toBe(join(snap('s-plugin'), 'browser'));
  });

  it('never copies a linked / external / project skill — it keeps its own path, with no diagnostic', () => {
    const linked = join(root, 'elsewhere', 'review');
    const project = join(workingDir, '.agents', 'skills', 'lint');
    write(join(linked, 'SKILL.md'), '# Review');
    write(join(project, 'SKILL.md'), '# Lint');
    const { manifest, diagnostics } = snapshotSessionSkills(manifestOf('s-ext', [
      skill('review', linked, { type: 'local-link', path: linked }),
      skill('lint', project, { type: 'project', root: project }),
    ]), { trust, dataDir });
    expect(manifest.prioritySkills.map(s => [s.name, s.rootDir, s.snapshotOf])).toEqual([
      ['review', linked, undefined], ['lint', project, undefined],
    ]);
    expect(diagnostics).toEqual([]);
    expect(existsSync(snapRoot('s-ext'))).toBe(false);
  });

  describe('repro: session data dir / bots dir aliased OUTSIDE the botmux root', () => {
    it('a linked skill pointing into a redirected bots dir or data dir copies nothing', () => {
      // ~/.botmux/bots -> /outside/bots and the data dir -> /outside/data
      const outside = join(root, 'outside');
      write(join(outside, 'bots', 'cli_sibling', 'send-cred.json'), '{"appSecret":"SIBLING-SECRET"}');
      write(join(outside, 'bots', 'cli_sibling', 'SKILL.md'), '# planted');
      write(join(outside, 'data', 'cli-identity', 'other.bin', '.data', 'lark-cli.env'), 'TOKEN=OTHER-SESSION-SECRET');
      write(join(outside, 'data', 'cli-identity', 'SKILL.md'), '# planted');
      symlinkSync(join(outside, 'bots'), join(home, '.botmux', 'bots'));
      const aliasedData = join(home, '.botmux', 'data-alias');
      symlinkSync(join(outside, 'data'), aliasedData);
      const aliasedTrust = { ...trust, sessionDataDir: aliasedData };
      // loadSkillPackage stores CANONICAL roots, i.e. under /outside.
      const { manifest } = snapshotSessionSkills(manifestOf('s-alias', [
        skill('sib', realpathSync(join(home, '.botmux', 'bots', 'cli_sibling')), { type: 'local-link', path: join(home, '.botmux', 'bots', 'cli_sibling') }),
        skill('ident', realpathSync(join(aliasedData, 'cli-identity')), { type: 'local-link', path: join(aliasedData, 'cli-identity') }),
      ]), { trust: aliasedTrust, dataDir });
      expect(manifest.prioritySkills.every(s => !s.snapshotOf)).toBe(true);
      expect(contents(join(dataDir, 'runtime-skills'))).not.toMatch(/SECRET/);
    });

    it('a store aliased into the data dir / a bots dir is not trusted (diagnosed, nothing copied)', () => {
      for (const [label, target] of [
        ['data dir', join(dataDir, 'evil-store')],
        ['bots dir', join(home, '.botmux', 'bots', 'cli_x', 'evil-store')],
      ] as const) {
        write(join(target, 'deploy', 'SKILL.md'), `# planted via ${label}`);
        const aliasedStore = join(root, `store-alias-${label.replace(' ', '-')}`);
        symlinkSync(target, aliasedStore);
        const { manifest } = snapshotSessionSkills(manifestOf(`s-store-${label.replace(' ', '-')}`, [
          skill('deploy', realpathSync(join(aliasedStore, 'deploy'))),
        ]), { trust: { ...trust, storeDir: aliasedStore }, dataDir });
        expect(manifest.prioritySkills[0].snapshotOf, label).toBeUndefined();
        expect(manifest.diagnostics, label).toEqual([expect.objectContaining({ code: 'skill_snapshot_untrusted_source', skillName: 'deploy' })]);
        expect(existsSync(snapRoot(`s-store-${label.replace(' ', '-')}`)), label).toBe(false);
      }
    });

    it('resolveManagedSkillSource compares canonical paths on both sides and requires a managed source kind', () => {
      const copy = (rootDir: string) => ({ rootDir, source: { type: 'local-copy' as const, originalPath: rootDir } });
      write(join(store('deploy'), 'SKILL.md'), '# Deploy');
      symlinkSync(store('deploy'), join(root, 'deploy-link'));
      expect(resolveManagedSkillSource(copy(join(root, 'deploy-link')), trust)).toEqual({ ok: true, root: store('deploy') });
      expect(resolveManagedSkillSource(copy(store('')), trust).ok).toBe(false);          // the store itself
      expect(resolveManagedSkillSource(copy(join(root, 'nope')), trust)).toEqual({ ok: false, reason: 'source_missing' });
      // a LINKED skill is never trusted, even when it sits right in the store
      expect(resolveManagedSkillSource({ rootDir: store('deploy'), source: { type: 'local-link', path: store('deploy') } }, trust))
        .toEqual({ ok: false, reason: 'not_botmux_managed' });
      const plugin = (rootDir: string) => ({ rootDir, source: { type: 'plugin' as const, pluginId: 'demo', root: rootDir } });
      write(join(home, '.botmux', 'plugins', 'demo', 'private', 'SKILL.md'), '# planted');
      write(join(home, '.botmux', 'plugins', 'demo', 'dist', 'skills', 'b', 'SKILL.md'), '# ok');
      expect(resolveManagedSkillSource(plugin(join(home, '.botmux', 'plugins', 'demo', 'private')), trust).ok).toBe(false);
      expect(resolveManagedSkillSource(plugin(join(home, '.botmux', 'plugins', 'demo', 'dist', 'skills', 'b')), trust).ok).toBe(true);
      // a store-kind entry must live in the store, a plugin-kind one in a bundle
      expect(resolveManagedSkillSource(copy(join(home, '.botmux', 'plugins', 'demo', 'dist', 'skills', 'b')), trust).ok).toBe(false);
    });
  });

  // Review repros: the managed dir is "trusted" but the ACTUAL source root
  // lands on a protected tree. Judged on the real root + its copied subtree.
  describe('repro: actual source root on a protected tree although under the (aliased) store', () => {
    const sibling = () => join(home, '.botmux', 'bots', 'cli_sibling');
    const plantSibling = () => {
      write(join(sibling(), 'send-cred.json'), '{"appSecret":"SIBLING-SECRET"}');
      write(join(sibling(), 'SKILL.md'), '# planted in a sibling BOT_HOME');
    };

    it('store -> ~/.botmux: a sibling BOT_HOME / the data dir / bots.json "inside the store" are never copied', () => {
      plantSibling();
      write(join(dataDir, 'cli-identity', 'other.bin', '.data', 'lark-cli.env'), 'TOKEN=OTHER-SESSION-SECRET');
      write(join(dataDir, 'cli-identity', 'SKILL.md'), '# planted');
      write(join(home, '.botmux', 'bots.json'), '[{"larkAppSecret":"BOTS-JSON-SECRET"}]');
      const aliasedStore = join(root, 'store-to-botmux');
      symlinkSync(join(home, '.botmux'), aliasedStore);
      const t = { ...trust, storeDir: aliasedStore };
      const { manifest } = snapshotSessionSkills(manifestOf('s-alias-home', [
        skill('sib', realpathSync(join(aliasedStore, 'bots', 'cli_sibling'))),           // forged "store" entry
        skill('ident', realpathSync(join(aliasedStore, 'data', 'cli-identity'))),
        skill('linked', sibling(), { type: 'local-link', path: sibling() }),              // --link of the sibling home
      ]), { trust: t, dataDir });
      expect(manifest.prioritySkills.every(sk => !sk.snapshotOf)).toBe(true);
      expect(contents(join(dataDir, 'runtime-skills'))).not.toMatch(/SECRET/);
      expect(manifest.diagnostics.map(d => [d.skillName, d.code])).toEqual([
        ['sib', 'skill_snapshot_untrusted_source'], ['ident', 'skill_snapshot_untrusted_source'],
      ]);
      // A genuine skill a misconfigured store would land on the botmux home is refused too.
      write(join(home, '.botmux', 'deploy', 'SKILL.md'), '# Deploy');
      expect(resolveManagedSkillSource({ rootDir: join(aliasedStore, 'deploy'), source: { type: 'local-copy', originalPath: '/x' } }, t).ok).toBe(false);
    });

    it('session data dir inside the store: the data-dir subtree is never copied, ordinary store skills still are', () => {
      const dataInStore = join(store(''), 'session-data');
      write(join(dataInStore, 'cli-identity', 'other.bin', '.data', 'lark-cli.env'), 'TOKEN=OTHER-SESSION-SECRET');
      write(join(dataInStore, 'cli-identity', 'SKILL.md'), '# planted');
      write(join(store('wrapper'), 'SKILL.md'), '# planted around the data dir');
      symlinkSync(dataInStore, join(store('wrapper'), 'unused-link')); // a link is never followed either
      write(join(store('deploy'), 'SKILL.md'), '# Deploy');
      const t = { ...trust, sessionDataDir: dataInStore };
      const { manifest } = snapshotSessionSkills(manifestOf('s-data-in-store', [
        skill('ident', join(dataInStore, 'cli-identity')),      // root inside the data dir
        skill('around', store('')),                              // the store root itself (covers the data dir)
        skill('deploy', store('deploy')),
      ]), { trust: t, dataDir });
      expect(manifest.prioritySkills.filter(sk => sk.snapshotOf).map(sk => sk.name)).toEqual(['deploy']);
      expect(contents(join(dataDir, 'runtime-skills'))).not.toMatch(/SECRET/);
      // a store entry whose subtree CONTAINS the data dir is refused as well
      const covering = join(store('covering'));
      write(join(covering, 'SKILL.md'), '# covering');
      const nestedData = join(covering, 'data');
      write(join(nestedData, 'secret.env'), 'TOKEN=NESTED-SECRET');
      expect(resolveManagedSkillSource({ rootDir: covering, source: { type: 'git', url: 'x', path: '.' } }, { ...trust, sessionDataDir: nestedData }))
        .toEqual({ ok: false, reason: 'source_overlaps_protected' });
    });

    it('`--link` of a sibling BOT_HOME (with SKILL.md) is never copied, whatever the store resolves to', () => {
      plantSibling();
      for (const storeDir of [trust.storeDir, join(home, '.botmux')]) {
        const { manifest } = snapshotSessionSkills(manifestOf('s-link-sib', [
          skill('sib', sibling(), { type: 'local-link', path: sibling() }),
        ]), { trust: { ...trust, storeDir }, dataDir });
        expect(manifest.prioritySkills[0].snapshotOf).toBeUndefined();
        expect(contents(join(dataDir, 'runtime-skills'))).not.toMatch(/SECRET/);
      }
    });

    it('a protected dir ALIASED INTO the store is matched at its real location (~/.ssh -> <store>/keys, data dir -> <store>/sd)', () => {
      write(join(store('keys'), 'id_rsa'), 'PRIVATE-KEY-SECRET');
      write(join(store('keys'), 'SKILL.md'), '# planted');
      symlinkSync(store('keys'), join(home, '.ssh'));
      write(join(store('sd'), 'cli-identity', 'x.env'), 'TOKEN=SESSION-SECRET');
      write(join(store('sd'), 'SKILL.md'), '# planted');
      const aliasedData = join(root, 'data-alias');
      symlinkSync(store('sd'), aliasedData);
      const t = { ...trust, sessionDataDir: aliasedData };
      const { manifest } = snapshotSessionSkills(manifestOf('s-alias-into-store', [
        skill('keys', store('keys')), skill('sd', store('sd')),
      ]), { trust: t, dataDir });
      expect(manifest.prioritySkills.every(sk => !sk.snapshotOf)).toBe(true);
      expect(contents(join(dataDir, 'runtime-skills'))).not.toMatch(/SECRET/);
    });

    it('a store aliased onto home cannot hand out ~/.ssh (explicitly denied host path) or cover the botmux home', () => {
      write(join(home, '.ssh', 'id_rsa'), 'PRIVATE-KEY-SECRET');
      write(join(home, '.ssh', 'SKILL.md'), '# planted');
      const storeOnHome = join(root, 'store-to-home');
      symlinkSync(home, storeOnHome);
      const t = { ...trust, storeDir: storeOnHome };
      expect(resolveManagedSkillSource({ rootDir: join(home, '.ssh'), source: { type: 'local-copy', originalPath: '/x' } }, t))
        .toEqual({ ok: false, reason: 'source_overlaps_protected' });
      const { manifest } = snapshotSessionSkills(manifestOf('s-home', [skill('ssh', join(home, '.ssh'))]), { trust: t, dataDir });
      expect(manifest.prioritySkills[0].snapshotOf).toBeUndefined();
      expect(contents(join(dataDir, 'runtime-skills'))).not.toMatch(/SECRET/);
    });
  });

  describe('repro: a directory swapped for a symlink while the copy runs', () => {
    it('a dir replaced by a symlink after listing is skipped — the target is never read', () => {
      write(join(root, 'secret', '.ssh', 'id_rsa'), 'FAKE-PRIVATE-KEY-SECRET');
      write(join(store('race'), 'SKILL.md'), '# Race');
      write(join(store('race'), 'refs', 'note.md'), 'note');
      __testOnly_setSnapshotRaceHook((relDir) => {
        if (relDir !== '') return;
        // After the skill root was listed: refs/ -> the secret dir.
        renameSync(join(store('race'), 'refs'), join(root, 'refs-moved'));
        symlinkSync(join(root, 'secret', '.ssh'), join(store('race'), 'refs'));
      });
      const { manifest, diagnostics } = snapshotSessionSkills(manifestOf('s-race', [skill('race', store('race'))]), { trust, dataDir });
      expect(contents(snapRoot('s-race'))).not.toMatch(/SECRET/);
      expect(existsSync(join(snap('s-race'), 'race', 'refs'))).toBe(false);
      expect(manifest.prioritySkills[0].snapshotOf).toBe(store('race'));
      expect(diagnostics.join('\n')).toContain('refs (symlink)');
    });

    it('an ANCESTOR swapped for a symlink mid-walk cannot redirect the copy (fds are pinned)', () => {
      write(join(root, 'secret', 'deep', 'id_rsa'), 'FAKE-PRIVATE-KEY-SECRET');
      write(join(store('race2'), 'SKILL.md'), '# Race2');
      write(join(store('race2'), 'a', 'deep', 'ok.md'), 'ok');
      __testOnly_setSnapshotRaceHook((relDir) => {
        if (relDir !== 'a') return;
        // While inside a/: swap a/ itself for a link to the secret tree.
        renameSync(join(store('race2'), 'a'), join(root, 'a-moved'));
        symlinkSync(join(root, 'secret'), join(store('race2'), 'a'));
      });
      snapshotSessionSkills(manifestOf('s-race2', [skill('race2', store('race2'))]), { trust, dataDir });
      expect(contents(snapRoot('s-race2'))).not.toMatch(/SECRET/);
    });

    it('symlinks, hard links and special files inside a store skill are never carried over', () => {
      write(join(store('tricky'), 'SKILL.md'), '# Tricky');
      write(join(store('tricky'), 'real.md'), 'REAL');
      write(join(root, 'outside', 'secret.txt'), 'TOPSECRET');
      symlinkSync(join(store('tricky'), 'real.md'), join(store('tricky'), 'alias.md'));
      symlinkSync(join(root, 'outside', 'secret.txt'), join(store('tricky'), 'leak.txt'));
      symlinkSync(join(root, 'outside'), join(store('tricky'), 'outdir'));
      linkSync(join(root, 'outside', 'secret.txt'), join(store('tricky'), 'hard.txt'));
      const { manifest, diagnostics } = snapshotSessionSkills(manifestOf('s-sym', [skill('tricky', store('tricky'))]), { trust, dataDir });
      expect(readdirSync(join(snap('s-sym'), 'tricky')).sort()).toEqual(['SKILL.md', 'real.md']);
      expect(contents(snapRoot('s-sym'))).not.toContain('TOPSECRET');
      expect(manifest.diagnostics).toEqual([expect.objectContaining({ code: 'skill_snapshot_entries_skipped', level: 'warn' })]);
      expect(diagnostics[0]).toMatch(/skipped 4 entries/);
    });
  });

  describe('repro: limits (wide / deep / big trees)', () => {
    const limits = { maxEntries: 50, maxDirs: 10, maxFiles: 5, maxBytes: 1024, maxDepth: 4 };
    it.each([
      ['wide: 1 file + 1000 empty dirs', (dir: string) => { for (let i = 0; i < 1000; i++) mkdirSync(join(dir, `d${i}`)); }, /more than 10 directories/],
      ['many entries (symlinks count too)', (dir: string) => { for (let i = 0; i < 60; i++) symlinkSync('/etc/hostname', join(dir, `l${i}`)); }, /more than 50 entries/],
      ['many files', (dir: string) => { for (let i = 0; i < 6; i++) writeFileSync(join(dir, `f${i}.md`), 'x'); }, /more than 5 files/],
      ['big', (dir: string) => { writeFileSync(join(dir, 'blob.bin'), 'y'.repeat(4096)); }, /more than 1024 bytes/],
      ['deep', (dir: string) => { mkdirSync(join(dir, 'a', 'b', 'c', 'd', 'e', 'f'), { recursive: true }); }, /deeper than 4 levels/],
    ])('%s → whole skill left out of the snapshot with a clear error', (_label, populate, reason) => {
      write(join(store('big'), 'SKILL.md'), '# Big');
      populate(store('big'));
      write(join(store('ok'), 'SKILL.md'), '# Ok');
      const { manifest, diagnostics } = snapshotSessionSkills(manifestOf('s-big', [skill('big', store('big')), skill('ok', store('ok'))]), { trust, dataDir, limits });
      expect(readdirSync(snap('s-big'))).toEqual(['ok']);
      const big = manifest.prioritySkills.find(s => s.name === 'big');
      expect(big?.rootDir).toBe(store('big'));
      expect(big?.snapshotOf).toBeUndefined();
      expect(manifest.diagnostics).toEqual([expect.objectContaining({ code: 'skill_snapshot_too_large', skillName: 'big' })]);
      expect(diagnostics.join('\n')).toMatch(reason);
      expect(diagnostics.join('\n')).toContain('exceeds the session snapshot limit (50 entries / 10 dirs / 5 files / 1024 bytes / depth 4)');
    });
  });

  it('`botmux skill show` explains an unavailable skill: linked (copy-install hint) or failed snapshot (reason)', () => {
    write(join(store('big'), 'SKILL.md'), '# Big');
    write(join(store('big'), 'blob.bin'), 'y'.repeat(4096));
    const { manifest } = snapshotSessionSkills(manifestOf('s-why', [
      skill('big', store('big')),
      skill('linked', join(root, 'not-mounted-in-sandbox'), { type: 'local-link', path: join(root, 'not-mounted-in-sandbox') }),
    ]), { trust, dataDir, limits: { maxEntries: 50, maxDirs: 10, maxFiles: 10, maxBytes: 100, maxDepth: 4 } });
    writeSessionSkillManifest(manifest);
    // In the sandbox the original store path is not mounted: emulate by removing it.
    rmSync(store('big'), { recursive: true, force: true });
    const env = { BOTMUX_SESSION_ID: 's-why', BOTMUX_READ_ISOLATION: '1' };
    const big = runSkillSessionCommand(['show', 'big'], env);
    expect(big.code).toBe(1);
    expect(big.stderr).toContain('skill big is not available inside this sandboxed session');
    expect(big.stderr).toContain('exceeds the session snapshot limit');
    const linked = runSkillSessionCommand(['read', 'linked', 'SKILL.md'], env);
    expect(linked.code).toBe(1);
    expect(linked.stderr).toContain('skill linked is a linked/external skill');
    expect(linked.stderr).toContain('not available inside this sandboxed session');
    expect(linked.stderr).toContain('botmux skills install <path>` without --link');
  });

  it('a linked skill outside the sandbox keeps working from its own path (no regression)', () => {
    const linked = join(root, 'elsewhere', 'review');
    write(join(linked, 'SKILL.md'), '# Review live');
    const { manifest } = snapshotSessionSkills(manifestOf('s-host', [skill('review', linked, { type: 'local-link', path: linked })]), { trust, dataDir });
    writeSessionSkillManifest(manifest);
    expect(runSkillSessionCommand(['show', 'review'], { BOTMUX_SESSION_ID: 's-host' }).stdout).toBe('# Review live');
  });

  it('a running session keeps serving its snapshot after the store copy is replaced; a respawn picks up the update', () => {
    write(join(store('deploy'), 'SKILL.md'), '# Deploy v1');
    write(join(store('deploy'), 'references', 'notes.md'), 'notes v1');
    writeSessionSkillManifest(snapshotSessionSkills(manifestOf('s-live', [skill('deploy', store('deploy'))]), { trust, dataDir }).manifest);
    rmSync(store('deploy'), { recursive: true, force: true }); // updateInstalledSkill shape
    write(join(store('deploy'), 'SKILL.md'), '# Deploy v2');
    const env = { BOTMUX_SESSION_ID: 's-live' };
    expect(runSkillSessionCommand(['show', 'deploy'], env).stdout).toBe('# Deploy v1');
    expect(runSkillSessionCommand(['read', 'deploy', 'references/notes.md'], env).stdout).toBe('notes v1');
    expect(runSkillSessionCommand(['resources', 'deploy'], env).stdout).toContain('references/notes.md');
    writeSessionSkillManifest(snapshotSessionSkills(manifestOf('s-live', [skill('deploy', store('deploy'))]), { trust, dataDir }).manifest);
    expect(runSkillSessionCommand(['show', 'deploy'], env).stdout).toBe('# Deploy v2');
  });

  it('keeps sessions apart and is removed with the session', () => {
    write(join(store('a'), 'SKILL.md'), '# A');
    write(join(store('b'), 'SKILL.md'), '# B');
    writeSessionSkillManifest(snapshotSessionSkills(manifestOf('sess-a', [skill('a', store('a'))]), { trust, dataDir }).manifest);
    writeSessionSkillManifest(snapshotSessionSkills(manifestOf('sess-b', [skill('b', store('b'))]), { trust, dataDir }).manifest);
    expect(readdirSync(snap('sess-a'))).toEqual(['a']);
    expect(readdirSync(snap('sess-b'))).toEqual(['b']);
    expect(snap('sess-a')).toBe(join(realpathSync(dataDir), 'runtime-skills', 'sess-a', 'snapshot'));
    removeSessionSkillRuntime('sess-a', dataDir);
    expect(existsSync(join(dataDir, 'runtime-skills', 'sess-a'))).toBe(false);
    expect(readSessionSkillManifest('sess-a')).toBeNull();
    expect(readdirSync(snap('sess-b'))).toEqual(['b']);
    expect(existsSync(sessionSkillManifestPath('sess-b', dataDir))).toBe(true);
  });

  // The working dir is `~` whenever a bot configures none (config default,
  // session-manager, setup) — the commonest layout. It is no credential
  // location: managed skills must snapshot under it, while every credential
  // location under `~` stays refused by its own entry.
  describe('workingDir = $HOME (the default when a bot configures none)', () => {
    const homeTrust = () => ({ ...trust, workingDir: home });
    const pluginSkillDir = () => join(home, '.botmux', 'plugins', 'demo', 'dist', 'skills', 'browser');

    it('store and plugin skills snapshot normally', () => {
      write(join(store('deploy'), 'SKILL.md'), '# Deploy');
      write(join(pluginSkillDir(), 'SKILL.md'), '# Browser');
      const { manifest, diagnostics } = snapshotSessionSkills({ ...manifestOf('s-home-ok', [
        skill('deploy', store('deploy')),
        skill('browser', pluginSkillDir(), { type: 'plugin', pluginId: 'demo', root: join(home, '.botmux', 'plugins', 'demo', 'dist') }),
      ]), workingDir: home }, { trust: homeTrust(), dataDir });
      expect(diagnostics).toEqual([]);
      expect(manifest.prioritySkills.map(sk => sk.rootDir)).toEqual([join(snap('s-home-ok'), 'deploy'), join(snap('s-home-ok'), 'browser')]);
      expect(readFileSync(join(snap('s-home-ok'), 'browser', 'SKILL.md'), 'utf-8')).toBe('# Browser');
    });

    it('every credential repro is still refused: --link sibling BOT_HOME, store -> ~/.botmux, ~/.ssh aliased into the store, data dir inside the store, store -> ~', () => {
      const sibling = join(home, '.botmux', 'bots', 'cli_sibling');
      write(join(sibling, 'send-cred.json'), '{"appSecret":"SIBLING-SECRET"}');
      write(join(sibling, 'SKILL.md'), '# planted');
      write(join(store('keys'), 'id_rsa'), 'PRIVATE-KEY-SECRET');
      write(join(store('keys'), 'SKILL.md'), '# planted');
      symlinkSync(store('keys'), join(home, '.ssh'));
      const dataInStore = join(store(''), 'session-data');
      write(join(dataInStore, 'cli-identity', 'x.env'), 'TOKEN=SESSION-SECRET');
      write(join(dataInStore, 'cli-identity', 'SKILL.md'), '# planted');
      write(join(store('deploy'), 'SKILL.md'), '# Deploy');
      const storeToBotmux = join(root, 'store-to-botmux');
      symlinkSync(join(home, '.botmux'), storeToBotmux);
      const storeToHome = join(root, 'store-to-home');
      symlinkSync(home, storeToHome);
      const cases: Array<[string, ResolvedSkill, SkillSnapshotTrust]> = [
        ['--link sibling BOT_HOME', skill('sib', sibling, { type: 'local-link', path: sibling }), homeTrust()],
        ['forged store entry = sibling BOT_HOME (store -> ~/.botmux)', skill('sib', realpathSync(join(storeToBotmux, 'bots', 'cli_sibling'))), { ...homeTrust(), storeDir: storeToBotmux }],
        ['~/.ssh aliased into the store', skill('keys', store('keys')), homeTrust()],
        ['session data dir inside the store', skill('ident', join(dataInStore, 'cli-identity')), { ...homeTrust(), sessionDataDir: dataInStore }],
        ['store -> ~ hands out ~/.ssh', skill('ssh', join(home, '.ssh')), { ...homeTrust(), storeDir: storeToHome }],
        ['store -> ~ hands out ~/.botmux/bots/<sibling>', skill('sib2', sibling), { ...homeTrust(), storeDir: storeToHome }],
      ];
      for (const [label, sk, t] of cases) {
        expect(resolveManagedSkillSource(sk, t).ok, label).toBe(false);
        const { manifest } = snapshotSessionSkills({ ...manifestOf('s-home-deny', [sk, skill('deploy', store('deploy'))]), workingDir: home }, { trust: t, dataDir });
        expect(manifest.prioritySkills.find(x => x.name === sk.name)?.snapshotOf, label).toBeUndefined();
        expect(contents(join(dataDir, 'runtime-skills')), label).not.toMatch(/SECRET/);
      }
    });

    it('cover-only still holds: a copy that would contain the WHOLE working dir is refused, one inside it is not', () => {
      write(join(store('wrap'), 'SKILL.md'), '# wraps the project');
      write(join(store('wrap'), 'proj', 'src.ts'), 'code');
      write(join(store('inner'), 'SKILL.md'), '# inside the project');
      expect(resolveManagedSkillSource(skill('wrap', store('wrap')), { ...trust, workingDir: join(store('wrap'), 'proj') }))
        .toEqual({ ok: false, reason: 'source_overlaps_protected' });
      expect(resolveManagedSkillSource(skill('inner', store('inner')), { ...trust, workingDir: store('') }).ok).toBe(true);
    });
  });

  // dirname(SESSION_DATA_DIR) is the "configured botmux home". With
  // SESSION_DATA_DIR=$HOME/data it is $HOME, with /data it is / — neither is a
  // botmux home, and treating them as one listed ~/.botmux (so the store) as
  // botmux-internal and fail-closed every managed skill.
  describe('SESSION_DATA_DIR whose parent is not a botmux home ($HOME/data, /data)', () => {
    beforeEach(() => { vi.stubEnv('HOME', home); });
    const layout = (sessionData: string, wd = home) => defaultSkillSnapshotTrust({ workingDir: wd, dataDir: sessionData });
    const pluginSkillDir = () => join(home, '.botmux', 'plugins', 'demo', 'dist', 'skills', 'browser');
    const pluginSkill = () => skill('browser', pluginSkillDir(), { type: 'plugin', pluginId: 'demo', root: join(home, '.botmux', 'plugins', 'demo', 'dist') });

    it('$HOME/data + default workingDir ~: store and plugin skills snapshot normally', () => {
      const t = layout(join(home, 'data'));
      expect(t.botmuxRoots).toEqual([join(home, '.botmux')]);
      expect(t.botsDirs).toEqual(expect.arrayContaining([join(home, 'bots'), join(home, '.botmux', 'bots')]));
      write(join(store('deploy'), 'SKILL.md'), '# Deploy');
      write(join(pluginSkillDir(), 'SKILL.md'), '# Browser');
      const { manifest, diagnostics } = snapshotSessionSkills({ ...manifestOf('s-homedata', [skill('deploy', store('deploy')), pluginSkill()]), workingDir: home },
        { trust: t, dataDir });
      expect(diagnostics).toEqual([]);
      expect(manifest.prioritySkills.map(sk => sk.rootDir)).toEqual([join(snap('s-homedata'), 'deploy'), join(snap('s-homedata'), 'browser')]);
    });

    it('$HOME/data: every credential repro is still refused (--link sibling, ~/.ssh into the store, session data, bots dirs, bots.json)', () => {
      const sessionData = join(home, 'data');
      write(join(sessionData, 'cli-identity', 'x.env'), 'TOKEN=SESSION-SECRET');
      write(join(sessionData, 'cli-identity', 'SKILL.md'), '# planted');
      const sibConfigured = join(home, 'bots', 'cli_sib');          // <dirname(dataDir)>/bots
      const sibDefault = join(home, '.botmux', 'bots', 'cli_sib2'); // default botmux home
      for (const sib of [sibConfigured, sibDefault]) {
        write(join(sib, 'send-cred.json'), '{"appSecret":"SIBLING-SECRET"}');
        write(join(sib, 'SKILL.md'), '# planted');
      }
      write(join(home, '.botmux', 'bots.json'), '[{"larkAppSecret":"BOTS-JSON-SECRET"}]');
      write(join(store('keys'), 'id_rsa'), 'PRIVATE-KEY-SECRET');
      write(join(store('keys'), 'SKILL.md'), '# planted');
      symlinkSync(store('keys'), join(home, '.ssh'));
      write(join(store('deploy'), 'SKILL.md'), '# Deploy');
      const storeToHome = join(root, 'store-to-home');
      symlinkSync(home, storeToHome);
      const t = layout(sessionData);
      const viaHome = { ...t, storeDir: storeToHome };
      const cases: Array<[string, ResolvedSkill, SkillSnapshotTrust]> = [
        ['--link sibling in <parent>/bots', skill('a', sibConfigured, { type: 'local-link', path: sibConfigured }), t],
        ['--link sibling in ~/.botmux/bots', skill('b', sibDefault, { type: 'local-link', path: sibDefault }), t],
        ['~/.ssh aliased into the store', skill('keys', store('keys')), t],
        ['session data (store -> ~)', skill('c', join(sessionData, 'cli-identity')), viaHome],
        ['<parent>/bots sibling (store -> ~)', skill('d', sibConfigured), viaHome],
        ['~/.botmux/bots (store -> ~)', skill('e', join(home, '.botmux', 'bots')), viaHome],
        ['~/.botmux containing bots.json (store -> ~)', skill('f', join(home, '.botmux')), viaHome],
        ['session data inside the store', skill('g', join(store('sd'), 'cli-identity')), layout(store('sd'))],
      ];
      write(join(store('sd'), 'cli-identity', 'x.env'), 'TOKEN=SESSION-SECRET');
      write(join(store('sd'), 'cli-identity', 'SKILL.md'), '# planted');
      write(join(home, '.botmux', 'SKILL.md'), '# planted');
      write(join(home, '.botmux', 'bots', 'SKILL.md'), '# planted');
      for (const [label, sk, tr] of cases) {
        expect(resolveManagedSkillSource(sk, tr).ok, label).toBe(false);
        const { manifest } = snapshotSessionSkills({ ...manifestOf('s-homedata-deny', [sk, skill('deploy', store('deploy'))]), workingDir: home }, { trust: tr, dataDir });
        expect(manifest.prioritySkills.find(x => x.name === sk.name)?.snapshotOf, label).toBeUndefined();
        expect(manifest.prioritySkills.find(x => x.name === 'deploy')?.snapshotOf, label).toBe(store('deploy'));
        expect(contents(join(dataDir, 'runtime-skills')), label).not.toMatch(/SECRET/);
      }
    });

    it('/data (parent is /): not everything refused, the session data dir and /bots still protected', () => {
      const t = layout('/data');
      expect(t.botmuxRoots).toEqual([join(home, '.botmux')]);
      expect(t.botsDirs).toContain('/bots');
      expect(t.sessionDataDir).toBe('/data');
      write(join(store('deploy'), 'SKILL.md'), '# Deploy');
      expect(resolveManagedSkillSource(skill('deploy', store('deploy')), t)).toEqual({ ok: true, root: store('deploy') });
    });

    it('unchanged: the default (~/.botmux/data) and a custom instance ($HOME/inst/data) stay botmux homes and snapshot normally', () => {
      write(join(store('deploy'), 'SKILL.md'), '# Deploy');
      for (const [sessionData, parent] of [[join(home, '.botmux', 'data'), join(home, '.botmux')], [join(home, 'inst', 'data'), join(home, 'inst')]]) {
        mkdirSync(sessionData, { recursive: true });
        const t = layout(sessionData);
        expect(t.botmuxRoots, sessionData).toContain(parent);
        expect(resolveManagedSkillSource(skill('deploy', store('deploy')), t).ok, sessionData).toBe(true);
      }
      // …and a custom instance's internals are still botmux-internal (store -> $HOME/inst).
      write(join(home, 'inst', 'connectors', 'SKILL.md'), '# planted');
      write(join(home, 'inst', 'connectors', 'token'), 'CONNECTOR-SECRET');
      const storeToInst = join(root, 'store-to-inst');
      symlinkSync(join(home, 'inst'), storeToInst);
      expect(resolveManagedSkillSource(skill('conn', join(home, 'inst', 'connectors')),
        { ...layout(join(home, 'inst', 'data')), storeDir: storeToInst })).toEqual({ ok: false, reason: 'source_overlaps_protected' });
    });

    it('plausibility rules for dirname(SESSION_DATA_DIR)', () => {
      const lay = { defaultBotmux: join(home, '.botmux'), storeDir: store(''), pluginsDir: join(home, '.botmux', 'plugins') };
      expect(plausibleConfiguredBotmuxHome(join(home, '.botmux'), lay)).toBe(true);
      expect(plausibleConfiguredBotmuxHome(join(home, 'inst'), lay)).toBe(true);
      expect(plausibleConfiguredBotmuxHome('/srv/botmux', lay)).toBe(true);
      expect(plausibleConfiguredBotmuxHome(home, lay)).toBe(false);               // $HOME/data
      expect(plausibleConfiguredBotmuxHome('/', lay)).toBe(false);                // /data
      expect(plausibleConfiguredBotmuxHome(dirname(home), lay)).toBe(false);     // an ancestor of $HOME
      // contains the store somewhere other than its own skills/store
      mkdirSync(join(home, 'odd', 'mystore'), { recursive: true });
      expect(plausibleConfiguredBotmuxHome(join(home, 'odd'), { ...lay, storeDir: join(home, 'odd', 'mystore') })).toBe(false);
      mkdirSync(join(home, 'odd2', 'skills', 'store'), { recursive: true });
      expect(plausibleConfiguredBotmuxHome(join(home, 'odd2'), { ...lay, storeDir: join(home, 'odd2', 'skills', 'store') })).toBe(true);
      // contains a botmux home somewhere other than at $HOME/.botmux
      mkdirSync(join(root, 'x', 'dfl'), { recursive: true });
      expect(plausibleConfiguredBotmuxHome(join(root, 'x'), { ...lay, defaultBotmux: join(root, 'x', 'dfl') })).toBe(false);
    });
  });
});
