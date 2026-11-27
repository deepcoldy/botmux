/**
 * Why a gateway could not write its state document (state.json), from the error
 * code of the failed write. One table for the gateway's log line and the
 * Dashboard server (which sends the cause; the frontend words it by that code,
 * in both UI languages), so the two never explain the same failure differently.
 *
 * Pure: no process code, no file access (the gateway and the Dashboard server
 * both import it; see test/wecom-import-boundaries.test.ts).
 */

export type WecomStateWriteFailureCause =
  | 'disk_full'
  | 'quota_exceeded'
  | 'permission_denied'
  | 'read_only'
  | 'io_error'
  | 'path_unusable'
  | 'too_many_open_files'
  | 'other'
  | 'unknown';

/**
 * The first failed write of a gateway's state document, as the gateway reports
 * it (WecomBridge `onStateWriteFailure`) and its runtime record carries it:
 * the error code when it has a valid one, when (epoch ms), and the state
 * directory (the directory of state.json; not a credential).
 */
export interface WecomStateWriteFailure {
  code?: string;
  at: number;
  directory: string;
}

/** The shape an error code must have to be kept: an errno name. Anything else is dropped. */
const ERROR_CODE = /^[A-Z0-9_]{1,32}$/;

/** `value` when it is a well-formed error code, else undefined. */
export function wecomStateWriteErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && ERROR_CODE.test(value) ? value : undefined;
}

const CAUSE_OF_CODE = new Map<string, WecomStateWriteFailureCause>([
  ['ENOSPC', 'disk_full'],
  ['EDQUOT', 'quota_exceeded'],
  ['EACCES', 'permission_denied'],
  ['EPERM', 'permission_denied'],
  ['EROFS', 'read_only'],
  ['EIO', 'io_error'],
  ['ENOENT', 'path_unusable'],
  ['ENOTDIR', 'path_unusable'],
  ['EISDIR', 'path_unusable'],
  ['EEXIST', 'path_unusable'],
  ['ELOOP', 'path_unusable'],
  ['ENAMETOOLONG', 'path_unusable'],
  ['EMFILE', 'too_many_open_files'],
  ['ENFILE', 'too_many_open_files'],
]);

/** The cause of a failed write: a well-formed code outside the table is `other`, no valid code `unknown`. */
export function wecomStateWriteFailureCause(code: unknown): WecomStateWriteFailureCause {
  const valid = wecomStateWriteErrorCode(code);
  if (!valid) {
    return 'unknown';
  }
  return CAUSE_OF_CODE.get(valid) ?? 'other';
}

/** Chinese words for each cause: what went wrong, and what to do before restarting the connection. */
const CAUSE_TEXT: Record<WecomStateWriteFailureCause, { reason: (code: string) => string; action: string }> = {
  disk_full: { reason: () => '磁盘空间已满', action: '清理状态目录所在磁盘的空间' },
  quota_exceeded: { reason: () => '磁盘配额已用完', action: '清理空间或调高配额' },
  permission_denied: { reason: () => '运行 botmux 的用户对状态目录没有写权限', action: '修正状态目录的属主或权限' },
  read_only: { reason: () => '状态目录所在的磁盘是只读的', action: '把该磁盘恢复为可写' },
  io_error: { reason: () => '磁盘读写出错（可能是硬件或文件系统故障）', action: '检查状态目录所在的磁盘' },
  path_unusable: {
    reason: () => '状态目录或状态文件的路径不可用（被删除、被别的文件占用，或路径不对）',
    action: '检查状态目录和其中的 state.json',
  },
  too_many_open_files: { reason: () => '打开的文件数达到系统上限', action: '调高上限，或关掉占用文件的进程' },
  other: { reason: code => `系统返回错误 ${code}`, action: '按该错误排查状态目录' },
  unknown: { reason: () => '原因未知', action: '查看这条连接的网关日志' },
};

/**
 * The cause of a failed write and its Chinese words. `reason` names the code
 * itself only for `other` (a code outside the table): a caller showing the
 * code next to any other reason adds it.
 */
export function describeWecomStateWriteFailure(code: unknown): {
  cause: WecomStateWriteFailureCause;
  code?: string;
  reason: string;
  action: string;
} {
  const valid = wecomStateWriteErrorCode(code);
  const cause = wecomStateWriteFailureCause(valid);
  const text = CAUSE_TEXT[cause];
  return { cause, ...(valid ? { code: valid } : {}), reason: text.reason(valid ?? ''), action: text.action };
}
