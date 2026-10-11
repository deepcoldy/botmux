import { spawn } from 'node:child_process';
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { basename, join, sep } from 'node:path';
import {
  botmuxCliInvocation,
  buildRelayHostEnv,
} from '../adapters/backend/sandbox.js';
import {
  MAX_REMOTE_RUNNER_SESSION_TOOL_ATTACHMENT_BYTES,
  MAX_REMOTE_RUNNER_SESSION_TOOL_TEXT_BYTES,
  type RemoteRunnerSessionToolAttachment,
  type RemoteRunnerSessionToolRequest,
  type RemoteRunnerSessionToolResult,
} from '../adapters/backend/remote-runner-protocol.js';

const MAX_STDERR_BYTES = 64 * 1024;
const MAX_ATTACHMENTS = 8;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface RemoteRunnerSessionToolHostContext {
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

export function remoteRunnerSessionToolArgs(
  request: RemoteRunnerSessionToolRequest,
  sessionId: string,
): string[] {
  switch (request.tool) {
    case 'history':
      return [
        'history',
        ...(request.limit !== undefined ? ['--limit', String(request.limit)] : []),
        ...(request.scope ? ['--scope', request.scope] : []),
        ...(request.withCardJson ? ['--with-card-json'] : []),
        '--session-id', sessionId,
      ];
    case 'quoted':
      return [
        'quoted', request.messageId,
        '--remote-runner-session-tool',
        ...(request.raw ? ['--raw'] : []),
        '--session-id', sessionId,
      ];
    case 'bots.list':
      return ['bots', 'list', '--scope', 'chat', '--session-id', sessionId];
    case 'skill.list':
      return ['skill', 'list'];
    case 'skill.show':
      return ['skill', 'show', request.name];
    case 'skill.read':
      return ['skill', 'read', request.name, request.path];
    case 'skill.resources':
      return ['skill', 'resources', request.name];
  }
}

function quotedAttachments(
  stdout: string,
  env: NodeJS.ProcessEnv,
): { stdout: string; attachments?: RemoteRunnerSessionToolAttachment[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { stdout };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { stdout };
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.attachments) || root.attachments.length === 0) return { stdout };
  if (root.attachments.length > MAX_ATTACHMENTS) {
    throw new Error(`quoted returned more than ${MAX_ATTACHMENTS} attachments`);
  }

  const dataDir = env.SESSION_DATA_DIR?.trim();
  if (!dataDir) throw new Error('SESSION_DATA_DIR is unavailable for quoted attachments');
  const attachmentRootInput = join(dataDir, 'attachments');
  const attachmentRootInfo = lstatSync(attachmentRootInput);
  if (attachmentRootInfo.isSymbolicLink() || !attachmentRootInfo.isDirectory()) {
    throw new Error('BotMux attachment root is unsafe');
  }
  const attachmentRoot = realpathSync(attachmentRootInput);
  const attachmentPrefix = attachmentRoot.endsWith(sep) ? attachmentRoot : `${attachmentRoot}${sep}`;
  const transferred: RemoteRunnerSessionToolAttachment[] = [];
  let totalBytes = 0;

  for (let index = 0; index < root.attachments.length; index++) {
    const raw = root.attachments[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('quoted returned an invalid attachment');
    }
    const item = raw as Record<string, unknown>;
    const path = typeof item.path === 'string' ? item.path : '';
    const name = typeof item.name === 'string' ? basename(item.name).slice(0, 255) : '';
    const type = item.type;
    if (!path || !name || (type !== 'image' && type !== 'file')) {
      throw new Error('quoted returned an invalid attachment');
    }
    const info = lstatSync(path);
    const resolved = realpathSync(path);
    if (info.isSymbolicLink() || !info.isFile()
        || (resolved !== attachmentRoot && !resolved.startsWith(attachmentPrefix))) {
      throw new Error('quoted attachment escaped the BotMux attachment root');
    }
    totalBytes += info.size;
    if (totalBytes > MAX_REMOTE_RUNNER_SESSION_TOOL_ATTACHMENT_BYTES) {
      throw new Error('quoted attachments exceed the Remote Runner transfer limit');
    }
    const placeholder = `botmux-session-tool://attachment/${index}`;
    item.path = placeholder;
    transferred.push({
      placeholder,
      name,
      type,
      ...(typeof item.mimeType === 'string' && item.mimeType.length <= 256
        ? { mimeType: item.mimeType }
        : {}),
      dataBase64: readFileSync(resolved).toString('base64'),
    });
  }

  return {
    stdout: `${JSON.stringify(root, null, 2)}\n`,
    attachments: transferred,
  };
}

/** Execute one strictly structured, read-only BotMux session helper on the
 * trusted host.  The provider cannot select a session, chat, bot, executable,
 * arbitrary argv or environment value. */
export async function runRemoteRunnerSessionTool(
  request: RemoteRunnerSessionToolRequest,
  context: RemoteRunnerSessionToolHostContext,
): Promise<RemoteRunnerSessionToolResult> {
  const invocation = botmuxCliInvocation(context.cliPath);
  const args = [...invocation.args, ...remoteRunnerSessionToolArgs(request, context.sessionId)];
  const env = buildRelayHostEnv(context.env ?? process.env);
  env.BOTMUX_HOST_RELAY_AUTHORIZED = '1';
  env.BOTMUX_SESSION_ID = context.sessionId;
  env.BOTMUX_TURN_ID = context.turnId;
  if (context.dispatchAttempt !== undefined) {
    env.BOTMUX_DISPATCH_ATTEMPT = String(context.dispatchAttempt);
  } else {
    delete env.BOTMUX_DISPATCH_ATTEMPT;
  }

  return new Promise<RemoteRunnerSessionToolResult>((resolve) => {
    const child = spawn(invocation.command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let captureOverflow = false;
    let timedOut = false;
    let settled = false;
    const finish = (result: RemoteRunnerSessionToolResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const append = (current: string, chunk: Buffer | string, limit: number): string => {
      const next = current + String(chunk);
      if (Buffer.byteLength(next, 'utf8') > limit) {
        captureOverflow = true;
        child.kill('SIGTERM');
        return next.slice(-limit);
      }
      return next;
    };
    child.stdout.on('data', chunk => {
      stdout = append(stdout, chunk, MAX_REMOTE_RUNNER_SESSION_TOOL_TEXT_BYTES);
    });
    child.stderr.on('data', chunk => {
      stderr = append(stderr, chunk, MAX_STDERR_BYTES);
    });
    let forceKill: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000);
      forceKill.unref?.();
    }, context.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeout.unref?.();
    child.on('error', error => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      finish({
        outcome: 'unknown',
        code: 'session_tool_child_failed',
        message: boundedDiagnostic(error.message, 'The BotMux session tool child failed to start.'),
      });
    });
    child.on('close', code => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (captureOverflow) {
        finish({
          outcome: 'rejected',
          code: 'session_tool_result_oversized',
          message: 'The BotMux session tool produced an oversized result.',
        });
        return;
      }
      if (timedOut) {
        finish({
          outcome: 'unknown',
          code: 'session_tool_timeout',
          message: 'The BotMux session tool timed out.',
        });
        return;
      }
      if (code === null) {
        finish({
          outcome: 'unknown',
          code: 'session_tool_exit_unknown',
          message: 'The BotMux session tool exited without a verifiable status.',
        });
        return;
      }
      try {
        const packaged = request.tool === 'quoted'
          ? quotedAttachments(stdout, env)
          : { stdout };
        finish({
          outcome: 'completed',
          exitCode: code,
          stdout: packaged.stdout,
          stderr,
          ...('attachments' in packaged && packaged.attachments
            ? { attachments: packaged.attachments }
            : {}),
        });
      } catch (error) {
        finish({
          outcome: 'rejected',
          code: 'session_tool_attachment_rejected',
          message: boundedDiagnostic(
            error instanceof Error ? error.message : String(error),
            'The quoted attachment transfer was rejected.',
          ),
        });
      }
    });
  });
}
