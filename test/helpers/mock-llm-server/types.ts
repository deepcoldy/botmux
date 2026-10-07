export type MockServerMode = 'synthetic' | 'record' | 'replay';

export interface MockServerConfig {
  /** Port to listen on (0 for dynamic free port) */
  port?: number;
  /** Host to bind (default: '127.0.0.1') */
  host?: string;
  /** Operational mode:
   *  - 'synthetic': Generate intelligent responses (tool calls / marker echoes) without any external calls
   *  - 'record': Transparently proxy upstream and record requests/responses to fixtures
   *  - 'replay': Serve recorded fixtures, dynamically replacing markers
   */
  mode?: MockServerMode;
  /** Real upstream base URL to forward requests to when mode === 'record' */
  upstreamUrl?: string;
  /** Directory to store/load fixture files */
  fixturesDir?: string;
  /** Delay in milliseconds between SSE chunk deliveries to simulate natural streaming cadence */
  chunkDelayMs?: number;
  /** Whether to log verbose request details */
  verbose?: boolean;
}

export interface SseEvent {
  event?: string;
  data: string;
  delayMs?: number;
}

export interface FixtureTape {
  id: string;
  timestamp: number;
  request: {
    method: string;
    path: string;
    model?: string;
    messagesSnippet?: string;
    body: unknown;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    events?: SseEvent[];
    bodyJson?: unknown;
  };
}
