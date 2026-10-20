import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CliAdapter, McpGatewayInstallSpec } from '../../../adapters/cli/types.js';
import { atomicWriteFileSync } from '../../../utils/atomic-write.js';
import { expandHomePath } from '../../../utils/working-dir.js';
import { readPluginRegistry } from '../../../services/plugin-registry-store.js';
import { readMaterializedPlugin } from '../materializer.js';
import {
  MCP_GATEWAY_FORWARDED_ENV_KEYS,
  MCP_GATEWAY_OWNER_ENV,
} from './environment.js';

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
}

export function defaultGatewayEntry(): GatewayEntry {
  // Canonicalize $HOME: on a symlinked-home host (/home/u → /data00/home/u) the
  // lexical path is written into the CLI's MCP config, but the file sandbox binds
  // only CANONICAL exec dirs — the lexical /home/u prefix doesn't exist in the
  // bwrap root, so codex/gemini's `botmux mcp serve` launch fails with
  // "No such file or directory" and MCP startup aborts. realpath the home root
  // so the command path lands on a bound dir. Same file off-sandbox, so it's a
  // safe no-op on non-symlinked hosts.
  let home = homedir();
  try { home = realpathSync(home); } catch { /* keep lexical if unresolvable */ }
  return {
    command: process.env.BOTMUX_BIN_PATH ?? join(home, '.botmux', 'bin', 'botmux'),
    args: ['mcp', 'serve'],
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
  if (next === current) return false;
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, next, { mode: 0o600 });
  return true;
}

function parseJsonConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf-8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_cli_mcp_json_config');
  return parsed as Record<string, unknown>;
}

function gatewayJsonValue(entry: GatewayEntry): Record<string, unknown> {
  return {
    type: 'stdio',
    command: entry.command,
    args: entry.args,
    env: {
      [MCP_GATEWAY_OWNER_ENV]: '1',
      // Claude expands these from the owning CLI process when it starts the
      // stdio relay. Empty defaults keep standalone Claude runs valid.
      ...Object.fromEntries(MCP_GATEWAY_FORWARDED_ENV_KEYS.map(key => [key, `\${${key}:-}`])),
    },
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

function removeCodexEntry(path: string): boolean {
  if (!existsSync(path)) return false;
  const current = readFileSync(path, 'utf-8');
  const nextBody = stripCodexBotmuxSections(dropMarkerLines(current, GATEWAY_START, GATEWAY_END));
  const next = nextBody ? `${nextBody}\n` : '';
  if (next === current) return false;
  atomicWriteFileSync(path, next, { mode: 0o600 });
  return true;
}

function isOwnedJsonEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const env = (value as Record<string, unknown>).env;
  return !!env && typeof env === 'object' && !Array.isArray(env)
    && (env as Record<string, unknown>)[MCP_GATEWAY_OWNER_ENV] === '1';
}

function removeClaudeEntry(path: string): boolean {
  if (!existsSync(path)) return false;
  const data = parseJsonConfig(path);
  if (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)) return false;
  const servers = data.mcpServers as Record<string, unknown>;
  if (!isOwnedJsonEntry(servers.botmux)) return false;
  delete servers.botmux;
  data.mcpServers = servers;
  atomicWriteFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  return true;
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
    const changed = spec.format === 'codex-toml'
      ? ensureCodexEntry(path, entry)
      : ensureClaudeEntry(path, entry);
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

export function removeGatewayEntry(
  adapter: Pick<CliAdapter, 'id' | 'mcpGateway'>,
): GatewayEntryReport {
  const spec = adapter.mcpGateway;
  if (!spec) return { cliId: adapter.id, state: 'adapter-required' };
  const path = configPath(spec);
  try {
    const removed = spec.format === 'codex-toml' ? removeCodexEntry(path) : removeClaudeEntry(path);
    return { cliId: adapter.id, state: removed ? 'removed' : 'absent', configPath: path };
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
    const configured = spec.format === 'codex-toml'
      ? (() => {
          const text = readFileSync(path, 'utf-8');
          return text.includes(GATEWAY_START) && /\[mcp_servers\.(?:botmux|"botmux")\]/.test(text);
        })()
      : (() => {
          const data = parseJsonConfig(path);
          const servers = data.mcpServers;
          return !!servers && typeof servers === 'object' && !Array.isArray(servers)
            && isOwnedJsonEntry((servers as Record<string, unknown>).botmux);
        })();
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
