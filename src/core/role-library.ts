import { lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** 角色库根：v0 固定约定，不做配置。 */
export function roleLibraryRoot(): string {
  return join(homedir(), 'botmux-roles');
}

/** appId 必须是「单段目录名」：它要被拼进沙盒 readWrite 白名单路径，含 `/` 或
 *  `.`/`..` 的值会被 join/realpath 归一到**角色库之外**（`join(root, '../../.ssh')`
 *  = `~/.ssh`），把 rw 授给任意目录。bots.json 是机主自己写的，但手改/拼错不该
 *  升级成一次沙盒逃逸。 */
const APP_ID_SEGMENT_RE = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;

/**
 * 该 bot 自己的角色库子树（`<角色库根 realpath>/<appId>`）——沙盒 readWrite 白名单用。
 * 任何一步不满足就返回 null：宁可不产生规则（角色系统不可用，机主看得见查得到），
 * 也不能把 readWrite 授到角色库之外。
 *
 * 三道校验，缺一不可：
 * 1. appId 形状（单段目录名）——见 APP_ID_SEGMENT_RE。
 * 2. 只 realpath 角色库根的**父目录**，然后 `botmux-roles` 与 `<appId>` 这**最后两段
 *    各自 lstat、必须是真目录**。为什么这么切：沙盒两个引擎都按 canonical 路径匹配，
 *    `$HOME` 本身是符号链接的机器（`/home/u` → `/data00/home/u` 这一类）不归一会静默
 *    fail-open——所以上层中间段必须 realpath、也允许它们是链接；但最后两段一旦跟链，
 *    「授权本 bot 的角色库」就变成「授权链接指向的任意目录」。
 * 3. 因此末两段用 **lstat 而不是 stat/realpath**：若 `<root>` 或 `<root>/<appId>` 在
 *    spawn 前已被摆成指向 `~/.ssh`、`~/.botmux` 或**另一个 bot 的角色库**的符号链接，
 *    跟随解析会把链接目标当成本 bot 的子树直接授 rw —— 任意目录读写 + 跨 bot 越权。
 *    末两段确定不是链接、上层已 realpath，返回值天然是 canonical 路径，调用方不得再
 *    realpath（再跟一次就把这道校验作废了）。
 *
 * 明确不在本函数（也不在本文件）射程内的两件事，都需要宿主级写权限，而拿到宿主级写
 * 权限的人本来就能直接改 bots.json 关掉沙盒 —— 且这两条对策略里**每一条**路径规则
 * （workingDir、botHome、cliDataPaths…全都在同一时点做一次存在性检查）都同样成立，
 * 只为这一条规则加固属于安全戏剧：
 * - TOCTOU：lstat 之后、真正 spawn/bind 之前把目录换成符号链接。路径型沙盒（Seatbelt
 *   吃路径字符串、bwrap 吃 bind 源）无法靠持 fd 关闭这个窗口。
 * - mount point：末段是 bind/FUSE 挂载点时仍是「真目录」，能把挂载目标整棵授出去。
 *
 * 另一件既有遗留：大小写不敏感卷上两个仅大小写不同的 appId 指向同一目录。那是角色库
 * 按 appId 分目录这个布局本身的性质（不开沙盒也一样共享），要治得在 bot 配置加载期按
 * 文件系统身份拒绝碰撞。
 */
export function roleLibrarySubtree(appId: string, rootOverride?: string): string | null {
  if (typeof appId !== 'string' || !APP_ID_SEGMENT_RE.test(appId)) return null;
  const root = rootOverride ?? roleLibraryRoot();
  const realDir = (p: string): string | null => {
    try {
      const st = lstatSync(p);
      return st.isSymbolicLink() || !st.isDirectory() ? null : p;
    } catch { return null; }
  };
  let parentReal: string;
  try { parentReal = realpathSync(dirname(root)); } catch { return null; }
  const rootPath = realDir(join(parentReal, basename(root)));
  if (!rootPath) return null;
  return realDir(join(rootPath, appId));
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
 * `botmux role switch` 的目标目录硬校验（调用方是模型，不可信）：
 * realpath 归一化（防 ../ 与符号链接逃逸）→ 必须位于角色库根之下
 * （文件系统身份 dev+ino 比较，防前缀兄弟目录与大小写变体绕过）→ 必须是已存在的目录。
 *
 * 传了 `ownAppId` 时**收窄到该 bot 自己的子树** `<角色库根>/<appId>`：不传等同旧行为
 * （只 pin 全局根）。收窄的理由是不收窄就能切进**别的 bot 的角色目录**——`/cd` 路由随后
 * 把 `ds.workingDir` 钉过去（`dashboard-ipc-server.ts`），而 `ds.workingDir` 在 fs-policy
 * 里**永远拿 readWrite**，于是那个 bot 的沙盒会话拿到对方角色目录（含 `users/<别人
 * openId>/` 私有角色）的 readWrite——rw 从 workingDir 那条腿来，不是从角色库专用 grant
 * （后者按本 bot appId keying，对错位目标返 null）。
 *
 * **FAIL-CLOSED（codex delta review）**：传了 `ownAppId` 但 `<根>/<appId>` 不是真目录
 * （旧 runbook 用人类 slug 命名这一层，或被摆成符号链接）时**直接拒绝**
 * （`own_role_library_missing`），**不回落全局根**。曾经的「回落全局根」是 fail-open：
 * 存量非 appId 布局下它让 `botmux role switch` 继续能切进任意 bot 的库内目录并经
 * workingDir 拿 rw，正是收窄要堵的越权。fail-closed 的代价是存量非 appId 部署在迁移
 * （`docs/roles/deploy-runbook.md` §8：把这层目录名改成 appId）之前切不动角色——但
 * 沙盒下角色系统本就 EPERM 不可用，fail-closed 不额外损失可用功能；非沙盒部署迁移一次
 * 即恢复。人工 IM `/cd` 不走本校验（走 `validateWorkingDir`），不受影响。
 */
export function validateRoleLibraryPath(
  input: string,
  rootOverride?: string,
  ownAppId?: string,
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
  // 收窄边界：本 bot 自己的子树。传了 ownAppId 但子树不是真目录（缺失/文件/符号链接）
  // → FAIL-CLOSED，绝不回落全局根（回落是 fail-open，见函数注释）。
  if (ownAppId) {
    const ownSubtree = roleLibrarySubtree(ownAppId, rootOverride);
    if (!ownSubtree) return { ok: false, error: 'own_role_library_missing' };
    let real: string;
    try { real = realpathSync(expanded); }
    catch { return { ok: false, error: 'dir_not_found' }; }
    if (/[\x00-\x1f\x7f]/.test(real)) return { ok: false, error: 'invalid_path_chars' };
    if (!isContainedIn(real, ownSubtree)) {
      // 区分两种越界，便于运营自查：在库内但不在自己子树 → 跨 bot（同样 403）。
      return {
        ok: false,
        error: isContainedIn(real, rootReal) ? 'outside_own_role_library' : 'outside_role_library',
      };
    }
    try { if (!statSync(real).isDirectory()) return { ok: false, error: 'not_a_directory' }; }
    catch { return { ok: false, error: 'dir_not_found' }; }
    return { ok: true, resolvedPath: real };
  }
  // 未传 ownAppId：旧行为，只 pin 全局根（内部/测试调用方）。
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
