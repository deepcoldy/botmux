export const MCP_GATEWAY_OWNER_ENV = 'BOTMUX_MCP_GATEWAY';
export const MCP_GATEWAY_SESSION_ENV = 'BOTMUX_SESSION_ID';
export const MCP_GATEWAY_DATA_DIR_ENV = 'SESSION_DATA_DIR';
export const MCP_GATEWAY_SOCKET_ENV = 'BOTMUX_MCP_GATEWAY_SOCKET';
export const MCP_GATEWAY_REQUIRED_ENV = 'BOTMUX_MCP_GATEWAY_REQUIRED';
/** Non-secret session routing values required by MCP-hosted commands such as
 * `vc-agent request-output`. The rotating authorization capability itself is
 * deliberately NOT an environment variable; it remains in the relay/proof
 * file and the daemon verifies it against the live worker turn. */
export const MCP_GATEWAY_SEND_RELAY_ENV = 'BOTMUX_SEND_RELAY';
export const MCP_GATEWAY_LARK_APP_ENV = 'BOTMUX_LARK_APP_ID';
export const MCP_GATEWAY_DAEMON_IPC_PORT_ENV = 'BOTMUX_DAEMON_IPC_PORT';
export const MCP_GATEWAY_ORIGIN_CHANNEL_ENV = 'BOTMUX_ORIGIN_CHANNEL_ID';

export const MCP_GATEWAY_HANDSHAKE_PREFIX = 'BOTMUX-MCP/1 ';
export const MCP_GATEWAY_HANDSHAKE_OK = 'BOTMUX-MCP/1 OK';
export const MCP_GATEWAY_HANDSHAKE_ERROR = 'BOTMUX-MCP/1 ERROR';

/** Environment copied by CLI-native MCP launchers from the owning Botmux CLI
 * process into the `botmux mcp serve` relay process. */
export const MCP_GATEWAY_FORWARDED_ENV_KEYS = [
  MCP_GATEWAY_SESSION_ENV,
  MCP_GATEWAY_DATA_DIR_ENV,
  MCP_GATEWAY_SOCKET_ENV,
  MCP_GATEWAY_REQUIRED_ENV,
  MCP_GATEWAY_SEND_RELAY_ENV,
  MCP_GATEWAY_LARK_APP_ENV,
  MCP_GATEWAY_DAEMON_IPC_PORT_ENV,
  MCP_GATEWAY_ORIGIN_CHANNEL_ENV,
] as const;
