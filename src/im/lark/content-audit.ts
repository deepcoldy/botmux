import { extractLarkBusinessCode } from './api-gate.js';

/**
 * 飞书内容安全审计类拒收。
 *
 * 这些错误是**确定性永久失败**：服务器拒绝的是消息内容本身（命中租户 DLP /
 * 敏感信息策略），同一条消息原样重试只会得到同样的拒绝。正确处理是立即停止
 * 重试并给出可操作反馈（改内容、打码、改走附件），而不是按瞬态错误退避。
 *
 * 错误码来源：飞书开放平台通用错误码文档 + 现网租户 DLP 实测返回。
 * - 230028: 租户内容 DLP（msg 形如 "contain sensitive data: EMAIL_ADDRESS"）
 * - 11312:  messages do not pass the audit（消息内容不合法）
 * - 11248:  message is sensitive（消息内容涉及敏感信息）
 * - 18054:  create message content fail（提示检查敏感信息）
 *
 * 注意：新增/删除这里的码必须同步更新 test/content-audit-send-failure.test.ts
 * 里的字面量断言——遍历集合自身的测试锁不住码集变化。
 */
export const LARK_CONTENT_AUDIT_ERROR_CODES: ReadonlySet<number> = new Set([
  230028,
  11312,
  11248,
  18054,
]);

/** Lark business code from an SDK/Axios rejection, including the 2xx-body
 *  `(code: NNN)` message-tail shape that client.ts uses when res.code!==0. */
export function larkErrorCode(err: unknown): number | undefined {
  return extractLarkBusinessCode(err);
}

/** Whether a send failure is the platform's content audit permanently
 *  rejecting THIS payload (retries cannot help). */
export function isLarkContentAuditError(err: unknown): boolean {
  const code = larkErrorCode(err);
  return code !== undefined && LARK_CONTENT_AUDIT_ERROR_CODES.has(code);
}

/**
 * Model-facing remediation hint appended to a `botmux send` failure. The CLI
 * runs inside the worker PTY, so a clear next-action line is what lets the model
 * self-correct instead of resending verbatim (which fails identically and can
 * burn the user-facing turn in silence).
 */
export function contentAuditSendRemediation(code: number | undefined): string {
  const codePart = code === undefined ? '' : `（错误码 ${code}）`;
  return `这是飞书内容安全审计的永久拒收${codePart}：原样重试必定再次失败，不要直接重发。`
    + '请从正文中删除或打码邮箱地址、手机号、证件号/银行卡号等敏感信息后重新发送；'
    + '若内容必须原样保留，请改为发送文件附件，或只在 Web 终端中展示而不要发进群。';
}
