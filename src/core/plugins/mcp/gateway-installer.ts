import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import type { CliAdapter, McpGatewayInstallSpec } from '../../../adapters/cli/types.js';
import { atomicWriteFileSync } from '../../../utils/atomic-write.js';
import { withFileLockSync } from '../../../utils/file-lock.js';
import { expandHomePath } from '../../../utils/working-dir.js';
import { readPluginRegistry } from '../../../services/plugin-registry-store.js';
import { readMaterializedPlugin } from '../materializer.js';
import { readGlobalConfig } from '../../../global-config.js';
import {
  MCP_GATEWAY_FORWARDED_ENV_KEYS,
  MCP_GATEWAY_INSTALL_ENTRY_ENV,
  MCP_GATEWAY_OWNER_ENV,
  MCP_GATEWAY_REQUIRED_ENV,
} from './environment.js';
import { effectiveMcpGatewayMaxToolTimeoutMs } from './runtime-options.js';

const GATEWAY_START = '# >>> botmux mcp gateway';
const GATEWAY_END = '# <<< botmux mcp gateway';

export interface GatewayEntryReport {
  cliId: string;
  state: 'installed' | 'unchanged' | 'configured' | 'removed' | 'absent' | 'adapter-required';
  configPath?: string;
  warning?: string;
}

export interface GatewayEntry {
  command: string;
  args: string[];
  maxToolTimeoutMs?: number;
}

export function defaultGatewayEntry(): GatewayEntry {
  // Canonicalize $HOME: on a symlinked-home host (/home/u → /data00/home/u) the
  // lexical path is written into the CLI's MCP config, but the file sandbox binds
  // only CANONICAL exec dirs — the lexical /home/u prefix doesn't exist in the
  // bwrap root, so codex/opencode's `botmux mcp serve` launch fails with
  // "No such file or directory" and MCP startup aborts. realpath the home root
  // so the command path lands on a bound dir. Same file off-sandbox, so it's a
  // safe no-op on non-symlinked hosts.
  let home = homedir();
  try { home = realpathSync(home); } catch { /* keep lexical if unresolvable */ }
  return {
    command: process.env.BOTMUX_BIN_PATH ?? join(home, '.botmux', 'bin', 'botmux'),
    args: ['mcp', 'serve'],
    maxToolTimeoutMs: effectiveMcpGatewayMaxToolTimeoutMs(readGlobalConfig().mcpGatewayMaxToolTimeoutMs),
  };
}

function dropMarkerLines(text: string, ...markers: string[]): string {
  // TOML editors can insert unrelated tables (e.g. hooks.state) before the
  // trailing end comment. Markers are not ownership boundaries: remove only the
  // marker lines, then let stripCodexTables remove our MCP tables by name.
  const ownedMarkers = new Set(markers);
  return text.split(/\r?\n/)
    .filter(line => !ownedMarkers.has(line.trim()))
    .join('\n');
}

function stripLegacyPluginBlocks(text: string): string {
  const start = /^\s*# >>> botmux plugin ([a-z][a-z0-9._-]{0,63})\s*$/m;
  let next = text;
  while (true) {
    const match = start.exec(next);
    if (!match || match.index === undefined) break;
    const end = `# <<< botmux plugin ${match[1]}`;
    const endIdx = next.indexOf(end, match.index + match[0].length);
    if (endIdx < 0) break;
    let after = endIdx + end.length;
    if (next.slice(after, after + 2) === '\r\n') after += 2;
    else if (next[after] === '\n') after += 1;
    next = `${next.slice(0, match.index)}${next.slice(after)}`;
  }
  return next;
}

// Returns the dotted path between the brackets of a `[table]` header, with
// quote characters preserved, or null for anything that is not a plain table
// header attributable by name. Bracket-aware: a `]` inside a quoted key
// (`[hooks.state."/tmp/we]ird:stop:0:0"]`) must not terminate the header, and
// `[[array-of-tables]]` is reported as null — it is never our MCP table, and
// treating it as "not a header" would let the section skipper stay latched on
// across it and eat every table below.
function parseTomlTableHeader(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[') || trimmed.startsWith('[[')) return null;
  let i = 1;
  let name = '';
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      name += ch;
      i += 1;
      while (i < trimmed.length && trimmed[i] !== quote) {
        if (quote === '"' && trimmed[i] === '\\' && i + 1 < trimmed.length) {
          name += trimmed.slice(i, i + 2);
          i += 2;
          continue;
        }
        name += trimmed[i];
        i += 1;
      }
      if (i >= trimmed.length) return null;
      name += trimmed[i];
      i += 1;
      continue;
    }
    if (ch === ']') break;
    name += ch;
    i += 1;
  }
  if (trimmed[i] !== ']') return null;
  const rest = trimmed.slice(i + 1).trim();
  if (rest && !rest.startsWith('#')) return null;
  return name;
}

// Splits the dotted path of a table header into its unquoted segments
// (`mcp_servers."my server".env` -> ['mcp_servers', 'my server', 'env']).
function parseTomlDottedKey(raw: string): string[] | null {
  const segments: string[] = [];
  let segment = '';
  let haveSegment = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"' || ch === "'") {
      haveSegment = true;
      i += 1;
      while (i < raw.length && raw[i] !== ch) {
        if (ch === '"' && raw[i] === '\\' && i + 1 < raw.length) {
          segment += (raw[i + 1] === '"' || raw[i + 1] === '\\') ? raw[i + 1] : raw.slice(i, i + 2);
          i += 2;
          continue;
        }
        segment += raw[i];
        i += 1;
      }
      if (i >= raw.length) return null;
      i += 1;
      continue;
    }
    if (ch === '.') {
      if (!haveSegment) return null;
      segments.push(segment);
      segment = '';
      haveSegment = false;
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') { i += 1; continue; }
    haveSegment = true;
    segment += ch;
    i += 1;
  }
  if (!haveSegment) return null;
  segments.push(segment);
  return segments;
}

// Name of the server in an `[mcp_servers.<name>...]` header (accepts bare,
// double- and single-quoted keys), or null for any other header.
function codexMcpServerName(header: string): string | null {
  const segments = parseTomlDottedKey(header);
  if (!segments || segments.length < 2 || segments[0] !== 'mcp_servers') return null;
  return segments[1];
}

function isBotmuxMcpSection(header: string): boolean {
  return codexMcpServerName(header) === 'botmux';
}

function hasCodexBotmuxTable(text: string): boolean {
  return text.split(/\r?\n/).some(line => {
    const header = parseTomlTableHeader(line);
    return header !== null && isBotmuxMcpSection(header) && parseTomlDottedKey(header)!.length === 2;
  });
}

// TraeX/CoCo rewrite their shared config wholesale: key order, number literals
// (600 -> 600.0) and our marker comments change while the tables survive.
function sameCodexToml(a: string, b: string): boolean {
  try {
    return isDeepStrictEqual(parseToml(a), parseToml(b));
  } catch {
    return false;
  }
}

// Removes every table whose header matches `isOwned`. Blank lines and comments
// trailing a removed table are buffered and kept: they introduce the NEXT table
// (or the document), not the table we own. Attributing them to the removed
// table would silently delete user comments and leave the skipper latched on
// across array-of-tables / keys containing `]` in tables below.
function stripCodexTables(text: string, isOwned: (header: string) => boolean): string {
  const kept: string[] = [];
  const pending: string[] = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      const header = parseTomlTableHeader(line);
      skipping = header !== null && isOwned(header);
      if (!skipping) kept.push(...pending);
      pending.length = 0;
    }
    if (skipping) {
      if (trimmed === '' || trimmed.startsWith('#')) pending.push(line);
      continue;
    }
    kept.push(line);
  }
  kept.push(...pending);
  return kept.join('\n');
}

function stripCodexBotmuxSections(text: string): string {
  return stripCodexTables(text, isBotmuxMcpSection).replace(/\n{3,}/g, '\n\n').trim();
}

function stripCodexNamedMcpSections(text: string, names: ReadonlySet<string>): string {
  if (names.size === 0) return text;
  return stripCodexTables(text, header => {
    const name = codexMcpServerName(header);
    return name !== null && names.has(name);
  });
}

function legacyMaterializedCodexNames(): Set<string> {
  const names = new Set<string>();
  try {
    for (const pluginId of Object.keys(readPluginRegistry().plugins)) {
      for (const entry of readMaterializedPlugin(pluginId)?.mcp ?? []) {
        if (entry.cliId === 'codex') names.add(entry.name);
      }
    }
  } catch {
    // Migration cleanup is best-effort; the stable gateway entry still wins.
  }
  return names;
}

function renderCodexEntry(entry: GatewayEntry): string {
  return [
    GATEWAY_START,
    '[mcp_servers.botmux]',
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map(value => JSON.stringify(value)).join(', ')}]`,
    // The Gateway applies the tighter per-plugin value. Codex needs a matching
    // outer ceiling so a valid long-running downstream call is not aborted by
    // its default MCP timeout before the Gateway can return the result.
    `tool_timeout_sec = ${Math.ceil(effectiveMcpGatewayMaxToolTimeoutMs(entry.maxToolTimeoutMs) / 1_000)}`,
    `env_vars = [${MCP_GATEWAY_FORWARDED_ENV_KEYS.map(value => JSON.stringify(value)).join(', ')}]`,
    GATEWAY_END,
  ].join('\n');
}

function ensureCodexEntry(path: string, entry: GatewayEntry): boolean {
  const current = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const withoutOwned = dropMarkerLines(stripLegacyPluginBlocks(current), GATEWAY_START, GATEWAY_END);
  const withoutLegacy = stripCodexNamedMcpSections(withoutOwned, legacyMaterializedCodexNames());
  const cleaned = stripCodexBotmuxSections(withoutLegacy);
  const next = `${[cleaned, renderCodexEntry(entry)].filter(Boolean).join('\n\n')}\n`;
  if (next === current || sameCodexToml(next, current)) return false;
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, next, { mode: 0o600 });
  return true;
}

interface JsonConfigSnapshot {
  data: Record<string, unknown>;
  /** Undefined means the file did not exist when this snapshot was read. */
  raw: string | undefined;
}

function readJsonConfigSnapshot(path: string, allowEmpty = false): JsonConfigSnapshot {
  if (!existsSync(path)) return { data: {}, raw: undefined };
  const raw = readFileSync(path, 'utf-8');
  const text = raw.replace(/^\uFEFF/, '');
  if (allowEmpty && text.trim() === '') return { data: {}, raw };
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_cli_mcp_json_config');
  return { data: parsed as Record<string, unknown>, raw };
}

function parseJsonConfig(path: string, allowEmpty = false): Record<string, unknown> {
  return readJsonConfigSnapshot(path, allowEmpty).data;
}

function gatewayJsonValue(entry: GatewayEntry): Record<string, unknown> {
  return {
    type: 'stdio',
    command: entry.command,
    args: entry.args,
    timeout: effectiveMcpGatewayMaxToolTimeoutMs(entry.maxToolTimeoutMs),
    env: {
      [MCP_GATEWAY_OWNER_ENV]: '1',
      // Claude expands these from the owning CLI process when it starts the
      // stdio relay. Empty defaults keep standalone Claude runs valid.
      ...Object.fromEntries(MCP_GATEWAY_FORWARDED_ENV_KEYS.map(key => [key, `\${${key}:-}`])),
    },
  };
}

function antigravityGatewayJsonValue(entry: GatewayEntry): Record<string, unknown> {
  return {
    args: entry.args,
    command: entry.command,
    disabled: false,
    env: {
      // agy inherits the owning CLI process env into stdio MCP servers and does
      // not expand `${VAR:-}` literals in mcp_config.json, so forwarded session
      // and socket keys must not be shadowed by placeholder strings here.
      [MCP_GATEWAY_OWNER_ENV]: '1',
    },
    timeoutSeconds: Math.ceil(effectiveMcpGatewayMaxToolTimeoutMs(entry.maxToolTimeoutMs) / 1_000),
  };
}

function ensureClaudeEntry(path: string, entry: GatewayEntry): boolean {
  const data = parseJsonConfig(path);
  const servers = data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)
    ? data.mcpServers as Record<string, unknown>
    : {};
  const desired = gatewayJsonValue(entry);
  if (JSON.stringify(servers.botmux) === JSON.stringify(desired)) return false;
  data.mcpServers = { ...servers, botmux: desired };
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  return true;
}

function antigravityServers(data: Record<string, unknown>): Record<string, unknown> {
  if (data.mcpServers !== undefined && (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers))) {
    throw new Error('invalid_cli_mcp_json_config');
  }
  return (data.mcpServers as Record<string, unknown> | undefined) ?? {};
}

function ensureAntigravityEntry(path: string, entry: GatewayEntry): boolean {
  // agy's initial migration creates a 0-byte `~/.gemini/config/mcp_config.json`
  // that `agy mcp list/add` itself treats as empty `{}`; accept whitespace-only
  // files while still rejecting malformed non-empty JSON or non-object servers.
  const desired = antigravityGatewayJsonValue(entry);
  // agy rewrites the whole file too and does not participate in Botmux's lock.
  // Discard a stale merge when the pre-rename read observes an external write;
  // after bounded conflicts, warn without overwriting the user's latest file.
  // This is BEST-EFFORT, not no-clobber CAS: an agy rename landing after the
  // final comparison can still be replaced (concurrent agy writers race the
  // same way). A strict guarantee requires a shared writer/locking protocol.
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = readJsonConfigSnapshot(path, true);
    const servers = antigravityServers(before.data);
    if (isDeepStrictEqual(servers.botmux, desired)) return false;
    const next = {
      ...before.data,
      mcpServers: { ...servers, botmux: desired },
    };
    const beforeWrite = readJsonConfigSnapshot(path, true);
    antigravityServers(beforeWrite.data);
    if (beforeWrite.raw !== before.raw) continue;
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return true;
  }
  throw new Error('cli_mcp_json_config_changed');
}

function isOwnedJsonEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const env = (value as Record<string, unknown>).env;
  return !!env && typeof env === 'object' && !Array.isArray(env)
    && (env as Record<string, unknown>)[MCP_GATEWAY_OWNER_ENV] === '1';
}

function isOwnedAntigravityEntry(value: unknown): boolean {
  return isOwnedJsonEntry(value) && (value as Record<string, unknown>).disabled !== true;
}

function configPath(spec: McpGatewayInstallSpec): string {
  return expandHomePath(spec.configPath);
}

export function ensureGatewayEntry(
  adapter: Pick<CliAdapter, 'id' | 'mcpGateway'>,
  entry: GatewayEntry = defaultGatewayEntry(),
): GatewayEntryReport {
  const spec = adapter.mcpGateway;
  if (!spec) return { cliId: adapter.id, state: 'adapter-required' };
  const path = configPath(spec);
  try {
    let changed: boolean;
    switch (spec.format) {
      case 'codex-toml':
        changed = ensureCodexEntry(path, entry);
        break;
      case 'claude-json':
        changed = ensureClaudeEntry(path, entry);
        break;
      case 'antigravity-json':
        changed = ensureAntigravityEntry(path, entry);
        break;
      default: {
        const _exhaustive: never = spec.format;
        throw new Error(`unsupported_mcp_gateway_format:${String(_exhaustive)}`);
      }
    }
    return { cliId: adapter.id, state: changed ? 'installed' : 'unchanged', configPath: path };
  } catch (err) {
    return {
      cliId: adapter.id,
      state: 'adapter-required',
      configPath: path,
      warning: err instanceof Error ? err.message : String(err),
    };
  }
}

export function inspectGatewayEntry(
  adapter: Pick<CliAdapter, 'id' | 'mcpGateway'>,
): GatewayEntryReport {
  const spec = adapter.mcpGateway;
  if (!spec) return { cliId: adapter.id, state: 'adapter-required' };
  const path = configPath(spec);
  try {
    if (!existsSync(path)) return { cliId: adapter.id, state: 'absent', configPath: path };
    let configured: boolean;
    switch (spec.format) {
      case 'codex-toml':
        configured = hasCodexBotmuxTable(readFileSync(path, 'utf-8'));
        break;
      case 'claude-json': {
        const data = parseJsonConfig(path);
        const servers = data.mcpServers;
        configured = !!servers && typeof servers === 'object' && !Array.isArray(servers)
          && isOwnedJsonEntry((servers as Record<string, unknown>).botmux);
        break;
      }
      case 'antigravity-json': {
        const data = parseJsonConfig(path, true);
        const servers = antigravityServers(data);
        configured = isOwnedAntigravityEntry(servers.botmux);
        break;
      }
      default: {
        const _exhaustive: never = spec.format;
        throw new Error(`unsupported_mcp_gateway_format:${String(_exhaustive)}`);
      }
    }
    return { cliId: adapter.id, state: configured ? 'configured' : 'absent', configPath: path };
  } catch (err) {
    return {
      cliId: adapter.id,
      state: 'adapter-required',
      configPath: path,
      warning: err instanceof Error ? err.message : String(err),
    };
  }
}

function canonicalOrResolved(path: string): string {
  const resolved = resolve(path);
  try { return realpathSync(resolved); } catch { return resolved; }
}

export function shouldEnsureAntigravityGatewayOnSpawn(input: {
  transport: 'terminal' | 'acp' | undefined;
  willReattachPersistent: boolean;
  runtimeEntryCount: number | undefined;
}): boolean {
  // A terminal agy survives a warm reattach and keeps its already-read config.
  // An ACP runner instead spawns a fresh agy for every turn, which reads it again.
  return (input.runtimeEntryCount ?? 0) > 0
    && (!input.willReattachPersistent || input.transport === 'acp');
}

function frozenAcpGatewayEntry(env: NodeJS.ProcessEnv): GatewayEntry {
  try {
    const raw = env[MCP_GATEWAY_INSTALL_ENTRY_ENV];
    if (!raw) return defaultGatewayEntry();
    const parsed = JSON.parse(raw) as Partial<GatewayEntry>;
    if (typeof parsed.command !== 'string' || !parsed.command
      || !Array.isArray(parsed.args) || !parsed.args.every(arg => typeof arg === 'string')) {
      return defaultGatewayEntry();
    }
    return {
      command: parsed.command,
      args: [...parsed.args],
      maxToolTimeoutMs: effectiveMcpGatewayMaxToolTimeoutMs(parsed.maxToolTimeoutMs),
    };
  } catch {
    return defaultGatewayEntry();
  }
}

export function ensureAntigravityGatewayForAcpTurn(
  adapter: Pick<CliAdapter, 'id' | 'mcpGateway'>,
  effectiveHome: string | undefined,
  env: NodeJS.ProcessEnv,
  entry?: GatewayEntry,
): GatewayEntryReport | undefined {
  // REQUIRED is worker-injected only while this session has a live MCP host.
  // Do not refresh the runner's frozen manifest/catalog, and do not touch a
  // standalone ACP runner's config when this session has no plugin MCP entries.
  if (env[MCP_GATEWAY_REQUIRED_ENV] !== '1') return undefined;
  const desiredEntry = entry ?? frozenAcpGatewayEntry(env);
  return ensureEffectiveHomeGatewayEntry(adapter, effectiveHome, desiredEntry)
    ?? ensureGatewayEntry(adapter, desiredEntry);
}

/**
 * When a bot overrides `HOME` via per-bot env, CLIs whose global MCP config
 * lives under `$HOME` (`antigravity-json`) read `<effectiveHome>/...` instead
 * of the daemon's own `homedir()`. Ensure that relocated config before spawn;
 * return `undefined` when no relocation applies.
 */
export function ensureEffectiveHomeGatewayEntry(
  adapter: Pick<CliAdapter, 'id' | 'mcpGateway'>,
  effectiveHome: string | undefined,
  entry: GatewayEntry = defaultGatewayEntry(),
): GatewayEntryReport | undefined {
  const spec = adapter.mcpGateway;
  if (
    !spec
    || spec.format !== 'antigravity-json'
    || !effectiveHome?.trim()
    || !isAbsolute(effectiveHome)
    || !spec.configPath.startsWith('~')
  ) {
    return undefined;
  }
  if (canonicalOrResolved(effectiveHome) === canonicalOrResolved(homedir())) return undefined;
  const relocatedPath = join(effectiveHome, spec.configPath.slice(1));
  try {
    mkdirSync(dirname(relocatedPath), { recursive: true });
    return withFileLockSync(relocatedPath, () => ensureGatewayEntry(
      { id: adapter.id, mcpGateway: { ...spec, configPath: relocatedPath } },
      entry,
    ));
  } catch (err) {
    return {
      cliId: adapter.id,
      state: 'adapter-required',
      configPath: relocatedPath,
      warning: err instanceof Error ? err.message : String(err),
    };
  }
}
