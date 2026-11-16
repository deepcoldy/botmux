/**
 * Recognize the native startup/resume failure, not arbitrary "model" errors.
 * This is presentation only: restart budgets, history and turn settlement are
 * deliberately unchanged. Metadata absence is scoped to this CLI/account;
 * it does not establish that a model was shut down on every product.
 */

/** Shared body of the native bootstrap error sentence. */
const NATIVE_MODEL_ERROR_BODY =
  /[ \t]*(?:\? for shortcuts[ \t]*)?Error:[ \t]*(?:Failed to resume session from [^\r\n]*?:[ \t]*)?thread\/(?:start|resume)(?=[: \t])[^\r\n]{0,2000}?model `([^`\r\n]{1,256})` is unavailable because its metadata could not be resolved \(code -3260[03]\)[ \t\r\n]*$/;

/** The Error record must start a line (or the whole tail). */
const STRICT_NATIVE_MODEL_ERROR = new RegExp(`(?:^|[\\r\\n])${NATIVE_MODEL_ERROR_BODY.source}`);

/**
 * Glued-record variant: no line boundary before Error. Used only when the
 * worker proves this CLI generation never reached a prompt, because
 * cursor-positioned TUI redraws leave no newline between a painted frame and
 * the following Error record once stripAnsiForLog removes the CUP sequences
 * (see the worker-traex-startup-readiness fixtures). The trailing `$` anchor
 * still requires the complete native sentence as the last record, and
 * `[^\r\n]` still forbids bridging across a real line break.
 */
const GLUED_NATIVE_MODEL_ERROR = NATIVE_MODEL_ERROR_BODY;

export function traexUnavailableModelFromStartupTail(
  tail: string | undefined,
  opts?: { allowGluedRecord?: boolean },
): string | undefined {
  if (!tail) return undefined;
  const clean = tail.slice(-12_000).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  // Never bridge an unrelated error to the next log record, and never search
  // inside user quotes. Native bootstrap errors are single stderr records.
  const match = (opts?.allowGluedRecord ? GLUED_NATIVE_MODEL_ERROR : STRICT_NATIVE_MODEL_ERROR)
    .exec(clean.trim());
  return match?.[1]?.trim() || undefined;
}

export function fixedTraexUnavailableModelNotice(input: {
  cliId: string | undefined;
  autoModelEnabled: boolean;
  selectedModel?: string;
  exitCode: number | null;
  startupFailure?: boolean;
  logTail?: string;
  consoleUrl: string | (() => string);
  locale: 'zh' | 'en';
}): string | undefined {
  if (input.cliId !== 'traex' || input.autoModelEnabled || input.exitCode !== 1
    || input.startupFailure === false) return undefined;
  // A worker that proves this generation never reached a prompt may hand us a
  // TUI frame glued to the Error record; older IPC without that evidence keeps
  // the strict line-boundary match.
  const model = traexUnavailableModelFromStartupTail(input.logTail, {
    allowGluedRecord: input.startupFailure === true,
  });
  if (!model || (input.selectedModel
    && model.toLowerCase() !== input.selectedModel.trim().toLowerCase())) return undefined;
  let url: URL;
  try { url = new URL(typeof input.consoleUrl === 'function' ? input.consoleUrl() : input.consoleUrl); }
  catch { return undefined; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
  // Never publish a long-lived dashboard bearer token as part of a crash notice.
  if (url.searchParams.has('t')) return undefined;
  // The notice is delivered as a plain-text Feishu message (msg_type 'text'),
  // so markdown escaping would render the backslashes verbatim; the same
  // message also carries the raw log tail containing the same model name.
  return input.locale === 'en'
    ? `⚠️ TraeX cannot provide the selected model ${model} in the current CLI/account catalog (model metadata unavailable), so the service cannot start or execute. The model may have been removed or its account visibility changed. Change the model in the console, then retry.\n\nConsole: ${url.toString()}`
    : `⚠️ 所选择的模型 ${model} 在 TraeX 当前可用目录中已不可用（模型元数据无法获取），服务无法启动执行。模型下架或当前账号目录变化都可能导致此问题。请前往控制台更换模型后重试。\n\n控制台：${url.toString()}`;
}
