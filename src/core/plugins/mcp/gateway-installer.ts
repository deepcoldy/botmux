import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CliAdapter, McpGatewayInstallSpec } from '../../../adapters/cli/types.js';
import { atomicWriteFileSync } from '../../../utils/atomic-write.js';
import { expandHomePath } from '../../../utils/working-dir.js';
import { readPluginRegistry } from '../../../services/plugin-registry-store.js';
import { readMaterializedPlugin } from '../materializer.js';

const GATEWAY_START = '# >>> botmux mcp gateway';
const GATEWAY_END = '# <<< botmux mcp gateway';
const GATEWAY_OWNER_ENV = 'BOTMUX_MCP_GATEWAY';

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
  return {
    command: process.env.BOTMUX_BIN_PATH ?? join(homedir(), '.botmux', 'bin', 'botmux'),
    args: ['mcp', 'serve'],
  };
}

function stripCommentBlock(text: string, start: string, end: string): string {
  let next = text;
  while (true) {
    const startIdx = next.indexOf(start);
    if (startIdx < 0) break;
    const endIdx = next.indexOf(end, startIdx);
    if (endIdx < 0) break;
    let after = endIdx + end.length;
    if (next.slice(after, after + 2) === '\r\n') after += 2;
    else if (next[after] === '\n') after += 1;
    next = `${next.slice(0, startIdx)}${next.slice(after)}`;
  }
  return next;
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

function isBotmuxMcpSection(header: string): boolean {
  return /^mcp_servers\.(?:botmux|"botmux")(?:\..+)?$/.test(header.trim());
}

function stripCodexBotmuxSections(text: string): string {
  const kept: string[] = [];
  let skip = false;
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
    if (section) skip = isBotmuxMcpSection(section[1]);
    if (!skip) kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripCodexNamedMcpSections(text: string, names: ReadonlySet<string>): string {
  if (names.size === 0) return text;
  const kept: string[] = [];
  let skip = false;
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
    if (section) {
      const match = section[1].trim().match(/^mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9._-]+))(?:\..+)?$/);
      const name = match?.[1] ?? match?.[2];
      skip = !!name && names.has(name);
    }
    if (!skip) kept.push(line);
  }
  return kept.join('\n');
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
    GATEWAY_END,
  ].join('\n');
}

function ensureCodexEntry(path: string, entry: GatewayEntry): boolean {
  const current = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const withoutOwned = stripCommentBlock(stripLegacyPluginBlocks(current), GATEWAY_START, GATEWAY_END);
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
    env: { [GATEWAY_OWNER_ENV]: '1' },
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
  const nextBody = stripCodexBotmuxSections(stripCommentBlock(current, GATEWAY_START, GATEWAY_END));
  const next = nextBody ? `${nextBody}\n` : '';
  if (next === current) return false;
  atomicWriteFileSync(path, next, { mode: 0o600 });
  return true;
}

function isOwnedJsonEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const env = (value as Record<string, unknown>).env;
  return !!env && typeof env === 'object' && !Array.isArray(env)
    && (env as Record<string, unknown>)[GATEWAY_OWNER_ENV] === '1';
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
