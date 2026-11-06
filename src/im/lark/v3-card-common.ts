/**
 * Text helpers shared by the v3 workflow cards (gate / blocked / loop-grant /
 * revisit-grant / run-save). v3-progress-card keeps its own escapeMd on
 * purpose: it also escapes `<>`.
 */
import { config } from '../../config.js';
import { buildV3RunDetailUrl } from '../../core/dashboard-url.js';

/** Clip to `max` chars with a bare ellipsis. */
export function short(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** Clip to `max` chars, pointing the reader at the Web detail page. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…（截断，完整见 Web 详情）`;
}

/** 转义 lark_md 里会被解析的字符，防 prompt / message 注入破坏卡片结构。 */
export function escapeMd(s: string): string {
  return s.replace(/[\\*_~`\[\]]/g, (c) => `\\${c}`);
}

export function v3RunDetailUrl(runId: string): string {
  return buildV3RunDetailUrl(runId, { host: config.dashboard.externalHost, port: config.dashboard.port });
}
