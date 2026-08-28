import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Counting settings-file reads is the only way to pin the gate ORDER: on an
// ordinary host the verdict is null either way, so only the syscall is
// observable. Wraps the real implementation — nothing is stubbed out.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, default: actual, readFileSync: vi.fn(actual.readFileSync) };
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
    const runExport = vi.fn(async () => 'merlin-cli: unexpected output');
    const call = () => ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      cachePath,
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
      env: {
        ...process.env,
        HOME: home,
        ARNOLD_WORKSPACE_ID: 'probe',
        PORT_LIST: '9001',
      },
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
});
