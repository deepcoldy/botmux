#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
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
  // The `pkg.pnpm.supportedArchitectures` mirror that used to live here is gone
  // with pnpm: bun selects optional-dependency arches via install flags (see the
  // `--os` / `--cpu` below), not project config, so there is nothing to inject
  // into the staged package.json.
  delete pkg.scripts;
  await writeFile(join(runtimeDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  await cp(join(root, 'bun.lock'), join(runtimeDir, 'bun.lock'));

  // The Universal app's bundled runtime must carry BOTH macOS optional-dependency
  // variants so it runs natively on Intel and ARM Macs. Under pnpm that was a
  // `supportedArchitectures` block (mirrored into package.json + a generated
  // pnpm-workspace.yaml, because pnpm 9 and 11 read it from different places);
  // bun takes it as install flags instead, so the whole generated-config dance is
  // gone: `--os darwin --cpu '*'` fetches every arch's optional deps rather than
  // just the builder machine's. assertBundledCanvasArchitectures() below is what
  // actually proves both arches landed, and it is unchanged.
  run('bun', [
    'install',
    '--production',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--os', 'darwin',
    '--cpu', '*',
  ], runtimeDir);
  await assertBundledCanvasArchitectures();
  await stageNodePty();
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
  // Prove BOTH macOS arches were staged, so the Universal app is not silently
  // half-native. This used to enumerate pnpm's content-addressed store
  // (`node_modules/.pnpm/@napi-rs+canvas-darwin-<arch>@…`), which does not exist
  // under bun's flat layout — it would have thrown on a perfectly correct
  // install. Assert on the PACKAGE PATH instead, which both layouts share: an
  // installed optional dep is always reachable at
  // node_modules/@napi-rs/canvas-darwin-<arch>.
  for (const arch of ['arm64', 'x64']) {
    const pkgDir = join(runtimeDir, 'node_modules', '@napi-rs', `canvas-darwin-${arch}`);
    if (!existsSync(pkgDir)) {
      throw new Error(`Bundled runtime is missing @napi-rs/canvas-darwin-${arch} (looked for ${pkgDir})`);
    }
  }
}

/**
 * Copy node-pty into the staged runtime tree.
 *
 * WHY A COPY INSTEAD OF A DEPENDENCY: node-pty is a devDependency on purpose. It has
 * an `install` script (`node scripts/prebuild.js || node-gyp rebuild`) and ships NO
 * linux prebuild, so any placement npm/bun would install for an end user turns a
 * node-gyp toolchain into an install prerequisite — measured: `npm i -g botmux` then
 * compiles pty.node from source on every machine that has a compiler. The CLI does
 * not need it installed at all (the single-file binary embeds pty.node at compile
 * time), and the desktop app does not need it BUILT: node-pty's loader tries
 * `build/Release` → `build/Debug` → `prebuilds/<platform>-<arch>` (lib/utils.js), and
 * the npm package carries darwin-arm64 + darwin-x64 prebuilds. Under
 * `--ignore-scripts` `build/Release` never exists, so macOS loads a prebuild.
 *
 * So: stage the package as-is from the builder's own node_modules. Its only
 * dependency (`node-addon-api`) is compile-time headers and is not needed at runtime.
 */
async function stageNodePty() {
  const target = join(runtimeDir, 'node_modules', 'node-pty');
  const require = createRequire(join(root, 'package.json'));
  let source;
  try {
    source = dirname(require.resolve('node-pty/package.json'));
  } catch (err) {
    throw new Error(
      'Cannot resolve node-pty from the builder checkout — run `bun install` first. '
      + `(${err && err.message ? err.message : String(err)})`,
    );
  }
  await rm(target, { recursive: true, force: true });
  // EXCLUDE build/ — correctness, not tidiness. node-pty's loader tries
  // `build/Release` BEFORE `prebuilds/<platform>-<arch>`, so any compiled artifact
  // sitting in the builder's own tree gets copied in and SHADOWS the prebuild we
  // actually want.
  //
  // How a stray build/ appears: node-pty's install script (scripts/prebuild.js)
  // exits 0 when `prebuilds/<platform>-<arch>` exists and only falls through to
  // `node-gyp rebuild` when it does not. So the release runner (macOS, prebuilds
  // present) normally has no build/ — but a Linux dev box does (no linux prebuild),
  // `npm_config_build_from_source=true` forces one, and a future node-pty could drop
  // a darwin prebuild. Any of those leaves an artifact for this cp to pick up.
  //
  // Worst case is silent and arch-specific: a macOS builder produces a SINGLE-arch
  // Mach-O, which would shadow the OTHER arch's prebuild inside the Universal app —
  // terminals dead on half the machines, with nothing failing at build time.
  await cp(source, target, {
    recursive: true,
    dereference: true,
    filter: src => !isUnderBuildDir(source, src),
  });

  // Fail closed, and assert what macOS ACTUALLY loads. Without this the desktop app
  // could ship with no terminal support at all and nothing would notice until a user
  // opened a session — the exact silent-failure shape this whole change removes.
  for (const arch of ['arm64', 'x64']) {
    const prebuild = join(target, 'prebuilds', `darwin-${arch}`, 'pty.node');
    if (!existsSync(prebuild)) {
      throw new Error(`Staged node-pty is missing its darwin-${arch} prebuild (looked for ${prebuild})`);
    }
  }
  // And assert the builder's own platform binary did NOT ride along: its presence
  // would shadow the prebuilds above (loader order), which is exactly the failure
  // the filter prevents.
  const shadowed = join(target, 'build', 'Release', 'pty.node');
  if (existsSync(shadowed)) {
    throw new Error(`Staged node-pty carries the builder's build/Release/pty.node (${shadowed}); it would shadow the darwin prebuild`);
  }
}

/** True when `candidate` is node-pty's `build/` dir (or anything inside it). */
function isUnderBuildDir(pkgRoot, candidate) {
  const buildDir = join(pkgRoot, 'build');
  return candidate === buildDir || candidate.startsWith(buildDir + sep);
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
