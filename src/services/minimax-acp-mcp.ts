import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { logger } from '../utils/logger.js';

type StringPair = { name: string; value: string };
type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: StringPair[] }
  | { name: string; type: 'http' | 'sse'; url: string; headers: StringPair[] };
type Source = 'account' | 'project';
type Entry = { source: Source; value: unknown };

// Match mcode's project-config bound; do not block on FIFOs or read arbitrary
// amounts of data in a long-lived runner. Account files use the same bound.
const MAX_CONFIG_BYTES = 1024 * 1024;
const RESERVED_NAMES = new Set(['matrix', 'nd', 'cu', '__proto__', 'constructor', 'prototype']);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

class InvalidConfig extends Error {}

function warn(source: Source, reason: string, name?: string): void {
  // Never include parser/native exception messages, URLs, commands or values:
  // these can contain MCP credentials, including invalid JSON fragments.
  logger.warn(`[minimax-mcp] ${source} config${name === undefined ? '' : ` server ${JSON.stringify(name)}`}: ${reason}`);
}

function readServers(path: string, source: Source, cwd: string): Record<string, unknown> {
  let fd: number | undefined;
  try {
    if (source === 'project') {
      const root = realpathSync(cwd);
      path = realpathSync(path);
      const fromRoot = relative(root, path);
      if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
        throw new InvalidConfig('path_outside_workspace');
      }
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK
      | (source === 'project' ? constants.O_NOFOLLOW ?? 0 : 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new InvalidConfig('invalid_file');
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let size = 0;
    for (;;) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
      if (size > MAX_CONFIG_BYTES) throw new InvalidConfig('invalid_file');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(buffer.subarray(0, size).toString('utf8')); }
    catch { throw new InvalidConfig('invalid_json'); }
    if (!record(parsed) || (parsed.mcpServers !== undefined && !record(parsed.mcpServers))) {
      throw new InvalidConfig('invalid_mcp_servers');
    }
    return (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(source, error instanceof InvalidConfig ? error.message : 'read_failed');
    }
    return {};
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function text(value: unknown, source: Source, env: NodeJS.ProcessEnv): string {
  if (typeof value !== 'string') throw new InvalidConfig('non_string_value');
  // mcode expands variables in project .mcp.json, while its account store
  // contains literal values. Use this bot's frozen environment, not host env.
  if (source === 'account') return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu, (_match, key: string, fallback: string | undefined) => {
    const resolved = env[key] ?? fallback;
    if (resolved === undefined) throw new InvalidConfig('missing_environment_variable');
    return resolved;
  });
}

function pairs(value: unknown, source: Source, env: NodeJS.ProcessEnv): StringPair[] {
  if (value === undefined) return [];
  if (!record(value)) throw new InvalidConfig('invalid_string_map');
  return Object.entries(value).map(([name, item]) => ({ name, value: text(item, source, env) }));
}

function convert(name: string, { source, value }: Entry, env: NodeJS.ProcessEnv,
  capabilities: { http?: boolean; sse?: boolean } | undefined): AcpMcpServer | undefined {
  if (!name.trim() || RESERVED_NAMES.has(name)) throw new InvalidConfig('reserved_or_empty_name');
  if (!record(value)) throw new InvalidConfig('invalid_server');
  if (value.enabled === false || (source === 'account' && (value.configured === false || value.builtin === true))) return;
  // ACP has no fields for these native options. A session overlay would hide
  // the original entry, losing OAuth/token resolution, timeouts or tool policy.
  // Keep such entries in mcode's own file-backed configuration instead.
  if (['auth', 'timeout', 'metadata', 'tools', 'description'].some(key => value[key] !== undefined)) {
    throw new InvalidConfig('native_only_options');
  }
  const type = value.type ?? (value.command ? 'stdio' : 'http');
  if (type === 'stdio') {
    const command = text(value.command, source, env);
    if (!command.trim()) throw new InvalidConfig('empty_command');
    const args = value.args ?? [];
    if (!Array.isArray(args)) throw new InvalidConfig('invalid_args');
    return { name, command, args: args.map(arg => text(arg, source, env)), env: pairs(value.env, source, env) };
  }
  if (type !== 'http' && type !== 'streamable-http' && type !== 'sse') throw new InvalidConfig('unsupported_transport');
  const transport = type === 'sse' ? 'sse' : 'http';
  if (capabilities?.[transport] !== true) throw new InvalidConfig('transport_not_advertised');
  const url = text(value.url, source, env);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new InvalidConfig('invalid_url'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new InvalidConfig('invalid_url');
  const headers = pairs(value.headers, source, env);
  // Native project MCP strips every configured header on cross-origin
  // redirects. ACP cannot express that policy; do not replace it with the
  // less restrictive session transport (which only has URL and headers).
  if (source === 'project' && headers.length) throw new InvalidConfig('native_only_project_headers');
  return { name, type: transport, url, headers };
}

/** Read the current bot's MCP connection definitions for one ACP attachment. */
export function loadAcpMcpServers(options: {
  cwd: string;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  capabilities?: { http?: boolean; sse?: boolean };
}): AcpMcpServer[] {
  const merged = new Map<string, Entry>();
  for (const [source, path] of [
    ['account', join(options.dataDir, 'mcp.json')],
    ['project', join(options.cwd, '.mcp.json')],
  ] as const) {
    for (const [name, value] of Object.entries(readServers(path, source, options.cwd))) merged.set(name, { source, value });
  }
  const servers: AcpMcpServer[] = [];
  for (const [name, entry] of merged) {
    try {
      const server = convert(name, entry, options.env, options.capabilities);
      if (server) servers.push(server);
    } catch (error) {
      warn(entry.source, error instanceof InvalidConfig ? error.message : 'invalid_server', name);
    }
  }
  return servers;
}
