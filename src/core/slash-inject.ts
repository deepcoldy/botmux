/** 通用注入通道禁止的命令：改变 daemon 记录所描述状态的命令必须走专用路由（如 botmux cd）。 */
const FORBIDDEN = new Set(['/cd']);

/**
 * 纯函数校验：能否把 `command` 作为一行斜杠命令注入到 TUI（inject_command）。
 * 规则：必须 `/` 开头、单行、命令名不在 FORBIDDEN 固定黑名单里、且命令名在调用方
 * 传入的 allowlist 里（缺省/空 allowlist = 默认全拒，即通用注入关闭）。
 * 不做副作用、不访问任何全局状态——allowlist 由调用方（如 bot-registry 的
 * tuiSlashAllow）解析后传入。
 */
export function validateSlashInjection(
  command: string,
  allowlist: readonly string[] | undefined,
): { ok: true; command: string } | { ok: false; error: string } {
  const cmd = command.trim();
  if (!cmd.startsWith('/')) return { ok: false, error: 'not_slash_command' };
  if (/[\r\n]/.test(cmd)) return { ok: false, error: 'multiline_rejected' };
  const name = cmd.split(/\s+/)[0].toLowerCase();
  if (FORBIDDEN.has(name)) return { ok: false, error: 'command_forbidden' };
  if (!allowlist || allowlist.length === 0) return { ok: false, error: 'allowlist_empty' };
  if (!allowlist.includes(name)) return { ok: false, error: 'not_in_allowlist' };
  return { ok: true, command: cmd };
}
