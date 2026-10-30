import { describe, expect, it } from 'vitest';
import {
  scratchHostView,
  remapIntoMerged,
  attachScratchSession,
} from '../src/adapters/backend/scratch-sandbox.js';
import {
  scratchViewPath,
  scratchViewPathSingle,
  scratchLinuxMappings,
  registerScratchView,
  registeredScratchView,
  clearScratchView,
  persistedScratchMappings,
  type ScratchPathMapping,
} from '../src/services/scratch-host-view.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';
import { lastJsonLine, privateMountNsAvailable, runInPrivateMountNs } from './helpers/private-mount-ns.js';

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

describe('attachScratchSession (warm reattach of a live scratch pane)', () => {
  it('re-serves the preserved outbox and never recreates one the pane cannot see', () => {
    if (process.platform !== 'linux') return;
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'scratch-attach-')));
    const sessionId = 'sid-live';
    const sessionRoot = join(dataDir, 'sandboxes', sessionId);
    const outbox = join(sessionRoot, 'outbox');
    const merged = join(sessionRoot, 'root');
    try {
      // No scratch tree at all.
      expect(attachScratchSession({ sessionId, dataDir })).toBeNull();
      mkdirSync(merged, { recursive: true });
      writeFileSync(join(sessionRoot, 'scratch.json'), JSON.stringify({
        v: 1, sid: sessionId, storage: 'disk', lower: '/', merged,
        upper: join(sessionRoot, 'upper'), work: join(sessionRoot, 'work'), createdAt: 1,
      }));
      // Meta survived but the outbox the pane bound by inode did not.
      expect(attachScratchSession({ sessionId, dataDir })).toBeNull();
      expect(existsSync(outbox)).toBe(false);
      mkdirSync(outbox);
      const inode = statSync(outbox).ino;
      const attached = attachScratchSession({ sessionId, dataDir });
      expect(attached?.outbox).toBe(outbox);
      expect(attached?.mergedHostPath).toBe(merged);
      expect(statSync(attached!.outbox).ino).toBe(inode);
    } finally {
      rmSandboxScratch(dataDir);
    }
  });
});

// These prepare a REAL scratch overlay (and one overlay per host submount), so
// they run in a private mount + PID namespace: a killed run cannot leave any of
// it in the host mount table for later scratch sessions to wrap again.
const diskScratchInPrivateNs = privateMountNsAvailable() && lastJsonLine<boolean>(runInPrivateMountNs(`
import { probeScratchMountsInThisNamespace } from './test/helpers/scratch-mount-probe.js';
console.log(JSON.stringify(probeScratchMountsInThisNamespace('disk')));
`)) === true;

describe('prepareScratchSandbox session temp alias', () => {
  it.skipIf(!diskScratchInPrivateNs).each([false, true])('keeps temp files inside COW and deny masks effective (args file: %s)', useBwrapArgsFile => {
    // The alias must live under the fresh /tmp mount, even when outer TMPDIR is elsewhere.
    const root = realpathSync(mkdtempSync('/tmp/scratch-short-temp-'));
    try {
      const run = runInPrivateMountNs(`
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareScratchSandbox, scratchHostView } from './src/adapters/backend/scratch-sandbox.js';
const root = ${JSON.stringify(root)};
const workingDir = join(root, 'work');
const cache = join(workingDir, 'cache', 'session');
const alias = join(root, 'short', 'session');
mkdirSync(cache, { recursive: true });
mkdirSync(join(root, 'short'));
symlinkSync(cache, alias);
writeFileSync(join(cache, 'secret'), 'must-stay-hidden');
const script = ${JSON.stringify(`
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
fs.writeFileSync(path.join(dir, 'artifact'), 'cow-only');
let secret;
try { secret = fs.readFileSync(path.join(os.tmpdir(), 'secret'), 'utf8'); } catch {}
console.log(JSON.stringify({ dir, temp: os.tmpdir(), secret: secret ?? null }));
`)};
// Bun itself may be a downloaded binary under /tmp, which scratch masks.
// Run the JS probe with installed Node; keep preparation on the test runtime.
const node = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' });
if (node.status !== 0) throw new Error('installed Node is required for the sandbox probe');
const plan = prepareScratchSandbox({ sessionId: 'short-temp', dataDir: join(root, 'data'),
  storage: 'disk', chdir: workingDir, home: workingDir,
  cliBin: realpathSync(node.stdout.trim()), cliArgs: ['-e', script], tempDir: alias,
  denyPaths: [join(cache, 'secret')], useBwrapArgsFile: ${useBwrapArgsFile} });
if (!plan) throw new Error('scratch preparation failed after capability probe');
try {
  const child = spawnSync(plan.bin, plan.args, {
    env: { ...process.env, ...plan.env, TMPDIR: alias, TMP: alias, TEMP: alias },
    encoding: 'utf8', timeout: 20_000 });
  if (child.status !== 0) throw new Error('sandbox child failed: ' + child.stderr);
  const report = JSON.parse(child.stdout.trim());
  const physicalDir = join(cache, report.dir.slice(alias.length));
  console.log(JSON.stringify({ ...report, hostArtifact: existsSync(physicalDir),
    mergedArtifact: readFileSync(join(scratchHostView(plan.mergedHostPath, physicalDir), 'artifact'), 'utf8') }));
} finally { plan.cleanup(); }
`);
      const result = lastJsonLine<{ dir: string; temp: string; secret: string | null; hostArtifact: boolean; mergedArtifact: string }>(run);
      expect(run.status, run.stderr).toBe(0);
      expect(result.temp).toBe(join(root, 'short', 'session'));
      expect(result.dir.startsWith(result.temp + '/probe-')).toBe(true);
      expect(result.secret).not.toBe('must-stay-hidden');
      expect(result.hostArtifact).toBe(false);
      expect(result.mergedArtifact).toBe('cow-only');
    } finally { rmSandboxScratch(root); }
  });
});

describe('prepareScratchSandbox tmux argument transport', () => {
  it.skipIf(!privateMountNsAvailable())('stores long bwrap options in a private file while keeping CLI argv on the command line', () => {
    const root = mkdtempSync(join(tmpdir(), 'scratch-sbx-tmux-args-'));
    try {
      const run = runInPrivateMountNs(`
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { prepareScratchSandbox } from './src/adapters/backend/scratch-sandbox.js';
const root = ${JSON.stringify(root)};
const dataDir = join(root, 'data');
const workingDir = join(root, 'work');
mkdirSync(dataDir, { recursive: true });
mkdirSync(workingDir, { recursive: true });
const denyPaths = Array.from({ length: 360 }, (_, index) => {
  const path = join(workingDir, \`deny-entry-\${index}-\${'x'.repeat(32)}\`);
  mkdirSync(path, { recursive: true });
  return path;
});
const plan = prepareScratchSandbox({
  sessionId: 'scratch-long-tmux',
  dataDir,
  storage: 'disk',
  chdir: workingDir,
  home: root,
  cliBin: '/bin/printf',
  cliArgs: ['%s', 'space value', '$literal', 'line\\nbreak'],
  denyPaths,
  useBwrapArgsFile: true,
});
if (!plan) { console.log(JSON.stringify({ prepared: false })); process.exit(0); }
const optionBytes = readFileSync(plan.argsFile);
const result = {
  prepared: true,
  argsFileMode: statSync(plan.argsFile).mode & 0o777,
  commandLineBytes: Buffer.byteLength([plan.bin, ...plan.args].join('\\0')),
  cliArgv: plan.args.slice(plan.args.indexOf('--') + 1),
  optionBytes: optionBytes.length,
  optionsHoldCliArg: optionBytes.includes(Buffer.from('space value')),
};
plan.cleanup();
console.log(JSON.stringify({
  ...result,
  treeAfterCleanup: existsSync(join(dataDir, 'sandboxes', 'scratch-long-tmux')),
  argsFileAfterCleanup: existsSync(plan.argsFile),
}));
`);
      const result = lastJsonLine<Record<string, unknown>>(run);
      expect(result.prepared, run.stderr).toBe(true);
      expect(result.argsFileMode).toBe(0o600);
      expect(result.commandLineBytes).toBeLessThan(8 * 1024);
      expect(result.cliArgv).toEqual([realpathSync('/bin/printf'), '%s', 'space value', '$literal', 'line\nbreak']);
      expect(result.optionBytes).toBeGreaterThan(16 * 1024);
      expect(result.optionsHoldCliArg).toBe(false);
      expect(result.treeAfterCleanup).toBe(false);
      expect(result.argsFileAfterCleanup).toBe(false);
    } finally {
      rmSandboxScratch(root);
    }
  });

  // Reaching the argv check needs the host-side overlay to come up first; in a
  // container without the mount primitives prepareScratchSandbox returns null
  // before it ever looks at the argv, so gate on the real capability.
  it.skipIf(!diskScratchInPrivateNs)('reclaims the scratch sandbox tree if compact launch preparation rejects invalid argv', () => {
    const root = mkdtempSync(join(tmpdir(), 'scratch-sbx-tmux-invalid-'));
    try {
      const run = runInPrivateMountNs(`
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { prepareScratchSandbox } from './src/adapters/backend/scratch-sandbox.js';
const root = ${JSON.stringify(root)};
const dataDir = join(root, 'data');
const workingDir = join(root, 'work');
mkdirSync(dataDir, { recursive: true });
mkdirSync(workingDir, { recursive: true });
let error = null;
try {
  prepareScratchSandbox({
    sessionId: 'invalid-argv',
    dataDir,
    storage: 'disk',
    chdir: workingDir,
    home: root,
    cliBin: '/bin/true',
    cliArgs: ['invalid\\0argument'],
    useBwrapArgsFile: true,
  });
} catch (thrown) {
  error = String(thrown?.message ?? thrown);
}
console.log(JSON.stringify({ error, treeExists: existsSync(join(realpathSync(dataDir), 'sandboxes', 'invalid-argv')) }));
`);
      const result = lastJsonLine<{ error: string | null; treeExists: boolean }>(run);
      expect(result.error, run.stderr).toMatch(/NUL/);
      expect(result.treeExists).toBe(false);
    } finally {
      rmSandboxScratch(root);
    }
  });
});
