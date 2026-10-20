import type { DashboardJsonResponse } from './dashboard-api.js';

/**
 * Bot 配置页「保存一个字段」的统一流程。
 *
 * 页面里几十处 save() 是同一条流水线：
 *   （调用方先做乐观更新、记下旧值）→ 清状态 + 置 busy → 发请求 →
 *   成功：用服务端回包落地 + 显示 ✓；失败（非 2xx / body.ok 为假 / 抛错）：回滚 + 显示 ✗ → 复位 busy。
 * 这里只收敛这条流水线本身；「乐观更新什么、回包怎么落地、怎么回滚」仍由调用方
 * 通过 `onSaved` / `rollback` 回调给出，所以各处差异（多个 busy 键、写进不同的
 * status 槽、成功文案依赖回包）都留在调用点，不被抽象吞掉。
 */

export type StatusMessage = { text: string; ok?: boolean } | null;

/** 取响应里最有信息量的失败原因：reason（+ manualCommand）> error > HTTP 状态码。 */
export function responseErrorText(res: DashboardJsonResponse): string {
  const reason = typeof res.body?.reason === 'string' ? res.body.reason : '';
  const manual = typeof res.body?.manualCommand === 'string' ? res.body.manualCommand : '';
  if (reason && manual) return `${reason}（${manual}）`;
  return String(reason || res.body?.error || res.status);
}

export function caughtErrorText(e: any): string {
  return e?.message ?? String(e);
}

export interface SaveBotFieldSpec {
  /** 发请求。通常是 `() => sendJson('PUT', url, body)`，也可以是 `putCardPref(...)` 这类已封装的写入。 */
  request(): Promise<DashboardJsonResponse>;
  setStatus(status: StatusMessage): void;
  /** busy 开关；用字符串键标 busy 的页面传 `on => setBusy(on ? 'key' : null)`。 */
  setBusy(busy: boolean): void;
  /** 请求期间显示的状态，缺省 null（清空）。 */
  pendingStatus?: StatusMessage;
  /**
   * 判定成功的口径。默认（true）要求 `res.ok && res.body.ok`——body 里必须显式带 ok；
   * 传 false 时只看 `res.ok`（HTTP 2xx 且 body.ok 不是 false），给写入端点不回 ok 字段的页面用。
   */
  strict?: boolean;
  /** 成功时用服务端回包落地本地状态 / patchBot。抛错会走失败分支（与原先写在 try 里一致）。 */
  onSaved?(body: any): void;
  /** 成功文案（helper 补 `✓ ` 前缀）；空串只显示 `✓`；可依赖回包。 */
  saved: string | ((body: any) => string);
  /** 失败文案（helper 补 `✗ ` 前缀），缺省 {@link responseErrorText}。 */
  errorText?(res: DashboardJsonResponse): string;
  /** 乐观更新的回滚：非成功响应与抛错都会调用。 */
  rollback?(): void;
}

/** 跑完整条流水线；返回是否保存成功（调用方一般不需要）。 */
export async function saveBotField(spec: SaveBotFieldSpec): Promise<boolean> {
  spec.setStatus(spec.pendingStatus ?? null);
  spec.setBusy(true);
  try {
    const res = await spec.request();
    const succeeded = spec.strict === false ? res.ok : res.ok && res.body.ok;
    if (succeeded) {
      spec.onSaved?.(res.body);
      const text = typeof spec.saved === 'function' ? spec.saved(res.body) : spec.saved;
      spec.setStatus({ text: text ? `✓ ${text}` : '✓', ok: true });
      return true;
    }
    spec.rollback?.();
    spec.setStatus({ text: `✗ ${(spec.errorText ?? responseErrorText)(res)}` });
  } catch (e: any) {
    spec.rollback?.();
    spec.setStatus({ text: `✗ ${caughtErrorText(e)}` });
  } finally {
    spec.setBusy(false);
  }
  return false;
}
