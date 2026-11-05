/**
 * `botmux setup add|configure --extra-scopes-file <json>`：调用方追加的权限清单。
 *
 * 内置清单（`lark-scopes.json`）覆盖 botmux 自身需要的权限；接入方（比如在 botmux
 * 之上跑自己 Agent 的项目）常常还要几项额外权限。以前只能建完应用再去开放平台手动
 * 导入，这里让调用方在建应用 / 重跑 configure 时一并带上。
 *
 * 支持两种文件格式：
 *   1. 与内置清单一致：`{"scopes":{"tenant":[...],"user":[...]}}`
 *   2. 条目列表：`{"scopes":[{"scope":"a:b","for":"..."}]}` 或 `["a:b", ...]`，
 *      条目没有 token 类型信息，一律视为 user 权限。
 *
 * 只做语法校验：平台目录里不存在的权限由 automateOpenPlatformSetup 跳过并在结果
 * `skippedScopes` 里如实列出，不让整个流程失败。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ScopeManifest } from './open-platform-automation.js';
import { isValidLarkScopeSyntax } from '../utils/lark-scope-catalog.js';

export interface NormalizedScopeManifest {
  scopes: { tenant: string[]; user: string[] };
}

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
