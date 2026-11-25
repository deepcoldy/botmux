import WebSocket from 'ws';
import { normalizeExistingAppServerEndpoint } from './existing-app-server.js';
import { JsonRpcStdioCore } from '../utils/jsonrpc-stdio.js';
import type { Session } from '../types.js';

/** A short-lived client of the existing server, never a server subprocess. */
export class SharedThreadClient {
  private readonly socket: WebSocket;
  private readonly ready: Promise<void>;
  private readonly rpc = new JsonRpcStdioCore({
    mapRpcError: (method, error) => new Error(`${method}: ${error.message}`),
    onMessage: message => {
      if (message.method && message.id !== undefined) {
        this.socket.send(JSON.stringify({ id: message.id, error: {
          code: -32601, message: 'Unsupported bootstrap client request',
        } }));
      }
    },
  });

  constructor(endpoint: string) {
    const url = new URL(normalizeExistingAppServerEndpoint(endpoint));
    const path = decodeURIComponent(url.pathname);
    if (url.protocol === 'unix:' && path.includes(':')) {
      throw new Error('Unix WebSocket socket path must not contain a colon');
    }
    this.socket = new WebSocket(url.protocol === 'unix:' ? `ws+unix://${path}:/` : url.href,
      { handshakeTimeout: 7000, maxPayload: 16 * 1024 * 1024 });
    this.ready = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
      this.socket.once('close', () => reject(new Error('Shared server disconnected')));
    });
    void this.ready.catch(() => {});
    this.socket.on('message', data => this.rpc.push(`${String(data)}\n`));
    this.socket.on('error', error => this.rpc.failAll(error));
    this.socket.on('close', () => this.rpc.failAll(new Error('Shared server disconnected')));
  }

  async request(method: string, params: unknown): Promise<any> {
    await this.ready;
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Shared server disconnected');
    const id = this.rpc.nextId();
    const response = this.rpc.track(id, method, { timeoutMs: 7000 });
    this.socket.send(JSON.stringify({ id, method, params }), error => {
      if (error) this.rpc.abort(id, error);
    });
    return response;
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'botmux-shared-thread', version: '1' },
      capabilities: { experimentalApi: true },
    });
    this.socket.send(JSON.stringify({ method: 'initialized' }));
  }

  close(): void {
    this.rpc.failAll(new Error('Shared thread client closed'));
    this.socket.terminate();
  }
}

export interface SharedThreadRemote {
  request(method: string, params: unknown): Promise<any>;
}

/** Persist received identity independently of whether a worker may still launch. */
export async function openSharedThread(
  mutate: <T>(change: (session: Session) => T) => T,
  remote: SharedThreadRemote,
): Promise<string> {
  const opening = mutate(session => {
    if (session.status !== 'active' || session.cliId !== 'codex') {
      throw new Error('Shared thread session is not active Codex');
    }
    const value = session.sharedThreadOpening;
    if (!value?.cwd || !value.title) throw new Error('Shared thread opening is not prepared');
    if (session.projectRouteRevision !== value.projectRouteRevision) {
      throw new Error('Shared thread route changed; reconcile before retrying');
    }
    // The externally managed server owns model configuration; the remote TUI
    // worker refuses an explicit serviceTier on attachment. Reset it inside the
    // same checkpoint transaction as /adopt does at bind time, covering every
    // retry and the already-bound idempotent re-entry below.
    session.serviceTier = 'inherit';
    if (session.cliSessionId && session.existingAppServerEndpoint === value.endpoint) {
      return { ...value, threadId: session.cliSessionId, route: session.projectRouteRevision };
    }
    if (value.phase === 'creating') {
      throw new Error('Shared thread creation result unknown; reconcile before retrying');
    }
    if (!value.threadId) {
      value.phase = 'creating';
    }
    return { ...value, route: session.projectRouteRevision };
  });
  let threadId = opening.threadId;
  if (!threadId) {
    const result = await remote.request('thread/start', { cwd: opening.cwd, ephemeral: false });
    threadId = result?.thread?.id;
    if (typeof threadId !== 'string' || !threadId) throw new Error('Missing shared thread creation receipt');
    const receivedId = threadId;
    mutate(session => {
      const current = session.sharedThreadOpening;
      if (!current || current.endpoint !== opening.endpoint || current.cwd !== opening.cwd
        || current.title !== opening.title || current.phase !== 'creating') {
        throw new Error('Shared thread opening changed');
      }
      current.threadId = receivedId;
      current.phase = 'created';
    });
  }
  // Naming persists a pre-turn rollout so the existing remote TUI can resume it.
  const read = await remote.request('thread/read', { threadId, includeTurns: false });
  if (read?.thread?.id !== threadId) throw new Error('Shared thread identity mismatch');
  // shortcut: name/set has no CAS; a concurrent manual rename can race this initial name.
  if (!read.thread.name) await remote.request('thread/name/set', { threadId, name: opening.title });
  mutate(session => {
    if (session.status !== 'active' || session.cliId !== 'codex'
      || session.projectRouteRevision !== opening.route
      || session.sharedThreadOpening?.threadId !== threadId
      || (session.cliSessionId && session.cliSessionId !== threadId)) {
      throw new Error('Shared thread session changed before binding');
    }
    session.cliSessionId = threadId;
    session.existingAppServerEndpoint = opening.endpoint;
  });
  return threadId;
}
