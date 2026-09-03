/**
 * Persisted record of the Gateway socket path a session's CLI was LAUNCHED
 * with. Written by the worker when it starts a CLI generation whose
 * environment carries `BOTMUX_MCP_GATEWAY_SOCKET`; consulted by the NEXT
 * worker generation (after a daemon restart) to decide whether a surviving
 * persistent pane can be reattached.
 *
 * Reattach is only safe when the pane's relay can reach the replacement host:
 *   - the recorded socket path must equal the deterministic path the new host
 *     will bind (sessionMcpGatewaySocketPath) — a pane launched by an older
 *     build with an mkdtemp-random path can never reconnect and must still be
 *     cold-resumed;
 *   - the record's relay protocol version must be ≥ 2 — version 2 is the
 *     first relay that reconnects after a socket loss (older relays exit on
 *     the first disconnect, so reattaching would strand a dead MCP client).
 *
 * The record lives outside the pane's reach (worker data dir, not session
 * tmpfs) and is cleared whenever a CLI generation launches without a Gateway.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Bumped when the relay's reconnect contract changes incompatibly. */
export const MCP_GATEWAY_RELAY_PROTOCOL_VERSION = 2;

export interface McpGatewayLaunchRecord {
  version: number;
  socketPath: string;
}

export function mcpGatewayLaunchRecordPath(dataDir: string, sessionId: string): string {
  return join(dataDir, 'mcp-gateway-launch', `${sessionId}.json`);
}

export function writeMcpGatewayLaunchRecord(
  dataDir: string,
  sessionId: string,
  socketPath: string,
): void {
  const path = mcpGatewayLaunchRecordPath(dataDir, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const record: McpGatewayLaunchRecord = {
    version: MCP_GATEWAY_RELAY_PROTOCOL_VERSION,
    socketPath,
  };
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function clearMcpGatewayLaunchRecord(dataDir: string, sessionId: string): void {
  rmSync(mcpGatewayLaunchRecordPath(dataDir, sessionId), { force: true });
}

export function readMcpGatewayLaunchRecord(
  dataDir: string,
  sessionId: string,
): McpGatewayLaunchRecord | null {
  let raw: string;
  try {
    raw = readFileSync(mcpGatewayLaunchRecordPath(dataDir, sessionId), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.version === 'number' && typeof parsed?.socketPath === 'string') {
      return { version: parsed.version, socketPath: parsed.socketPath };
    }
  } catch { /* malformed record — treated as absent below */ }
  return null;
}

/** Pure decision: may the worker reattach a surviving persistent pane that
 *  carries plugin MCP state, instead of killing it for a cold-resume? */
export function mcpGatewayPaneReattachSafe(
  record: McpGatewayLaunchRecord | null,
  expectedSocketPath: string,
): boolean {
  return record !== null
    && record.version >= MCP_GATEWAY_RELAY_PROTOCOL_VERSION
    && record.socketPath === expectedSocketPath;
}
