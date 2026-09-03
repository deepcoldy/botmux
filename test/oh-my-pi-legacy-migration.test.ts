import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOhMyPiAdapter, ompSessionDir } from '../src/adapters/cli/oh-my-pi.js';
import { migrateLegacyOmpSession } from '../src/services/oh-my-pi-legacy-migration.js';

const TS = '2026-08-20T05:47:50.955Z';
const NATIVE_ID = '01a01db6-232b-7000-aa2e-f9a749493d62';

function row(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

function transcript(options: {
  sessionId: string;
  cwd: string;
  nativeId?: string;
  role?: string;
  markerSessionId?: string;
  foreignSessionId?: string;
  titleSlot?: boolean;
  suffix?: string;
}): string {
  const nativeId = options.nativeId ?? NATIVE_ID;
  const marker = options.markerSessionId ?? options.sessionId;
  const title = options.titleSlot
    ? row({ type: 'title', v: 1, title: 'legacy', updatedAt: TS, pad: '' })
    : '';
  const markers = [
    `<session_id>${marker}</session_id>`,
    options.foreignSessionId ? `<session_id>${options.foreignSessionId}</session_id>` : '',
  ].filter(Boolean).join('\n');
  return title
    + row({ type: 'session', version: 3, id: nativeId, timestamp: TS, cwd: options.cwd })
    + row({
      type: 'message',
      id: randomUUID(),
      parentId: null,
      timestamp: TS,
      message: {
        role: options.role ?? 'user',
        content: [{ type: 'text', text: `${markers}\ninline preview artifact://1${options.suffix ?? ''}` }],
      },
    });
}

describe('OMP legacy session migration', () => {
  let root: string;
  let home: string;
  let cwd: string;
  let sessionsRoot: string;
  let sessionId: string;
  let exactDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-omp-legacy-'));
    home = join(root, 'home');
    cwd = join(home, 'repo');
    sessionsRoot = join(home, '.omp', 'agent', 'sessions');
    sessionId = 'effective-botmux-session';
    mkdirSync(cwd, { recursive: true });
    mkdirSync(sessionsRoot, { recursive: true });
    vi.stubEnv('HOME', home);
    exactDir = ompSessionDir(sessionId);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function legacyFile(bucket: string, body: string, nativeId = NATIVE_ID): string {
    const dir = join(sessionsRoot, bucket);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `2026-08-20T05-47-50-955Z_${nativeId}.jsonl`);
    writeFileSync(path, body);
    return path;
  }

  it('copies one parsed exact user-marker match byte-for-byte with private modes and keeps artifacts legacy-only', () => {
    const body = transcript({ sessionId, cwd, titleSlot: true });
    const source = legacyFile('-repo', body);
    const artifactDir = source.slice(0, -'.jsonl'.length);
    mkdirSync(artifactDir);
    writeFileSync(join(artifactDir, '1.bash.log'), 'large legacy tool output');
    if (process.platform !== 'win32') chmodSync(source, 0o644);

    const result = migrateLegacyOmpSession(sessionId, cwd, exactDir);

    expect(result).toMatchObject({
      status: 'migrated',
      sourcePath: realpathSync(source),
      targetPath: join(exactDir, basename(source)),
      artifactDirectoryPreserved: true,
    });
    if (result.status !== 'migrated') throw new Error('expected migration');
    expect(readFileSync(result.targetPath)).toEqual(readFileSync(source));
    expect(readFileSync(source, 'utf8')).toBe(body);
    if (process.platform !== 'win32') {
      expect(lstatSync(source).mode & 0o777).toBe(0o644);
      expect(lstatSync(result.targetPath).mode & 0o777).toBe(0o600);
      expect(lstatSync(exactDir).mode & 0o777).toBe(0o700);
    }
    expect(readFileSync(result.targetPath, 'utf8')).toContain('inline preview artifact://1');
    expect(readdirSync(exactDir)).toEqual([basename(source)]);
    expect(readFileSync(join(artifactDir, '1.bash.log'), 'utf8')).toBe('large legacy tool output');

    const args = createOhMyPiAdapter('/usr/bin/omp').buildArgs({ sessionId, resume: true });
    expect(args[args.indexOf('--resume') + 1]).toBe(result.targetPath);
    expect(args[args.indexOf('--session-dir') + 1]).toBe(exactDir);
  });

  it('keeps the adapter exact probe pure until the explicit migration preflight publishes', () => {
    const adapter = createOhMyPiAdapter('/usr/bin/omp');
    legacyFile('-repo', transcript({ sessionId, cwd }));

    expect(adapter.checkResumeTargetExists?.({ sessionId })).toBe(false);
    expect(lstatSync(sessionsRoot).isDirectory()).toBe(true);
    expect(() => lstatSync(exactDir)).toThrow();

    expect(migrateLegacyOmpSession(sessionId, cwd, exactDir).status).toBe('migrated');
    expect(adapter.checkResumeTargetExists?.({ sessionId })).toBe(true);
  });

  it('treats any exact top-level JSONL entry as authoritative and retries idempotently', () => {
    const source = legacyFile('-repo', transcript({ sessionId, cwd }));
    const first = migrateLegacyOmpSession(sessionId, cwd, exactDir);
    expect(first.status).toBe('migrated');
    const before = readFileSync(source);

    const retry = migrateLegacyOmpSession(sessionId, cwd, exactDir);
    expect(retry).toEqual({ status: 'skipped', reason: 'exact-history-exists' });
    expect(readFileSync(source)).toEqual(before);
    expect(readdirSync(exactDir).filter(name => name.endsWith('.jsonl'))).toHaveLength(1);
  });

  it('does not choose between a preexisting divergent exact history and legacy history', () => {
    const source = legacyFile('-repo', transcript({ sessionId, cwd }));
    mkdirSync(exactDir, { recursive: true });
    const exact = join(exactDir, 'fresh.jsonl');
    writeFileSync(exact, 'fresh divergent branch\n');

    expect(migrateLegacyOmpSession(sessionId, cwd, exactDir)).toEqual({
      status: 'skipped', reason: 'exact-history-exists',
    });
    expect(readFileSync(source, 'utf8')).toContain(sessionId);
    expect(readFileSync(exact, 'utf8')).toBe('fresh divergent branch\n');
  });

  it('rejects zero, multiple, assistant-only, foreign, cwd, header, and filename mismatches', () => {
    const cases: Array<[string, () => void, string]> = [
      ['assistant marker', () => { legacyFile('-a', transcript({ sessionId, cwd, role: 'assistant' })); }, 'no-match'],
      ['foreign marker', () => { legacyFile('-a', transcript({ sessionId, cwd, foreignSessionId: 'another-session' })); }, 'no-match'],
      ['cwd mismatch', () => {
        const other = join(home, 'other');
        mkdirSync(other);
        legacyFile('-a', transcript({ sessionId, cwd: other }));
      }, 'no-match'],
      ['invalid header', () => { legacyFile('-a', `${row({ type: 'custom' })}${row({ type: 'message' })}`); }, 'no-match'],
      ['missing header version', () => {
        legacyFile('-a', transcript({ sessionId, cwd }).replace('"version":3,', ''));
      }, 'no-match'],
      ['filename mismatch', () => { legacyFile('-a', transcript({ sessionId, cwd, nativeId: 'different-native' })); }, 'no-match'],
      ['malformed complete row', () => { legacyFile('-a', `${transcript({ sessionId, cwd })}{bad}\n`); }, 'inconclusive'],
      ['partial row', () => { legacyFile('-a', `${transcript({ sessionId, cwd })}{"type":`); }, 'inconclusive'],
    ];

    for (const [name, arrange, reason] of cases) {
      rmSync(sessionsRoot, { recursive: true, force: true });
      mkdirSync(sessionsRoot, { recursive: true });
      arrange();
      const result = migrateLegacyOmpSession(sessionId, cwd, exactDir);
      expect(result, name).toMatchObject({ status: 'skipped', reason });
      expect(() => lstatSync(exactDir), name).toThrow();
    }

    rmSync(sessionsRoot, { recursive: true, force: true });
    mkdirSync(sessionsRoot, { recursive: true });
    legacyFile('-a', transcript({ sessionId, cwd }));
    legacyFile('-b', transcript({ sessionId, cwd, nativeId: '01a01db6-232b-7000-aa2e-f9a749493d63' }), '01a01db6-232b-7000-aa2e-f9a749493d63');
    expect(migrateLegacyOmpSession(sessionId, cwd, exactDir)).toMatchObject({
      status: 'skipped', reason: 'ambiguous',
    });
    expect(() => lstatSync(exactDir)).toThrow();
  });

  it('fails closed for symlink and special JSONL entries', () => {
    const safe = legacyFile('-safe', transcript({ sessionId, cwd }));
    const unsafeBucket = join(sessionsRoot, '-unsafe');
    mkdirSync(unsafeBucket);
    symlinkSync(safe, join(unsafeBucket, 'linked.jsonl'));
    expect(migrateLegacyOmpSession(sessionId, cwd, exactDir)).toMatchObject({
      status: 'skipped', reason: 'inconclusive',
    });
    expect(() => lstatSync(exactDir)).toThrow();

    rmSync(unsafeBucket, { recursive: true, force: true });
    mkdirSync(join(unsafeBucket, 'special.jsonl'), { recursive: true });
    expect(migrateLegacyOmpSession(sessionId, cwd, exactDir)).toMatchObject({
      status: 'skipped', reason: 'inconclusive',
    });

    rmSync(unsafeBucket, { recursive: true, force: true });
    mkdirSync(exactDir, { recursive: true });
    symlinkSync(safe, join(exactDir, 'unsafe-exact.jsonl'));
    expect(migrateLegacyOmpSession(sessionId, cwd, exactDir)).toEqual({
      status: 'skipped', reason: 'exact-history-exists',
    });
  });

  it('never treats another exact Botmux directory as a legacy bucket', () => {
    const sibling = join(sessionsRoot, 'botmux', 'sibling');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(
      join(sibling, `2026-08-20T05-47-50-955Z_${NATIVE_ID}.jsonl`),
      transcript({ sessionId, cwd }),
    );
    expect(migrateLegacyOmpSession(sessionId, cwd, exactDir)).toEqual({
      status: 'skipped', reason: 'no-match', detail: undefined,
    });
    expect(() => lstatSync(exactDir)).toThrow();
  });

  it('fails closed when scan budgets are exhausted', () => {
    legacyFile('-a', transcript({ sessionId, cwd }));
    legacyFile('-b', transcript({ sessionId: 'other', cwd, nativeId: '01a01db6-232b-7000-aa2e-f9a749493d64' }), '01a01db6-232b-7000-aa2e-f9a749493d64');
    const result = migrateLegacyOmpSession(sessionId, cwd, exactDir, {
      limits: { maxBuckets: 1 },
    });
    expect(result).toMatchObject({ status: 'skipped', reason: 'inconclusive' });
    expect(() => lstatSync(exactDir)).toThrow();
  });

  it('detects source mutation, cleans its temp, and preserves the source', () => {
    const source = legacyFile('-repo', transcript({ sessionId, cwd }));
    const result = migrateLegacyOmpSession(sessionId, cwd, exactDir, {
      testHooks: {
        beforeCopy: path => writeFileSync(path, `${readFileSync(path, 'utf8')}changed\n`),
      },
    });
    expect(result).toMatchObject({ status: 'skipped', reason: 'inconclusive' });
    expect(readFileSync(source, 'utf8')).toContain('changed');
    expect(() => lstatSync(exactDir)).toThrow();
  });

  it('does not overwrite a concurrent destination and removes only its private temp', () => {
    const source = legacyFile('-repo', transcript({ sessionId, cwd }));
    const targetName = basename(source);
    const result = migrateLegacyOmpSession(sessionId, cwd, exactDir, {
      testHooks: {
        beforePublish: targetPath => writeFileSync(targetPath, 'competitor\n'),
      },
    });
    expect(result).toMatchObject({ status: 'skipped', reason: 'inconclusive' });
    expect(readFileSync(join(exactDir, targetName), 'utf8')).toBe('competitor\n');
    expect(readFileSync(source, 'utf8')).toContain(sessionId);
    expect(readdirSync(exactDir).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('pins the cold-resume worker guard and preflight-before-probe ordering', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const preflight = worker.indexOf("if (cfg.cliId === 'oh-my-pi' && effectiveResume && !willReattachPersistent && !cfg.adoptMode)");
    const migration = worker.indexOf('migrateLegacyOmpSession(', preflight);
    const probe = worker.indexOf('cliAdapter.checkResumeTargetExists?.({', migration);
    expect(preflight).toBeGreaterThan(-1);
    expect(migration).toBeGreaterThan(preflight);
    expect(probe).toBeGreaterThan(migration);
    expect(worker.slice(migration, probe)).toContain('effectiveAdapterSessionId');
    expect(worker.slice(migration, probe)).toContain('cfg.workingDir');
  });
});
