import { execFileSync } from 'node:child_process';
import {
  constants, copyFileSync, existsSync, lstatSync, mkdirSync,
  readFileSync, realpathSync, statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';
import { withFileLockSync } from '../utils/file-lock.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { t } from '../i18n/index.js';

export type CodexStatusLineSetup =
  | { kind: 'updated' | 'configured'; configPath: string }
  | { kind: 'failed'; configPath?: string };

const DEFAULT_ITEMS = ['model-with-reasoning', 'current-dir', 'thread-name'];
const isId = (item: string): boolean => item === 'session-id' || item === 'thread-id';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');
const decode = (text: string) => parse(text, { integersAsBigInt: 'asNeeded' });

/** Keep comments and unrelated item spelling while moving either ID alias last.
 * The complete TOML document is validated before and after every candidate edit. */
function appendId(array: string, id: string): string {
  const tokens = [...array.matchAll(/#[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'[^']*'|,/g)];
  const removed = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || !/^["']/.test(token[0])) continue;
    const value = decode(`item = ${token[0]}`).item;
    if (typeof value !== 'string' || !isId(value)) continue;
    for (let n = token.index; n < token.index + token[0].length; n++) removed.add(n);
    const following = tokens.slice(i + 1).find(next => !next[0].startsWith('#'));
    const preceding = tokens.slice(0, i).reverse().find(prev => !prev[0].startsWith('#'));
    const comma = following?.[0] === ',' ? following : preceding?.[0] === ',' ? preceding : undefined;
    if (comma) removed.add(comma.index);
  }
  const retained = array.split('').map((char, index) => removed.has(index) ? '' : char).join('');
  const remaining = [...retained.matchAll(/#[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'[^']*'|,/g)]
    .filter(token => !token[0].startsWith('#'));
  const last = remaining.at(-1);
  const at = last ? last.index + last[0].length : 1;
  const addition = last?.[0] === ',' ? ` ${JSON.stringify(id)},`
    : last ? `, ${JSON.stringify(id)}` : JSON.stringify(id);
  return retained.slice(0, at) + addition + retained.slice(at);
}

/** Returns a minimal text edit or refuses an unfamiliar/invalid TOML layout. */
export function codexStatusLineConfigText(source: string): string {
  const before = decode(source);
  const tui = before.tui;
  if (tui !== undefined && !isRecord(tui)) throw new Error('Invalid tui table');
  const original = tui?.status_line;
  if (original !== undefined && !isStrings(original)) throw new Error('Invalid status line');
  const items = original ?? DEFAULT_ITEMS;
  const id = items.find(isId) ?? 'session-id';
  const nextItems = [...items.filter(item => !isId(item)), id];
  if (isDeepStrictEqual(original, nextItems)) return source;
  const expected = decode(source);
  if (isRecord(expected.tui)) expected.tui.status_line = nextItems;
  else expected.tui = decode(`[tui]\nstatus_line = ${JSON.stringify(nextItems)}`).tui;
  const accept = (candidate: string): boolean => {
    try { return isDeepStrictEqual(decode(candidate), expected); } catch { return false; }
  };
  if (original !== undefined) {
    // Also accept a root dotted key. Semantic validation rejects matches inside
    // comments, multiline strings, other tables, and ambiguous duplicate keys.
    for (const match of source.matchAll(/^[\t ]*(?:tui\s*\.\s*)?(?:status_line|"status_line"|'status_line')[\t ]*=[\t ]*\[/gm)) {
      const start = match.index + match[0].length - 1;
      for (let end = source.indexOf(']', start); end >= 0; end = source.indexOf(']', end + 1)) {
        const array = source.slice(start, end + 1);
        try {
          if (!isDeepStrictEqual(decode(`item = ${array}`).item, original)) continue;
          const candidate = source.slice(0, start) + appendId(array, id) + source.slice(end + 1);
          if (accept(candidate)) return candidate;
        } catch { /* Not the end of the array, or an unsupported string spelling. */ }
      }
    }
  } else {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const assignment = `status_line = ${JSON.stringify(nextItems)}${eol}`;
    for (const header of source.matchAll(/^[\t ]*\[[\t ]*(?:tui|"tui"|'tui')[\t ]*\][\t ]*(?:#[^\r\n]*)?(?:\r?\n|$)/gm)) {
      const at = header.index + header[0].length;
      const candidate = source.slice(0, at) + (header[0].endsWith('\n') ? '' : eol) + assignment + source.slice(at);
      if (accept(candidate)) return candidate;
    }
    const candidate = `${source}${source.endsWith('\n') ? '' : eol}[tui]${eol}${assignment}`;
    if (accept(candidate)) return candidate;
  }
  throw new Error('Unsupported status line layout');
}

/** The environment must belong to the observed CLI, not the BotMux worker.
 * Never fall back to the worker's HOME/CODEX_HOME when inspection fails. */
export function codexConfigPathFromProcessEnvironment(raw: string, nulSeparated: boolean): string | undefined {
  const entries = nulSeparated ? raw.split('\0') : raw.split(/ (?=[A-Za-z_][A-Za-z_0-9]*=)/);
  if (['HOME', 'CODEX_HOME'].some(key => entries.filter(entry => entry.startsWith(`${key}=`)).length > 1)) return undefined;
  const get = (key: string): string | undefined => {
    const matches = entries.filter(entry => entry.startsWith(`${key}=`));
    return matches.length === 1 ? matches[0]?.slice(key.length + 1).trim() : undefined;
  };
  const home = get('HOME');
  const configured = get('CODEX_HOME');
  const root = configured === '~' ? home : configured?.startsWith('~/') && home ? join(home, configured.slice(2))
    : configured || (home ? join(home, '.codex') : undefined);
  return root && isAbsolute(root) && !/[\r\n\0]/.test(root) ? join(root, 'config.toml') : undefined;
}

export function codexConfigPathForPid(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === 'linux') {
      return codexConfigPathFromProcessEnvironment(readFileSync(`/proc/${pid}/environ`, 'utf8'), true);
    }
    if (process.platform === 'darwin') {
      const env = execFileSync('ps', ['eww', '-p', String(pid), '-o', 'command='], {
        encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      });
      return codexConfigPathFromProcessEnvironment(env.trimEnd(), false);
    }
  } catch { /* Missing process or inaccessible environment. */ }
  return undefined;
}

export function ensureCodexStatusLineConfig(
  configPath: string,
  { copyFile = copyFileSync }: { copyFile?: typeof copyFileSync } = {},
): CodexStatusLineSetup {
  try {
    // Resolve dotfile symlinks before locking, backing up, or replacing content.
    if (existsSync(configPath) || lstatExists(configPath)) configPath = realpathSync(configPath);
    mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
    configPath = join(realpathSync(dirname(configPath)), basename(configPath));
    return withFileLockSync<CodexStatusLineSetup>(`${configPath}.botmux-statusline`, () => {
      const existed = existsSync(configPath);
      const before = existed ? readFileSync(configPath, 'utf8') : '';
      const after = codexStatusLineConfigText(before);
      if (after === before) return { kind: 'configured', configPath };
      const mode = existed ? statSync(configPath).mode & 0o777 : 0o600;
      if (existed) {
        const backup = `${configPath}.botmux-statusline.bak`;
        try { copyFile(configPath, backup, constants.COPYFILE_EXCL); }
        catch (error) { if (!isRecord(error) || error.code !== 'EEXIST') throw error; }
      }
      // Protect edits made outside BotMux while preparing the patch.
      if (existed !== existsSync(configPath) || (existed && readFileSync(configPath, 'utf8') !== before)) {
        throw new Error('Config changed during preparation');
      }
      atomicWriteFileSync(configPath, after, { mode });
      return { kind: 'updated', configPath };
    }, { maxWaitMs: 250 });
  } catch {
    // Parser / OS errors may embed secrets from the config. Expose no raw error.
    return { kind: 'failed', configPath };
  }
}

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

export function codexStatusLineSetupNotice(setup: CodexStatusLineSetup): string {
  return t(`worker.codex_statusline_${setup.kind}`, { path: setup.configPath ?? t('worker.codex_statusline_unknown_path') });
}
