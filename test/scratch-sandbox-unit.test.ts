import { describe, expect, it } from 'vitest';
import {
  scratchHostView,
  remapIntoMerged,
  prepareScratchSandbox,
} from '../src/adapters/backend/scratch-sandbox.js';
import {
  scratchMergedRootFor,
  scratchViewPath,
  scratchViewPathSingle,
  scratchLinuxMappings,
  registerScratchView,
  registeredScratchView,
  clearScratchView,
  persistedScratchMappings,
  type ScratchPathMapping,
} from '../src/services/scratch-host-view.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';

describe('Linux scratch host-view mapping', () => {
  const merged = '/var/lib/botmux/data/sandboxes/sid-1/root';

  it('prefixes an absolute host path with the merged root', () => {
    expect(scratchHostView(merged, '/root/.codex/x.jsonl'))
      .toBe(`${merged}/root/.codex/x.jsonl`);
    expect(scratchHostView(merged, '/etc/hostname')).toBe(`${merged}/etc/hostname`);
  });

  it('rejects relative input', () => {
    expect(() => scratchHostView(merged, 'etc/hostname')).toThrow(/absolute path/);
  });

  it('keeps the back-compat alias identical', () => {
    expect(remapIntoMerged(merged, '/root/x')).toBe(scratchHostView(merged, '/root/x'));
  });

  it('derives the merged root deterministically from dataDir + sid', () => {
    expect(scratchMergedRootFor('/data', 'sid')).toBe('/data/sandboxes/sid/root');
  });

  it('builds the single full-root linux mapping', () => {
    expect(scratchLinuxMappings(merged)).toEqual([{ from: '/', to: merged }]);
  });
});

describe('multi-mapping scratchViewPath (Linux + macOS)', () => {
  const merged = '/data/sandboxes/s/root';

  it('returns the input unchanged without mappings / for relative input', () => {
    expect(scratchViewPath(undefined, '/root/x')).toBe('/root/x');
    expect(scratchViewPath([], '/root/x')).toBe('/root/x');
    expect(scratchViewPath(scratchLinuxMappings(merged), 'rel')).toBe('rel');
  });

  it('maps through the linux full-root mapping', () => {
    expect(scratchViewPath(scratchLinuxMappings(merged), '/root/x')).toBe(`${merged}/root/x`);
  });

  it('maps HOME and a nested project clone independently (macOS shape)', () => {
    const maps: ScratchPathMapping[] = [
      { from: '/Users/u', to: '/data/sandboxes/s/clone/home/__Users_u' },
      { from: '/Volumes/proj', to: '/data/sandboxes/s/clone/work/__Volumes_proj' },
    ];
    expect(scratchViewPath(maps, '/Users/u/.codex/s.jsonl'))
      .toBe('/data/sandboxes/s/clone/home/__Users_u/.codex/s.jsonl');
    expect(scratchViewPath(maps, '/Volumes/proj/app/main.go'))
      .toBe('/data/sandboxes/s/clone/work/__Volumes_proj/app/main.go');
    // Uncovered system path is returned unchanged (read-only, not cloned).
    expect(scratchViewPath(maps, '/etc/hostname')).toBe('/etc/hostname');
  });

  it('lets a deeper mapping win over a shallower one regardless of order', () => {
    const maps: ScratchPathMapping[] = [
      { from: '/Volumes/proj', to: '/clone/proj' },
      { from: '/Users/u', to: '/clone/home' },
    ];
    expect(scratchViewPath([...maps].reverse(), '/Users/u/.zshrc')).toBe('/clone/home/.zshrc');
  });

  it('single-root helper matches the multi-mapping result', () => {
    expect(scratchViewPathSingle(merged, '/root/x')).toBe(`${merged}/root/x`);
    expect(scratchViewPathSingle(undefined, '/root/x')).toBe('/root/x');
  });
});

describe('live view registry', () => {
  it('tracks mappings per session and ignores empty input', () => {
    const maps = scratchLinuxMappings('/m/root');
    expect(registeredScratchView('sid-reg')).toBeUndefined();
    registerScratchView('sid-reg', maps);
    expect(registeredScratchView('sid-reg')).toEqual(maps);
    registerScratchView('sid-reg', undefined);
    registerScratchView('sid-reg', []);
    expect(registeredScratchView('sid-reg')).toEqual(maps);
    clearScratchView('sid-reg');
    expect(registeredScratchView('sid-reg')).toBeUndefined();
  });
});

describe('persistedScratchMappings (cross-process meta)', () => {
  it('reads the mappings array from scratch.json and rejects garbage entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scratch-meta-'));
    const sid = 'sid-meta';
    const tree = join(dir, 'sandboxes', sid);
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, 'scratch.json'), JSON.stringify({
      mappings: [
        { from: '/Users/u', to: join(tree, 'clone', 'home') },
        { from: 'relative/bad', to: '/x' },
        { from: '/p', to: 'notabs' },
        'junk',
      ],
    }));
    expect(persistedScratchMappings(dir, sid)).toEqual([
      { from: '/Users/u', to: join(tree, 'clone', 'home') },
    ]);
    expect(persistedScratchMappings(dir, 'nope')).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('scratchViewPath canonicalises symlink-aliased input (mac /tmp → /private/tmp)', () => {
  it('maps a path given via a symlink alias when it exists on disk', () => {
    // /tmp is a symlink to /private/tmp on macOS (and often Linux too). Build
    // a mapping from the REAL path; the caller hands in the alias.
    const maps: ScratchPathMapping[] = [
      { from: '/private/tmp/work', to: '/clone/work' },
    ];
    // Only assert when this host actually has the /tmp → /private/tmp alias.
    let realTmp: string;
    try { realTmp = realpathSync('/tmp'); } catch { realTmp = '/tmp'; }
    if (realTmp !== '/tmp') {
      const aliasWork = join('/tmp', 'work', 'x');
      const got = scratchViewPath(maps, aliasWork);
      expect(got).toBe(join('/clone/work', 'x'));
    }
  });

  it('falls back to the original path when canonicalisation cannot resolve', () => {
    const maps: ScratchPathMapping[] = [{ from: '/home/u', to: '/clone/home' }];
    // A definitely-nonexistent path uncovered by any mapping returns as-is.
    const p = '/some/missing/path/that/does/not/exist';
    expect(scratchViewPath(maps, p)).toBe(p);
  });
});

describe('prepareScratchSandbox tmux argument transport', () => {
  it('stores long bwrap options in a private file while keeping CLI argv on the command line', () => {
    if (process.platform !== 'linux' || process.getuid?.() !== 0) return;
    const root = mkdtempSync(join(tmpdir(), 'scratch-sbx-tmux-args-'));
    const dataDir = join(root, 'data');
    const workingDir = join(root, 'work');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workingDir, { recursive: true });
    const denyPaths = Array.from({ length: 360 }, (_, index) => {
      const path = join(workingDir, `deny-entry-${index}-${'x'.repeat(32)}`);
      mkdirSync(path, { recursive: true });
      return path;
    });
    let plan: ReturnType<typeof prepareScratchSandbox> = null;
    try {
      plan = prepareScratchSandbox({
        sessionId: 'scratch-long-tmux',
        dataDir,
        storage: 'disk',
        chdir: workingDir,
        home: root,
        cliBin: '/bin/printf',
        cliArgs: ['%s', 'space value', '$literal', 'line\nbreak'],
        denyPaths,
        useBwrapArgsFile: true,
      });
      if (!plan) return;

      expect(plan.argsFile).toBeDefined();
      expect(statSync(plan.argsFile!).mode & 0o777).toBe(0o600);
      expect(Buffer.byteLength([plan.bin, ...plan.args].join('\0'))).toBeLessThan(8 * 1024);
      expect(plan.args.slice(plan.args.indexOf('--') + 1)).toEqual([
        realpathSync('/bin/printf'), '%s', 'space value', '$literal', 'line\nbreak',
      ]);
      const optionBytes = readFileSync(plan.argsFile!);
      expect(optionBytes.length).toBeGreaterThan(16 * 1024);
      expect(optionBytes.includes(Buffer.from('space value'))).toBe(false);
      plan.cleanup();
      expect(existsSync(join(dataDir, 'sandboxes', 'scratch-long-tmux'))).toBe(false);
    } finally {
      plan?.cleanup();
      if (plan?.argsFile) expect(existsSync(plan.argsFile)).toBe(false);
      rmSandboxScratch(root);
    }
  });

  it('reclaims the scratch sandbox tree if compact launch preparation rejects invalid argv', () => {
    if (process.platform !== 'linux' || process.getuid?.() !== 0) return;
    const root = mkdtempSync(join(tmpdir(), 'scratch-sbx-tmux-invalid-'));
    const dataDir = join(root, 'data');
    const workingDir = join(root, 'work');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workingDir, { recursive: true });
    const sessionRoot = join(realpathSync(dataDir), 'sandboxes', 'invalid-argv');
    try {
      expect(() => prepareScratchSandbox({
        sessionId: 'invalid-argv',
        dataDir,
        storage: 'disk',
        chdir: workingDir,
        home: root,
        cliBin: '/bin/true',
        cliArgs: ['invalid\0argument'],
        useBwrapArgsFile: true,
      })).toThrow(/NUL/);
      expect(existsSync(sessionRoot)).toBe(false);
    } finally {
      rmSandboxScratch(root);
    }
  });
});
