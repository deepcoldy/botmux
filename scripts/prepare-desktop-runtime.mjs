#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import https from 'node:https';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = join(root, 'build', 'desktop-runtime');
const nodeDir = join(root, 'build', 'desktop-node');
const nodeVersion = process.env.BOTMUX_DESKTOP_NODE_VERSION || '22.20.0';
const platforms = ['darwin-arm64', 'darwin-x64'];
const pinnedChecksums = {
  'node-v22.20.0-darwin-arm64.tar.gz': 'cc04a76a09f79290194c0646f48fec40354d88969bec467789a5d55dd097f949',
  'node-v22.20.0-darwin-x64.tar.gz': '00df9c5df3e4ec6848c26b70fb47bf96492f342f4bed6b17f12d99b3a45eeecc',
};

await stageBotmuxRuntime();
await stageNodeRuntimes();

async function stageBotmuxRuntime() {
  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(runtimeDir, { recursive: true });

  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const stagedVersion = normalizeVersion(process.env.BOTMUX_DESKTOP_VERSION);
  if (stagedVersion) pkg.version = stagedVersion;
  // pnpm 9 reads supportedArchitectures from package.json. Keep this mirror in
  // addition to pnpm-workspace.yaml below so both pnpm 9 and 11 stage the same
  // Universal runtime dependency set.
  pkg.pnpm = {
    ...(pkg.pnpm ?? {}),
    supportedArchitectures: { os: ['darwin'], cpu: ['arm64', 'x64'] },
  };
  delete pkg.scripts;
  await writeFile(join(runtimeDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  await cp(join(root, 'pnpm-lock.yaml'), join(runtimeDir, 'pnpm-lock.yaml'));
  // pnpm 11 reads project settings from pnpm-workspace.yaml. Install both
  // macOS optional dependency variants so the Universal app's bundled runtime
  // works natively on Intel and ARM Macs.
  await writeFile(join(runtimeDir, 'pnpm-workspace.yaml'), [
    'packages:',
    "  - '.'",
    'supportedArchitectures:',
    '  os:',
    '    - darwin',
    '  cpu:',
    '    - arm64',
    '    - x64',
    '',
  ].join('\n'));

  run('pnpm', ['install', '--prod', '--frozen-lockfile', '--ignore-scripts'], runtimeDir);
  await assertBundledCanvasArchitectures();
  // electron-builder applies the app-level `!node_modules/**` exclusion to
  // extraResources and expands pnpm symlinks into duplicate dependency trees.
  // A single archive crosses that boundary intact; afterPack expands it before
  // code signing.
  run('tar', ['-czf', 'node_modules.tar.gz', 'node_modules'], runtimeDir);
  await rm(join(runtimeDir, 'node_modules'), { recursive: true, force: true });
  const distDir = join(root, 'dist');
  await cp(distDir, join(runtimeDir, 'dist'), {
    recursive: true,
    filter: source => isRuntimeDistPath(distDir, source),
  });
}

async function assertBundledCanvasArchitectures() {
  const entries = await readdir(join(runtimeDir, 'node_modules', '.pnpm'));
  for (const arch of ['arm64', 'x64']) {
    const prefix = `@napi-rs+canvas-darwin-${arch}@`;
    if (!entries.some(entry => entry.startsWith(prefix))) {
      throw new Error(`Bundled runtime is missing @napi-rs/canvas-darwin-${arch}`);
    }
  }
}

function normalizeVersion(value) {
  const version = String(value ?? '').trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

function isRuntimeDistPath(distDir, source) {
  const path = relative(distDir, source);
  if (!path) return true;
  const top = path.split(sep)[0];
  if (top === 'desktop' || top === '.icon-icns' || top.startsWith('mac')) return false;
  return !/\.(?:dmg|zip|blockmap)$/i.test(top) && !top.startsWith('builder-');
}

async function stageNodeRuntimes() {
  await rm(nodeDir, { recursive: true, force: true });
  await mkdir(nodeDir, { recursive: true });
  const cacheDir = join(homedir(), 'Library', 'Caches', 'botmux-desktop-node', `v${nodeVersion}`);
  await mkdir(cacheDir, { recursive: true });
  let sums;

  for (const platform of platforms) {
    const filename = `node-v${nodeVersion}-${platform}.tar.gz`;
    const expected = pinnedChecksums[filename]
      ?? checksumFor(sums ??= await fetchText(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`), filename);
    const archive = join(cacheDir, filename);
    if (!(await fileMatches(archive, expected))) {
      await rm(archive, { force: true });
      await download(`https://nodejs.org/dist/v${nodeVersion}/${filename}`, archive);
      if (!(await fileMatches(archive, expected))) throw new Error(`Node checksum mismatch: ${filename}`);
    }

    const extracted = await mkdtemp(join(tmpdir(), 'botmux-node-'));
    try {
      run('tar', ['-xzf', archive, '-C', extracted, '--strip-components=1'], root);
      const target = join(nodeDir, platform);
      await mkdir(join(target, 'bin'), { recursive: true });
      await cp(join(extracted, 'bin', 'node'), join(target, 'bin', 'node'));
      await cp(join(extracted, 'LICENSE'), join(target, 'LICENSE'));
    } finally {
      await rm(extracted, { recursive: true, force: true });
    }
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? 1}`);
}

function checksumFor(sums, filename) {
  const line = sums.split(/\r?\n/).find(candidate => candidate.endsWith(`  ${filename}`));
  if (!line) throw new Error(`Checksum not found for ${filename}`);
  return line.split(/\s+/)[0];
}

async function fileMatches(path, expected) {
  try {
    const content = await readFile(path);
    return createHash('sha256').update(content).digest('hex') === expected;
  } catch {
    return false;
  }
}

async function fetchText(url) {
  const chunks = [];
  for await (const chunk of await request(url)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function download(url, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await pipeline(await request(url), createWriteStream(destination, { mode: 0o644 }));
}

function request(url) {
  return new Promise((resolveRequest, reject) => {
    https.get(url, response => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolveRequest(request(new URL(response.headers.location, url).toString()));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`GET ${url} failed: ${response.statusCode}`));
        return;
      }
      resolveRequest(response);
    }).on('error', reject);
  });
}
