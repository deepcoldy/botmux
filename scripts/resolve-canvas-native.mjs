import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function resolveCanvasSkiaNative(platform, arch, libc, { repoRoot = REPO_ROOT, tempRoot = tmpdir() } = {}) {
  if (!['darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Unsupported canvas target: ${platform}-${arch}`);
  }
  if (platform === 'linux' && !['glibc', 'musl'].includes(libc)) {
    throw new Error(`Cannot resolve canvas for linux-${arch}: target libc must be glibc or musl`);
  }
  const suffix = `${platform}-${arch}${platform === 'linux' ? `-${libc === 'glibc' ? 'gnu' : 'musl'}` : ''}`;
  const pkg = `@napi-rs/canvas-${suffix}`;
  const skiaName = `skia.${suffix}.node`;
  const require = createRequire(join(repoRoot, 'package.json'));

  try {
    const local = join(dirname(require.resolve(`${pkg}/package.json`)), skiaName);
    if (existsSync(local)) return local;
  } catch {}

  const lock = readFileSync(join(repoRoot, 'bun.lock'), 'utf8');
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entry = new RegExp(`"${escaped}"\\s*:\\s*\\[\\s*"${escaped}@([^"]+)"\\s*,\\s*"([^"]*)"\\s*,\\s*\\{[^}]*\\}\\s*,\\s*"(sha512-[^"]+)"\\s*\\]`).exec(lock);
  if (!entry) throw new Error(`${pkg} is not pinned in bun.lock; cannot resolve its skia native for ${suffix}.`);
  const [, version, lockedUrl, integrity] = entry;
  const tarball = lockedUrl || `https://registry.npmjs.org/${pkg}/-/canvas-${suffix}-${version}.tgz`;
  const response = await fetch(tarball);
  if (!response.ok) throw new Error(`fetching ${pkg}@${version} from ${tarball} failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (digest !== integrity) throw new Error(`${pkg}@${version} integrity mismatch: bun.lock ${integrity}, downloaded ${digest}`);

  const directory = mkdtempSync(join(tempRoot, `botmux-skia-${suffix}-`));
  try {
    const archive = join(directory, 'canvas.tgz');
    writeFileSync(archive, bytes);
    execFileSync('tar', ['-xzf', archive, '-C', directory], { stdio: 'pipe' });
    const native = join(directory, 'package', skiaName);
    if (!existsSync(native)) throw new Error(`${pkg}@${version} has no ${skiaName} in its tarball`);
    return native;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
