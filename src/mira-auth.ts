import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type JsonObject = Record<string, any>;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function runSqliteCookieQuery(dbPath: string): string {
  const sql = [
    "select name || '=' || value",
    'from cookies',
    "where value != ''",
    "  and (host_key = 'mira.bytedance.com' or host_key = '.mira.bytedance.com' or host_key like '%.mira.bytedance.com')",
    "order by case when name = 'mira_session' then 0 else 1 end",
  ].join(' ');
  return execFileSync('sqlite3', [dbPath, sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
  });
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function defaultCookieDbCandidates(): string[] {
  const home = homedir();
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  return uniqueStrings([
    // macOS Mira.app / Electron default used by the original runner.
    join(home, 'Library', 'Application Support', 'mira', 'Cookies'),
    // Linux XDG config locations. Some Electron apps preserve the package name
    // casing, and Chromium-based profiles may put cookies under Default/.
    join(xdgConfigHome, 'mira', 'Cookies'),
    join(xdgConfigHome, 'Mira', 'Cookies'),
    join(xdgConfigHome, 'mira', 'Default', 'Cookies'),
    join(xdgConfigHome, 'Mira', 'Default', 'Cookies'),
  ]);
}

function cookieDbCandidates(): string[] {
  const explicitPath = process.env.MIRA_COOKIE_DB?.trim();
  if (explicitPath) return [explicitPath];
  return defaultCookieDbCandidates();
}

function miraConfigCandidates(): string[] {
  const explicitPath = process.env.MIRA_CONFIG?.trim();
  if (explicitPath) return [explicitPath];
  return [join(homedir(), '.mira', 'config.json')];
}

function formatCookieDbNotFoundMessage(configPaths: string[], dbCandidates: string[]): string {
  const configSearched = configPaths.length > 0 ? configPaths.join(', ') : '(none)';
  const dbSearched = dbCandidates.length > 0 ? dbCandidates.join(', ') : '(none)';
  return [
    'Mira cookie was not found.',
    `Checked devbox config: ${configSearched}.`,
    `Checked cookie DB paths: ${dbSearched}.`,
    'Set MIRA_COOKIE_HEADER, MIRA_SESSION, MIRA_CONFIG, or MIRA_COOKIE_DB.',
  ].join(' ');
}

function trimNonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function headerFromCookiePairs(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const pairs = value
    .map((item) => {
      if (!item || typeof item !== 'object') return undefined;
      const obj = item as JsonObject;
      const name = trimNonEmpty(obj.name);
      const cookieValue = trimNonEmpty(obj.value);
      if (!name || !cookieValue) return undefined;
      return `${name}=${cookieValue}`;
    })
    .filter((item): item is string => !!item);
  return pairs.some(pair => pair.startsWith('mira_session=')) ? pairs.join('; ') : undefined;
}

function findStringByKey(value: unknown, keys: Set<string>): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKey(item, keys);
      if (found) return found;
    }
    return undefined;
  }
  const obj = value as JsonObject;
  for (const [key, child] of Object.entries(obj)) {
    if (keys.has(key.toLowerCase())) {
      const str = trimNonEmpty(child);
      if (str) return str;
    }
  }
  for (const child of Object.values(obj)) {
    const found = findStringByKey(child, keys);
    if (found) return found;
  }
  return undefined;
}

function findCookiePairsByKey(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) return headerFromCookiePairs(value);
  const obj = value as JsonObject;
  for (const [key, child] of Object.entries(obj)) {
    if (['cookies', 'cookiejar', 'cookie_jar'].includes(key.toLowerCase())) {
      const header = headerFromCookiePairs(child);
      if (header) return header;
    }
  }
  for (const child of Object.values(obj)) {
    const header = findCookiePairsByKey(child);
    if (header) return header;
  }
  return undefined;
}

export function cookieHeaderFromMiraConfig(config: unknown): string | undefined {
  const directHeader = findStringByKey(config, new Set([
    'cookie',
    'cookieheader',
    'cookie_header',
    'mira_cookie_header',
    'mira-cookie-header',
    'mira_cookie',
  ]));
  if (directHeader) return directHeader;

  const pairHeader = findCookiePairsByKey(config);
  if (pairHeader) return pairHeader;

  const session = findStringByKey(config, new Set([
    'mira_session',
    'mira-session',
    'mira_session_id',
    'mira-session-id',
  ]));
  if (session) return session.includes('=') ? session : `mira_session=${session}`;

  return undefined;
}

function readMiraConfigCookieHeader(configPaths: string[]): string | undefined {
  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to read Mira config ${configPath}: ${errorMessage(err)}`);
    }
    const header = cookieHeaderFromMiraConfig(parsed);
    if (header) return header;
  }
  return undefined;
}

export function readCookieHeader(): string {
  if (process.env.MIRA_COOKIE_HEADER?.trim()) return process.env.MIRA_COOKIE_HEADER.trim();
  if (process.env.MIRA_SESSION?.trim()) return `mira_session=${process.env.MIRA_SESSION.trim()}`;

  const configPaths = miraConfigCandidates();
  const configCookieHeader = readMiraConfigCookieHeader(configPaths);
  if (configCookieHeader) return configCookieHeader;

  const candidates = cookieDbCandidates();
  const cookieDbPath = candidates.find(path => existsSync(path));
  if (!cookieDbPath) throw new Error(formatCookieDbNotFoundMessage(configPaths, candidates));

  let output: string;
  try {
    output = runSqliteCookieQuery(cookieDbPath);
  } catch (err: any) {
    const detail = err?.stderr ? String(err.stderr).trim() : errorMessage(err);
    throw new Error(`Failed to read Mira cookies via sqlite3 from ${cookieDbPath}: ${detail}`);
  }

  const cookies = output.split('\n').map(s => s.trim()).filter(Boolean);
  if (!cookies.some(c => c.startsWith('mira_session='))) {
    throw new Error('Mira login cookie mira_session was not found. Set MIRA_COOKIE_HEADER or MIRA_SESSION, or sign in to Mira and set MIRA_COOKIE_DB.');
  }
  return cookies.join('; ');
}
