import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';

function resolveHome(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || homedir();
}

export function atomcodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ATOMCODE_HOME?.trim();
  if (configured) {
    return configured.startsWith('~/')
      ? join(resolveHome(env), configured.slice(2))
      : resolve(configured);
  }
  return join(resolveHome(env), '.atomcode');
}

export function atomcodeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(atomcodeDataDir(env), 'config.toml');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Mirror AtomCode's Config::logical_models(): merge legacy [providers.*] and
 *  new-schema [models.*] keys into the sorted model-id catalog ACP exposes. */
export function parseAtomcodeConfigModels(rawToml: string): string[] {
  let parsed: unknown;
  try {
    parsed = parseToml(rawToml);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const ids = new Set<string>();
  for (const section of [parsed.providers, parsed.models]) {
    if (!isRecord(section)) continue;
    for (const [id, entry] of Object.entries(section)) {
      if (id.trim() && isRecord(entry)) ids.add(id);
    }
  }
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export async function detectAtomcodeModels(
  options?: { env?: NodeJS.ProcessEnv },
): Promise<readonly string[] | null> {
  const env = options?.env ?? process.env;
  try {
    const raw = await readFile(atomcodeConfigPath(env), 'utf8');
    const models = parseAtomcodeConfigModels(raw);
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}
