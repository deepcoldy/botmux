import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 角色库根：v0 固定约定，不做配置。 */
export function roleLibraryRoot(): string {
  return join(homedir(), 'botmux-roles');
}

/** 文件系统身份包含判断（dev+ino）：从 childReal 逐级向上，某祖先与 rootReal 同一目录即包含。
 *  不依赖字符串大小写语义——大小写敏感/不敏感卷、darwin/linux 行为一致。
 *  childReal === rootReal 时首个检查从其父目录开始，天然拒绝根本身。 */
function isContainedIn(childReal: string, rootReal: string): boolean {
  const root = statSync(rootReal);
  let cur = childReal;
  while (true) {
    const parent = dirname(cur);
    if (parent === cur) return false;
    const st = statSync(parent);
    if (st.dev === root.dev && st.ino === root.ino) return true;
    cur = parent;
  }
}

/**
 * botmux cd 的目标目录硬校验（调用方是模型，不可信）：
 * realpath 归一化（防 ../ 与符号链接逃逸）→ 必须位于角色库根之下
 * （文件系统身份 dev+ino 比较，防前缀兄弟目录与大小写变体绕过）→ 必须是已存在的目录。
 */
export function validateRoleLibraryPath(
  input: string,
  rootOverride?: string,
): { ok: true; resolvedPath: string } | { ok: false; error: string } {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: false, error: 'empty_path' };
  // 维持「单行注入」不变量（与 slash 校验的 multiline_rejected 对称）：拒绝内嵌
  // 控制字符，防止 /cd 路径把第二条命令伪装进注入的 text→Enter 窗口。范围覆盖全部
  // C0 控制字符 + DEL（\x00-\x1f\x7f），不只是 \r\n——tab、ESC（\x1b，可能携带
  // 终端转义序列）、backspace 等同样能在 sendRawCommandLine 的 text→Enter 窗口里
  // 污染 TUI 输入行。
  if (/[\x00-\x1f\x7f]/.test(raw)) return { ok: false, error: 'invalid_path_chars' };
  // `~` 展开，与 IM /cd 的 validateWorkingDir 行为一致：调用方（模型）常写带引号的
  // "~/botmux-roles/..."（shell 不展开），不该因此误报 dir_not_found。裸 `~` 展开后
  // 是 home 本身，仍会被下面的包含性判断拒绝。
  const expanded = raw === '~' ? homedir()
    : raw.startsWith('~/') ? join(homedir(), raw.slice(2))
    : raw;
  let rootReal: string;
  try { rootReal = realpathSync(rootOverride ?? roleLibraryRoot()); }
  catch { return { ok: false, error: 'role_library_missing' }; }
  let real: string;
  try { real = realpathSync(expanded); }
  catch { return { ok: false, error: 'dir_not_found' }; }
  // 库内符号链接可能指向含换行等控制字符的目录名，把 raw 处的干净校验洗掉——
  // resolvedPath 是最终写回调用方（进而可能被注入）的值，必须同样校验。
  if (/[\x00-\x1f\x7f]/.test(real)) return { ok: false, error: 'invalid_path_chars' };
  if (!isContainedIn(real, rootReal)) return { ok: false, error: 'outside_role_library' };
  try { if (!statSync(real).isDirectory()) return { ok: false, error: 'not_a_directory' }; }
  catch { return { ok: false, error: 'dir_not_found' }; }
  return { ok: true, resolvedPath: real };
}
