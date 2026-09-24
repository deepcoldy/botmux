/**
 * Detect MCP servers that carry their own credentials.
 *
 * Trigger-user auth works by wrapping the CLI binaries an agent execs. An MCP
 * server that talks to Feishu through its own app id and secret never execs
 * `lark-cli`, so no wrapper sees it and the policy simply does not reach it —
 * the agent can still read and write Feishu under an identity unrelated to the
 * current sender.
 *
 * This module finds those servers so the operator can be told. It deliberately
 * only WARNS:
 *
 *  - Hard-blocking would break legitimate setups. A self-configured Feishu
 *    client has real uses, and botmux does not own it.
 *  - Staying silent would be worse than either: the operator would believe the
 *    boundary is complete. Pretending to cover something is more dangerous than
 *    not covering it.
 *
 * Detection is by declared credential env vars, not by a list of known server
 * names — a name list goes stale the moment someone writes a new server, and
 * "botmux did not recognize it" is not a safety property.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CredentialBearingMcpServer {
  /** Server name as written in the config. */
  name: string;
  /** Which config declared it, for a message the operator can act on. */
  source: string;
  /** Names only — never values. A warning must not itself leak a secret. */
  credentialEnvKeys: string[];
}

/**
 * Env var names that mean "this server authenticates on its own".
 *
 * Matched as substrings so provider-specific spellings are covered without an
 * exhaustive list. `_APP_ID` alone does not qualify: an app id is not a
 * credential, and flagging it would produce noise that trains people to ignore
 * the warning.
 */
const CREDENTIAL_ENV_MARKERS = [
  'APP_SECRET',
  'ACCESS_TOKEN',
  'USER_TOKEN',
  'TENANT_TOKEN',
  'SECRET_KEY',
  'ACCESS_KEY',
  'PRIVATE_KEY',
  'API_KEY',
  'CLIENT_SECRET',
];

function credentialKeysIn(env: Record<string, unknown> | undefined): string[] {
  if (!env || typeof env !== 'object') return [];
  return Object.keys(env).filter(key => {
    const upper = key.toUpperCase();
    return CREDENTIAL_ENV_MARKERS.some(marker => upper.includes(marker));
  });
}

/** Parse Claude-style JSON config (`{"mcpServers": {name: {env: {...}}}}`). */
export function findCredentialBearingMcpInJson(
  raw: string,
  source: string,
): CredentialBearingMcpServer[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const servers = (parsed as { mcpServers?: Record<string, { env?: Record<string, unknown> }> })?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const out: CredentialBearingMcpServer[] = [];
  for (const [name, def] of Object.entries(servers)) {
    const keys = credentialKeysIn(def?.env);
    if (keys.length) out.push({ name, source, credentialEnvKeys: keys });
  }
  return out;
}

/**
 * Parse Codex-style TOML (`[mcp_servers.<name>.env]` blocks).
 *
 * A deliberately small scanner rather than a TOML dependency: we only need
 * "which server declared a credential-shaped key", and being approximate is
 * acceptable here — over-reporting produces one extra advisory line, while a new
 * dependency in the daemon's boot path would not be worth that.
 */
export function findCredentialBearingMcpInToml(
  raw: string,
  source: string,
): CredentialBearingMcpServer[] {
  const found = new Map<string, Set<string>>();
  let currentEnvServer: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    const header = /^\[mcp_servers\.([^.\]]+)(\.[^\]]+)?\]$/.exec(trimmed);
    if (header) {
      // Only an `.env` table can declare credentials; any other sub-table (or
      // the server table itself) ends the current env block.
      currentEnvServer = header[2] === '.env' ? header[1] : null;
      continue;
    }
    if (trimmed.startsWith('[')) { currentEnvServer = null; continue; }
    if (!currentEnvServer) continue;
    const key = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed)?.[1];
    if (!key) continue;
    if (!credentialKeysIn({ [key]: true }).length) continue;
    if (!found.has(currentEnvServer)) found.set(currentEnvServer, new Set());
    found.get(currentEnvServer)!.add(key);
  }
  return [...found].map(([name, keys]) => ({ name, source, credentialEnvKeys: [...keys] }));
}

/** Config files an agent's MCP servers are typically declared in. */
function defaultConfigPaths(home: string): Array<{ path: string; kind: 'json' | 'toml' }> {
  return [
    { path: join(home, '.claude.json'), kind: 'json' },
    { path: join(home, '.codex', 'config.toml'), kind: 'toml' },
  ];
}

/**
 * Scan this machine's agent configs for credential-bearing MCP servers.
 *
 * Best-effort by design: an unreadable or malformed config yields nothing rather
 * than throwing. This runs to produce an advisory, and an advisory that can
 * break a session start is worse than a missing advisory.
 */
export function scanCredentialBearingMcpServers(
  home = homedir(),
  configs = defaultConfigPaths(home),
): CredentialBearingMcpServer[] {
  const out: CredentialBearingMcpServer[] = [];
  for (const { path, kind } of configs) {
    try {
      if (!existsSync(path)) continue;
      const raw = readFileSync(path, 'utf8');
      out.push(...(kind === 'json'
        ? findCredentialBearingMcpInJson(raw, path)
        : findCredentialBearingMcpInToml(raw, path)));
    } catch { /* unreadable config — no advisory from it */ }
  }
  return out;
}

/**
 * The operator-facing advisory, or null when there is nothing to say.
 *
 * Names the servers and where they are declared so the message is actionable,
 * and never includes a credential value — only which keys were seen.
 */
export function credentialBearingMcpAdvisory(
  servers: readonly CredentialBearingMcpServer[],
): string | null {
  if (!servers.length) return null;
  const list = servers.map(s => `${s.name}（${s.source}）`).join('、');
  return `检测到 ${servers.length} 个自带凭证的 MCP server：${list}。`
    + '它们用自己的应用凭证直连，不经过 botmux 包装的 CLI，因此不受「按触发人鉴权」约束——'
    + 'agent 仍可通过它们以与当轮发送者无关的身份读写。'
    + '如需完整隔离，请在对应配置里禁用这些 server。';
}
