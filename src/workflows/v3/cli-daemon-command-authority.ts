/**
 * Caller/target authorization for agent-facing daemon mutations:
 * `botmux workflow start|cancel|retry|grant`.
 *
 * These commands run as child processes of a long-lived CLI.  The inherited
 * BOTMUX_OWNER_OPEN_ID / BOTMUX_LARK_APP_ID values describe the session at
 * spawn time, not necessarily the human who opened the current turn.  The
 * only chat authority is therefore resolveCurrentTurnProvenance(): a fresh
 * process-tree marker joined to the latest durable session record.
 */
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

import {
  resolveCurrentTurnProvenance,
  type CurrentTurnProvenance,
} from '../../core/current-turn-provenance.js';
import {
  GRILL_STATUS_FILE,
  defaultBaseDir,
  readGrillState,
  type RunChatBinding,
} from './grill-state.js';
import { isValidRunId } from './ops-projection.js';
import { readRunEnvelope } from './run-envelope.js';

export type V3DaemonCommandBindingSource = 'run-envelope' | 'legacy-grill' | 'legacy-unbound';

export interface V3DaemonCommandAuthority {
  runDir: string;
  /** Exact daemon owner selected from the authenticated target/current turn. */
  larkAppId: string;
  mode: 'chat' | 'standalone';
  bindingSource: V3DaemonCommandBindingSource;
}

export interface AuthorizeV3DaemonCommandOptions {
  runId: string;
  dataDir: string;
  baseDir?: string;
  envSessionId?: string;
  startPid?: number;
  /** Explicit `--bot`; inherited BOTMUX_LARK_APP_ID is intentionally ignored. */
  requestedLarkAppId?: string;
  /** Cancel-only escape hatch: an unbound manual run is mutated on local disk
   * and therefore does not need a daemon selector. Other daemon commands keep
   * requiring --bot for standalone routing. */
  allowStandaloneLocal?: boolean;
  /** Test seam. Production always uses the fresh marker/session resolver. */
  resolveProvenance?: (options: {
    dataDir: string;
    envSessionId?: string;
    startPid?: number;
  }) => CurrentTurnProvenance | null;
}

export class V3DaemonCommandAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V3DaemonCommandAuthorityError';
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertLegacyBindingShape(binding: RunChatBinding, runId: string): void {
  if (!nonEmpty(binding.larkAppId) || !nonEmpty(binding.chatId)) {
    throw new V3DaemonCommandAuthorityError(
      `legacy run ${runId} 的 grill.chatBinding 缺少有效 larkAppId/chatId`,
    );
  }
  for (const [key, value] of [
    ['ownerOpenId', binding.ownerOpenId],
    ['rootMessageId', binding.rootMessageId],
    ['sessionId', binding.sessionId],
  ] as const) {
    if (value !== undefined && !nonEmpty(value)) {
      throw new V3DaemonCommandAuthorityError(
        `legacy run ${runId} 的 grill.chatBinding.${key} 无效`,
      );
    }
  }
}

function readTargetBinding(
  runDir: string,
  runId: string,
): { binding?: RunChatBinding; source: V3DaemonCommandBindingSource } {
  let stat;
  try {
    stat = lstatSync(runDir);
  } catch {
    throw new V3DaemonCommandAuthorityError(`找不到 v3 run ${runId}`);
  }
  if (!stat.isDirectory()) {
    throw new V3DaemonCommandAuthorityError(`v3 run 路径不是目录：${runDir}`);
  }

  const envelope = readRunEnvelope(runDir, runId);
  if (envelope.kind === 'ok') {
    return {
      ...(envelope.envelope.chatBinding ? { binding: envelope.envelope.chatBinding } : {}),
      source: 'run-envelope',
    };
  }
  if (envelope.kind === 'invalid') {
    // Compatibility is intentionally missing-only. A corrupt run.json must
    // never be bypassed by a still-readable grill.state.json.
    throw new V3DaemonCommandAuthorityError(
      `v3 run ${runId} 的 run.json 无效，拒绝降级到 grill.state：${envelope.problems.join('; ')}`,
    );
  }

  const grillPath = join(runDir, GRILL_STATUS_FILE);
  if (existsSync(grillPath)) {
    const grill = readGrillState(runDir);
    if (!grill) {
      throw new V3DaemonCommandAuthorityError(
        `legacy run ${runId} 的 ${GRILL_STATUS_FILE} 无法解析`,
      );
    }
    if (grill.runId !== runId) {
      throw new V3DaemonCommandAuthorityError(
        `legacy run 目录 ${runId} 与 grill.state.runId ${grill.runId} 不一致`,
      );
    }
    if (grill.chatBinding) assertLegacyBindingShape(grill.chatBinding, runId);
    return {
      ...(grill.chatBinding ? { binding: grill.chatBinding } : {}),
      source: 'legacy-grill',
    };
  }

  // Old standalone/manual runs predate both run.json and grill.state.json.
  // Requiring dag.json distinguishes one of those runs from an empty/unknown
  // directory while preserving the one-release compatibility path.
  if (!existsSync(join(runDir, 'dag.json'))) {
    throw new V3DaemonCommandAuthorityError(
      `v3 run ${runId} 既没有 run.json/grill.state.json，也没有 legacy dag.json`,
    );
  }
  return { source: 'legacy-unbound' };
}

/** The exact identity tuple a chat mutation must prove against the binding. */
export interface V3RunMutationCurrentTuple {
  callerOpenId: string;
  chatId: string;
  larkAppId: string;
}

function mismatchFields(current: V3RunMutationCurrentTuple, target: RunChatBinding): string[] {
  const fields: string[] = [];
  if (current.callerOpenId !== target.ownerOpenId) fields.push('callerOpenId');
  if (current.chatId !== target.chatId) fields.push('chatId');
  if (current.larkAppId !== target.larkAppId) fields.push('larkAppId');
  return fields;
}

/**
 * Chat-tuple authorization core shared by the CLI host path (marker-derived
 * provenance) and the daemon session relay (capability-derived live session).
 * The tuple must have been AUTHENTICATED by the caller: process-tree marker +
 * durable session join on the host, or rotating per-turn capability + the
 * daemon's own live session record on the relay path — never env/argv claims.
 */
export function authorizeV3RunMutationForCurrentTuple(options: {
  runId: string;
  baseDir?: string;
  current: V3RunMutationCurrentTuple;
}): V3DaemonCommandAuthority {
  if (!isValidRunId(options.runId)) {
    throw new V3DaemonCommandAuthorityError(`v3 runId 非法：${options.runId}`);
  }
  const runDir = join(options.baseDir ?? defaultBaseDir(), options.runId);
  const target = readTargetBinding(runDir, options.runId);
  if (!target.binding) {
    throw new V3DaemonCommandAuthorityError(
      `run ${options.runId} 是未绑定的 standalone/legacy run，不能从 botmux chat turn 修改`,
    );
  }
  if (!nonEmpty(target.binding.ownerOpenId)) {
    throw new V3DaemonCommandAuthorityError(
      `run ${options.runId} 的 chatBinding 缺少已认证 owner，不能从 botmux chat turn 修改`,
    );
  }
  const mismatches = mismatchFields(options.current, target.binding);
  if (mismatches.length > 0) {
    throw new V3DaemonCommandAuthorityError(
      `当前 turn 与 run ${options.runId} 的 chatBinding 不匹配：${mismatches.join(', ')}`,
    );
  }
  return {
    runDir,
    larkAppId: target.binding.larkAppId,
    mode: 'chat',
    bindingSource: target.source,
  };
}

/**
 * Authorize a CLI daemon mutation and return the only app id it may contact.
 *
 * Chat callers may mutate only a run bound to the exact current
 * (caller, chat, app) tuple. Genuine standalone callers may mutate only an
 * unbound run and must name the daemon explicitly with --bot. This preserves
 * the dev path without letting a detached/stale agent fall back to it.
 */
export function authorizeV3DaemonCommand(
  options: AuthorizeV3DaemonCommandOptions,
): V3DaemonCommandAuthority {
  if (!isValidRunId(options.runId)) {
    throw new V3DaemonCommandAuthorityError(`v3 runId 非法：${options.runId}`);
  }

  const resolveProvenance = options.resolveProvenance ?? resolveCurrentTurnProvenance;
  const current = resolveProvenance({
    dataDir: options.dataDir,
    ...(options.envSessionId ? { envSessionId: options.envSessionId } : {}),
    ...(options.startPid !== undefined ? { startPid: options.startPid } : {}),
  });
  const runDir = join(options.baseDir ?? defaultBaseDir(), options.runId);
  const requested = options.requestedLarkAppId;
  if (requested !== undefined && !nonEmpty(requested)) {
    throw new V3DaemonCommandAuthorityError('--bot 需要非空 larkAppId');
  }

  if (current) {
    const authority = authorizeV3RunMutationForCurrentTuple({
      runId: options.runId,
      ...(options.baseDir ? { baseDir: options.baseDir } : {}),
      current,
    });
    if (requested !== undefined && requested !== authority.larkAppId) {
      throw new V3DaemonCommandAuthorityError(
        `--bot ${requested} 不能覆盖 run/当前 turn 绑定的 bot ${authority.larkAppId}`,
      );
    }
    return authority;
  }

  const target = readTargetBinding(runDir, options.runId);

  if (target.binding) {
    throw new V3DaemonCommandAuthorityError(
      `run ${options.runId} 绑定了 chat caller，standalone 命令不能修改`,
    );
  }
  if (!requested && !options.allowStandaloneLocal) {
    throw new V3DaemonCommandAuthorityError(
      `standalone 操作未绑定 run ${options.runId} 时必须显式提供 --bot <larkAppId>`,
    );
  }
  return {
    runDir,
    larkAppId: requested ?? '',
    mode: 'standalone',
    bindingSource: target.source,
  };
}
