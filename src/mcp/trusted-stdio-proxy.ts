import { TRUSTED_IDENTITY_FIELDS } from '../utils/trusted-mcp.js';

type JsonObject = Record<string, unknown>;

const DATA_AGENT_TOOL_NAMES = new Set([
  'validate_sql_for_user',
  'run_query_for_user',
]);

export function getTrustedDataMcpProxyDiagnostics(env: NodeJS.ProcessEnv = process.env): JsonObject {
  return {
    status: env.BOTMUX_DATA_MCP_PROXY_ENABLED === 'true' ? 'blocked' : 'disabled',
    target: 'data-agent',
    injectTools: Array.from(DATA_AGENT_TOOL_NAMES),
    hiddenSchemaFields: Array.from(TRUSTED_IDENTITY_FIELDS),
    agentVisibleArguments: ['sql', 'datasource'],
    reason: 'trusted identity injection must be provided by a host-owned MCP gateway; per-turn identity files are disabled',
    stdio: {
      clientReadProtocols: ['jsonl', 'content-length'],
      upstreamReadProtocols: ['jsonl', 'content-length'],
      upstreamWriteProtocol: 'jsonl',
      clientResponseProtocol: 'matches-client-request',
    },
    upstream: 'disabled',
    failClosedErrorCodes: ['trusted_identity_gateway_unavailable'],
  };
}

export async function runTrustedDataMcpProxy(): Promise<void> {
  throw new Error('Data MCP identity proxy requires host-owned trusted identity injection and is not available in this stdio proxy');
}
