/**
 * atomic-write.ts — 原子写文件统一入口（tmp + rename）。
 *
 * 为什么需要它：裸 writeFileSync 在「写一半时被并发读 / 进程崩溃」下会让读者
 * 看到半截内容（torn read），对跨进程共享的 JSON 状态文件、被 watcher 当触发
 * 器消费的文件、被并发 exec 的脚本都是真实事故源（参考 cjadk settings.json
 * 覆盖事故）。POSIX rename(2) 同文件系统内原子替换：读者要么看到旧文件、要么
 * 看到完整新文件，永远不会看到中间态。
 *
 * tmp 命名带 pid + 随机后缀：多个进程并发写同一目标（如 30 个 daemon 齐写
 * bots-info.json）时，固定 `.tmp` 名会互相撕对方的半成品再 rename 上去——
 * 唯一名让每个写者各写各的，rename 收敛为 last-writer-wins。
 *
 * 约束：tmp 与目标同目录（同 fs 才保证 rename 原子且不跨设备失败）；失败时
 * best-effort 清理 tmp，绝不破坏旧文件。
 *
 * symlink：写前把目标解析到真实路径（realpath）再 rename。否则目标若是
 * symlink（如 dotfiles 用户软链管理的 ~/.claude/settings.json），rename 会把
 * 链接本体替换成普通文件——链接断掉、真实目标变孤儿；而被换掉的 in-place 写
 * 是穿透链接写真实目标的。目标不存在时退而解析父目录（覆盖「软链目录里建新
 * 文件」），悬空 symlink 这种病态形态不特判。
 */
import { writeFileSync, renameSync, unlinkSync, realpathSync, chmodSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, basename, join } from 'node:path';

export interface AtomicWriteOptions {
  /**
   * 文件权限（如 0o600 密钥 / 0o755 可执行脚本）。设置在 tmp 上，rename 后保留。
   * 严格生效：creation mode 会被 umask 截断（umask 077 下 0o755 落成 0o700），
   * 故写后再显式 chmod 到精确值——创建时仍传 mode 保证文件从不以比目标更宽的
   * 权限存在过（截断只会更紧），chmod 再放宽到精确值。
   */
  mode?: number;
  /** 文本编码，默认 utf-8（data 为 Buffer 时忽略）。 */
  encoding?: BufferEncoding;
}

/** 生成与目标同目录的唯一 tmp 路径。 */
function tmpPathFor(filePath: string): string {
  return `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

/** 解析 symlink 到真实路径；目标不存在时解析父目录，保持 in-place 写的穿透语义。 */
function resolveRealPathSync(filePath: string): string {
  try { return realpathSync(filePath); } catch { /* 目标尚不存在 */ }
  try { return join(realpathSync(dirname(filePath)), basename(filePath)); } catch { return filePath; }
}

async function resolveRealPath(filePath: string): Promise<string> {
  try { return await fsp.realpath(filePath); } catch { /* 目标尚不存在 */ }
  try { return join(await fsp.realpath(dirname(filePath)), basename(filePath)); } catch { return filePath; }
}

/**
 * 原子写（同步）：写同目录唯一 tmp → rename 覆盖目标。
 * 任何失败都不会影响目标文件的旧内容；tmp 残留会被 best-effort 清理。
 */
export function atomicWriteFileSync(
  filePath: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {},
): void {
  filePath = resolveRealPathSync(filePath);
  const tmp = tmpPathFor(filePath);
  try {
    writeFileSync(tmp, data, {
      encoding: typeof data === 'string' ? (options.encoding ?? 'utf-8') : undefined,
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    });
    if (options.mode !== undefined) chmodSync(tmp, options.mode);
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp 可能根本没写出来 */ }
    throw err;
  }
}

/**
 * 原子写（异步）：语义同 atomicWriteFileSync，给 async 调用链（workflow 运行时等）。
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  filePath = await resolveRealPath(filePath);
  const tmp = tmpPathFor(filePath);
  try {
    await fsp.writeFile(tmp, data, {
      encoding: typeof data === 'string' ? (options.encoding ?? 'utf-8') : undefined,
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    });
    if (options.mode !== undefined) await fsp.chmod(tmp, options.mode);
    await fsp.rename(tmp, filePath);
  } catch (err) {
    try { await fsp.unlink(tmp); } catch { /* tmp 可能根本没写出来 */ }
    throw err;
  }
}
