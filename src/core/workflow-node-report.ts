/**
 * Structured submission of a bot-executed workflow node (design 2026-11-03
 * §7.2): `botmux report --dispatch-root <handoff> --status completed
 * --output <key>=<path> --result-file <path>`.
 *
 *   CLI (reads files in its own view, incl. sandbox)
 *     → its own daemon, session-authenticated   (WORKFLOW_NODE_REPORT_ROUTE)
 *       verifies the signed handoff binding, pre-validates the node contract
 *     → the main bot's daemon, trusted-host IPC  (WORKFLOW_HANDOFF_EVENT_ROUTE)
 *       the only journal writer: ingest / blocked / accepted / stalled, then
 *       re-drives the run
 *
 * Errors travel back verbatim so the bot can fix and resubmit in the same
 * turn; the node stays running until a submission validates.
 *
 * Size bounds: the largest existing daemon IPC request body is the decision
 * board's 16 MiB (base64 images). Submissions ride base64 inside JSON (4/3
 * growth), so one submission is capped at 8 MiB of raw file bytes (≈10.7 MiB
 * encoded) with at most 4 MiB per file and 32 files; the request body limit is
 * 12 MiB. Bigger products (code changes, datasets) belong in result.json as a
 * branch name or link.
 */

import { V3_ARTIFACT_OUTPUT_KEY_RE } from '../workflows/v3/artifact-contract-declarations.js';
import type { V3GoalNode } from '../workflows/v3/dag.js';

export const WORKFLOW_NODE_REPORT_ROUTE = '/api/workflow/node-report';
export const WORKFLOW_HANDOFF_EVENT_ROUTE = '/api/workflow/handoff-event';
export const WORKFLOW_HANDOFF_STOP_ROUTE = '/api/workflow/handoff-stop';

export const WORKFLOW_SUBMISSION_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const WORKFLOW_SUBMISSION_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const WORKFLOW_SUBMISSION_MAX_FILES = 32;
export const WORKFLOW_NODE_REPORT_MAX_BODY_BYTES = 12 * 1024 * 1024;
export const WORKFLOW_HANDOFF_EVENT_MAX_BODY_BYTES = WORKFLOW_NODE_REPORT_MAX_BODY_BYTES;
/** Bound for `result.json` (it is parsed in memory on both daemons). */
export const WORKFLOW_RESULT_MAX_BYTES = 1024 * 1024;

// ─── CLI side ─────────────────────────────────────────────────────────────

export interface WorkflowReportArgs {
  outputs: Array<{ key: string; path: string }>;
  resultFile?: string;
}

/** Parse the repeatable `--output <key>=<path>` and the single
 *  `--result-file <path>`. Pure; no file access. */
export function parseWorkflowReportArgs(args: readonly string[]): { ok: true; value: WorkflowReportArgs } | { ok: false; error: string } {
  const outputs: WorkflowReportArgs['outputs'] = [];
  let resultFile: string | undefined;
  let resultFileCount = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let value: string | undefined;
    let flag: '--output' | '--result-file' | undefined;
    if (arg === '--output' || arg === '--result-file') {
      flag = arg;
      value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return { ok: false, error: `${arg} 需要一个值。` };
      i++;
    } else if (arg.startsWith('--output=')) {
      flag = '--output';
      value = arg.slice('--output='.length);
    } else if (arg.startsWith('--result-file=')) {
      flag = '--result-file';
      value = arg.slice('--result-file='.length);
    }
    if (!flag) continue;
    if (flag === '--result-file') {
      resultFileCount++;
      if (!value!.trim()) return { ok: false, error: '--result-file 需要一个文件路径。' };
      resultFile = value!;
      continue;
    }
    const eq = value!.indexOf('=');
    const key = eq > 0 ? value!.slice(0, eq) : '';
    const path = eq > 0 ? value!.slice(eq + 1) : '';
    if (!key || !path.trim()) return { ok: false, error: `--output 必须写成 <key>=<路径>：${value}` };
    if (!V3_ARTIFACT_OUTPUT_KEY_RE.test(key)) return { ok: false, error: `--output 的 key 不合法：${key}` };
    if (outputs.some((output) => output.key === key)) return { ok: false, error: `--output ${key} 重复了。` };
    outputs.push({ key, path });
  }
  if (resultFileCount > 1) return { ok: false, error: '--result-file 只能指定一次。' };
  if (outputs.length > WORKFLOW_SUBMISSION_MAX_FILES) {
    return { ok: false, error: `一次最多提交 ${WORKFLOW_SUBMISSION_MAX_FILES} 个 --output。` };
  }
  return { ok: true, value: { outputs, ...(resultFile !== undefined ? { resultFile } : {}) } };
}

export interface WorkflowSubmissionFileReader {
  /** Size of a regular file, or a readable error. */
  size(path: string): { ok: true; bytes: number } | { ok: false; error: string };
  read(path: string): Buffer;
}

export interface WorkflowSubmissionPayload {
  files: Array<{ key: string; name: string; data: string }>;
  resultText?: string;
}

/** Read the submitted files within the bounds (sizes checked before reading). */
export function readWorkflowSubmissionFiles(
  args: WorkflowReportArgs,
  reader: WorkflowSubmissionFileReader,
): { ok: true; value: WorkflowSubmissionPayload } | { ok: false; error: string } {
  let total = 0;
  const files: WorkflowSubmissionPayload['files'] = [];
  for (const output of args.outputs) {
    const size = reader.size(output.path);
    if (!size.ok) return { ok: false, error: `--output ${output.key}：${size.error}` };
    if (size.bytes > WORKFLOW_SUBMISSION_MAX_FILE_BYTES) {
      return { ok: false, error: `--output ${output.key} 超过单文件上限 ${WORKFLOW_SUBMISSION_MAX_FILE_BYTES} 字节；大产物请提交分支名或链接（写进 result.json）。` };
    }
    total += size.bytes;
    if (total > WORKFLOW_SUBMISSION_MAX_TOTAL_BYTES) {
      return { ok: false, error: `本次提交的文件合计超过 ${WORKFLOW_SUBMISSION_MAX_TOTAL_BYTES} 字节；大产物请提交分支名或链接（写进 result.json）。` };
    }
    const name = output.path.split(/[\\/]/).pop() || output.key;
    files.push({ key: output.key, name, data: reader.read(output.path).toString('base64') });
  }
  let resultText: string | undefined;
  if (args.resultFile !== undefined) {
    const size = reader.size(args.resultFile);
    if (!size.ok) return { ok: false, error: `--result-file：${size.error}` };
    if (size.bytes > WORKFLOW_RESULT_MAX_BYTES) {
      return { ok: false, error: `--result-file 超过上限 ${WORKFLOW_RESULT_MAX_BYTES} 字节。` };
    }
    resultText = reader.read(args.resultFile).toString('utf-8');
  }
  return { ok: true, value: { files, ...(resultText !== undefined ? { resultText } : {}) } };
}

// ─── Wire shapes ────────────────────────────────────────────────────────────

export type WorkflowReportStatus = 'completed' | 'blocked' | 'failed' | 'in_progress' | 'pending';

export interface WorkflowNodeReportRequest {
  dispatchRoot: string;
  status?: WorkflowReportStatus;
  content: string;
  files?: Array<{ key: string; name: string; data: string }>;
  resultText?: string;
}

/** Decoded submission after bounds checks (both daemons re-check). */
export interface DecodedWorkflowSubmission {
  files: Array<{ key: string; name: string; data: Buffer }>;
  resultText?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Decode and re-bound base64 files from an untrusted request body. */
export function decodeWorkflowSubmission(raw: unknown):
  { ok: true; value: DecodedWorkflowSubmission } | { ok: false; error: string } {
  const body = isRecord(raw) ? raw : {};
  const rawFiles = body.files === undefined ? [] : body.files;
  if (!Array.isArray(rawFiles)) return { ok: false, error: 'bad_files' };
  if (rawFiles.length > WORKFLOW_SUBMISSION_MAX_FILES) return { ok: false, error: 'too_many_files' };
  let total = 0;
  const files: DecodedWorkflowSubmission['files'] = [];
  for (const entry of rawFiles) {
    if (!isRecord(entry) || typeof entry.key !== 'string' || typeof entry.name !== 'string' || typeof entry.data !== 'string') {
      return { ok: false, error: 'bad_files' };
    }
    if (!V3_ARTIFACT_OUTPUT_KEY_RE.test(entry.key)) return { ok: false, error: 'bad_output_key' };
    const data = Buffer.from(entry.data, 'base64');
    if (data.length > WORKFLOW_SUBMISSION_MAX_FILE_BYTES) return { ok: false, error: 'file_too_large' };
    total += data.length;
    if (total > WORKFLOW_SUBMISSION_MAX_TOTAL_BYTES) return { ok: false, error: 'submission_too_large' };
    files.push({ key: entry.key, name: entry.name.slice(0, 200), data });
  }
  if (body.resultText !== undefined && typeof body.resultText !== 'string') return { ok: false, error: 'bad_result' };
  const resultText = body.resultText as string | undefined;
  if (resultText !== undefined && Buffer.byteLength(resultText) > WORKFLOW_RESULT_MAX_BYTES) {
    return { ok: false, error: 'result_too_large' };
  }
  return { ok: true, value: { files, ...(resultText !== undefined ? { resultText } : {}) } };
}

/**
 * Pre-validation against the node contract on the executing bot's daemon
 * (§7.2 step 2). The main bot's daemon re-validates everything; this only
 * fails fast on what is certain from the declaration alone.
 */
export function precheckWorkflowSubmission(
  node: Pick<V3GoalNode, 'id' | 'outputs' | 'resultSchema'>,
  submission: { files: ReadonlyArray<{ key: string }>; resultText?: string },
): { ok: true; result?: unknown } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const declared = node.outputs;
  if (declared) {
    for (const file of submission.files) {
      const declaration = Object.prototype.hasOwnProperty.call(declared, file.key) ? declared[file.key] : undefined;
      if (!declaration) {
        problems.push(`--output ${file.key}：节点「${node.id}」没有声明这个产出（声明的有：${Object.keys(declared).join(', ') || '无'}）`);
      } else if (declaration.kind === 'directory') {
        problems.push(`--output ${file.key}：目录型产出不能作为文件提交`);
      }
    }
  }
  let result: unknown;
  if (submission.resultText !== undefined) {
    try {
      result = JSON.parse(submission.resultText);
    } catch (err) {
      problems.push(`--result-file 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
    }
    if (result !== undefined && (!isRecord(result))) problems.push('result.json 顶层必须是 JSON 对象');
  }
  if (node.resultSchema) {
    if (submission.resultText === undefined) {
      problems.push(`节点「${node.id}」要求 result.json（字段：${Object.keys(node.resultSchema.properties).join(', ')}），请加 --result-file`);
    } else if (isRecord(result)) {
      for (const field of node.resultSchema.required ?? []) {
        if (!(field in result)) problems.push(`result.json 缺少必填字段 "${field}"`);
      }
    }
  }
  if (declared) {
    const submitted = new Set(submission.files.map((file) => file.key));
    for (const [key, declaration] of Object.entries(declared)) {
      if (declaration.path === 'result.json') continue; // carried by --result-file
      if (declaration.kind === 'directory') {
        problems.push(`节点声明了目录型产出 ${key}（${declaration.path}），交给 Bot 执行时还不能提交目录`);
        continue;
      }
      if (!submitted.has(key)) problems.push(`缺少声明的产出 ${key}（${declaration.path}），请加 --output ${key}=<路径>`);
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, ...(result !== undefined ? { result } : {}) };
}

/** User-facing text for an engine rejection of a late / foreign report. */
export const WORKFLOW_REPORT_REJECTION_TEXT: Record<string, string> = {
  'unknown-attempt': '这条交接不属于当前运行中的节点尝试',
  'run-not-running': '工作流已不在运行（已结束或受阻）',
  'already-succeeded': '本节点已完成，无需再交',
  superseded: '本次尝试已被返工或流程修改替代',
  retried: '本节点已重试，请按新的交接消息提交',
  cancelled: '工作流或本节点已取消',
  'timed-out': '本节点已超时，提交不再被接受',
  reassigned: '本节点已改派给其他 Bot',
  closed: '本次尝试已结束',
  'session-mismatch': '提交的会话不是接单的那个会话',
  'handed-to-human': '本节点已交给人决定，这次提交不再算数',
};
