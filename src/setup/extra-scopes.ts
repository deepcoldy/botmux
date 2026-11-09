/**
 * `botmux setup add|configure --extra-scopes-file <json>`：调用方追加的权限清单。
 *
 * 内置清单（`lark-scopes.json`）覆盖 botmux 自身需要的权限；接入方（比如在 botmux
 * 之上跑自己 Agent 的项目）常常还要几项额外权限。以前只能建完应用再去开放平台手动
 * 导入，这里让调用方在建应用 / 重跑 configure 时一并带上。
 *
 * 支持两种文件格式：
 *   1. 与内置清单一致：`{"scopes":{"tenant":[...],"user":[...]}}`。桶对象只认 tenant /
 *      user 两个键，别的键多半是桶名拼错，直接报错。
 *   2. 条目列表：`{"scopes":[{"scope":"a:b","for":"..."}]}` 或 `["a:b", ...]`，
 *      条目没有 token 类型信息，一律视为 user 权限；条目里 scope 以外的字段当说明忽略。
 *      tenant 权限只能用第 1 种格式。
 *
 * 只做语法校验：平台目录里不存在的权限由 automateOpenPlatformSetup 跳过并在结果
 * `skippedScopes` 里如实列出，不让整个流程失败。
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ScopeManifest } from './open-platform-automation.js';
import { isValidLarkScopeSyntax } from '../utils/lark-scope-catalog.js';
import { expandHomePath } from '../utils/working-dir.js';

export interface NormalizedScopeManifest {
  scopes: { tenant: string[]; user: string[] };
}

const BUCKET_KEYS: readonly string[] = ['tenant', 'user'];

function collectEntry(entry: unknown, index: number): string {
  const raw = typeof entry === 'string'
    ? entry
    : entry && typeof entry === 'object' && typeof (entry as { scope?: unknown }).scope === 'string'
      ? (entry as { scope: string }).scope
      : undefined;
  if (raw === undefined) {
    throw new Error(`第 ${index + 1} 项既不是字符串也没有 scope 字段`);
  }
  return raw.trim();
}

function validateList(names: string[], label: string): string[] {
  const invalid = names.filter(name => !isValidLarkScopeSyntax(name));
  if (invalid.length > 0) {
    throw new Error(`${label} 含非法权限名: ${invalid.join(', ')}`);
  }
  return [...new Set(names)];
}

/** 解析追加权限清单的 JSON 文本。格式或权限名非法时抛 Error（message 面向用户）。 */
export function parseExtraScopeManifest(text: string): NormalizedScopeManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const scopes = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? (parsed as { scopes?: unknown }).scopes
      : undefined;

  if (Array.isArray(scopes)) {
    return { scopes: { tenant: [], user: validateList(scopes.map(collectEntry), 'scopes') } };
  }
  if (scopes && typeof scopes === 'object') {
    const unknownKeys = Object.keys(scopes).filter(key => !BUCKET_KEYS.includes(key));
    if (unknownKeys.length > 0) {
      throw new Error(`scopes 只接受 tenant / user 两个键，不认识: ${unknownKeys.join(', ')}`);
    }
    const buckets = scopes as { tenant?: unknown; user?: unknown };
    const read = (value: unknown, key: 'tenant' | 'user'): string[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
        throw new Error(`scopes.${key} 必须是字符串数组`);
      }
      return validateList((value as string[]).map(v => v.trim()), `scopes.${key}`);
    };
    return { scopes: { tenant: read(buckets.tenant, 'tenant'), user: read(buckets.user, 'user') } };
  }
  throw new Error('缺少 scopes 字段（需要 {"scopes":{"tenant":[],"user":[]}} 或 {"scopes":[{"scope":"..."}]}）');
}

/** 读取并解析追加权限清单文件；错误信息带上文件路径。 */
export function loadExtraScopeManifest(filePath: string): NormalizedScopeManifest {
  const abs = resolve(filePath);
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    throw new Error(`读取追加权限清单 ${abs} 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return parseExtraScopeManifest(text);
  } catch (err) {
    throw new Error(`追加权限清单 ${abs} 无效: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 按 tenant / user 两桶分别合并去重；base 的顺序在前。 */
export function mergeScopeManifests(base: ScopeManifest, extra: ScopeManifest): NormalizedScopeManifest {
  const merge = (a: string[] | undefined, b: string[] | undefined) => [...new Set([...(a ?? []), ...(b ?? [])])];
  return {
    scopes: {
      tenant: merge(base.scopes?.tenant, extra.scopes?.tenant),
      user: merge(base.scopes?.user, extra.scopes?.user),
    },
  };
}

/** 本次 add / configure 与追加清单相关的结果；`--json` 输出里的 `extraScopes` 就是它。 */
export interface ExtraScopesReport {
  /** 本次使用或记着的清单路径（能解析时为绝对路径）；null 表示没有（含本次清除）。 */
  file: string | null;
  /**
   * 追加清单是否并入了本次交给开放平台自动配置的权限清单。权限实际申请到没有要看
   * `openPlatform`（含自动配置是否完成与 `skippedScopes`）。
   */
  merged: boolean;
  /** 追加清单在内置清单之外新增的权限数（tenant / user 两桶分别计）。 */
  addedScopeCount: number;
  /** 本次 `--extra-scopes-file -` 删掉了已记录的路径。 */
  cleared?: true;
  warning?: string;
}

export interface ExtraScopesResolution {
  /** 交给 automateOpenPlatformSetup 的合并清单；undefined 表示用内置默认清单。 */
  manifest?: NormalizedScopeManifest;
  /** 要写回该机器人配置的值：字符串记这个路径，null 删除字段，undefined 不改。 */
  persist?: string | null;
  /** undefined 表示这次与追加清单无关（没传参，也没有记录）。 */
  report?: ExtraScopesReport;
}

/**
 * 决定本次 add / configure 用哪份追加清单、要不要改写配置里记的路径。
 *
 * - `requested`：命令行 `--extra-scopes-file`；undefined 是没传，null 是 `-`（清除）。
 * - `saved`：该机器人配置里 `extraScopesFile` 的原值（只有 configure 有；可能被手改成任何东西）。
 *
 * 显式传入的文件读不了或格式不对直接抛错。没传参数时只读不写：沿用的旧路径出问题只降级
 * 为警告、本次回退内置清单，也不为改写路径格式落盘——configure 是 partial 失败后唯一的续跑
 * 命令，不能被一个丢失或改坏的文件、或一次写盘失败卡死。
 */
export function resolveExtraScopes(input: {
  requested: string | null | undefined;
  saved?: unknown;
  base: ScopeManifest;
}): ExtraScopesResolution {
  const { requested, saved, base } = input;
  if (requested === null) {
    if (saved === undefined) return { report: { file: null, merged: false, addedScopeCount: 0 } };
    return { persist: null, report: { file: null, merged: false, addedScopeCount: 0, cleared: true } };
  }
  const savedPath = typeof saved === 'string' && saved.trim() ? saved.trim() : undefined;
  const reuse = requested === undefined;
  const raw = requested ?? savedPath;
  if (raw === undefined) return {};
  const expanded = expandHomePath(raw);
  const degraded = (file: string, reason: string, hint: string): ExtraScopesResolution => ({
    report: {
      file,
      merged: false,
      addedScopeCount: 0,
      warning: `沿用已记录的追加权限清单失败（${reason}），本次只申请内置清单。${hint}` +
        '换文件用 --extra-scopes-file <路径>，不再需要就用 --extra-scopes-file - 清除。',
    },
  });
  // 相对路径不按当前目录猜：换个目录跑 configure 会静默换成另一份同名文件。
  if (reuse && !isAbsolute(expanded)) {
    return degraded(raw, `记录的路径 ${raw} 不是绝对路径`, '');
  }
  const file = resolve(expanded);

  let extra: NormalizedScopeManifest;
  try {
    extra = loadExtraScopeManifest(file);
  } catch (err) {
    if (!reuse) throw err;
    return degraded(file, err instanceof Error ? err.message : String(err), '修好文件后重跑会继续沿用；');
  }

  const baseTenant = new Set(base.scopes?.tenant ?? []);
  const baseUser = new Set(base.scopes?.user ?? []);
  const addedScopeCount = extra.scopes.tenant.filter(name => !baseTenant.has(name)).length
    + extra.scopes.user.filter(name => !baseUser.has(name)).length;
  return {
    manifest: mergeScopeManifests(base, extra),
    ...(reuse || file === savedPath ? {} : { persist: file }),
    report: {
      file,
      merged: true,
      addedScopeCount,
      ...(addedScopeCount === 0
        ? { warning: `追加权限清单 ${file} 未贡献内置清单之外的权限（文件里没有权限，或列出的都已在内置清单中）。` }
        : {}),
    },
  };
}
