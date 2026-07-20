import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import {
  MCP_GATEWAY_HANDSHAKE_ERROR,
  MCP_GATEWAY_HANDSHAKE_OK,
  MCP_GATEWAY_HANDSHAKE_PREFIX,
} from './environment.js';

const MAX_HANDSHAKE_BYTES = 512;
const HANDSHAKE_TIMEOUT_MS = 2_000;
export const MCP_GATEWAY_AUTH_FILENAME = 'auth';

export function mcpGatewayAuthTokenPath(socketPath: string): string {
  return join(dirname(socketPath), MCP_GATEWAY_AUTH_FILENAME);
}

export function readMcpGatewayAuthToken(socketPath: string): string {
  const token = readFileSync(mcpGatewayAuthTokenPath(socketPath), 'utf8').trim();
  if (!token) throw new Error('Gateway authentication token is empty');
  return token;
}

function readSocketLine(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const finish = (error?: Error, line?: string) => {
      cleanup();
      if (error) reject(error);
      else resolve(line ?? '');
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error('Gateway connection closed during authentication'));
    const onData = (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.length > MAX_HANDSHAKE_BYTES) {
        finish(new Error('Gateway authentication frame is too large'));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const remainder = buffer.subarray(newline + 1);
      socket.pause();
      if (remainder.length > 0) socket.unshift(remainder);
      finish(undefined, buffer.subarray(0, newline).toString('utf8').replace(/\r$/, ''));
    };

    timer = setTimeout(
      () => finish(new Error('Gateway authentication timed out')),
      HANDSHAKE_TIMEOUT_MS,
    );
    timer.unref?.();
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function tokenMatches(presented: string, expected: string): boolean {
  const presentedBytes = Buffer.from(presented);
  const expectedBytes = Buffer.from(expected);
  return presentedBytes.length === expectedBytes.length
    && timingSafeEqual(presentedBytes, expectedBytes);
}

/** Authenticate a newly accepted worker-side socket before MCP sees any bytes. */
export async function acceptMcpGatewayHandshake(socket: Socket, expectedToken: string): Promise<boolean> {
  try {
    const line = await readSocketLine(socket);
    const presentedToken = line.startsWith(MCP_GATEWAY_HANDSHAKE_PREFIX)
      ? line.slice(MCP_GATEWAY_HANDSHAKE_PREFIX.length)
      : '';
    if (!tokenMatches(presentedToken, expectedToken)) {
      socket.end(`${MCP_GATEWAY_HANDSHAKE_ERROR}\n`);
      return false;
    }
    socket.write(`${MCP_GATEWAY_HANDSHAKE_OK}\n`);
    return true;
  } catch {
    socket.destroy();
    return false;
  }
}

/** Authenticate the CLI-side relay before piping untrusted MCP stdio. */
export async function sendMcpGatewayHandshake(socket: Socket, token: string): Promise<void> {
  socket.write(`${MCP_GATEWAY_HANDSHAKE_PREFIX}${token}\n`);
  const response = await readSocketLine(socket);
  if (response !== MCP_GATEWAY_HANDSHAKE_OK) {
    throw new Error('Botmux MCP Gateway authentication failed');
  }
  socket.resume();
}
