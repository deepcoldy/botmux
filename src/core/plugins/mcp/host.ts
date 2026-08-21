import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PluginMcpGateway, type GatewayTrustedTurnIdentityProvider } from './gateway.js';
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

/** Deterministic per-session Gateway socket directory.
 *
 * The name is a pure function of (dataDir, sessionId) — NO random component —
 * so a replacement worker (daemon restart / upgrade) re-serves the socket at
 * the exact path a surviving persistent pane's relay already holds in its
 * environment, and the relay can simply reconnect instead of the worker having
 * to kill the pane and cold-resume the CLI.
 *
 * Stays under tmpdir (not dataDir) to keep the Unix socket below macOS's short
 * sun_path limit, and keeps the `bmcp-<uid>-` prefix so the existing Seatbelt
 * deny regex (sessionMcpGatewayPathRegex) covers it unchanged. The predictable
 * name is safe because ensurePrivateGatewayDir fails closed unless the
 * directory is a real 0700 directory owned by this uid — a squatter can only
 * DoS session startup, never observe traffic (connections still require the
 * rotating auth token). */
export function sessionMcpGatewaySocketDir(sessionId: string, dataDir: string): string {
  const uid = process.getuid?.() ?? 0;
  const sessionKey = createHash('sha256')
    .update(dataDir)
    .update('\0')
    .update(sessionId)
    .digest('hex')
    .slice(0, 16);
  return join(tmpdir(), `bmcp-${uid}-${sessionKey}`);
}

/** Deterministic per-session Gateway socket path (see sessionMcpGatewaySocketDir). */
export function sessionMcpGatewaySocketPath(sessionId: string, dataDir: string): string {
  return join(sessionMcpGatewaySocketDir(sessionId, dataDir), 'g.sock');
}

/** Create-or-verify the deterministic socket directory. Fail closed on
 *  anything that is not a 0700 directory owned by this uid: a symlink or a
 *  foreign-owned squat must abort session startup rather than let the Gateway
 *  serve (or the token be written) through an attacker-controlled path. */
function ensurePrivateGatewayDir(dir: string): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
    return;
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
  }
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(`Gateway socket dir ${dir} exists and is not a directory (planted symlink/file?)`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`Gateway socket dir ${dir} is owned by uid ${stat.uid} (expected ${uid})`);
  }
  if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/** Rotate the Gateway auth token atomically (tmp + rename) so a relay that
 *  re-reads the file mid-rotation always sees either the old or the new token,
 *  never a partial write or a missing file. */
function rotateGatewayAuthToken(socketPath: string): string {
  const token = randomBytes(32).toString('base64url');
  const finalPath = mcpGatewayAuthTokenPath(socketPath);
  const tmpPath = `${finalPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmpPath, `${token}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(tmpPath, finalPath);
  return token;
}

/**
 * Serve a session's credential-bearing Gateway in the trusted worker process.
 * The CLI receives only a Unix socket capability and never reads the runtime
 * descriptor snapshot or plugin credentials itself.
 */
export async function startSessionMcpGatewayHost(opts: {
  sessionId: string;
  dataDir: string;
  trustedTurnIdentity?: GatewayTrustedTurnIdentityProvider;
  onError?: (error: Error) => void;
}): Promise<SessionMcpGatewayHost> {
  const socketDir = sessionMcpGatewaySocketDir(opts.sessionId, opts.dataDir);
  const socketPath = join(socketDir, 'g.sock');
  ensurePrivateGatewayDir(socketDir);
  // A stale socket file from a dead worker generation blocks bind(); a live
  // predecessor is impossible (the daemon runs one worker per session), so
  // removing it unconditionally is safe and makes the fresh host authoritative.
  rmSync(socketPath, { force: true });
  const authToken = rotateGatewayAuthToken(socketPath);

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
      }, {
        trustedTurnIdentity: opts.trustedTurnIdentity,
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
    rmSync(socketPath, { force: true });
    throw error;
  });
  server.on('error', reportError);
  try {
    chmodSync(socketPath, 0o600);
  } catch (error) {
    server.close();
    rmSync(socketPath, { force: true });
    throw error;
  }

  return {
    socketPath,
    socketDir,
    close(): Promise<void> {
      closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        // Revoke the listener capability before the first await. Worker signal
        // handlers call process.exit(), so async-only cleanup would otherwise
        // leave a stale connectable socket behind.
        //
        // Deliberately unlink ONLY the socket file — the directory (and the
        // auth token inside it) must survive worker generations: a sandboxed
        // persistent pane bind-mounts this directory BY INODE (bwrap --ro-bind),
        // so deleting and recreating the directory would permanently detach the
        // pane's view. The replacement host reuses the directory in place,
        // rotates the token, and re-binds the socket at the same path so the
        // pane's relay can reconnect. A token file without a listener grants
        // nothing.
        rmSync(socketPath, { force: true });
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
