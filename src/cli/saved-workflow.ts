/** CLI adapter for v3 Saved Workflows. Core policy lives in library-service. */

import { dirname, resolve } from 'node:path';

import { loadBotConfigs } from '../bot-registry.js';
import { resolveCurrentTurnProvenance } from '../core/current-turn-provenance.js';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import type { RawParamInput } from '../workflows/shared/params.js';
import { defaultBaseDir } from '../workflows/v3/grill-state.js';
import {
  instantiatePublishedSavedWorkflow,
  listVisibleSavedWorkflows,
  loadVisibleSavedWorkflow,
  resolveOwnedTerminalRunDir,
  resolveVisibleSavedWorkflow,
  saveTerminalRunAsWorkflow,
  type SavedWorkflowActorContext,
} from '../workflows/v3/library-service.js';
import { SAVED_WORKFLOW_PARAM_NAME_RE } from '../workflows/v3/library-schema.js';
import { postWorkflowDaemonMutation } from '../workflows/v3/daemon-ipc-client.js';

const FORBIDDEN_PARAM_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const RUN_FLAGS_WITH_VALUE = new Set(['--library-dir', '--base-dir', '--run-id']);
const SAVE_FLAGS_WITH_VALUE = new Set([
  '--library-dir', '--base-dir', '--workflow-id', '--expected-revision',
]);
const SAVE_BOOLEAN_FLAGS = new Set(['--json', '--allow-draft']);

function savedWorkflowScopeLabel(scope: { kind: 'chat' | 'global' }): string {
  return scope.kind === 'global' ? '当前 Bot 全局' : '本群';
}

export function formatSavedWorkflowCliShow(
  loaded: Awaited<ReturnType<typeof loadVisibleSavedWorkflow>>,
  context: SavedWorkflowActorContext,
  raw: boolean,
): string {
  if (raw) {
    if (
      loaded.metadata.owner.openId !== context.actor.openId ||
      loaded.metadata.owner.larkAppId !== context.actor.larkAppId
    ) {
      throw new Error('Saved Workflow 完整定义仅 owner 可查看；其它用户只能查看脱敏摘要');
    }
    return JSON.stringify(loaded, null, 2);
  }
  const params = Object.keys(loaded.revision.payload.inputs);
  return [
    `Saved Workflow：${loaded.metadata.displayName}`,
    `workflowId: ${loaded.metadata.workflowId}`,
    `scope: ${savedWorkflowScopeLabel(loaded.metadata.scope)}`,
    `status: ${loaded.metadata.status}`,
    `revision: v${loaded.revision.payload.humanVersion} (${loaded.revision.revisionId})`,
    `params: ${params.length > 0 ? params.join(', ') : '(无)'}`,
  ].join('\n');
}

export function formatSavedWorkflowCliList(
  listed: Awaited<ReturnType<typeof listVisibleSavedWorkflows>>,
  json: boolean,
): string {
  // The library metadata contains immutable ownership/routing fields. A
  // current-bot global catalog is readable by other chats, so neither the
  // machine-readable nor human-readable list may serialize metadata directly.
  const entries = listed.entries.map((entry) => ({
    workflowId: entry.workflowId,
    displayName: entry.displayName,
    scope: savedWorkflowScopeLabel(entry.scope),
    status: entry.status,
    ...(entry.publishedRevision ? { publishedRevision: entry.publishedRevision } : {}),
  }));
  if (json) return JSON.stringify({ entries }, null, 2);
  if (entries.length === 0) {
    return '还没有 Saved Workflow。成功跑完一次后用 `botmux workflow save last [名称]` 固化。';
  }
  return entries.map((entry) =>
    `${entry.displayName}\t${entry.workflowId}\t${entry.scope}\t${entry.status}` +
    `${entry.publishedRevision ? `\t${entry.publishedRevision}` : ''}`,
  ).join('\n');
}

function argValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) return args[i + 1];
    if (args[i]?.startsWith(`${flag}=`)) return args[i]!.slice(flag.length + 1);
  }
  return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function positionals(args: string[], flagsWithValue: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (flagsWithValue.includes(token)) { i++; continue; }
    if (flagsWithValue.some((flag) => token.startsWith(`${flag}=`))) continue;
    if (token.startsWith('--')) continue;
    out.push(token);
  }
  return out;
}

export function contextFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  startPid: number = process.ppid,
): SavedWorkflowActorContext {
  const dataDir = env.SESSION_DATA_DIR;
  if (!dataDir) {
    throw new Error(
      'Saved Workflow save/run requires an authenticated current botmux turn ' +
      '(SESSION_DATA_DIR is unavailable)',
    );
  }
  const provenance = resolveCurrentTurnProvenance({
    dataDir,
    envSessionId: env.BOTMUX_SESSION_ID,
    startPid,
  });
  if (!provenance) {
    throw new Error('Saved Workflow save/run requires an authenticated current botmux turn');
  }
  return {
    actor: { larkAppId: provenance.larkAppId, openId: provenance.callerOpenId },
    chatId: provenance.chatId,
    ...(provenance.chatType ? { chatType: provenance.chatType } : {}),
    ...(provenance.rootMessageId ? { rootMessageId: provenance.rootMessageId } : {}),
    sessionId: provenance.sessionId,
  };
}

function libraryDataDir(args: string[]): string {
  return argValue(args, '--library-dir') ?? dirname(defaultBaseDir());
}

function runsBaseDir(args: string[]): string {
  return argValue(args, '--base-dir') ?? defaultBaseDir();
}

/**
 * `workflow run` immediately asks the live daemon to start the materialized
 * run. That daemon only resolves ids under its canonical v3 root, so accepting
 * a different CLI directory would create a valid but permanently orphaned run.
 * Core materialization keeps an injectable baseDir for tests/migrations; the
 * user-facing start command does not.
 */
export function assertDaemonManagedRunBaseDir(baseDir: string, canonical = defaultBaseDir()): void {
  if (resolve(baseDir) !== resolve(canonical)) {
    throw new Error(
      `botmux workflow run 不支持自定义 --base-dir；daemon 仅从 ${canonical} 启动 v3 run`,
    );
  }
}

/** Agent-facing CLI cannot prove the daemon's per-chat `canOperate` policy. */
export function assertAgentFacingSaveScope(args: readonly string[]): void {
  if (args.some((token) => token === '--distill' || token.startsWith('--distill='))) {
    throw new Error(
      'botmux workflow save 不接受 --distill：参数蒸馏必须由用户在飞书中显式发送 ' +
      '`/workflow save [last|runId] <名称> --distill`，并在提案卡片中确认',
    );
  }
  if (args.some((token) => token === '--global' || token.startsWith('--global='))) {
    throw new Error(
      'botmux workflow save 不接受 --global（当前 Bot 全局）：请由用户在飞书中显式发送 ' +
      '`/workflow save [last|runId] [名称] --global`，由 daemon 校验 canOperate 权限',
    );
  }
  if (args.some((token) => token === '--ack-unsafe' || token.startsWith('--ack-unsafe='))) {
    throw new Error(
      'botmux workflow save 不接受 --ack-unsafe：agent 不能代替用户确认疑似 secret/绝对路径；' +
      '请先向用户展示 lint，再由用户在飞书中显式发送原 `/workflow save ... --ack-unsafe` 命令',
    );
  }
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (!token.startsWith('--')) continue;
    if (SAVE_BOOLEAN_FLAGS.has(token)) continue;
    if (SAVE_FLAGS_WITH_VALUE.has(token)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`botmux workflow save 参数 ${token} 缺少值`);
      }
      index++;
      continue;
    }
    const matchedValueFlag = [...SAVE_FLAGS_WITH_VALUE]
      .find((flag) => token.startsWith(`${flag}=`));
    if (matchedValueFlag) {
      if (token.length === matchedValueFlag.length + 1) {
        throw new Error(`botmux workflow save 参数 ${matchedValueFlag} 缺少值`);
      }
      continue;
    }
    // Preserve the historical CLI surface: unknown `--*` tokens are ignored
    // by positional parsing. Only the three agent-forbidden authority flags
    // above are security decisions; tightening unrelated tokens here would be
    // a compatibility break for existing callers.
  }
}

export async function assertAgentFacingAppendScope(
  dataDir: string,
  workflowId: string,
  context: SavedWorkflowActorContext,
  resolveVisible: typeof resolveVisibleSavedWorkflow = resolveVisibleSavedWorkflow,
): Promise<void> {
  // Resolve through the application-service visibility boundary before
  // revealing scope. A guessed ID owned by another app/chat must look exactly
  // like a missing workflow to the agent-facing CLI.
  const metadata = await resolveVisible({
    dataDir,
    ref: workflowId,
    context,
    includeDrafts: true,
  });
  if (metadata.scope.kind === 'global') {
    throw new Error(
      `agent-facing CLI 不能修改当前 Bot 全局 Saved Workflow ${workflowId}：` +
      '该操作需要 daemon 侧 canOperate 授权，当前版本请新建 chat scope 版本或等待 IM 编辑入口',
    );
  }
}

/**
 * Parse Saved Workflow CLI params without confusing another option's value for
 * a bare `key=value` param. The null-prototype result and reserved-name guard
 * keep `__proto__` from becoming an inherited assignment rather than input.
 */
export function collectSavedWorkflowRawParams(args: string[]): Record<string, RawParamInput> {
  const out = Object.create(null) as Record<string, RawParamInput>;
  const ingest = (pair: string | undefined, kind: 'string' | 'json' = 'string'): void => {
    if (!pair) throw new Error('参数必须是 key=value');
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error(`参数必须是 key=value：${pair}`);
    const key = pair.slice(0, eq);
    if (!SAVED_WORKFLOW_PARAM_NAME_RE.test(key) || FORBIDDEN_PARAM_NAMES.has(key)) {
      throw new Error(`参数名非法：${key}`);
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error(`参数重复：${key}`);
    const value = pair.slice(eq + 1);
    if (kind === 'json') {
      try {
        out[key] = { kind: 'json', value: JSON.parse(value) as unknown };
      } catch (err) {
        throw new Error(
          `--param-json ${key} 不是有效 JSON：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      out[key] = { kind: 'string', value };
    }
  };

  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--param') {
      ingest(args[++i]);
      continue;
    }
    if (token.startsWith('--param=')) {
      ingest(token.slice('--param='.length));
      continue;
    }
    if (token === '--param-json') {
      ingest(args[++i], 'json');
      continue;
    }
    if (token.startsWith('--param-json=')) {
      ingest(token.slice('--param-json='.length), 'json');
      continue;
    }
    if (RUN_FLAGS_WITH_VALUE.has(token)) {
      // The value may legitimately contain '=' (for example a filesystem
      // path); it belongs to the option, never to workflow params.
      if (i + 1 < args.length) i++;
      continue;
    }
    if ([...RUN_FLAGS_WITH_VALUE].some((flag) => token.startsWith(`${flag}=`))) continue;
    if (!token.startsWith('--') && token.includes('=') && i > 0) ingest(token);
  }
  return out;
}

async function startMaterializedRun(runId: string, larkAppId: string): Promise<void> {
  const daemon = findOnlineDaemon(larkAppId);
  if (!daemon) throw new Error(`bot ${larkAppId} 的 daemon 不在线，run 已物化但尚未启动：${runId}`);
  const response = await postWorkflowDaemonMutation({ daemon, runId, mutation: 'start' });
  if (!response.ok) {
    throw new Error(`daemon start 失败 (HTTP ${response.status}): ${response.bodyRaw}`);
  }
}

export async function cmdSavedWorkflow(sub: string, args: string[]): Promise<void> {
  const context = contextFromEnv();
  const dataDir = libraryDataDir(args);
  const baseDir = runsBaseDir(args);
  const json = hasFlag(args, '--json');

  if (sub === 'save') {
    // Global publication is an IM authorization decision (`canOperate`), not
    // something an agent-facing child process can prove from session files.
    // Keep this path chat-scoped and require the daemon-owned slash command
    // for the privileged scope transition.
    assertAgentFacingSaveScope(args);
    const positional = positionals(args, [
      '--library-dir', '--base-dir', '--workflow-id', '--expected-revision',
    ]);
    const source = positional[0] ?? 'last';
    const displayName = positional.slice(1).join(' ').trim() || undefined;
    const workflowId = argValue(args, '--workflow-id');
    if (workflowId) await assertAgentFacingAppendScope(dataDir, workflowId, context);
    const runDir = await resolveOwnedTerminalRunDir({ baseDir, source, context });
    const result = await saveTerminalRunAsWorkflow(workflowId ? {
      dataDir,
      runDir,
      context,
      workflowId,
      expectedLatestRevision: argValue(args, '--expected-revision'),
      allowDraft: hasFlag(args, '--allow-draft'),
      acknowledgeUnsafeLiterals: false,
    } : {
      dataDir,
      runDir,
      context,
      ...(displayName ? { displayName } : {}),
      scope: 'chat',
      allowDraft: hasFlag(args, '--allow-draft'),
      acknowledgeUnsafeLiterals: false,
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(
        `${result.created ? '✅ 已保存' : '✅ 已追加版本'}：${result.metadata.displayName}\n` +
        `workflowId: ${result.metadata.workflowId}\n` +
        `revision: ${result.revision.revisionId} (v${result.revision.payload.humanVersion})\n` +
        `status: ${result.metadata.status}`,
      );
    }
    return;
  }

  if (sub === 'run') {
    assertDaemonManagedRunBaseDir(baseDir);
    const positional = positionals(args, ['--library-dir', '--base-dir', '--param', '--param-json', '--run-id']);
    const ref = positional.find((token) => !token.includes('='));
    if (!ref) throw new Error('用法: botmux workflow run <名称|workflowId> [--param key=value]');
    const materialized = await instantiatePublishedSavedWorkflow({
      dataDir,
      ref,
      context,
      rawParams: collectSavedWorkflowRawParams(args),
      bots: loadBotConfigs(),
      baseDir,
      runId: argValue(args, '--run-id'),
    });
    await startMaterializedRun(materialized.runId, context.actor.larkAppId);
    if (json) console.log(JSON.stringify({ runId: materialized.runId, runDir: materialized.runDir }, null, 2));
    else console.log(`✅ Saved Workflow 已启动：${materialized.runId}`);
    return;
  }

  if (sub === 'list' || sub === 'ls') {
    const listed = await listVisibleSavedWorkflows({ dataDir, context });
    console.log(formatSavedWorkflowCliList(listed, json));
    return;
  }

  if (sub === 'show') {
    const ref = positionals(args, ['--library-dir', '--base-dir'])[0];
    if (!ref) throw new Error('用法: botmux workflow show <名称|workflowId>');
    const loaded = await loadVisibleSavedWorkflow({ dataDir, ref, context });
    console.log(formatSavedWorkflowCliShow(loaded, context, json));
    return;
  }

  throw new Error(`未知 Saved Workflow 子命令：${sub}`);
}
