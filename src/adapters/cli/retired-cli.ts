/**
 * CLI ids botmux used to support and has removed. A bots.json row may still
 * carry one: that Bot is not started (the rest of the fleet is), and every
 * surface that meets it — loader, `botmux start/restart`, Dashboard, setup —
 * shows the same notice instead of failing later with "Unknown CLI adapter".
 *
 * The replacement is never applied automatically: the old CLI's binary,
 * sign-in, model names, wrapper and env do not carry over, so a silent swap
 * would fail inside the first session instead of at startup.
 */

export interface RetiredCli {
  /** Name shown to the user. */
  label: string;
  /** cliId to switch to. */
  replacement: string;
  /** Number the setup menu used for it (kept unassigned; scripted setup feeds numbers). */
  setupChoice?: string;
}

export const RETIRED_CLIS: Readonly<Record<string, RetiredCli>> = {
  gemini: { label: 'Gemini CLI', replacement: 'antigravity', setupChoice: '6' },
};

export function retiredCli(cliId: unknown): RetiredCli | undefined {
  return typeof cliId === 'string' && Object.hasOwn(RETIRED_CLIS, cliId) ? RETIRED_CLIS[cliId] : undefined;
}

/** One-paragraph Chinese notice: what happened and how to fix the row. */
export function retiredCliNotice(cliId: string, botLabel?: string): string {
  const retired = retiredCli(cliId);
  if (!retired) return '';
  const who = botLabel ? `Bot ${botLabel} 的 ` : '';
  return `${who}cliId "${cliId}"（${retired.label}）已停止官方维护，botmux 已移除该适配器，这个 Bot 不会启动。`
    + `请把 bots.json 里它的 cliId 改成 "${retired.replacement}"（Antigravity CLI，命令 agy：先安装并用 Google 账号登录，`
    + `或在 ~/.gemini/antigravity-cli/settings.json 写 "modelProvider": "gemini" 并设置 GEMINI_API_KEY），`
    + `也可以用 botmux setup 修改这个 Bot 的 CLI；原来为 ${retired.label} 配的 model、cliPathOverride、wrapperCli 一并改掉或删掉，`
    + `改完执行 botmux restart。其它 Bot 不受影响。`;
}

/** bots.json rows whose cliId is retired, with their raw array index. */
export function findRetiredCliBots(entries: readonly unknown[]): Array<{ index: number; appId: string; cliId: string; label: string }> {
  const out: Array<{ index: number; appId: string; cliId: string; label: string }> = [];
  entries.forEach((entry, index) => {
    const row = (entry ?? {}) as { cliId?: unknown; larkAppId?: unknown; name?: unknown };
    if (!retiredCli(row.cliId)) return;
    const appId = typeof row.larkAppId === 'string' ? row.larkAppId : '';
    const label = typeof row.name === 'string' && row.name.trim() ? `${row.name.trim()}（${appId}）` : appId || `#${index}`;
    out.push({ index, appId, cliId: row.cliId as string, label });
  });
  return out;
}
