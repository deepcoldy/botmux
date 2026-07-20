#!/usr/bin/env node

/**
 * Opt-in Dashboard self-update integration lab.
 *
 * The lab owns an isolated HOME, npm prefix/cache, PM2_HOME, PATH and loopback
 * port. It never invokes a PATH-resolved botmux and only removes directories
 * carrying its marker file.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, realpathSync } from 'node:fs';
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const officialRegistry = 'https://registry.npmjs.org/';
const pm2Cli = join(repoRoot, 'node_modules', 'pm2', 'bin', 'pm2');
const labRoot = resolve(
  process.env.BOTMUX_UPDATE_ITEST_ROOT
    ?? join(tmpdir(), 'botmux-dashboard-update-itest'),
);
const markerPath = join(labRoot, '.botmux-dashboard-update-itest.json');
const runId = randomUUID();
let ownsLabRoot = false;
const args = process.argv.slice(2);
const commands = new Map([
  ['--serve', 'serve'],
  ['--real', 'real'],
  ['--down', 'down'],
]);
if (args.length > 1 || (args.length === 1 && !commands.has(args[0]))) {
  throw new Error('usage: dashboard-update-itest.mjs [--serve|--real|--down]');
}
const command = args.length === 0 ? 'verify' : commands.get(args[0]);

if (process.platform === 'win32') {
  throw new Error('dashboard update integration lab currently supports macOS and Linux');
}
if (labRoot === resolve(homedir()) || labRoot === repoRoot || labRoot === resolve(repoRoot, '..')) {
  throw new Error(`refusing unsafe lab root: ${labRoot}`);
}

const shutdownController = new AbortController();
const activeRuns = new Set();
let resolveStopSignal;
const stopSignal = new Promise(resolveSignal => { resolveStopSignal = resolveSignal; });
const signalHandlers = new Map();

function startSignalHandling() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      stopSignalHandling();
      shutdownController.abort(new Error(`received ${signal}`));
      resolveStopSignal(signal);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
}

function stopSignalHandling() {
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  signalHandlers.clear();
}

function requestSignal(timeoutMs) {
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), shutdownController.signal]);
}

const paths = {
  home: join(labRoot, 'home'),
  config: join(labRoot, 'home', '.botmux'),
  data: join(labRoot, 'home', '.botmux', 'data'),
  logs: join(labRoot, 'home', '.botmux', 'logs'),
  pm2Home: join(labRoot, 'home', '.botmux', 'pm2'),
  prefix: join(labRoot, 'prefix'),
  packages: join(labRoot, 'packages'),
  staging: join(labRoot, 'staging'),
  tools: join(labRoot, 'tools'),
  cache: join(labRoot, 'npm-cache'),
  npmrc: join(labRoot, 'empty.npmrc'),
  installLog: join(labRoot, 'install.jsonl'),
  installFault: join(labRoot, 'install-fault'),
  activeInstall: join(labRoot, 'active-install.json'),
  bots: join(labRoot, 'home', '.botmux', 'bots.json'),
  portFile: join(labRoot, 'home', '.botmux', '.dashboard-port'),
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

function findExecutable(name) {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`${name} is required on PATH`);
}

function run(executable, args, options = {}) {
  const capture = options.capture === true;
  if (shutdownController.signal.aborted && options.ignoreShutdown !== true) {
    return Promise.reject(shutdownController.signal.reason);
  }
  const promise = new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      shell: false,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let terminationReason = '';
    let forceTimer;
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
    }
    const onAbort = () => terminate('interrupted');
    const terminate = reason => {
      if (terminationReason) return;
      terminationReason = reason;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    };
    const timeout = setTimeout(
      () => terminate(`timed out after ${options.timeoutMs ?? 180_000}ms`),
      options.timeoutMs ?? 180_000,
    );
    if (options.ignoreShutdown !== true) {
      shutdownController.signal.addEventListener('abort', onAbort, { once: true });
      if (shutdownController.signal.aborted) onAbort();
    }
    const clear = () => {
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      shutdownController.signal.removeEventListener('abort', onAbort);
    };
    child.on('error', error => {
      clear();
      rejectRun(error);
    });
    child.on('exit', (code, signal) => {
      clear();
      if (terminationReason) {
        rejectRun(new Error(`${executable} ${args.join(' ')} ${terminationReason}`));
        return;
      }
      if (code === 0) return resolveRun({ stdout, stderr });
      const detail = stderr.trim() || stdout.trim() || signal || `exit ${code}`;
      rejectRun(new Error(`${executable} ${args.join(' ')} failed: ${detail}`));
    });
  });
  activeRuns.add(promise);
  promise.then(
    () => activeRuns.delete(promise),
    () => activeRuns.delete(promise),
  );
  return promise;
}

function canonicalVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
}

function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

async function registryVersions() {
  const response = await fetch('https://registry.npmjs.org/botmux', {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: requestSignal(20_000),
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  const manifest = await response.json();
  const latest = manifest?.['dist-tags']?.latest;
  assert(canonicalVersion(latest), `npm latest is not a stable version: ${latest}`);
  const previous = Object.keys(manifest?.versions ?? {})
    .filter(version => canonicalVersion(version) && compareVersions(version, latest) < 0)
    .sort((a, b) => compareVersions(b, a))[0];
  assert(previous, `no stable version older than ${latest} was found`);
  return { latest, previous };
}

async function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.on('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? rejectPort(error) : resolvePort(port));
    });
  });
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function readMarker() {
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    return marker?.kind === 'botmux-dashboard-update-itest' && marker?.root === labRoot
      ? marker
      : null;
  } catch {
    return null;
  }
}

async function writeMarker(extra = {}) {
  await writeFile(markerPath, `${JSON.stringify({
    kind: 'botmux-dashboard-update-itest',
    root: labRoot,
    runId,
    createdAt: new Date().toISOString(),
    ...extra,
  }, null, 2)}\n`, { mode: 0o600 });
}

async function prepareRoot() {
  if (await pathExists(labRoot)) {
    const marker = await readMarker();
    const hint = marker ? 'run with --down first' : 'directory is not owned by this test';
    throw new Error(`lab root already exists (${hint}): ${labRoot}`);
  }
  await mkdir(labRoot, { recursive: false, mode: 0o700 });
  await writeMarker();
  ownsLabRoot = true;
  await Promise.all([
    mkdir(paths.data, { recursive: true }),
    mkdir(paths.logs, { recursive: true }),
    mkdir(paths.pm2Home, { recursive: true }),
    mkdir(paths.prefix, { recursive: true }),
    mkdir(paths.packages, { recursive: true }),
    mkdir(paths.staging, { recursive: true }),
    mkdir(paths.tools, { recursive: true }),
    mkdir(paths.cache, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(paths.bots, '[]\n', { mode: 0o600 }),
    writeFile(join(paths.config, 'config.json'), '{"lang":"zh"}\n', { mode: 0o600 }),
    writeFile(join(paths.config, '.env'), '# Isolated Dashboard update integration lab.\n', { mode: 0o600 }),
    writeFile(paths.npmrc, '', { mode: 0o600 }),
    symlink(process.execPath, join(paths.tools, 'node')),
  ]);
}

function makeLabEnv(port) {
  const env = {
    HOME: paths.home,
    PM2_HOME: paths.pm2Home,
    BOTS_CONFIG: paths.bots,
    SESSION_DATA_DIR: paths.data,
    BOTMUX_DASHBOARD_HOST: '127.0.0.1',
    BOTMUX_DASHBOARD_PORT: String(port),
    NPM_CONFIG_USERCONFIG: paths.npmrc,
    npm_config_userconfig: paths.npmrc,
    NPM_CONFIG_CACHE: paths.cache,
    npm_config_cache: paths.cache,
    PATH: [join(paths.prefix, 'bin'), paths.tools, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    GIT_TERMINAL_PROMPT: '0',
    DISABLE_UPDATE_PROMPT: 'true',
  };
  for (const key of ['LANG', 'LC_ALL', 'TMPDIR', 'USER', 'LOGNAME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function packFixture(version, realNpm, env) {
  const stage = join(paths.staging, version);
  await mkdir(stage, { recursive: true });
  await cp(join(repoRoot, 'dist'), join(stage, 'dist'), { recursive: true });
  for (const name of ['ecosystem.config.cjs', 'README.md', 'README.en.md', 'LICENSE']) {
    await cp(join(repoRoot, name), join(stage, name));
  }
  const source = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const fixturePackage = {
    name: source.name,
    version,
    description: source.description,
    type: source.type,
    main: source.main,
    bin: source.bin,
    files: source.files,
    engines: source.engines,
    license: source.license,
    dependencies: source.dependencies,
  };
  await writeFile(join(stage, 'package.json'), `${JSON.stringify(fixturePackage, null, 2)}\n`);
  const result = await run(realNpm, [
    'pack',
    '--ignore-scripts',
    '--pack-destination', paths.packages,
  ], { cwd: stage, env, capture: true });
  const filename = result.stdout.trim().split(/\r?\n/).at(-1);
  assert(filename, `npm pack did not return an archive name for ${version}`);
  return join(paths.packages, filename);
}

function npmWrapper(realNpm, latest, previous, latestArchive, previousArchive, realMode) {
  return `#!/usr/bin/env node
const { appendFileSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const prefix = ${JSON.stringify(paths.prefix)};
const registry = ${JSON.stringify(officialRegistry)};
const expected = ['install', '-g', '--prefix', prefix];
if (args.length !== 5 || expected.some((value, index) => args[index] !== value)) {
  console.error('refusing unexpected npm invocation');
  process.exit(64);
}
const spec = args[4];
let fault = '';
try { fault = readFileSync(${JSON.stringify(paths.installFault)}, 'utf8').trim(); } catch {}
if (fault && fault !== 'install-fail' && fault !== 'version-mismatch') {
  console.error('refusing unknown integration fault: ' + fault);
  process.exit(66);
}
const rawRegistry = String(process.env.NPM_CONFIG_REGISTRY || process.env.npm_config_registry || '');
const normalizedRegistry = rawRegistry ? rawRegistry.replace(/\\/?$/, '/') : '';
let installArgs;
if (spec === ${JSON.stringify(`botmux@${previous}`)}) {
  if (normalizedRegistry !== registry) {
    console.error('rollback must use the official npm registry');
    process.exit(65);
  }
  installArgs = fault === 'version-mismatch'
    ? ['install', '-g', '--prefix', prefix, ${JSON.stringify(latestArchive)}]
    : ${realMode
      ? `args.concat(['--registry', registry])`
      : `['install', '-g', '--prefix', prefix, ${JSON.stringify(previousArchive)}]`};
} else if (spec === 'botmux@latest' || spec === ${JSON.stringify(`botmux@${latest}`)}) {
  installArgs = ['install', '-g', '--prefix', prefix, ${JSON.stringify(latestArchive)}];
} else {
  console.error('refusing unexpected package spec: ' + spec);
  process.exit(64);
}
appendFileSync(${JSON.stringify(paths.installLog)}, JSON.stringify({ at: new Date().toISOString(), spec, prefix, registry: normalizedRegistry || null, fault: fault || null }) + '\\n');
if (fault === 'install-fail') {
  console.error('simulated install failure');
  process.exit(70);
}
installArgs.push('--cache', ${JSON.stringify(paths.cache)}, '--ignore-scripts', '--no-audit', '--no-fund');
writeFileSync(${JSON.stringify(paths.activeInstall)}, JSON.stringify({ runId: ${JSON.stringify(runId)}, pid: process.pid, at: new Date().toISOString() }));
let result;
try {
  result = spawnSync(${JSON.stringify(realNpm)}, installArgs, { stdio: 'inherit', env: process.env, cwd: ${JSON.stringify(paths.home)} });
} finally {
  rmSync(${JSON.stringify(paths.activeInstall)}, { force: true });
}
if (result.error) throw result.error;
process.exit(result.status == null ? 1 : result.status);
`;
}

async function installArchive(realNpm, archive, env) {
  await run(realNpm, [
    'install', '-g', '--prefix', paths.prefix, archive,
    '--registry', officialRegistry,
    '--cache', paths.cache,
    '--ignore-scripts', '--no-audit', '--no-fund',
  ], { cwd: paths.home, env });
}

function packageRoot() {
  return join(paths.prefix, 'lib', 'node_modules', 'botmux');
}

function cliPath() {
  return join(paths.prefix, 'bin', 'botmux');
}

async function installedVersion() {
  const pkg = JSON.parse(await readFile(join(packageRoot(), 'package.json'), 'utf8'));
  return pkg.version;
}

async function startDashboard(env) {
  const ecosystem = join(paths.config, 'ecosystem.config.json');
  await writeFile(ecosystem, `${JSON.stringify({
    apps: [{
      name: 'botmux-dashboard',
      script: join(packageRoot(), 'dist', 'dashboard.js'),
      cwd: packageRoot(),
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3_000,
      stop_exit_codes: [0],
      kill_timeout: 3_500,
      error_file: join(paths.logs, 'dashboard-error.log'),
      out_file: join(paths.logs, 'dashboard-out.log'),
      merge_logs: true,
      env,
    }],
  }, null, 2)}\n`, { mode: 0o600 });
  await run(process.execPath, [pm2Cli, 'start', ecosystem], { cwd: paths.home, env, capture: true });
}

async function currentPort(fallback) {
  try {
    const port = Number((await readFile(paths.portFile, 'utf8')).trim());
    return Number.isInteger(port) && port > 0 ? port : fallback;
  } catch {
    return fallback;
  }
}

async function dashboardState(fallbackPort) {
  const port = await currentPort(fallbackPort);
  const response = await fetch(`http://127.0.0.1:${port}/__selfcheck`, {
    signal: requestSignal(1_000),
  });
  if (!response.ok) throw new Error(`selfcheck returned HTTP ${response.status}`);
  const nonce = (await response.text()).trim();
  const pid = Number((await readFile(join(paths.pm2Home, 'pids', 'botmux-dashboard-0.pid'), 'utf8')).trim());
  return { port, nonce, pid, version: await installedVersion() };
}

async function waitForDashboard(fallbackPort, predicate = () => true, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await dashboardState(fallbackPort);
      if (predicate(state)) return state;
    } catch (error) {
      if (shutdownController.signal.aborted) throw shutdownController.signal.reason;
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`dashboard did not reach the expected state: ${lastError?.message ?? 'timeout'}`);
}

async function rotateToken(env, port) {
  const result = await run(cliPath(), ['dashboard'], { cwd: paths.home, env, capture: true });
  const url = result.stdout.split(/\r?\n/).find(line => line.startsWith('http://'));
  assert(url, `botmux dashboard did not return a local URL: ${result.stdout}`);
  const parsed = new URL(url);
  const token = parsed.searchParams.get('t');
  assert(token, 'dashboard URL did not contain a token');
  parsed.hostname = '127.0.0.1';
  parsed.port = String(port);
  return { token, url: parsed.toString() };
}

async function api(port, token, pathname, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('cookie', `botmux_dashboard_token=${token}`);
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers,
    signal: requestSignal(120_000),
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* Some legacy routes return text. */ }
  return { response, body, text };
}

async function runUpdateWhenRestartSettles(port, token) {
  const deadline = Date.now() + 30_000;
  let result;
  do {
    result = await api(port, token, '/api/update/run', { method: 'POST' });
    if (result.response.status !== 409) return result;
    await sleep(500);
  } while (Date.now() < deadline);
  return result;
}

async function verifyRoundTrip(context) {
  let state = context.state;
  const { latest, previous, token, realMode, env } = context;
  console.log('Checking isolated status, allow-list and rejected requests…');
  const status = await api(state.port, token, '/api/update/status');
  assert(status.response.ok, `initial status failed: ${status.text}`);
  assert(status.body?.current === latest, `expected current ${latest}, got ${status.body?.current}`);
  assert(status.body?.installs?.multiple === false, 'lab PATH exposes more than one botmux install');

  const versions = await api(state.port, token, '/api/update/versions?refresh=1');
  assert(versions.response.ok && versions.body?.ok === true, `version list failed: ${versions.text}`);
  assert(versions.body.versions.some(entry => entry.version === previous), `${previous} is not an allowed rollback target`);

  const logSizeBefore = await stat(paths.installLog).then(value => value.size).catch(() => 0);
  const unauthenticated = await fetch(`http://127.0.0.1:${state.port}/api/update/rollback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: previous }),
    signal: requestSignal(120_000),
  });
  assert(unauthenticated.status === 401, `unauthenticated rollback returned ${unauthenticated.status}`);
  const invalid = await api(state.port, token, '/api/update/rollback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: '../3.0.0' }),
  });
  assert(invalid.response.status === 400, `invalid rollback returned ${invalid.response.status}`);
  const unlisted = await api(state.port, token, '/api/update/rollback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: '0.0.0' }),
  });
  assert(unlisted.response.status === 400, `unlisted rollback returned ${unlisted.response.status}`);
  const logSizeAfter = await stat(paths.installLog).then(value => value.size).catch(() => 0);
  assert(logSizeAfter === logSizeBefore, 'a rejected rollback reached npm');

  for (const fault of ['install-fail', 'version-mismatch']) {
    const beforeFailure = await dashboardState(state.port);
    await writeFile(paths.installFault, `${fault}\n`, { mode: 0o600 });
    let failedRollback;
    try {
      failedRollback = await api(state.port, token, '/api/update/rollback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: previous }),
      });
    } finally {
      await rm(paths.installFault, { force: true });
    }
    assert(failedRollback.response.status === 500, `${fault} rollback returned ${failedRollback.response.status}`);
    const expectedError = fault === 'install-fail' ? 'install_failed' : 'install_version_mismatch';
    assert(failedRollback.body?.error === expectedError, `${fault} returned ${failedRollback.text}`);
    await sleep(500);
    const afterFailure = await dashboardState(state.port);
    assert(afterFailure.version === latest, `${fault} changed the installed version`);
    assert(afterFailure.pid === beforeFailure.pid && afterFailure.nonce === beforeFailure.nonce, `${fault} restarted Dashboard`);
    assert(!(await pathExists(join(paths.data, 'restart-intent.json'))), `${fault} left a restart intent`);
  }

  const beforeRollback = state;
  const rollback = await api(state.port, token, '/api/update/rollback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: previous }),
  });
  assert(rollback.response.status === 202 && rollback.body?.newVersion === previous, `rollback failed: ${rollback.text}`);
  const installEntries = (await readFile(paths.installLog, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  const rollbackInstall = installEntries.at(-1);
  assert(rollbackInstall?.spec === `botmux@${previous}`, 'rollback did not use the exact package version');
  assert(rollbackInstall?.registry === officialRegistry, 'rollback did not use the official npm registry');
  state = await waitForDashboard(state.port, next => (
    next.version === previous && next.nonce !== beforeRollback.nonce && next.pid !== beforeRollback.pid
  ));
  console.log(`✓ Rolled back and restarted: ${latest} → ${previous}`);

  if (realMode) {
    const beforeRestore = state;
    await installArchive(context.realNpm, context.latestArchive, env);
    await run(cliPath(), ['restart'], { cwd: paths.home, env, capture: true });
    state = await waitForDashboard(state.port, next => (
      next.version === latest && next.nonce !== beforeRestore.nonce && next.pid !== beforeRestore.pid
    ));
  } else {
    const lowStatus = await api(state.port, token, '/api/update/status');
    assert(lowStatus.body?.current === previous && lowStatus.body?.behind === true, 'fixture rollback status is incorrect');
    const beforeUpgrade = state;
    const update = await runUpdateWhenRestartSettles(state.port, token);
    assert(update.response.ok && update.body?.newVersion === latest, `upgrade failed: ${update.text}`);
    const restart = await api(state.port, token, '/api/update/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ update: { oldVersion: previous, newVersion: latest } }),
    });
    assert(restart.response.status === 202, `restart failed: ${restart.text}`);
    state = await waitForDashboard(state.port, next => (
      next.version === latest && next.nonce !== beforeUpgrade.nonce && next.pid !== beforeUpgrade.pid
    ));
  }
  console.log(`✓ Restored and restarted: ${previous} → ${latest}`);

  const finalStatus = await api(state.port, token, '/api/update/status');
  assert(finalStatus.body?.current === latest && finalStatus.body?.behind === false, 'final latest status is incorrect');
  assert(finalStatus.body?.installs?.multiple === false, 'final PATH exposes more than one botmux install');
  console.log(`✓ Dashboard update integration passed: ${latest} → ${previous} → ${latest}`);
  return state;
}

async function killLabPm2() {
  const marker = await readMarker();
  const env = makeLabEnv(marker?.port ?? 0);
  await run(process.execPath, [pm2Cli, 'kill'], {
    cwd: paths.home,
    env,
    capture: true,
    ignoreShutdown: true,
    timeoutMs: 30_000,
  });
}

async function waitForActiveRuns() {
  while (activeRuns.size > 0) {
    await Promise.allSettled([...activeRuns]);
  }
}

async function waitForInstallIdle() {
  const deadline = Date.now() + 30_000;
  while (await pathExists(paths.activeInstall)) {
    if (Date.now() >= deadline) {
      throw new Error(`an npm install is still active; lab files were kept: ${labRoot}`);
    }
    await sleep(100);
  }
}

async function pm2DaemonIsGone() {
  const artifacts = ['pm2.pid', 'rpc.sock', 'pub.sock'].map(name => join(paths.pm2Home, name));
  return (await Promise.all(artifacts.map(path => pathExists(path)))).every(exists => !exists);
}

async function portIsClosed(port) {
  return new Promise((resolveClosed, rejectClosed) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const timeout = setTimeout(() => {
      socket.destroy();
      rejectClosed(new Error(`timed out checking isolated Dashboard port ${port}`));
    }, 500);
    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolveClosed(false);
    });
    socket.once('error', error => {
      clearTimeout(timeout);
      if (error?.code === 'ECONNREFUSED') resolveClosed(true);
      else rejectClosed(error);
    });
  });
}

async function cleanup(existingLab = false) {
  if (!(await pathExists(labRoot))) return;
  if (!existingLab && !ownsLabRoot) return;
  const marker = await readMarker();
  if (!marker) throw new Error(`refusing to remove unmarked lab root: ${labRoot}`);
  if (!existingLab && marker.runId !== runId) {
    throw new Error(`refusing to remove a lab owned by another run: ${labRoot}`);
  }
  const ports = new Set([marker.port, await currentPort(0)].filter(port => Number.isInteger(port) && port > 0));
  await waitForActiveRuns();
  await killLabPm2();
  await waitForInstallIdle();
  const deadline = Date.now() + 5_000;
  let stopped = false;
  while (Date.now() < deadline) {
    const portsClosed = (await Promise.all([...ports].map(port => portIsClosed(port)))).every(Boolean);
    if (portsClosed && await pm2DaemonIsGone()) {
      stopped = true;
      break;
    }
    await sleep(100);
  }
  if (!stopped) throw new Error(`isolated Dashboard or PM2 daemon is still active; lab files were kept: ${labRoot}`);
  await rm(labRoot, { recursive: true, force: false });
  ownsLabRoot = false;
}

async function createLab(realMode) {
  for (const required of ['dist/cli.js', 'dist/dashboard.js', 'dist/dashboard-web/index.html']) {
    await access(join(repoRoot, required), constants.R_OK);
  }
  await access(pm2Cli, constants.R_OK);
  const realNpm = findExecutable('npm');
  await access(realNpm, constants.X_OK);
  await prepareRoot();
  const requestedPort = await freePort();
  await writeMarker({ port: requestedPort, realMode });
  const env = makeLabEnv(requestedPort);
  const { latest, previous } = await registryVersions();
  console.log(`Preparing isolated Dashboard update lab (${latest} ↔ ${previous})…`);
  const [latestArchive, previousArchive] = await Promise.all([
    packFixture(latest, realNpm, env),
    realMode ? Promise.resolve(null) : packFixture(previous, realNpm, env),
  ]);
  await installArchive(realNpm, latestArchive, env);
  const wrapper = join(paths.tools, 'npm');
  await writeFile(wrapper, npmWrapper(realNpm, latest, previous, latestArchive, previousArchive, realMode), { mode: 0o755 });
  await chmod(wrapper, 0o755);
  await startDashboard(env);
  let state = await waitForDashboard(requestedPort, next => next.version === latest);
  await writeMarker({ port: state.port, latest, previous, realMode });
  const auth = await rotateToken(env, state.port);
  console.log(`✓ Isolated Dashboard ready on 127.0.0.1:${state.port}`);
  return { env, realNpm, latest, previous, latestArchive, previousArchive, token: auth.token, url: auth.url, state, realMode };
}

async function main() {
  startSignalHandling();
  try {
    if (command === 'down') {
      await cleanup(true);
      console.log(`✓ Removed Dashboard update lab: ${labRoot}`);
      return;
    }

    try {
      const context = await createLab(command === 'real');
      if (command === 'serve') {
        console.log('\nDashboard update lab is ready:');
        console.log(context.url);
        console.log(`Versions: v${context.latest} ↔ v${context.previous}`);
        console.log('Press Ctrl-C to stop and remove the isolated lab.');
        const keepAlive = setInterval(() => {}, 60_000);
        try {
          await stopSignal;
        } finally {
          clearInterval(keepAlive);
        }
        return;
      }
      await verifyRoundTrip(context);
    } finally {
      await cleanup();
    }
  } finally {
    stopSignalHandling();
  }
}

try {
  await main();
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
