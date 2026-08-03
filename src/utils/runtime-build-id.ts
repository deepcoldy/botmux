import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RuntimeBuildEntry {
  path: string;
  content: string | Buffer;
}

export type RuntimeBuildIdentity =
  | { status: 'known'; id: string; source: 'artifact' | 'source' }
  | { status: 'unknown'; reason: 'artifact_invalid' | 'source_unavailable' | 'read_failed' };

const BUILD_ID_RE = /^[a-f0-9]{64}$/;
let cachedIdentity: RuntimeBuildIdentity | undefined;

export function computeRuntimeBuildId(entries: readonly RuntimeBuildEntry[]): string {
  const hash = createHash('sha256');
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const path = entry.path.split(sep).join('/');
    const content = typeof entry.content === 'string' ? Buffer.from(entry.content) : entry.content;
    hash.update(`${Buffer.byteLength(path)}:${path}:${content.byteLength}:`);
    hash.update(content);
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function isRuntimeBuildId(value: unknown): value is string {
  return typeof value === 'string' && BUILD_ID_RE.test(value);
}

function collectEntries(root: string, extension: '.ts' | '.js'): RuntimeBuildEntry[] {
  const entries: RuntimeBuildEntry[] = [];
  const visit = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, item.name);
      const rel = relative(root, absolute).split(sep).join('/');
      if (item.isDirectory()) {
        if (rel === 'dashboard/web' || rel.startsWith('dashboard/web/')) continue;
        visit(absolute);
      } else if (
        item.isFile()
        && item.name.endsWith(extension)
        && !item.name.endsWith('.d.ts')
      ) {
        entries.push({ path: rel, content: readFileSync(absolute) });
      }
    }
  };
  visit(root);
  return entries;
}

export function collectCompiledRuntimeEntries(
  sourceRoot: string,
  distRoot: string,
): RuntimeBuildEntry[] {
  return collectEntries(sourceRoot, '.ts').map(entry => {
    const path = `${entry.path.slice(0, -3)}.js`;
    return { path, content: readFileSync(join(distRoot, ...path.split('/'))) };
  });
}

export function resolveRuntimeBuildIdentity(options: {
  artifactPath: string;
  sourceRoot?: string;
}): RuntimeBuildIdentity {
  if (existsSync(options.artifactPath)) {
    try {
      const id = readFileSync(options.artifactPath, 'utf8').trim();
      return isRuntimeBuildId(id)
        ? { status: 'known', id, source: 'artifact' }
        : { status: 'unknown', reason: 'artifact_invalid' };
    } catch {
      return { status: 'unknown', reason: 'read_failed' };
    }
  }
  if (!options.sourceRoot || !existsSync(options.sourceRoot)) {
    return { status: 'unknown', reason: 'source_unavailable' };
  }
  try {
    const entries = collectEntries(options.sourceRoot, '.ts');
    return entries.length > 0
      ? { status: 'known', id: computeRuntimeBuildId(entries), source: 'source' }
      : { status: 'unknown', reason: 'source_unavailable' };
  } catch {
    return { status: 'unknown', reason: 'read_failed' };
  }
}

export function runtimeBuildIdentity(): RuntimeBuildIdentity {
  if (cachedIdentity) return cachedIdentity;
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  cachedIdentity = resolveRuntimeBuildIdentity({
    artifactPath: join(projectRoot, 'dist', '.runtime-build-id'),
    sourceRoot: join(projectRoot, 'src'),
  });
  return cachedIdentity;
}
