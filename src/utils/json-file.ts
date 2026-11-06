/**
 * json-file.ts — JSON 状态文件的「软读」入口：损坏时隔离原文件，而不是让后续写入覆盖它。
 *
 * 为什么需要它：不少 store 的读路径长这样——
 *
 *   try { return JSON.parse(readFileSync(fp)) } catch { /* corrupt *\/ }
 *   return {};
 *
 * 服务得以继续运行，但 read-modify-write 的下一次写入会拿这份「空状态」原子地
 * 覆盖掉原文件——损坏的内容（往往还有大半可人工恢复的数据）就此静默丢失，而且
 * 没有任何日志。本 helper 把「损坏」这一分支改为：先把原文件 rename 成
 * `${path}.corrupt-<ms>` 留作证据，再返回 fallback。此后写入落在一个干净的路径上，
 * 不会碰隔离文件。
 *
 * 何时用（软读）：
 *   - 状态可丢弃 / 可重建，且服务必须继续运行（owner 映射、邀请码、配对、
 *     花名册缓存、卡片冻结态……），「空状态」是可接受的降级。
 *   - 读侧本来就是「损坏 → 空」，只是想让它不再顺手销毁证据。
 *
 * 何时不要用（应 fail-closed，让读错误向上抛）：
 *   - 读到的状态是后续动作的授权 / 去重 / 幂等依据，把损坏当「空」会 fail-open
 *     （例如严格模式的 async-trigger 失败证据、崩溃一致性日志、预算硬闸）。
 *   - 调用方需要区分「文件不存在」「文件损坏」「读不了」三种情形并分别处理。
 *   - 文件有多级恢复流程（先试备份、再试重建）——应自己编排，别藏进 fallback。
 *
 * 非解析类读错误（EACCES / EIO / EISDIR 等）：文件内容无法判断是否损坏，所以
 * **不隔离**（rename 既可能失败，也可能把一份完好的文件挪走），只 logger.warn
 * 并返回 fallback——与被替换的手写 `catch { return {} }` 行为一致。注意这意味着
 * 之后的写入仍可能覆盖那份读不了的文件；需要拒绝这种覆盖的调用方属于上面的
 * fail-closed 场景，不要用本 helper。
 *
 * 只管读。写入请直接用 `atomicWriteFileSync`（./atomic-write.ts），保留各 store
 * 自己的序列化格式 / mode。
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, renameSync, statSync } from 'node:fs';
import { errorMessage } from './error-message.js';
import { logger } from './logger.js';

export interface ReadJsonFileSoftOptions<T> {
  /** 文件不存在 / 损坏 / 读不了时的返回值。每次调用都会重新求值，可放心返回可变对象。 */
  fallback: () => T;
  /**
   * 形状校验（type guard）。JSON 能解析但 validate 返回 false（或抛出）视同损坏，
   * 同样会被隔离。省略则只检查「能不能解析」，调用方自己负责对结果做防御。
   */
  validate?: (v: unknown) => v is T;
  /** 日志里的 store 名，如 `bot-owner-store`。 */
  label: string;
}

/** 非 null、非数组的 JSON 对象——绝大多数 `Record<string, X>` 型 store 的顶层形状校验。 */
export function isJsonObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errCode(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err ? String((err as NodeJS.ErrnoException).code) : undefined;
}

/** 隔离目标：`${path}.corrupt-<ms>`；同毫秒已有同名文件时追加 `-<n>`，绝不覆盖先前的隔离文件。 */
function quarantinePathFor(path: string): string {
  const base = `${path}.corrupt-${Date.now()}`;
  let dest = base;
  for (let i = 1; existsSync(dest) && i < 1000; i++) dest = `${base}-${i}`;
  return dest;
}

/**
 * best-effort 隔离。`readIdent` 是读文件时那个 inode 的身份：多个读者同时撞上同一份
 * 损坏文件时，先到者隔离并写入新文件，后到者若按路径盲 rename，会把先到者刚写好的
 * 完好文件挪走——所以 rename 前核对路径上仍是当时读到的那个 inode，不是就放弃隔离。
 */
function quarantine(path: string, readIdent: { dev: number; ino: number } | undefined, reason: string, label: string): void {
  try {
    if (readIdent) {
      const cur = statSync(path);
      if (cur.dev !== readIdent.dev || cur.ino !== readIdent.ino) {
        logger.warn(`[json-file] ${label}: ${path} ${reason}, but it was replaced since it was read; not quarantining`);
        return;
      }
    }
    const dest = quarantinePathFor(path);
    renameSync(path, dest);
    logger.warn(`[json-file] ${label}: ${path} ${reason}; moved to ${dest}, continuing with fallback`);
  } catch (err) {
    logger.warn(`[json-file] ${label}: ${path} ${reason}; failed to quarantine (${errCode(err) ?? errorMessage(err)}), continuing with fallback — the next write may overwrite it`);
  }
}

/**
 * 读 JSON 文件；任何失败都返回 `fallback()`，且不会因损坏而让后续写入吞掉原文件。
 *
 *   - 不存在（ENOENT）            → fallback()，静默
 *   - JSON 解析失败 / validate 否 → 隔离为 `${path}.corrupt-<ms>`，warn，fallback()
 *   - 其它读错误（EACCES 等）     → 不隔离，warn，fallback()
 */
export function readJsonFileSoft<T>(path: string, opts: ReadJsonFileSoftOptions<T>): T {
  let raw: string;
  let ident: { dev: number; ino: number } | undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const st = fstatSync(fd);
    ident = { dev: st.dev, ino: st.ino };
    raw = readFileSync(fd, 'utf-8');
  } catch (err) {
    const code = errCode(err);
    if (code !== 'ENOENT') {
      logger.warn(`[json-file] ${opts.label}: cannot read ${path} (${code ?? errorMessage(err)}); using fallback without quarantining`);
    }
    return opts.fallback();
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    quarantine(path, ident, `is not valid JSON (${errorMessage(err)})`, opts.label);
    return opts.fallback();
  }

  if (opts.validate) {
    let ok = false;
    try { ok = opts.validate(parsed); } catch { ok = false; }
    if (!ok) {
      quarantine(path, ident, 'has an unexpected shape', opts.label);
      return opts.fallback();
    }
  }
  return parsed as T;
}
