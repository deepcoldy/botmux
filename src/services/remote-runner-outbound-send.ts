import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  botmuxCliInvocation,
  buildRelayHostEnv,
} from '../adapters/backend/sandbox.js';
import type {
  RemoteRunnerOutboundMessage,
  RemoteRunnerOutboundMessageResult,
} from '../adapters/backend/remote-runner-protocol.js';

const MAX_CAPTURE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface RemoteRunnerOutboundHostContext {
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
  env?: NodeJS.ProcessEnv;
  cliPath?: string;
  timeoutMs?: number;
}

function boundedDiagnostic(value: string, fallback: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return (normalized || fallback).slice(0, 1000);
}

export function classifyRemoteRunnerOutboundHostResult(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): RemoteRunnerOutboundMessageResult {
  if (exitCode === 0) {
    for (const line of stdout.trim().split('\n').reverse()) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { success?: unknown; messageId?: unknown };
        if (parsed.success === true && typeof parsed.messageId === 'string' && parsed.messageId) {
          return { outcome: 'delivered', messageId: parsed.messageId };
        }
      } catch { /* keep looking for the CLI's final JSON line */ }
    }
    return {
      outcome: 'unknown',
      code: 'outbound_result_invalid',
      message: 'The BotMux send child exited successfully without a verifiable message id.',
    };
  }
  if (exitCode === 2) {
    return {
      outcome: 'rejected',
      code: 'outbound_rejected',
      message: boundedDiagnostic(stderr, 'The outbound message was rejected before delivery.'),
    };
  }
  return {
    outcome: 'unknown',
    code: 'outbound_delivery_unknown',
    message: boundedDiagnostic(stderr, 'The outbound delivery result is unknown; do not retry automatically.'),
  };
}

/** Re-enter this exact BotMux build on the host so Remote Runner output uses
 * the ordinary send policy, routing, card renderer, hooks and Lark client.
 * The provider contributes only bounded content/addressing intent; session and
 * turn authority are frozen by the worker-owned environment below. */
export async function sendRemoteRunnerOutboundMessage(
  message: RemoteRunnerOutboundMessage,
  context: RemoteRunnerOutboundHostContext,
): Promise<RemoteRunnerOutboundMessageResult> {
  const directory = mkdtempSync(join(tmpdir(), 'botmux-remote-outbound-'));
  const contentPath = join(directory, 'content.md');
  writeFileSync(contentPath, message.content, { mode: 0o600 });
  const invocation = botmuxCliInvocation(context.cliPath);
  const args = [
    ...invocation.args,
    'send',
    '--remote-runner-outbound',
    '--response-kind', message.responseKind,
    message.mention === 'requester' ? '--mention-back' : '--no-mention',
    '--content-file', contentPath,
    '--session-id', context.sessionId,
  ];
  const env = buildRelayHostEnv(context.env ?? process.env);
  env.BOTMUX_HOST_RELAY_AUTHORIZED = '1';
  env.BOTMUX_SESSION_ID = context.sessionId;
  env.BOTMUX_TURN_ID = context.turnId;
  if (context.dispatchAttempt !== undefined) {
    env.BOTMUX_DISPATCH_ATTEMPT = String(context.dispatchAttempt);
  } else {
    delete env.BOTMUX_DISPATCH_ATTEMPT;
  }

  try {
    return await new Promise<RemoteRunnerOutboundMessageResult>((resolve) => {
      const child = spawn(invocation.command, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let captureOverflow = false;
      const append = (current: string, chunk: Buffer | string): string => {
        const next = current + String(chunk);
        if (Buffer.byteLength(next, 'utf8') > MAX_CAPTURE_BYTES) {
          captureOverflow = true;
          child.kill('SIGTERM');
          return next.slice(-MAX_CAPTURE_BYTES);
        }
        return next;
      };
      child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
      child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
      const timeout = setTimeout(() => child.kill('SIGTERM'), context.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timeout.unref?.();
      child.on('error', error => {
        clearTimeout(timeout);
        resolve({
          outcome: 'unknown',
          code: 'outbound_child_failed',
          message: boundedDiagnostic(error.message, 'The BotMux send child failed to start.'),
        });
      });
      child.on('close', code => {
        clearTimeout(timeout);
        if (captureOverflow) {
          resolve({
            outcome: 'unknown',
            code: 'outbound_result_oversized',
            message: 'The BotMux send child produced an oversized result; do not retry automatically.',
          });
          return;
        }
        resolve(classifyRemoteRunnerOutboundHostResult(code, stdout, stderr));
      });
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
