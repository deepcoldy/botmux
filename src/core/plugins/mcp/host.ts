import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PluginMcpGateway } from './gateway.js';
import { acceptMcpGatewayHandshake, mcpGatewayAuthTokenPath } from './socket-auth.js';

export interface SessionMcpGatewayHost {
  socketPath: string;
  socketDir: string;
  close(): Promise<void>;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Seatbelt deny for every Gateway socket directory owned by this OS user. */
export function sessionMcpGatewayPathRegex(
  socketRoot: string,
  uid: number = process.getuid?.() ?? 0,
): string {
  const root = socketRoot.replace(/\/+$/, '');
  return `^${escapeForRegex(root)}/bmcp-${uid}-[^/]+(?:/|$)`;
}

function gatewaySocketDir(sessionId: string, dataDir: string): string {
  const uid = process.getuid?.() ?? 0;
  const sessionKey = createHash('sha256')
    .update(dataDir)
    .update('\0')
    .update(sessionId)
    .digest('hex')
    .slice(0, 8);
  // mkdtemp is atomic, avoids a predictable shared parent under /tmp, and
  // keeps the resulting Unix socket below macOS's short sun_path limit.
  return mkdtempSync(join(tmpdir(), `bmcp-${uid}-${sessionKey}-`));
}

/**
 * Serve a session's credential-bearing Gateway in the trusted worker process.
 * The CLI receives only a Unix socket capability and never reads the runtime
 * descriptor snapshot or plugin credentials itself.
 */
export async function startSessionMcpGatewayHost(opts: {
  sessionId: string;
  dataDir: string;
  onError?: (error: Error) => void;
}): Promise<SessionMcpGatewayHost> {
  const socketDir = gatewaySocketDir(opts.sessionId, opts.dataDir);
  const socketPath = join(socketDir, 'g.sock');
  const authToken = randomBytes(32).toString('base64url');
  chmodSync(socketDir, 0o700);
  writeFileSync(mcpGatewayAuthTokenPath(socketPath), `${authToken}\n`, { mode: 0o600, flag: 'wx' });

  const sockets = new Set<Socket>();
  const connectionClosers = new Set<() => Promise<void>>();
  let closing: Promise<void> | undefined;
  const reportError = (error: unknown): void => {
    opts.onError?.(error instanceof Error ? error : new Error(String(error)));
  };

  const server: NetServer = createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.once('close', () => {
      sockets.delete(socket);
    });
    void (async () => {
      if (!await acceptMcpGatewayHandshake(socket, authToken)) return;
      const gateway = new PluginMcpGateway(undefined, {
        ...process.env,
        SESSION_DATA_DIR: opts.dataDir,
        BOTMUX_SESSION_ID: opts.sessionId,
      });
      let gatewayClose: Promise<void> | undefined;
      const closeGateway = (): Promise<void> => {
        gatewayClose ??= gateway.close()
          .catch(reportError)
          .finally(() => connectionClosers.delete(closeGateway));
        return gatewayClose;
      };
      connectionClosers.add(closeGateway);
      socket.once('close', () => { void closeGateway(); });
      await gateway.connect(new StdioServerTransport(socket, socket));
      socket.resume();
    })().catch((error) => {
      reportError(error);
      socket.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onInitialError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onInitialError);
      resolve();
    };
    server.once('error', onInitialError);
    server.once('listening', onListening);
    server.listen(socketPath);
  }).catch((error) => {
    rmSync(socketDir, { recursive: true, force: true });
    throw error;
  });
  server.on('error', reportError);
  try {
    chmodSync(socketPath, 0o600);
  } catch (error) {
    server.close();
    rmSync(socketDir, { recursive: true, force: true });
    throw error;
  }

  return {
    socketPath,
    socketDir,
    close(): Promise<void> {
      closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        // Revoke the filesystem capability before the first await. Worker
        // signal handlers call process.exit(), so async-only cleanup would
        // otherwise leave a stale socket directory behind.
        rmSync(socketDir, { recursive: true, force: true });
        const serverClosed = new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        });
        await Promise.allSettled([...connectionClosers].map(close => close()));
        await serverClosed;
      })();
      return closing;
    },
  };
}
