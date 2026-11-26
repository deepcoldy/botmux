import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { loadBotConfigsCached, type BotConfig } from '../bot-registry.js';
import { parseExtraScopeManifest } from '../setup/extra-scopes.js';
import { isKnownLarkUserScope } from '../utils/lark-scope-catalog.js';
import { expandHomePath } from '../utils/working-dir.js';

const cachedUserScopes = new Map<string, { revision: string; scopes: ReadonlySet<string> }>();

function configuredExtraScopesFile(bot: Pick<BotConfig, 'larkAppId' | 'extraScopesFile'>): string | undefined {
  try {
    // `setup configure` updates bots.json without restarting an online daemon.
    const live = loadBotConfigsCached().find(configured => configured.larkAppId === bot.larkAppId);
    if (live) return live.extraScopesFile;
  } catch {
    // Retain the running bot's configuration while the file is unavailable.
  }
  return bot.extraScopesFile;
}

async function loadExtraUserScopes(path: string | undefined): Promise<ReadonlySet<string> | undefined> {
  if (typeof path !== 'string' || !path.trim()) return undefined;
  const expanded = expandHomePath(path.trim());
  // Like setup configure, a recorded path must not depend on the daemon's cwd.
  if (!isAbsolute(expanded)) return undefined;
  const filePath = resolve(expanded);
  try {
    const file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (stat.isFile()) {
        const revision = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        const cached = cachedUserScopes.get(filePath);
        if (cached?.revision === revision) return cached.scopes;
        const manifest = parseExtraScopeManifest(await file.readFile('utf8'));
        const scopes = new Set(manifest.scopes.user);
        cachedUserScopes.set(filePath, { revision, scopes });
        return scopes;
      }
    } finally {
      await file.close();
    }
  } catch {
    // A missing or invalid file leaves the built-in name validation usable.
  }
  cachedUserScopes.delete(filePath);
  return undefined;
}

/** Validate scope names against the built-in catalog and this bot's declarations. */
export async function unknownLarkUserScopes(
  requested: readonly string[],
  options: { bot: Pick<BotConfig, 'larkAppId' | 'extraScopesFile'>; allowUnknown?: boolean },
): Promise<string[]> {
  const unknown = requested.filter(scope => !isKnownLarkUserScope(scope, options));
  if (!unknown.length) return unknown;
  const extraScopes = await loadExtraUserScopes(configuredExtraScopesFile(options.bot));
  return extraScopes ? unknown.filter(scope => !extraScopes.has(scope)) : unknown;
}
