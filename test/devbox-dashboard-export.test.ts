import realFs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Counting settings-file reads is the only way to pin the gate ORDER: on an
// ordinary host the verdict is null either way, so only the syscall is
// observable. Wraps the real implementation — nothing is stubbed out.
// `statSync` is wrapped the same way so the memo tests can force a fingerprint
// collision deterministically (a real one depends on timestamp granularity).
vi.mock('node:fs', () => {
  // `require` inside the factory, not the vitest-only `importOriginal` argument
  // (bun passes none) and not a top-level import (vitest hoists this call above
  // the imports, so a top-level namespace would be read before initialisation).
  const actual = require('node:fs') as typeof import('node:fs');
  return {
    ...actual,
    default: actual,
    readFileSync: vi.fn(actual.readFileSync),
    statSync: vi.fn(actual.statSync),
  };
});

import {
  type DevboxExportStreams,
  devboxDashboardBaseUrl,
  ensureDevboxDashboardExport,
  resetDevboxDashboardExportCaches,
} from '../src/platform/devbox-dashboard-export.js';
import { logger } from '../src/utils/logger.js';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';

const readSpy = vi.mocked(readFileSync);
const statSpy = vi.mocked(statSync);

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-devbox-export-'));
  chmodSync(dir, 0o700);
  return dir;
}

function fixture() {
  return join(tmpDir(), 'cache.json');
}

function exportStreams(stdout: string, stderr = ''): DevboxExportStreams {
  return { stdout, stderr };
}

const IGNORE_ENV_FILE = { envFileMode: 'ignore' as const };
const PRIVATE_RESULT = '{"short_url":"https://devbox.example.com","is_public":false}';
const PUBLIC_RESULT = '{"short_url":"https://devbox.example.com","is_public":true}';

const devboxEnv = {
  ARNOLD_WORKSPACE_ID: '103424',
  PORT_LIST: '10001,10002',
};

beforeEach(() => {
  // The read-side memo and the export negative cache are process-wide.
  resetDevboxDashboardExportCaches();
});

afterEach(() => {
  // `default` is the untouched module (see the factory above).
  statSpy.mockImplementation(realFs.statSync);
});

describe('ensureDevboxDashboardExport', () => {
  it('parses warning-prefixed private export output and persists a reusable cache', async () => {
    const cachePath = fixture();
    const runExport = vi.fn(async () => exportStreams(`Warning: upgrade available\n${PRIVATE_RESULT}\n`));

    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath,
      merlinCliPath: '/fake/merlin-cli',
      runExport,
    })).resolves.toBe('https://devbox.example.com');
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath,
      merlinCliPath: '/fake/merlin-cli',
      runExport,
    })).resolves.toBe('https://devbox.example.com');

    expect(runExport).toHaveBeenCalledTimes(1);
    expect(devboxDashboardBaseUrl({
      cachePath,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      port: 9001,
    })).toBe('https://devbox.example.com');
    expect(readFileSync(cachePath, 'utf8')).not.toContain('token');
  });

  it('does not reuse a cache outside its workspace or after auto-export is disabled', async () => {
    const cachePath = fixture();
    await ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath,
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => exportStreams(PRIVATE_RESULT),
    });
    expect(devboxDashboardBaseUrl({
      cachePath,
      port: 9001,
      env: { ...devboxEnv, ARNOLD_WORKSPACE_ID: 'other' },
      ...IGNORE_ENV_FILE,
    })).toBeNull();
    expect(devboxDashboardBaseUrl({
      cachePath,
      port: 9001,
      env: { ...devboxEnv, BOTMUX_DEVBOX_AUTO_EXPORT: '0' },
      ...IGNORE_ENV_FILE,
    })).toBeNull();
  });

  // PORT_LIST is the only reason 10001 is exportable — the 9001–9010 window does
  // not cover it. Without this case, replacing the whole PORT_LIST branch with
  // `return false` left the suite green.
  it('exports a port that only PORT_LIST allows', async () => {
    const runExport = vi.fn(async () => exportStreams(PRIVATE_RESULT));
    await expect(ensureDevboxDashboardExport({
      port: 10001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport,
    })).resolves.toBe('https://devbox.example.com');
    expect(runExport).toHaveBeenCalledWith('/fake/merlin-cli', 10001, expect.any(Number));
  });

  it.each([
    ['ordinary host', { PORT_LIST: '10001' }, 9001],
    ['disabled', { ...devboxEnv, BOTMUX_DEVBOX_AUTO_EXPORT: '0' }, 9001],
    ['explicit remote base', devboxEnv, 9001, true],
    ['unsupported port', devboxEnv, 7891],
    // `Number('') === 0`, so a trailing comma used to make port 0 exportable.
    ['port 0 against a trailing-comma PORT_LIST', { ...devboxEnv, PORT_LIST: '10001,' }, 0],
  ])('does not spawn on %s', async (_name, env, port, remoteBaseConfigured = false) => {
    const runExport = vi.fn();
    await expect(ensureDevboxDashboardExport({
      port,
      remoteBaseConfigured,
      env,
      envFileMode: 'read',
      cachePath: fixture(),
      envFilePath: join(tmpDir(), 'absent.env'),
      merlinCliPath: '/fake/merlin-cli',
      runExport,
    })).resolves.toBeNull();
    expect(runExport).not.toHaveBeenCalled();
  });

  it.each([
    ['credentialed URL', '{"short_url":"https://user:pass@devbox.example.com","is_public":false}'],
    ['public export', '{"short_url":"https://devbox.example.com","is_public":true}'],
    ['malformed output', 'not json'],
    // A later private object must not override an earlier public verdict.
    ['public result followed by a private-looking object',
      '{"short_url":"https://devbox.example.com","is_public":true}\n{"short_url":"https://evil.example.com","is_public":false}'],
    // Nor may a private-looking log line hide the actual public verdict.
    ['private-looking log followed by a public result for the same URL',
      '{"level":"preview","short_url":"https://devbox.example.com","is_public":false}\n'
      + '{"short_url":"https://devbox.example.com","is_public":true}'],
    ['two private-looking result objects (ambiguous output)',
      '{"short_url":"https://one.example.com","is_public":false}\n'
      + '{"short_url":"https://two.example.com","is_public":false}'],
    ['a truncated public result after a private-looking result',
      '{"short_url":"https://devbox.example.com","is_public":false}\n'
      + '{"short_url":"https://devbox.example.com","is_public":true'],
    ['an unmatched warning swallowing a later public result',
      '{"short_url":"https://devbox.example.com","is_public":false}\nWarning {\n'
      + '{"short_url":"https://devbox.example.com","is_public":true}'],
    ['a nested second result-shaped object',
      '{"short_url":"https://devbox.example.com","is_public":false,'
      + '"preview":{"short_url":"https://devbox.example.com","is_public":true}}'],
    ['duplicate public/private verdict keys',
      '{"short_url":"https://devbox.example.com","is_public":true,"is_public":false}'],
    ['a private result followed by balanced malformed public output',
      '{"short_url":"https://devbox.example.com","is_public":false}\n'
      + '{"short_url":"https://devbox.example.com","is_public":true,}'],
    ['balanced malformed public output followed by a private result',
      '{"short_url":"https://devbox.example.com","is_public":true,}\n'
      + '{"short_url":"https://devbox.example.com","is_public":false}'],
    ['a private result followed by Python-style public output',
      '{"short_url":"https://devbox.example.com","is_public":false}\n'
      + "{'short_url':'https://devbox.example.com','is_public':true}"],
    ['a private result followed by unquoted-key public output',
      '{"short_url":"https://devbox.example.com","is_public":false}\n'
      + '{short_url:"https://devbox.example.com",is_public:true}'],
  ])('fails closed for %s', async (_name, output) => {
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => exportStreams(output),
    })).resolves.toBeNull();
  });

  it.each([
    ['clean output', ''],
    ['brace prose', 'Note {see docs}'],
    ['object-like retry warning', 'Warning: retry {attempt: 3}'],
    ['Python-style config warning', "Warning: config {'legacy': true}"],
    ['progress warning', 'Exporting {step 1/3: creating tunnel}'],
    ['an unmatched opening brace', 'Tip: diagnostic context {'],
    ['Go struct formatting', 'state={Port:9001 Public:false}'],
    ['an echoed result', PRIVATE_RESULT],
  ])('ignores %s on stderr once stdout has a valid result', async (_name, stderr) => {
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => exportStreams(PRIVATE_RESULT, stderr),
    })).resolves.toBe('https://devbox.example.com');
  });

  it.each([
    ['plain progress', 'export completed\n'],
    ['a JSON log object', '{"level":"info","message":"done"}\n'],
    ['harmless brace prose', 'Warning {legacy}\n'],
  ])('falls back to stderr when stdout contains only %s', async (_name, stdout) => {
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => exportStreams(stdout, PRIVATE_RESULT),
    })).resolves.toBe('https://devbox.example.com');
  });

  // Mutation guard: changing the stdout-null branch to fall through into
  // stderr would incorrectly accept the private-looking stderr object here.
  it('does not fall back to stderr after stdout rejects a public result', async () => {
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => exportStreams(PUBLIC_RESULT, PRIVATE_RESULT),
    })).resolves.toBeNull();
  });

  it('does not treat a plaintext public stdout verdict as result-free', async () => {
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => exportStreams(
        'short_url=https://public.example is_public=true',
        PRIVATE_RESULT,
      ),
    })).resolves.toBeNull();
  });

  it('rejects plaintext result fields after a private stderr JSON candidate', async () => {
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => exportStreams(
        '',
        `${PRIVATE_RESULT}\nshort_url=https://public.example is_public=true`,
      ),
    })).resolves.toBeNull();
  });

  it.each([
    ['plain markers',
      '{"level":"info","message":"short_url=https://public.example is_public=true"}'],
    ['Unicode-escaped markers',
      '{"level":"info","message":"\\u0073hort_url=https://public.example is_\\u0070ublic=true"}'],
  ])('does not treat stdout JSON log values containing %s as result-free', async (_name, stdout) => {
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => exportStreams(stdout, PRIVATE_RESULT),
    })).resolves.toBeNull();
  });

  it('rejects a private JSON result that carries a conflicting plaintext verdict value', async () => {
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => exportStreams(
        '{"short_url":"https://private.example","is_public":false,'
        + '"message":"actual short_url=https://public.example is_public=true"}',
      ),
    })).resolves.toBeNull();
  });

  it('logs a URL-free debug reason when a result-shaped candidate is rejected', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => exportStreams(PUBLIC_RESULT),
    })).resolves.toBeNull();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('non-private export verdict'));
    expect(JSON.stringify(debug.mock.calls)).not.toContain('devbox.example.com');
    debug.mockRestore();
  });

  // Strict scanning still tolerates harmless noise in the same stream, which
  // covers injected runners and future merlin-cli versions that log to stdout.
  it.each([
    ['a brace inside a warning', 'Warning: config {legacy} deprecated\n{"short_url":"https://devbox.example.com","is_public":false}'],
    ['a JSON log line', '{"level":"warn","msg":"x"}\n{"short_url":"https://devbox.example.com","is_public":false}'],
    ['trailing prose with braces', '{"short_url":"https://devbox.example.com","is_public":false}\nNote {see docs}'],
    ['a nested object in the result', '{"short_url":"https://devbox.example.com","is_public":false,"meta":{"ttl":3600}}'],
    ['a brace inside a JSON string value', '{"short_url":"https://devbox.example.com","is_public":false,"note":"a { brace"}'],
  ])('parses the export result despite %s', async (_name, output) => {
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => exportStreams(output),
    })).resolves.toBe('https://devbox.example.com');
  });

  // The stderr-noise table above never puts noise in the SAME stream as the
  // result, and the same-stream table above only uses colon-free noise. The
  // crossed cells are where a blanket `includes(':')` on malformed candidates
  // used to reject valid output (feature silently off) — and a stream that
  // carries everything on stderr is a natural CLI shape, so stderr is crossed too.
  const SAME_STREAM_NOISE: Array<[string, string]> = [
    ['an object-like retry warning', 'Warning: retry {attempt: 3}'],
    ['a Python-style config warning', "Warning: config {'legacy': true}"],
    ['a progress warning', 'Exporting {step 1/3: creating tunnel}'],
    ['Go struct formatting', 'state={Port:9001 Public:false}'],
    ['brace prose carrying a URL', 'see {docs: https://wiki.example/guide}'],
  ];
  it.each(SAME_STREAM_NOISE.flatMap(([name, noise]): Array<[string, DevboxExportStreams]> => [
    [`${name} before the stdout result`, exportStreams(`${noise}\n${PRIVATE_RESULT}`)],
    [`${name} after the stdout result`, exportStreams(`${PRIVATE_RESULT}\n${noise}`)],
    [`${name} before a stderr-only result`, exportStreams('', `${noise}\n${PRIVATE_RESULT}`)],
    [`${name} after a stderr-only result`, exportStreams('', `${PRIVATE_RESULT}\n${noise}`)],
  ]).concat([
    ['an unmatched opening brace after the stdout result',
      exportStreams(`${PRIVATE_RESULT}\nTip: diagnostic context {`)],
    ['an unmatched opening brace after a stderr-only result',
      exportStreams('', `${PRIVATE_RESULT}\nTip: diagnostic context {`)],
  ]))('parses the export result despite %s', async (_name, streams) => {
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => streams,
    })).resolves.toBe('https://devbox.example.com');
  });

  // A canonical private-looking log record — the only parseable result-shaped
  // candidate in each case below. The real (public) verdict is spelled so the
  // strict parser cannot read it; if the malformed verdict were skipped as
  // noise, this record would become the sole result and be trusted (fail-open).
  const FAKE_PRIVATE_LOG = '{"level":"preview","short_url":"https://public.example","is_public":false}';
  const UNREADABLE_PUBLIC_VERDICTS: Array<[string, string]> = [
    ['camelCase', '{shortUrl: "https://public.example", isPublic: True}'],
    ['hyphen separators', '{short-url: "https://public.example", is-public: True}'],
    ['dot separators', '{short.url: "https://public.example", is.public: True}'],
    ['double underscores', '{short__url: "https://public.example", is__public: True}'],
    ['slash separators', '{short/url: "https://public.example", is/public: True}'],
    ['colon separators', '{short:url "https://public.example" is:public True}'],
    ['space separators', '{short url: "https://public.example", is public: True}'],
    ['mixed-case hyphens', '{Short-Url: "https://public.example", Is-Public: TRUE}'],
    ['a Go %v struct', '{ShortURL:https://public.example IsPublic:true}'],
    ['single quotes with an escaped underscore',
      "{'short\\u005furl': 'https://public.example', 'is\\u005fpublic': True}"],
    // NFKD folds fullwidth letters back to ASCII; unquoted, so only the marker
    // search (not the quoted-key check) can see these.
    ['unquoted fullwidth homoglyphs', '{ｓhort_url: "https://public.example", iｓ_public: True}'],
    // Cyrillic `ѕ` has no compatibility decomposition, so the marker search is
    // blind here; the quoted-key check is what keeps these failing closed.
    ['quoted Cyrillic homoglyphs', '{"ѕhort_url": "https://public.example", "iѕ_public": True}'],
    ['escaped quoted Cyrillic homoglyphs',
      '{"\\u0455hort_url": "https://public.example", "i\\u0455_public": True}'],
  ];
  it.each(UNREADABLE_PUBLIC_VERDICTS.flatMap(([name, verdict]): Array<[string, DevboxExportStreams]> => [
    [`${name}, before the log (same stream)`, exportStreams(`${verdict}\n${FAKE_PRIVATE_LOG}`)],
    [`${name}, after the log (same stream)`, exportStreams(`${FAKE_PRIVATE_LOG}\n${verdict}`)],
    [`${name}, truncated after the log`, exportStreams(`${FAKE_PRIVATE_LOG}\n${verdict.slice(0, -1)}`)],
    [`${name}, both on stderr`, exportStreams('', `${FAKE_PRIVATE_LOG}\n${verdict}`)],
    // The fail-open this PR exists for, in its cross-stream form: stdout holds
    // the real verdict, stderr holds result-shaped log noise. stdout must be
    // judged ambiguous (no stderr fallback), not "result-free".
    [`${name} on stdout, the log on stderr`, exportStreams(verdict, FAKE_PRIVATE_LOG)],
  ]))('does not trust a private-looking log beside an unreadable public verdict: %s', async (_name, streams) => {
    // Positive canary: the same log record alone IS accepted, so a null below
    // means the verdict was seen, not that the probe is broken.
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => exportStreams(FAKE_PRIVATE_LOG),
    })).resolves.toBe('https://public.example');
    // Fresh negative cache: the canary's success must not mask the case.
    resetDevboxDashboardExportCaches();
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => streams,
    })).resolves.toBeNull();
  });

  // Accepted costs of the predicate above, pinned so loosening them is a
  // deliberate security decision: both fail CLOSED (no tunnel, local URL kept).
  it.each([
    // The unclosed `{` swallows the result into one unterminated candidate.
    ['an unmatched opening brace BEFORE the result', `Tip: diagnostic context {\n${PRIVATE_RESULT}`],
    // A marker word inside brace prose is indistinguishable from a verdict.
    ['brace prose containing a marker word',
      `${PRIVATE_RESULT}\nsee {docs: https://wiki.example/short-url-guide}`],
  ])('fails closed for %s (accepted cost)', async (_name, stdout) => {
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => exportStreams(stdout),
    })).resolves.toBeNull();
  });

  it('fails softly when the export runner rejects', async () => {
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => { throw new Error('timeout'); },
    })).resolves.toBeNull();
  });

  it('fails softly in linear time for many unmatched opening braces', async () => {
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => exportStreams('{'.repeat(50_000)),
    })).resolves.toBeNull();
  }, 1_000);

  // A hanging merlin-cli pays the full timeout. Repeating that on every caller
  // in the same process is what made `start` overrun its own 6s budget.
  it('does not re-spawn after a failure inside the negative-cache window', async () => {
    const cachePath = fixture();
    const runExport = vi.fn(async () => { throw new Error('timeout'); });
    const call = () => ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath,
      merlinCliPath: '/fake/merlin-cli',
      runExport,
    });
    await expect(call()).resolves.toBeNull();
    await expect(call()).resolves.toBeNull();
    expect(runExport).toHaveBeenCalledTimes(1);
  });

  // The negative cache has TWO write sites: the runner rejecting (above) and the
  // runner resolving with output that cannot be parsed. Only the first was
  // covered, so removing the second's write left the suite green.
  it('does not re-spawn after an unparseable exit-0 export inside the window', async () => {
    const cachePath = fixture();
    // Must be the {stdout, stderr} shape: returning a bare string made this land
    // in the runner-threw branch (reading .stdout off a string yields undefined,
    // and the scan throws), so it exercised the OTHER negative-cache write site
    // and stayed green when this one was deleted.
    const runExport = vi.fn(async () => ({ stdout: 'merlin-cli: unexpected output', stderr: '' }));
    const call = () => ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      cachePath,
      envFileMode: 'ignore' as const,
      merlinCliPath: '/fake/merlin-cli',
      runExport,
    });
    await expect(call()).resolves.toBeNull();
    await expect(call()).resolves.toBeNull();
    expect(runExport).toHaveBeenCalledTimes(1);
  });

  // An ordinary host has no ARNOLD_WORKSPACE_ID, so the read side is reached
  // constantly from the CSRF hot path and must not touch the filesystem there:
  // the Devbox gates are checked before the switch, which may read ~/.botmux/.env.
  it('does not read the settings file on a non-Devbox host', () => {
    const envFilePath = join(tmpDir(), '.env');
    // The file EXISTS and disables the feature, so a regression cannot pass by
    // swallowing ENOENT — reading it would be observable below.
    writeFileSync(envFilePath, 'BOTMUX_DEVBOX_AUTO_EXPORT=0\n');
    const cachePath = fixture();
    const reads = () => readSpy.mock.calls.filter(([p]) => p === envFilePath).length;

    for (const env of [{}, { ARNOLD_WORKSPACE_ID: 'ws' }, { PORT_LIST: '9001' }]) {
      resetDevboxDashboardExportCaches();
      readSpy.mockClear();
      expect(devboxDashboardBaseUrl({ cachePath, env, envFilePath, port: 9001 })).toBeNull();
      expect(reads()).toBe(0);
    }

    // On a real Devbox the switch IS consulted, which is what pins the ordering
    // as an optimization rather than a behaviour change: same null verdict, but
    // this time the file was actually read.
    resetDevboxDashboardExportCaches();
    readSpy.mockClear();
    expect(devboxDashboardBaseUrl({
      cachePath,
      env: devboxEnv,
      envFilePath,
      port: 9001,
    })).toBeNull();
    expect(reads()).toBe(1);
  });

  it('reads the disable switch from ~/.botmux/.env when the CLI never dotenv-loads it', async () => {
    const dir = tmpDir();
    const envFilePath = join(dir, '.env');
    writeFileSync(envFilePath, 'LARK_APP_SECRET=must-not-leak\nBOTMUX_DEVBOX_AUTO_EXPORT=0\n');
    const runExport = vi.fn();

    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      envFileMode: 'read',
      cachePath: join(dir, 'cache.json'),
      envFilePath,
      merlinCliPath: '/fake/merlin-cli',
      runExport,
    })).resolves.toBeNull();
    expect(runExport).not.toHaveBeenCalled();
    // Only that one key is consulted; nothing from the file enters process.env.
    expect(process.env.LARK_APP_SECRET).toBeUndefined();

    // An inline value still wins over the file, matching dotenv precedence.
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: { ...devboxEnv, BOTMUX_DEVBOX_AUTO_EXPORT: '1' },
      envFileMode: 'read',
      cachePath: join(dir, 'cache.json'),
      envFilePath,
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => exportStreams(PRIVATE_RESULT),
    })).resolves.toBe('https://devbox.example.com');
  });

  it('reads the settings file by default even with env injection and ignores it only explicitly', () => {
    const home = tmpDir();
    mkdirSync(join(home, '.botmux'), { mode: 0o700 });
    writeFileSync(join(home, '.botmux', '.env'), 'BOTMUX_DEVBOX_AUTO_EXPORT=0\n', { mode: 0o600 });
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      ARNOLD_WORKSPACE_ID: 'probe',
      PORT_LIST: '9001',
    };
    // An inherited value wins over the fixture file (dotenv precedence), so a
    // shell exporting the switch as 1 OR 0 would make this case measure the
    // shell instead of the file.
    delete childEnv.BOTMUX_DEVBOX_AUTO_EXPORT;
    const child = spawnSyncTsEvalWithRepoImports(`
      const { ensureDevboxDashboardExport } = await import('./src/platform/devbox-dashboard-export.js');
      const defaultsToRead = await ensureDevboxDashboardExport({
        port: 9001,
        remoteBaseConfigured: false,
        env: process.env,
        cachePath: process.env.HOME + '/read-cache.json',
        merlinCliPath: '/fake/merlin-cli',
        runExport: async () => ({ stdout: '${PRIVATE_RESULT}', stderr: '' }),
      });
      const explicitlyIgnored = await ensureDevboxDashboardExport({
        port: 9001,
        remoteBaseConfigured: false,
        env: process.env,
        envFileMode: 'ignore',
        cachePath: process.env.HOME + '/ignored-cache.json',
        merlinCliPath: '/fake/merlin-cli',
        runExport: async () => ({
          stdout: '{"short_url":"https://isolated.example.com","is_public":false}',
          stderr: '',
        }),
      });
      console.log(JSON.stringify({ defaultsToRead, explicitlyIgnored }));
    `, {
      cwd: process.cwd(),
      env: childEnv,
      encoding: 'utf8',
    });
    expect(child.status, child.stderr?.toString()).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      defaultsToRead: null,
      explicitlyIgnored: 'https://isolated.example.com',
    });
  });
});

describe('devboxDashboardBaseUrl', () => {
  async function seedCache(port: number) {
    const cachePath = fixture();
    await ensureDevboxDashboardExport({
      port,
      remoteBaseConfigured: false,
      env: devboxEnv,
      ...IGNORE_ENV_FILE,
      cachePath,
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => exportStreams(
        `{"short_url":"https://tunnel-for-${port}.example.com","is_public":false}`,
      ),
    });
    return cachePath;
  }

  // The dashboard probes upward on EADDRINUSE, so a cache written for 9001 can
  // outlive the bind it was made for. The read side used to ignore the port
  // entirely and keep advertising (and trusting) that stale tunnel.
  it('rejects a cache written for a different dashboard port', async () => {
    const cachePath = await seedCache(9001);
    expect(devboxDashboardBaseUrl({ cachePath, env: devboxEnv, ...IGNORE_ENV_FILE, port: 9001 }))
      .toBe('https://tunnel-for-9001.example.com');
    expect(devboxDashboardBaseUrl({ cachePath, env: devboxEnv, ...IGNORE_ENV_FILE, port: 9002 }))
      .toBeNull();
  });

  it('resolves the port from .dashboard-port when the caller does not pass one', async () => {
    const cachePath = await seedCache(9001);
    const portFilePath = join(tmpDir(), '.dashboard-port');

    writeFileSync(portFilePath, '9001\n');
    expect(devboxDashboardBaseUrl({ cachePath, env: devboxEnv, ...IGNORE_ENV_FILE, portFilePath }))
      .toBe('https://tunnel-for-9001.example.com');

    writeFileSync(portFilePath, '9002\n');
    expect(devboxDashboardBaseUrl({ cachePath, env: devboxEnv, ...IGNORE_ENV_FILE, portFilePath }))
      .toBeNull();
  });

  // The case above used to flake ~50%: a same-size in-place rewrite within the
  // filesystem's timestamp granularity left the stat fingerprint unchanged, and
  // a pure-fingerprint memo served the old port. Hammer exactly that shape.
  it('never serves a stale port across back-to-back same-size in-place rewrites', async () => {
    const cachePath = await seedCache(9001);
    const portFilePath = join(tmpDir(), '.dashboard-port');
    const read = () => devboxDashboardBaseUrl({ cachePath, env: devboxEnv, ...IGNORE_ENV_FILE, portFilePath });
    for (let i = 0; i < 50; i++) {
      writeFileSync(portFilePath, '9001\n');
      expect(read()).toBe('https://tunnel-for-9001.example.com');
      writeFileSync(portFilePath, '9002\n');
      expect(read()).toBeNull();
    }
  });

  describe('read-side memo', () => {
    async function memoFixture() {
      const cachePath = await seedCache(9001);
      const portFilePath = join(tmpDir(), '.dashboard-port');
      writeFileSync(portFilePath, '9001\n');
      const read = () => devboxDashboardBaseUrl({ cachePath, env: devboxEnv, ...IGNORE_ENV_FILE, portFilePath });
      const portReads = () => readSpy.mock.calls.filter(([p]) => p === portFilePath).length;
      return { cachePath, portFilePath, read, portReads };
    }

    /** Make every later stat of `path` report what it reports now — the shape of
     *  a timestamp-granularity collision, without depending on timing. */
    function freezeStat(path: string) {
      const frozen = realFs.statSync(path);
      statSpy.mockImplementation(((p: Parameters<typeof statSync>[0], ...rest: unknown[]) => (
        p === path ? frozen : (realFs.statSync as (...args: unknown[]) => unknown)(p, ...rest)
      )) as typeof statSync);
    }

    it('re-reads a file changed inside the racy window even when its fingerprint collides', async () => {
      const { portFilePath, read } = await memoFixture();
      freezeStat(portFilePath);
      // Real clock: the port file was written moments ago.
      expect(read()).toBe('https://tunnel-for-9001.example.com');
      writeFileSync(portFilePath, '9002\n');
      expect(read()).toBeNull();
    });

    it('serves a settled read from the memo, but never longer than the max age', async () => {
      const { portFilePath, read, portReads } = await memoFixture();
      freezeStat(portFilePath);
      // Every fixture file is now a minute old: outside the racy window.
      let clock = Date.now() + 60_000;
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
      try {
        expect(read()).toBe('https://tunnel-for-9001.example.com');
        const readsAfterFirst = portReads();
        // A rewrite the fingerprint cannot see: only the max age can surface it.
        writeFileSync(portFilePath, '9002\n');
        // Hot hits — one per second — must neither re-read the files nor renew
        // the entry; a renewal here would let a busy process stay stale forever.
        for (let i = 0; i < 4; i++) {
          clock += 1_000;
          expect(read()).toBe('https://tunnel-for-9001.example.com');
        }
        expect(portReads()).toBe(readsAfterFirst);
        clock += 1_000; // 5s after the last FULL read
        expect(read()).toBeNull();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('checks the fingerprint on every call, so a settled entry sees an atomic replace at once', async () => {
      const { portFilePath, read } = await memoFixture();
      const clock = Date.now() + 60_000;
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
      try {
        expect(read()).toBe('https://tunnel-for-9001.example.com');
        // Same instant, so no max age can be what invalidates it: the CLI
        // exports in its own process and re-reads `/__cli/current` right away.
        writeFileSync(`${portFilePath}.next`, '9002\n');
        renameSync(`${portFilePath}.next`, portFilePath);
        expect(read()).toBeNull();
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  it('falls back to BOTMUX_DASHBOARD_PORT when no port file exists', async () => {
    const cachePath = await seedCache(9002);
    const portFilePath = join(tmpDir(), 'absent-port');
    expect(devboxDashboardBaseUrl({
      cachePath,
      portFilePath,
      env: { ...devboxEnv, BOTMUX_DASHBOARD_PORT: '9002' },
      ...IGNORE_ENV_FILE,
    })).toBe('https://tunnel-for-9002.example.com');
    expect(devboxDashboardBaseUrl({
      cachePath,
      portFilePath,
      env: { ...devboxEnv, BOTMUX_DASHBOARD_PORT: '9001' },
      ...IGNORE_ENV_FILE,
    })).toBeNull();
  });

  it('invalidates the production memo immediately on cross-process cache and port writes', () => {
    const home = tmpDir();
    const configDir = join(home, '.botmux');
    mkdirSync(configDir, { mode: 0o700 });
    chmodSync(configDir, 0o700);
    writeFileSync(join(configDir, '.dashboard-port'), '9001\n', { mode: 0o600 });

    const childEnv = {
      ...process.env,
      HOME: home,
      ARNOLD_WORKSPACE_ID: 'probe',
      PORT_LIST: '9001,9002',
    };
    delete childEnv.BOTMUX_DEVBOX_AUTO_EXPORT;
    const child = spawnSyncTsEvalWithRepoImports(`
      const { chmodSync, renameSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { devboxDashboardBaseUrl } = await import('./src/platform/devbox-dashboard-export.js');
      const dir = join(process.env.HOME, '.botmux');
      const portPath = join(dir, '.dashboard-port');
      const cachePath = join(dir, 'devbox-dashboard-export.json');
      const atomicWrite = (path, text) => {
        const temp = path + '.next';
        writeFileSync(temp, text, { mode: 0o600 });
        chmodSync(temp, 0o600);
        renameSync(temp, path);
      };
      const cache = (port, shortUrl) => JSON.stringify({ workspaceId: 'probe', port, shortUrl }) + '\\n';
      const firstMiss = devboxDashboardBaseUrl();
      atomicWrite(cachePath, cache(9001, 'https://fresh-9001.example.com'));
      const afterExternalExport = devboxDashboardBaseUrl();
      atomicWrite(portPath, '9002\\n');
      atomicWrite(cachePath, cache(9002, 'https://fresh-9002.example.com'));
      const afterPortDrift = devboxDashboardBaseUrl();
      console.log(JSON.stringify({ firstMiss, afterExternalExport, afterPortDrift }));
    `, {
      cwd: process.cwd(),
      env: childEnv,
      encoding: 'utf8',
    });
    expect(child.status, child.stderr?.toString()).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      firstMiss: null,
      afterExternalExport: 'https://fresh-9001.example.com',
      afterPortDrift: 'https://fresh-9002.example.com',
    });
  });

  // End to end on the production paths: a fresh Devbox dashboard that has no
  // login token yet answers `/__cli/current` with no-active-token. The export
  // must still happen on that answer, because the web-terminal links — one
  // builder, `buildTerminalUrl`, for the PTY and tmux backends alike — read only
  // the export cache. Gating the export on a usable dashboard link left them
  // local until the owner ran `botmux dashboard`.
  it('a no-active-token dashboard answer still exports, and terminal links switch to the tunnel', () => {
    const home = tmpDir();
    const configDir = join(home, '.botmux');
    mkdirSync(configDir, { mode: 0o700 });
    chmodSync(configDir, 0o700);
    writeFileSync(join(configDir, '.dashboard-port'), '9001\n', { mode: 0o600 });

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      ARNOLD_WORKSPACE_ID: 'probe',
      PORT_LIST: '9001',
    };
    delete childEnv.BOTMUX_DEVBOX_AUTO_EXPORT;
    delete childEnv.BOTMUX_PUBLIC_URL;
    const child = spawnSyncTsEvalWithRepoImports(`
      const { exportAfterDashboardAnswer } = await import('./src/cli/dashboard-command.js');
      const { ensureDevboxDashboardExport } = await import('./src/platform/devbox-dashboard-export.js');
      const { buildTerminalUrl, setTerminalProxyPort } = await import('./src/core/terminal-url.js');
      setTerminalProxyPort(17001);
      const ds = {
        session: { sessionId: 'sess-1' },
        workerPort: 17002,
        workerToken: 'wtok',
        workerViewToken: 'vtok',
      };
      const before = buildTerminalUrl(ds);
      const endpointCalls = [];
      const answer = await exportAfterDashboardAnswer(
        { ok: false, reason: 'no-active-token' },
        () => ensureDevboxDashboardExport({
          port: 9001,
          remoteBaseConfigured: false,
          merlinCliPath: '/fake/merlin-cli',
          runExport: async () => ({ stdout: '${PRIVATE_RESULT}', stderr: '' }),
        }),
        async (path) => { endpointCalls.push(path); return { ok: false, reason: 'unreachable' }; },
      );
      console.log(JSON.stringify({
        before,
        answer,
        endpointCalls,
        readLink: buildTerminalUrl(ds),
        writeLink: buildTerminalUrl(ds, { write: true }),
      }));
    `, {
      cwd: process.cwd(),
      env: childEnv,
      encoding: 'utf8',
    });
    expect(child.status, child.stderr?.toString()).toBe(0);
    const out = JSON.parse(child.stdout.toString().trim().split('\n').at(-1) ?? '');
    expect(out.before).not.toContain('devbox.example.com');
    expect(out).toMatchObject({
      answer: { ok: false, reason: 'no-active-token' },
      // No token was minted or rotated: the helper made no endpoint call at all.
      endpointCalls: [],
      readLink: 'https://devbox.example.com/s/sess-1?viewToken=vtok',
      writeLink: 'https://devbox.example.com/s/sess-1?token=wtok',
    });
  });
});
