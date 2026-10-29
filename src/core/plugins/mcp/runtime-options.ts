/** Default host-wide ceiling. Kept at the former fixed value for compatibility. */
export const DEFAULT_MCP_GATEWAY_MAX_TOOL_TIMEOUT_MS = 10 * 60 * 1_000;
/** Largest delay supported by Node timers without overflow/coercion. */
export const ABSOLUTE_MAX_MCP_GATEWAY_TOOL_TIMEOUT_MS = 2_147_483_647;

export interface PluginMcpRuntimeOptions {
  env?: Record<string, string>;
  toolTimeoutMs?: number;
}

export function normalizeMcpGatewayMaxToolTimeoutMs(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value > 0
    && value <= ABSOLUTE_MAX_MCP_GATEWAY_TOOL_TIMEOUT_MS
    ? value
    : undefined;
}

export function effectiveMcpGatewayMaxToolTimeoutMs(value: unknown): number {
  return normalizeMcpGatewayMaxToolTimeoutMs(value) ?? DEFAULT_MCP_GATEWAY_MAX_TOOL_TIMEOUT_MS;
}

export function pluginMcpToolTimeoutOptions(toolTimeoutMs?: number): {
  timeout?: number;
  maxTotalTimeout?: number;
} {
  return toolTimeoutMs === undefined
    ? {}
    : { timeout: toolTimeoutMs, maxTotalTimeout: toolTimeoutMs };
}
