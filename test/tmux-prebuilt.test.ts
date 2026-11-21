import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TMUX_PREBUILT_CANDIDATES,
  debDataMember,
  extractTmuxFromDeb,
  glibcAtLeast,
  inspectManagedTmux,
  installManagedTmux,
  installManagedTmuxForHost,
  missingLibrariesFromLoaderError,
  parseGlibcVersion,
  parseLdconfigLibraries,
  prebuiltCandidatesFor,
  probePrebuiltSupport,
  releaseIdFor,
  sha256Hex,
  type PrebuiltInstallIo,
  type PrebuiltSupportIo,
  type TmuxPrebuiltCandidate,
} from '../src/setup/tmux-prebuilt.js';
import { TMUX_RECOMMENDED_MIN, isTmuxBelowRecommended, parseTmuxRelease } from '../src/setup/tmux-recommended.js';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ─── Synthetic .deb fixtures (no real tmux anywhere) ────────────────────────

function tarEntry(name: string, body: Buffer, mode: number): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 'utf8');
  header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 'latin1');
  header.write('0000000\0', 108, 'latin1');
  header.write('0000000\0', 116, 'latin1');
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
  header.write('00000000000\0', 136, 'latin1');
  header.write('        ', 148, 'latin1');
  header.write('0', 156, 'latin1');
  header.write('ustar\0' + '00', 257, 'latin1');
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
  return Buffer.concat([header, body, pad]);
}

function tarOf(files: Array<{ name: string; body: string; mode?: number }>): Buffer {
  return Buffer.concat([
    ...files.map(f => tarEntry(f.name, Buffer.from(f.body), f.mode ?? 0o644)),
    Buffer.alloc(1024, 0),
  ]);
}

function arOf(members: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [Buffer.from('!<arch>\n', 'latin1')];
  for (const m of members) {
    const h = `${m.name.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(m.data.length).padEnd(10)}\`\n`;
    parts.push(Buffer.from(h, 'latin1'), m.data);
    if (m.data.length & 1) parts.push(Buffer.from('\n', 'latin1'));
  }
  return Buffer.concat(parts);
}

/** A fake "tmux" (a shell script) that answers -V like the real one would. */
function fakeTmuxScript(versionLine: string, opts: { exitCode?: number } = {}): string {
  return `#!/bin/sh\nif [ "$1" = -V ]; then echo "${versionLine}"; exit ${opts.exitCode ?? 0}; fi\nexit 0\n`;
}

const scriptOf = new WeakMap<Buffer, string>();

function debWith(script: string, compression: 'gz' | 'xz' = 'gz'): Buffer {
  const tar = tarOf([
    { name: './usr/bin/tmux', body: script, mode: 0o755 },
    { name: './usr/share/doc/tmux/README', body: 'readme' },
  ]);
  let data: Buffer;
  if (compression === 'gz') data = gzipSync(tar);
  else {
    const r = spawnSync('xz', ['-c'], { input: tar });
    if (r.status !== 0) throw new Error('xz unavailable');
    data = r.stdout;
  }
  const deb = arOf([
    { name: 'debian-binary', data: Buffer.from('2.0\n') },
    { name: 'control.tar.gz', data: gzipSync(tarOf([{ name: './control', body: 'Package: tmux\n' }])) },
    { name: `data.tar.${compression}`, data },
  ]);
  scriptOf.set(deb, script);
  return deb;
}

function candidateFor(deb: Buffer, over: Partial<TmuxPrebuiltCandidate> = {}): TmuxPrebuiltCandidate {
  return {
    release: '3.5a',
    debVersion: '3.5a-2~bpo12+1',
    arch: 'x64',
    fileName: 'tmux_3.5a-2~bpo12+1_amd64.deb',
    size: deb.length,
    sha256: sha256Hex(deb),
    binSha256: sha256Hex(Buffer.from(scriptOf.get(deb) ?? '')),
    urls: ['https://mirror-a.invalid/tmux.deb', 'https://mirror-b.invalid/tmux.deb'],
    hostLibraries: ['libevent_core-2.1.so.7'],
    minGlibc: '2.34',
    ...over,
  };
}

const fixtureTable: TmuxPrebuiltCandidate[] = [];
/** Fixture candidates are what this test's "botmux" ships (ownership table). */
function TABLE(cs: TmuxPrebuiltCandidate[]): TmuxPrebuiltCandidate[] {
  for (const c of cs) if (!fixtureTable.includes(c)) fixtureTable.push(c);
  return fixtureTable;
}
const inspect = (root: string) => inspectManagedTmux(root, fixtureTable);

const hasXz = spawnSync('xz', ['--version']).status === 0;
const hasDpkgDeb = spawnSync('dpkg-deb', ['--version']).status === 0;

/** Real extraction / -V / probe (the fixture binary is a script), fake network. */
function io(files: Record<string, Buffer | Error>, over: Partial<PrebuiltInstallIo> = {}): PrebuiltInstallIo & { downloads: string[] } {
  const downloads: string[] = [];
  return {
    downloads,
    download: vi.fn(async (url: string, maxBytes: number) => {
      downloads.push(url);
      const f = files[url];
      if (!f) throw new Error('HTTP 404');
      if (f instanceof Error) throw f;
      if (f.length > maxBytes) throw new Error(`response larger than ${maxBytes} bytes`);
      return f;
    }),
    extractTmux: (deb, workDir) => extractTmuxFromDeb(deb, workDir, { dpkgDeb: null }),
    runVersion: async bin => {
      const r = spawnSync(bin, ['-V'], { encoding: 'utf8' });
      return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    },
    functionalProbe: vi.fn(async () => ({ ok: true, output: '' })),
    now: () => new Date('2026-11-20T00:00:00Z'),
    ...over,
  };
}

// ─── The fixed candidate table ──────────────────────────────────────────────

describe('fixed prebuilt sources', () => {
  it('every candidate is pinned: exact file, size, SHA256, https URLs naming that file', () => {
    expect(TMUX_PREBUILT_CANDIDATES.length).toBeGreaterThan(0);
    for (const c of TMUX_PREBUILT_CANDIDATES) {
      expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(c.size).toBeGreaterThan(100_000);
      expect(c.fileName).toBe(`tmux_${c.debVersion}_${c.arch === 'x64' ? 'amd64' : 'arm64'}.deb`);
      expect(c.debVersion.startsWith(`${c.release}-`)).toBe(true);
      expect(c.urls.length).toBeGreaterThan(0);
      for (const url of c.urls) {
        expect(url.startsWith('https://')).toBe(true);
        expect(url.endsWith(`/${c.fileName}`)).toBe(true);
      }
      // A permanent copy always exists (the live pool drops superseded backports).
      expect(c.urls.some(u => u.startsWith('https://snapshot.debian.org/'))).toBe(true);
      expect(c.hostLibraries.length).toBeGreaterThan(0);
      expect(parseTmuxRelease(c.release)).not.toBeNull();
    }
  });

  it('every supported architecture has a candidate that meets the recommendation', () => {
    for (const arch of ['x64', 'arm64'] as const) {
      const usable = prebuiltCandidatesFor(arch);
      expect(usable.length).toBeGreaterThan(0);
      expect(usable.every(c => !isTmuxBelowRecommended(c.release, TMUX_RECOMMENDED_MIN))).toBe(true);
    }
  });

  it('release ids are plain directory names', () => {
    for (const c of TMUX_PREBUILT_CANDIDATES) expect(releaseIdFor(c)).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('parsing helpers', () => {
  it('reads the data member of a .deb and rejects garbage', () => {
    const deb = debWith(fakeTmuxScript('tmux 3.5a'));
    expect(debDataMember(deb).name).toBe('data.tar.gz');
    expect(() => debDataMember(Buffer.from('not a deb'))).toThrow();
    expect(() => debDataMember(deb.subarray(0, deb.length - 10))).toThrow();
  });

  it('ldconfig -p / loader errors / glibc versions', () => {
    const ld = [
      '1342 libs found in cache `/etc/ld.so.cache\'',
      '\tlibjemalloc.so.2 (libc6,x86-64) => /lib/x86_64-linux-gnu/libjemalloc.so.2',
      '\tlibevent_core-2.1.so.7 (libc6,x86-64) => /lib/x86_64-linux-gnu/libevent_core-2.1.so.7',
      '\tlibutempter.so.0 (libc6) => /lib/i386-linux-gnu/libutempter.so.0',
    ].join('\n');
    expect([...parseLdconfigLibraries(ld, 'x64')].sort()).toEqual(['libevent_core-2.1.so.7', 'libjemalloc.so.2']);
    expect(parseLdconfigLibraries(ld, 'arm64').size).toBe(0);
    expect(missingLibrariesFromLoaderError(
      '/x/tmux: error while loading shared libraries: libjemalloc.so.2: cannot open shared object file: No such file or directory',
    )).toEqual(['libjemalloc.so.2']);
    expect(parseGlibcVersion('glibc 2.36\n')).toBe('2.36');
    expect(parseGlibcVersion('')).toBeUndefined();
    expect(glibcAtLeast('2.35', '2.34')).toBe(true);
    expect(glibcAtLeast('2.31', '2.34')).toBe(false);
    expect(glibcAtLeast('2.34', '2.34')).toBe(true);
  });
});

describe('extracting usr/bin/tmux', () => {
  it('via tar (gzip data member)', async () => {
    const work = tempDir('pb-extract-');
    const bin = await extractTmuxFromDeb(debWith(fakeTmuxScript('tmux 3.5a')), join(work, 'w'), { dpkgDeb: null });
    expect(readFileSync(bin, 'utf8')).toContain('tmux 3.5a');
  });

  it.runIf(hasXz)('via tar + xz (the format Debian ships)', async () => {
    const work = tempDir('pb-extract-');
    const bin = await extractTmuxFromDeb(debWith(fakeTmuxScript('tmux 3.5a'), 'xz'), join(work, 'w'), { dpkgDeb: null });
    expect(readFileSync(bin, 'utf8')).toContain('tmux 3.5a');
  });

  it.runIf(hasDpkgDeb && hasXz)('via dpkg-deb when it is present', async () => {
    const work = tempDir('pb-extract-');
    const bin = await extractTmuxFromDeb(debWith(fakeTmuxScript('tmux 3.5a'), 'xz'), join(work, 'w'));
    expect(readFileSync(bin, 'utf8')).toContain('tmux 3.5a');
  });
});

// ─── Host support ───────────────────────────────────────────────────────────

describe('can this host run botmux\'s own tmux', () => {
  const allLibs = [...new Set(TMUX_PREBUILT_CANDIDATES.flatMap(c => c.hostLibraries))];
  const ldWith = (libs: readonly string[]) => libs.map(l => `\t${l} (libc6,x86-64) => /lib/x86_64-linux-gnu/${l}`).join('\n');
  function supportIo(over: Partial<PrebuiltSupportIo> = {}): PrebuiltSupportIo {
    return {
      platform: 'linux',
      arch: 'x64',
      glibcVersion: async () => 'glibc 2.36',
      has: () => true,
      ldconfig: async () => ldWith(allLibs),
      ...over,
    };
  }

  it('a glibc ≥ 2.34 Linux host with the libraries gets every candidate, in order', async () => {
    const s = await probePrebuiltSupport(supportIo());
    expect(s).toMatchObject({ ok: true, arch: 'x64', glibc: '2.36' });
    expect(s.ok && s.candidates.map(c => c.release)).toEqual(prebuiltCandidatesFor('x64').map(c => c.release));
  });

  it('only the candidate whose libraries the host has', async () => {
    const without35 = allLibs.filter(l => l !== 'libjemalloc.so.2');
    const s = await probePrebuiltSupport(supportIo({ ldconfig: async () => ldWith(without35) }));
    expect(s.ok && s.candidates.every(c => !c.hostLibraries.includes('libjemalloc.so.2'))).toBe(true);
  });

  it('no candidate fits → names what the closest one lacks', async () => {
    const s = await probePrebuiltSupport(supportIo({ ldconfig: async () => ldWith(['libtinfo.so.6']) }));
    expect(s).toMatchObject({ ok: false, reason: 'libraries' });
    expect(!s.ok && s.missingLibraries).toContain('libevent_core-2.1.so.7');
  });

  it('unreadable ldconfig leaves it to the install-time trial run', async () => {
    expect(await probePrebuiltSupport(supportIo({ ldconfig: async () => null }))).toMatchObject({ ok: true });
  });

  it('refuses non-Linux, other architectures, musl / old glibc, no extractor, outdated table', async () => {
    expect(await probePrebuiltSupport(supportIo({ platform: 'darwin' }))).toMatchObject({ ok: false, reason: 'platform' });
    expect(await probePrebuiltSupport(supportIo({ arch: 'ia32' }))).toMatchObject({ ok: false, reason: 'arch' });
    expect(await probePrebuiltSupport(supportIo({ glibcVersion: async () => null }))).toMatchObject({ ok: false, reason: 'glibc' });
    expect(await probePrebuiltSupport(supportIo({ glibcVersion: async () => 'glibc 2.31' }))).toMatchObject({ ok: false, reason: 'glibc', detail: '2.31' });
    expect(await probePrebuiltSupport(supportIo({ has: () => false }))).toMatchObject({ ok: false, reason: 'extractor' });
    expect(await probePrebuiltSupport(supportIo({ has: t => t === 'tar' }))).toMatchObject({ ok: false, reason: 'extractor' });
    expect(await probePrebuiltSupport(supportIo({ has: t => t === 'tar' || t === 'xz' }))).toMatchObject({ ok: true });
    expect(await probePrebuiltSupport(supportIo(), { version: '9.9', why: { zh: '', en: '' } }))
      .toMatchObject({ ok: false, reason: 'outdated' });
  });
});

// ─── Install ────────────────────────────────────────────────────────────────

describe('installing botmux\'s own tmux', () => {
  it('downloads, verifies, stages, then switches `current` — the binary keeps its name', async () => {
    const root = join(tempDir('pb-root-'), 'tmux');
    const deb = debWith(fakeTmuxScript('tmux 3.5a'));
    const c = candidateFor(deb);
    const fakeIo = io({ [c.urls[0]!]: deb });
    const lines: string[] = [];
    const r = await installManagedTmux({ root, table: TABLE([c]), candidates: [c], io: fakeIo, onLine: l => lines.push(l) });
    expect(r).toMatchObject({ ok: true, release: '3.5a', source: c.urls[0] });
    expect(lstatSync(join(root, 'current')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, 'current'))).toBe(`releases/${releaseIdFor(c)}`);
    const state = inspect(root);
    expect(state).toMatchObject({ state: 'valid', manifest: { release: '3.5a', debSha256: c.sha256, fileName: c.fileName } });
    expect(state.state === 'valid' && state.binPath.endsWith('/bin/tmux')).toBe(true);
    // What tmuxEnv puts first on PATH (precedence itself: tmux-env-managed.test.ts).
    expect(readFileSync(join(root, 'current', 'bin', 'tmux'), 'utf8')).toContain('tmux 3.5a');
    expect(fakeIo.functionalProbe).toHaveBeenCalledTimes(1);
    expect(lines.join('\n')).toContain('sha256 ok');
    // No staging or temp link left behind.
    expect(readdirSync(join(root, 'releases'))).toEqual([releaseIdFor(c)]);
    expect(readdirSync(root).sort()).toEqual(['current', 'releases']);
  });

  it('wrong bytes from one mirror are discarded; the other mirror is used', async () => {
    const root = join(tempDir('pb-root-'), 'tmux');
    const deb = debWith(fakeTmuxScript('tmux 3.5a'));
    const c = candidateFor(deb);
    const tampered = Buffer.from(deb);
    tampered[tampered.length - 1] ^= 0xff;
    const fakeIo = io({ [c.urls[0]!]: tampered, [c.urls[1]!]: deb });
    const r = await installManagedTmux({ root, table: TABLE([c]), candidates: [c], io: fakeIo, onLine: () => {} });
    expect(r).toMatchObject({ ok: true, source: c.urls[1] });
  });

  it('nothing matches the pinned SHA256 → nothing is installed or executed', async () => {
    const root = join(tempDir('pb-root-'), 'tmux');
    const deb = debWith(fakeTmuxScript('tmux 3.5a'));
    const c = candidateFor(deb);
    const evil = Buffer.from(deb);
    evil[evil.length - 2] ^= 0x55; // same size, different bytes
    const runVersion = vi.fn(async () => ({ ok: true, output: 'tmux 3.5a' }));
    const fakeIo = io({ [c.urls[0]!]: evil, [c.urls[1]!]: evil }, { runVersion });
    const r = await installManagedTmux({ root, table: TABLE([c]), candidates: [c], io: fakeIo, onLine: () => {} });
    expect(r).toMatchObject({ ok: false, failure: 'checksum_mismatch' });
    expect(runVersion).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'current'))).toBe(false);
  });

  it('an oversized body is refused while downloading (never buffered past the pinned size)', async () => {
    const root = join(tempDir('pb-root-'), 'tmux');
    const deb = debWith(fakeTmuxScript('tmux 3.5a'));
    const c = candidateFor(deb);
    const fakeIo = io({ [c.urls[0]!]: Buffer.concat([deb, Buffer.alloc(10)]), [c.urls[1]!]: new Error('ECONNRESET') });
    const r = await installManagedTmux({ root, table: TABLE([c]), candidates: [c], io: fakeIo, onLine: () => {} });
    expect(r).toMatchObject({ ok: false, failure: 'download_failed' });
    for (const [, maxBytes] of (fakeIo.download as any).mock.calls) expect(maxBytes).toBeLessThanOrEqual(c.size + 1);
    expect(existsSync(join(root, 'current'))).toBe(false);
  });

  it('a candidate whose libraries the host lacks is skipped for the next one', async () => {
    const root = join(tempDir('pb-root-'), 'tmux');
    const needsJemalloc = debWith('#!/bin/sh\necho "/x/tmux: error while loading shared libraries: libjemalloc.so.2: cannot open shared object file: No such file or directory" >&2\nexit 127\n');
    const works = debWith(fakeTmuxScript('tmux 3.4'));
    const c35 = candidateFor(needsJemalloc, { urls: ['https://a.invalid/35.deb'] });
    const c34 = candidateFor(works, { release: '3.4', debVersion: '3.4-8~bpo12+1', fileName: 'tmux_3.4-8~bpo12+1_amd64.deb', urls: ['https://a.invalid/34.deb'] });
    const r = await installManagedTmux({
      root, table: TABLE([c35, c34]), candidates: [c35, c34], io: io({ [c35.urls[0]!]: needsJemalloc, [c34.urls[0]!]: works }), onLine: () => {},
    });
    expect(r).toMatchObject({ ok: true, release: '3.4' });
    expect(readdirSync(join(root, 'releases'))).toEqual([releaseIdFor(c34)]);
  });

  it('every candidate lacking libraries → libs_missing naming them, nothing installed', async () => {
    const root = join(tempDir('pb-root-'), 'tmux');
    const a = debWith('#!/bin/sh\necho "x: error while loading shared libraries: libjemalloc.so.2: cannot open shared object file: No such file or directory" >&2\nexit 127\n');
    const b = debWith('#!/bin/sh\necho "x: error while loading shared libraries: libutempter.so.0: cannot open shared object file: No such file or directory" >&2\nexit 127\n');
    const ca = candidateFor(a, { urls: ['https://a.invalid/a.deb'] });
    const cb = candidateFor(b, { release: '3.4', debVersion: '3.4-8~bpo12+1', fileName: 'tmux_3.4-8~bpo12+1_amd64.deb', urls: ['https://a.invalid/b.deb'] });
    const r = await installManagedTmux({ root, table: TABLE([ca, cb]), candidates: [ca, cb], io: io({ [ca.urls[0]!]: a, [cb.urls[0]!]: b }), onLine: () => {} });
    expect(r).toMatchObject({ ok: false, failure: 'libs_missing' });
    expect(!r.ok && r.missingLibraries?.sort()).toEqual(['libjemalloc.so.2', 'libutempter.so.0']);
    expect(existsSync(join(root, 'current'))).toBe(false);
    expect(readdirSync(join(root, 'releases'))).toEqual([]);
  });

  it('a binary reporting another release, or failing the server probe, is not promoted', async () => {
    const root = join(tempDir('pb-root-'), 'tmux');
    const wrong = debWith(fakeTmuxScript('tmux 3.3a'));
    const c = candidateFor(wrong);
    expect(await installManagedTmux({ root, table: TABLE([c]), candidates: [c], io: io({ [c.urls[0]!]: wrong }), onLine: () => {} }))
      .toMatchObject({ ok: false, failure: 'verify_failed' });

    const fine = debWith(fakeTmuxScript('tmux 3.5a'));
    const c2 = candidateFor(fine);
    const probeFails = io({ [c2.urls[0]!]: fine }, { functionalProbe: async () => ({ ok: false, output: 'create window failed' }) });
    expect(await installManagedTmux({ root, table: TABLE([c2]), candidates: [c2], io: probeFails, onLine: () => {} }))
      .toMatchObject({ ok: false, failure: 'verify_failed' });
    expect(existsSync(join(root, 'current'))).toBe(false);
  });

  it('an installed copy is replaced only atomically, and the old release is cleaned up', async () => {
    const root = join(tempDir('pb-root-'), 'tmux');
    const d34 = debWith(fakeTmuxScript('tmux 3.4'));
    const c34 = candidateFor(d34, { release: '3.4', debVersion: '3.4-8~bpo12+1', fileName: 'tmux_3.4-8~bpo12+1_amd64.deb', urls: ['https://a.invalid/34.deb'] });
    await installManagedTmux({ root, table: TABLE([c34]), candidates: [c34], io: io({ [c34.urls[0]!]: d34 }), onLine: () => {} });
    const d35 = debWith(fakeTmuxScript('tmux 3.5a'));
    const c35 = candidateFor(d35, { urls: ['https://a.invalid/35.deb'] });
    const r = await installManagedTmux({ root, table: TABLE([c35]), candidates: [c35], io: io({ [c35.urls[0]!]: d35 }), onLine: () => {} });
    expect(r).toMatchObject({ ok: true, release: '3.5a' });
    expect(readlinkSync(join(root, 'current'))).toBe(`releases/${releaseIdFor(c35)}`);
    expect(readdirSync(join(root, 'releases'))).toEqual([releaseIdFor(c35)]);
  });

  it('a failure while staging leaves the existing install exactly as it was', async () => {
    const root = join(tempDir('pb-root-'), 'tmux');
    const d34 = debWith(fakeTmuxScript('tmux 3.4'));
    const c34 = candidateFor(d34, { release: '3.4', debVersion: '3.4-8~bpo12+1', fileName: 'tmux_3.4-8~bpo12+1_amd64.deb', urls: ['https://a.invalid/34.deb'] });
    await installManagedTmux({ root, table: TABLE([c34]), candidates: [c34], io: io({ [c34.urls[0]!]: d34 }), onLine: () => {} });
    const before = inspect(root);
    const d35 = debWith(fakeTmuxScript('tmux 3.5a'));
    const c35 = candidateFor(d35, { urls: ['https://a.invalid/35.deb'] });
    const crashing = io({ [c35.urls[0]!]: d35 }, { functionalProbe: async () => { throw new Error('ENOSPC'); } });
    const r = await installManagedTmux({ root, table: TABLE([c35]), candidates: [c35], io: crashing, onLine: () => {} });
    expect(r).toMatchObject({ ok: false, failure: 'io' });
    expect(inspect(root)).toEqual(before);
    expect(readdirSync(join(root, 'releases'))).toEqual([releaseIdFor(c34)]);
  });

  it('the same release already installed is not downloaded again', async () => {
    const root = join(tempDir('pb-root-'), 'tmux');
    const deb = debWith(fakeTmuxScript('tmux 3.5a'));
    const c = candidateFor(deb);
    await installManagedTmux({ root, table: TABLE([c]), candidates: [c], io: io({ [c.urls[0]!]: deb }), onLine: () => {} });
    const again = io({});
    expect(await installManagedTmux({ root, table: TABLE([c]), candidates: [c], io: again, onLine: () => {} }))
      .toMatchObject({ ok: true, alreadyInstalled: true });
    expect(again.downloads).toEqual([]);
  });

  it('leftovers of an interrupted run are cleared before installing', async () => {
    const root = join(tempDir('pb-root-'), 'tmux');
    mkdirSync(join(root, 'releases', '.staging-old-deadbeef', 'bin'), { recursive: true });
    writeFileSync(join(root, 'current.tmp-cafe'), '');
    const deb = debWith(fakeTmuxScript('tmux 3.5a'));
    const c = candidateFor(deb);
    expect(await installManagedTmux({ root, table: TABLE([c]), candidates: [c], io: io({ [c.urls[0]!]: deb }), onLine: () => {} })).toMatchObject({ ok: true });
    expect(readdirSync(join(root, 'releases'))).toEqual([releaseIdFor(c)]);
    expect(readdirSync(root).sort()).toEqual(['current', 'releases']);
  });
});

describe('only a provably botmux-installed copy is ever replaced', () => {
  async function installed() {
    const root = join(tempDir('pb-root-'), 'tmux');
    const deb = debWith(fakeTmuxScript('tmux 3.4'));
    const c = candidateFor(deb, { release: '3.4', debVersion: '3.4-8~bpo12+1', fileName: 'tmux_3.4-8~bpo12+1_amd64.deb', urls: ['https://a.invalid/34.deb'] });
    await installManagedTmux({ root, table: TABLE([c]), candidates: [c], io: io({ [c.urls[0]!]: deb }), onLine: () => {} });
    const next = debWith(fakeTmuxScript('tmux 3.5a'));
    const c35 = candidateFor(next, { urls: ['https://a.invalid/35.deb'] });
    return { root, c35, next };
  }
  const tryReplace = async (root: string, c35: TmuxPrebuiltCandidate, next: Buffer) => {
    const fakeIo = io({ [c35.urls[0]!]: next });
    const r = await installManagedTmux({ root, table: TABLE([c35]), candidates: [c35], io: fakeIo, onLine: () => {} });
    return { r, downloads: fakeIo.downloads };
  };

  it('a modified executable', async () => {
    const { root, c35, next } = await installed();
    const state = inspect(root);
    if (state.state !== 'valid') throw new Error('setup');
    chmodSync(state.binPath, 0o755);
    writeFileSync(state.binPath, '#!/bin/sh\necho someone else\n');
    expect(inspect(root)).toMatchObject({ state: 'foreign' });
    const { r, downloads } = await tryReplace(root, c35, next);
    expect(r).toMatchObject({ ok: false, failure: 'foreign' });
    expect(downloads).toEqual([]);
    expect(readFileSync(state.binPath, 'utf8')).toContain('someone else');
  });

  it('a missing or rewritten manifest', async () => {
    const { root, c35, next } = await installed();
    const state = inspect(root);
    if (state.state !== 'valid') throw new Error('setup');
    writeFileSync(join(state.releaseDir, 'manifest.json'), '{"schema":2}');
    expect((await tryReplace(root, c35, next)).r).toMatchObject({ ok: false, failure: 'foreign' });
  });

  it('`current` that is a real directory, or points outside releases/', async () => {
    const a = await installed();
    rmSync(join(a.root, 'current'));
    mkdirSync(join(a.root, 'current'));
    expect((await tryReplace(a.root, a.c35, a.next)).r).toMatchObject({ ok: false, failure: 'foreign' });

    const b = await installed();
    rmSync(join(b.root, 'current'));
    symlinkSync('/usr', join(b.root, 'current'));
    expect((await tryReplace(b.root, b.c35, b.next)).r).toMatchObject({ ok: false, failure: 'foreign' });
  });

  it('`current` pointing at a well-formed copy OUTSIDE releases/ (or at a staging dir) is not ours', async () => {
    const a = await installed();
    const state = inspect(a.root);
    if (state.state !== 'valid') throw new Error('setup');
    // A complete, hash-consistent copy — but not where botmux keeps its releases.
    const outside = join(a.root, '..', 'elsewhere');
    mkdirSync(join(outside, 'bin'), { recursive: true });
    writeFileSync(join(outside, 'bin', 'tmux'), readFileSync(state.binPath), { mode: 0o755 });
    writeFileSync(join(outside, 'manifest.json'), readFileSync(join(state.releaseDir, 'manifest.json')));
    rmSync(join(a.root, 'current'));
    symlinkSync('../elsewhere', join(a.root, 'current'));
    expect(inspect(a.root)).toMatchObject({ state: 'foreign' });

    const b = await installed();
    const bs = inspect(b.root);
    if (bs.state !== 'valid') throw new Error('setup');
    const staging = join(b.root, 'releases', '.staging-x');
    mkdirSync(join(staging, 'bin'), { recursive: true });
    writeFileSync(join(staging, 'bin', 'tmux'), readFileSync(bs.binPath), { mode: 0o755 });
    writeFileSync(join(staging, 'manifest.json'), readFileSync(join(bs.releaseDir, 'manifest.json')));
    rmSync(join(b.root, 'current'));
    symlinkSync('releases/.staging-x', join(b.root, 'current'));
    expect(inspect(b.root)).toMatchObject({ state: 'foreign' });
  });

  it('anything else living in botmux\'s tmux directory', async () => {
    const { root, c35, next } = await installed();
    writeFileSync(join(root, 'notes.txt'), 'mine');
    expect((await tryReplace(root, c35, next)).r).toMatchObject({ ok: false, failure: 'foreign' });
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('mine');
  });
});

describe('the daemon entry point re-checks the host first', () => {
  it('an unsupported host is reported, nothing is downloaded', async () => {
    const download = vi.fn();
    const r = await installManagedTmuxForHost(() => {}, {
      root: join(tempDir('pb-root-'), 'tmux'),
      supportIo: { platform: 'linux', arch: 'x64', glibcVersion: async () => 'glibc 2.28', has: () => true, ldconfig: async () => null },
      io: { download, extractTmux: vi.fn(), runVersion: vi.fn(), functionalProbe: vi.fn(), now: () => new Date() },
    });
    expect(r).toMatchObject({ ok: false, failure: 'unsupported' });
    expect(download).not.toHaveBeenCalled();
  });

  it('missing libraries are reported as such', async () => {
    const r = await installManagedTmuxForHost(() => {}, {
      root: join(tempDir('pb-root-'), 'tmux'),
      supportIo: { platform: 'linux', arch: 'x64', glibcVersion: async () => 'glibc 2.36', has: () => true, ldconfig: async () => '' },
      io: { download: vi.fn(), extractTmux: vi.fn(), runVersion: vi.fn(), functionalProbe: vi.fn(), now: () => new Date() },
    });
    expect(r).toMatchObject({ ok: false, failure: 'libs_missing' });
    expect(!r.ok && r.missingLibraries?.length).toBeGreaterThan(0);
  });
});

describe('adversarial-review regressions', () => {
  async function installedAt(root: string, release = '3.4') {
    const deb = debWith(fakeTmuxScript(`tmux ${release}`));
    const c = candidateFor(deb, { release, debVersion: `${release}-8~bpo12+1`, fileName: `tmux_${release}-8~bpo12+1_amd64.deb`, urls: [`https://a.invalid/${release}.deb`] });
    expect(await installManagedTmux({ root, table: TABLE([c]), candidates: [c], io: io({ [c.urls[0]!]: deb }), onLine: () => {} })).toMatchObject({ ok: true });
    return c;
  }
  function next() {
    const deb = debWith(fakeTmuxScript('tmux 3.5a'));
    const c = candidateFor(deb, { urls: ['https://a.invalid/next.deb'] });
    return { c, deb, files: { [c.urls[0]!]: deb } };
  }

  it('a symlinked releases/ is foreign: nothing outside botmux\'s directory is deleted or written', async () => {
    const base = tempDir('pb-root-');
    const root = join(base, 'tmux');
    const elsewhere = join(base, 'shared-disk');
    mkdirSync(join(elsewhere, 'my-tmux-build'), { recursive: true });
    writeFileSync(join(elsewhere, 'precious.txt'), 'keep me');
    mkdirSync(root);
    symlinkSync(elsewhere, join(root, 'releases'));
    const n = next();
    const r = await installManagedTmux({ root, table: TABLE([n.c]), candidates: [n.c], io: io(n.files), onLine: () => {} });
    expect(r).toMatchObject({ ok: false, failure: 'foreign' });
    expect(readdirSync(elsewhere).sort()).toEqual(['my-tmux-build', 'precious.txt']);
  });

  it('inspection alone already calls a symlinked releases/ foreign', () => {
    const base = tempDir('pb-root-');
    const root = join(base, 'tmux');
    mkdirSync(join(base, 'elsewhere'));
    mkdirSync(root);
    symlinkSync(join(base, 'elsewhere'), join(root, 'releases'));
    expect(inspect(root)).toMatchObject({ state: 'foreign' });
  });

  it('a symlinked root is foreign too', async () => {
    const base = tempDir('pb-root-');
    mkdirSync(join(base, 'real'));
    symlinkSync(join(base, 'real'), join(base, 'tmux'));
    expect(inspect(join(base, 'tmux'))).toMatchObject({ state: 'foreign' });
  });

  it('something the user put into releases/ makes the directory foreign and is never deleted', async () => {
    const root = join(tempDir('pb-root-'), 'tmux');
    await installedAt(root);
    mkdirSync(join(root, 'releases', 'my-own-3.6-build'));
    writeFileSync(join(root, 'releases', 'NOTES.txt'), 'mine');
    expect(inspect(root)).toMatchObject({ state: 'foreign' });
    const n = next();
    expect(await installManagedTmux({ root, table: TABLE([n.c]), candidates: [n.c], io: io(n.files), onLine: () => {} }))
      .toMatchObject({ ok: false, failure: 'foreign' });
    expect(readdirSync(join(root, 'releases'))).toContain('my-own-3.6-build');
    expect(readFileSync(join(root, 'releases', 'NOTES.txt'), 'utf8')).toBe('mine');
  });

  it('a hand-written manifest for a build botmux does not ship is not "ours"', async () => {
    const root = join(tempDir('pb-root-'), 'tmux');
    await installedAt(root);
    const s = inspect(root);
    if (s.state !== 'valid') throw new Error('setup');
    const forged = '#!/bin/sh\necho "tmux 3.4"\n# not a shipped build\n';
    writeFileSync(s.binPath, forged);
    writeFileSync(join(s.releaseDir, 'manifest.json'), JSON.stringify({ ...s.manifest, binSha256: sha256Hex(Buffer.from(forged)) }));
    expect(inspect(root)).toMatchObject({ state: 'foreign' });
  });

  it('a package whose usr/bin/tmux is not the pinned binary is rejected before it runs', async () => {
    const root = join(tempDir('pb-root-'), 'tmux');
    const deb = debWith(fakeTmuxScript('tmux 3.5a'));
    const c = candidateFor(deb, { binSha256: 'f'.repeat(64) });
    const runVersion = vi.fn(async () => ({ ok: true, output: 'tmux 3.5a' }));
    const r = await installManagedTmux({ root, table: TABLE([c]), candidates: [c], io: io({ [c.urls[0]!]: deb }, { runVersion }), onLine: () => {} });
    expect(r).toMatchObject({ ok: false, failure: 'checksum_mismatch' });
    expect(runVersion).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'current'))).toBe(false);
  });

  it('a package whose usr/bin/tmux is a symlink is not followed', async () => {
    const work = tempDir('pb-extract-');
    const host = join(work, 'host-file');
    writeFileSync(host, '#!/bin/sh\necho RAN-HOST-FILE\n');
    // tar entry type 2 (symlink) pointing at a host file
    const header = Buffer.alloc(512, 0);
    header.write('./usr/bin/tmux', 0);
    header.write('0000777\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write('00000000000\0', 124); header.write('00000000000\0', 136); header.write('        ', 148);
    header.write('2', 156); header.write(host, 157); header.write('ustar\0' + '00', 257);
    let sum = 0; for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    const tar = Buffer.concat([header, Buffer.alloc(1024, 0)]);
    const deb = arOf([{ name: 'debian-binary', data: Buffer.from('2.0\n') }, { name: 'data.tar.gz', data: gzipSync(tar) }]);
    await expect(extractTmuxFromDeb(deb, join(work, 'w'), { dpkgDeb: null })).rejects.toThrow(/not a regular file/);
  });

  it('a second install cannot sweep away the first one\'s staging (one installer per directory)', async () => {
    const root = join(tempDir('pb-root-'), 'tmux');
    const a = next();
    const b = next();
    let bStarted: () => void = () => {};
    const bReachedDownload = new Promise<void>(r => { bStarted = r; });
    // A pauses mid-install until B is past its leftover sweep — or, when the
    // directory is locked, gives up waiting (B cannot start) and finishes.
    let aInProbe = false;
    const ioA = io(a.files, {
      functionalProbe: async () => {
        aInProbe = true;
        await Promise.race([bReachedDownload, new Promise(r => setTimeout(r, 300))]);
        return { ok: true, output: '' };
      },
    });
    const ioB = io(b.files);
    const downloadB = ioB.download;
    ioB.download = vi.fn(async (url: string, max: number) => { bStarted(); return downloadB(url, max); });
    const first = installManagedTmux({ root, table: TABLE([a.c]), candidates: [a.c], io: ioA, onLine: () => {} });
    await vi.waitFor(() => expect(aInProbe).toBe(true));
    const second = installManagedTmux({ root, table: TABLE([b.c]), candidates: [b.c], io: ioB, onLine: () => {} });
    const [ra, rb] = await Promise.all([first, second]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(inspect(root)).toMatchObject({ state: 'valid' });
  });

  it('a crash after the release was renamed but before `current` was switched is recovered by the next install', async () => {
    const root = join(tempDir('pb-root-'), 'tmux');
    await installedAt(root);
    const n = next();
    // Simulate the half-done step: the new release dir exists, current still old.
    const half = join(root, 'releases', releaseIdFor(n.c));
    mkdirSync(join(half, 'bin'), { recursive: true });
    writeFileSync(join(half, 'bin', 'tmux'), 'partial');
    expect(inspect(root)).toMatchObject({ state: 'valid' });
    const r = await installManagedTmux({ root, table: TABLE([n.c]), candidates: [n.c], io: io(n.files), onLine: () => {} });
    expect(r).toMatchObject({ ok: true, release: '3.5a' });
    expect(inspect(root)).toMatchObject({ state: 'valid', manifest: { release: '3.5a' } });
  });

  it('the same build installed but no longer runnable is re-installed, not reported as done', async () => {
    const root = join(tempDir('pb-root-'), 'tmux');
    const n = next();
    await installManagedTmux({ root, table: TABLE([n.c]), candidates: [n.c], io: io(n.files), onLine: () => {} });
    const fakeIo = io(n.files, {
      runVersion: vi.fn()
        .mockResolvedValueOnce({ ok: false, output: 'error while loading shared libraries: libjemalloc.so.2: cannot open shared object file' })
        .mockResolvedValue({ ok: true, output: 'tmux 3.5a' }),
    });
    const r = await installManagedTmux({ root, table: TABLE([n.c]), candidates: [n.c], io: fakeIo, onLine: () => {} });
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.alreadyInstalled).toBeFalsy();
    expect(fakeIo.downloads).toEqual([n.c.urls[0]]);
  });
});
