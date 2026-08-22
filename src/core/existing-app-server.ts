/**
 * Validation shared by BotConfig loading and worker launch for the experimental
 * "attach a Codex TUI to an already-running App Server" mode.
 *
 * The endpoint is intentionally local-only. A BotMux configuration must never
 * turn a chat message into a client of an arbitrary network-hosted app-server:
 * credentials, query/hash components, and non-loopback WebSocket hosts are all
 * rejected. Unix sockets are the normal production route for a Codex App
 * Server on the same development machine.
 */

export interface ExistingAppServerConfig {
  endpoint: string;
}

function endpointError(label: string, message: string): Error {
  return new Error(`${label}: ${message}`);
}

/**
 * Return a canonical, safe-to-pass endpoint string or throw a configuration
 * error. The caller deliberately does not probe filesystem/socket liveness:
 * the Codex App may reconnect after BotMux has loaded config, and liveness is a
 * launch-time concern rather than a configuration-time one.
 */
export function normalizeExistingAppServerEndpoint(
  raw: unknown,
  label = 'existingAppServer.endpoint',
): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw endpointError(label, 'must be a non-empty string');
  }
  const endpoint = raw.trim();
  if (/\s/.test(endpoint)) {
    throw endpointError(label, 'must not contain whitespace');
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw endpointError(label, 'must be a valid unix:// or local ws:// URL');
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw endpointError(label, 'must not contain credentials, query parameters, or fragments');
  }

  if (parsed.protocol === 'unix:') {
    if (parsed.hostname || !parsed.pathname.startsWith('/')) {
      throw endpointError(label, 'unix URL must use an absolute socket path (unix:///absolute/path.sock)');
    }
    let socketPath: string;
    try {
      socketPath = decodeURIComponent(parsed.pathname);
    } catch {
      throw endpointError(label, 'contains an invalid encoded socket path');
    }
    if (!socketPath || socketPath.includes('\0')) {
      throw endpointError(label, 'contains an invalid socket path');
    }
    return endpoint;
  }

  if (parsed.protocol === 'ws:') {
    const port = Number(parsed.port);
    if (
      parsed.hostname !== '127.0.0.1'
      || !parsed.port
      || !Number.isInteger(port)
      || port < 1
      || port > 65_535
      || (parsed.pathname !== '/' && parsed.pathname !== '')
    ) {
      throw endpointError(
        label,
        'WebSocket URL must be exactly ws://127.0.0.1:<port> with no extra path',
      );
    }
    return endpoint;
  }

  throw endpointError(label, 'only unix:// and ws://127.0.0.1:<port> endpoints are allowed');
}

export function normalizeExistingAppServerConfig(
  raw: unknown,
  label = 'existingAppServer',
): ExistingAppServerConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw endpointError(label, 'must be an object with an endpoint field');
  }
  const value = raw as { endpoint?: unknown };
  return {
    endpoint: normalizeExistingAppServerEndpoint(value.endpoint, `${label}.endpoint`),
  };
}
