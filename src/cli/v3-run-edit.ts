/**
 * `botmux workflow status|edit` — agent-facing runtime flow edits (design
 * §13.1). Parsing and response formatting live here so they are testable
 * without spawning the CLI; cli.ts wires authorization and daemon IPC.
 */

import { readFileSync } from 'node:fs';

import { WORKFLOW_DAEMON_IPC_BODY_LIMIT_BYTES } from '../workflows/v3/daemon-ipc-auth.js';
import { V3_REVISION_REASON_LABELS } from '../im/lark/v3-revision-card.js';
import type { V3RevisionConfirmReason } from '../workflows/v3/event-contract.js';
import { formatV3RunStatus, type V3RunStatusView } from '../workflows/v3/run-edit.js';

export const V3_RUN_EDIT_USAGE =
  '用法: botmux workflow edit <runId> --patch-file <文件|-> --base <版本> [--json]';
export const V3_RUN_STATUS_USAGE = '用法: botmux workflow status <runId> [--json]';

export type V3RunEditCliOptions =
  | { ok: true; patchFile: string; base: number; json: boolean }
  | { ok: false; error: string };

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value === undefined || (value.startsWith('--') && value !== '-') ? '' : value;
}

export function parseV3RunEditCliOptions(rest: readonly string[]): V3RunEditCliOptions {
  const known = new Set(['--patch-file', '--base', '--json']);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith('--')) continue;
    if (!known.has(arg)) return { ok: false, error: `未知参数 ${arg}` };
    if (arg !== '--json') i++;
  }
  const patchFile = flagValue(rest, '--patch-file');
  if (!patchFile) return { ok: false, error: '缺少 --patch-file <文件|->' };
  const baseRaw = flagValue(rest, '--base');
  if (!baseRaw) return { ok: false, error: '缺少 --base <版本>（先用 botmux workflow status 读当前版本）' };
  const base = Number(baseRaw);
  if (!Number.isSafeInteger(base) || base < 1) return { ok: false, error: `--base 必须是正整数（收到 ${baseRaw}）` };
  return { ok: true, patchFile, base, json: rest.includes('--json') };
}

/** Read and parse the patch JSON from a file or `-` (stdin). The engine
 *  validates its structure; this only guarantees it is JSON and fits IPC. */
export function readV3RunEditPatch(
  patchFile: string,
  readStdin: () => string = () => readFileSync(0, 'utf-8'),
): unknown {
  const text = patchFile === '-' ? readStdin() : readFileSync(patchFile, 'utf-8');
  let patch: unknown;
  try {
    patch = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`patch 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  // Room for the base/caller envelope around the patch.
  if (Buffer.byteLength(JSON.stringify(patch), 'utf-8') > WORKFLOW_DAEMON_IPC_BODY_LIMIT_BYTES - 1024) {
    throw new Error('patch 太大：一次修改请控制在 15KB 以内，拆成多次 edit');
  }
  return patch;
}

function reasonText(reasons: unknown): string {
  if (!Array.isArray(reasons)) return '';
  return reasons
    .map((reason) => V3_REVISION_REASON_LABELS[reason as V3RevisionConfirmReason] ?? String(reason))
    .join('；');
}

function revisionRefs(value: unknown): Array<{ revision: number; from?: unknown; cause?: unknown; card?: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { revision: number; from?: unknown; cause?: unknown; card?: unknown } =>
    !!item && typeof item === 'object' && typeof (item as { revision?: unknown }).revision === 'number');
}

/** Why a direct edit voided a pending change (V3ProposalVoidCause). */
const VOID_CAUSE_TEXT: Record<string, string> = {
  overlap: '和这次修改涉及同一批节点',
  notApplicable: '套到新版本上已无法生效（例如重做额度已被这次修改用完，或它依赖的节点变了）',
  meaningChanged: '套到新版本上后，改动内容或需要确认的原因和确认卡上的不一样了',
  carryFailed: '没能顺延到新版本（记录写入失败）',
};

/** Map the daemon's edit response to CLI output + exit code. */
export function formatV3RunEditResponse(
  runId: string,
  response: { ok: boolean; status: number; bodyRaw: string },
): { exitCode: number; text: string } {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(response.bodyRaw) as Record<string, unknown>;
  } catch {
    // fall through with the raw body
  }
  if (response.ok && body.kind === 'applied') {
    const lines = [`✅ run ${runId} 已改为第 ${String(body.revision)} 版：${String(body.summary ?? '')}`];
    for (const item of revisionRefs(body.voidedProposals)) {
      const card = item.card === 'frozen' ? '（确认卡已冻结）' : item.card === 'failed' ? '（确认卡没能冻结，点了也不会生效）' : '';
      lines.push(`⚠️ 第 ${item.revision} 版待确认修改${VOID_CAUSE_TEXT[String(item.cause)] ?? '在这次修改生效后已不再适用'}，已作废${card}；需要的话基于第 ${String(body.revision)} 版重新提。`);
    }
    for (const item of revisionRefs(body.carriedProposals)) {
      const card = item.card === 'moved' ? '原确认卡已更新为新版本'
        : item.card === 'posted' ? '已发新的确认卡'
          : '确认卡暂时没发出去，daemon 恢复后会重发';
      lines.push(`⏳ 第 ${String(item.from)} 版待确认修改和这次修改不相关，顺延为第 ${item.revision} 版，继续等发起人确认（${card}）。`);
    }
    return { exitCode: 0, text: lines.join('\n') };
  }
  if (response.ok && body.kind === 'proposed') {
    return {
      exitCode: 0,
      text:
        `⏳ 第 ${String(body.revision)} 版需要发起人确认（${reasonText(body.reasons)}），` +
        (body.cardPosted === false
          ? '确认卡发送失败，daemon 恢复后会重发；'
          : '已在主话题发「流程修改确认」卡；') +
        '确认前涉及的节点暂停派发，其余节点照常运行。',
    };
  }
  if (response.status === 409 && body.error === 'revision_conflict') {
    const status = body.status as V3RunStatusView | undefined;
    return {
      exitCode: 3,
      text:
        `❌ 版本冲突：当前已是第 ${String(body.currentRevision)} 版，请重新读取状态后基于最新版本再改。` +
        (status ? `\n${formatV3RunStatus(status)}` : ''),
    };
  }
  if (response.status === 422 && Array.isArray(body.problems)) {
    const grant = body.rerunBudget
      ? body.grantCardPosted === false
        ? '\n追加重做额度卡发送失败，请让发起人稍后重试。'
        : body.grantCardPosted === 'already'
          ? '\n主话题里已有这次的「追加重做额度」卡，等发起人处理，不要反复提交。'
          : '\n已在主话题发「追加重做额度」卡；发起人同意后，用同样的 patch 重新提交。'
      : '';
    return { exitCode: 2, text: `❌ 修改未通过校验：\n  - ${(body.problems as unknown[]).map(String).join('\n  - ')}${grant}` };
  }
  if (body.error === 'proposal_pending') {
    return { exitCode: 1, text: `❌ ${String(body.detail ?? '已有待确认的修改，请等发起人处理')}` };
  }
  if (body.error === 'run_not_editable') {
    return { exitCode: 1, text: `❌ run ${runId} 当前不能修改${body.detail ? `：${String(body.detail)}` : ''}` };
  }
  return { exitCode: 1, text: `❌ edit 失败 (HTTP ${response.status}): ${response.bodyRaw}` };
}
