import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { atomicWriteFileSync } from '../../../utils/atomic-write.js';
import { withFileLock } from '../../../utils/file-lock.js';

export function defaultWecomConfigFile(): string {
  return join(homedir(), '.botmux', 'wecom', 'config.json');
}

export function wecomRoot(): string {
  return join(homedir(), '.botmux', 'wecom');
}

export function wecomConfigId(file: string): string {
  return createHash('sha256').update(resolve(file)).digest('hex');
}

/**
 * Registries a lenient read found damaged and has not read cleanly since. This
 * function runs on every Dashboard refresh: a damaged registry is logged once
 * per process, and again only after it was read cleanly in between.
 */
const damagedRegistriesLogged = new Set<string>();

export function readWecomConfigPaths(root = wecomRoot(), strict = false): string[] {
  const fallback = root === wecomRoot() ? defaultWecomConfigFile() : join(root, 'config.json');
  const index = join(root, 'config-registry.json');
  let paths: unknown = [];
  if (existsSync(index)) {
    try {
      const parsed = JSON.parse(readFileSync(index, 'utf8'));
      if (parsed?.version !== 1 || !Array.isArray(parsed.paths) || parsed.paths.length > 100) {
        throw new Error('wecom_registry_invalid');
      }
      paths = parsed.paths;
      damagedRegistriesLogged.delete(index);
    } catch {
      if (strict) {
        throw new Error('wecom_registry_invalid');
      }
      if (!damagedRegistriesLogged.has(index)) {
        damagedRegistriesLogged.add(index);
        console.error(`[wecom] 连接登记文件 ${index} 无法解析，暂只读取默认配置路径`);
      }
    }
  }
  return [...new Set([
    fallback,
    ...(paths as unknown[]).filter((path): path is string =>
      typeof path === 'string' && path.startsWith('/') && path.length < 4096),
  ].map(path => resolve(path)))];
}

/** Explicit registration only: no directory/HOME scan and no browser-supplied paths. */
export async function registerWecomConfig(file: string, root = wecomRoot()): Promise<void> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const index = join(root, 'config-registry.json');
  await withFileLock(index, async () => {
    const paths = [...new Set([...readWecomConfigPaths(root, true), resolve(file)])];
    if (paths.length > 100) {
      throw new Error('wecom_registry_full');
    }
    atomicWriteFileSync(index, JSON.stringify({ version: 1, paths }), {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
  }, { maxWaitMs: 100 });
}
