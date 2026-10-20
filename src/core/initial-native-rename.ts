/**
 * 话题头（以及其它在首次 spawn 之前就写好的用户标题）怎么落到 CLI 自己的会话名。
 *
 * 三条通道，故意不合成一条：
 *   - Pi：启动参数 `--name`，且只在 `resume === false` 的首次启动。带 `--session-id`
 *     resume 时 Pi 会无条件再写一条 session_info，名字取最后一条，所以重启不能再带。
 *   - Claude Code / Grok / Cursor：单独的 `initialNativeRename`（`/rename <标题>`），
 *     不混进 bot 的 startupCommands。那些命令（如 `/effort`）每次新进程都要重放；
 *     `/rename` 只在这个 worker 里敲一次，worker 内重启不再武装，否则会盖掉用户
 *     后来在 CLI 里改的名字。Grok / Cursor 把首轮正文烤进 argv，这条命令仍算进
 *     {@link spawnHasStartupWork}，正文会推迟到「已有启动命令 → /rename → 正文」。
 *   - Codex：用户标题已经由 thread/name/set 在首条输入提交后写上，这里不再敲 `/rename`。
 *
 * 只作用于还没有 CLI 会话 id 的全新 spawn。冷恢复、接管、wrapper、远端后端都不做。
 * 命令文本来自适配器的 `buildSessionRenameCommand`：没声明这项能力就不敲。
 */

const STARTUP_RENAME_CLI_IDS = new Set(['claude-code', 'grok', 'cursor']);

export interface InitialNativeRenameInput {
  cliId?: string;
  wrapperCli?: string;
  backendType?: string;
  /** `!resume && !cliSessionId`。已有 CLI 会话的再次拉起不算。 */
  fresh: boolean;
  adopted: boolean;
  /** 仅当 nativeSessionTitleUserDefined 时传入，已 trim。 */
  userDefinedTitle?: string;
}

function eligible(input: InitialNativeRenameInput): boolean {
  if (!input.fresh || input.adopted) return false;
  if (input.wrapperCli?.trim()) return false;
  if (input.backendType === 'riff' || input.backendType === 'mojo') return false;
  const title = input.userDefinedTitle?.trim();
  return !!title;
}

/** Pi 的 `--name` 参数。其它 CLI 返回 undefined。 */
export function initialPiLaunchSessionTitle(input: InitialNativeRenameInput): string | undefined {
  if (input.cliId !== 'pi' || !eligible(input)) return undefined;
  return input.userDefinedTitle!.trim().replace(/[\r\n]+/g, ' ');
}

/**
 * 本次 spawn 单独携带的那一行 `/rename`。不经过 normalizeStartupCommand：那条有
 * 200 字上限，而会话标题本身就可以到 200，加上前缀会把合法标题丢掉。
 * `buildCommand` 必须是适配器声明的 `buildSessionRenameCommand`；没声明则不敲。
 */
export function initialNativeRenameStartupCommand(
  input: InitialNativeRenameInput,
  buildCommand: ((title: string) => string) | undefined,
): string | undefined {
  if (!buildCommand || !input.cliId || !STARTUP_RENAME_CLI_IDS.has(input.cliId) || !eligible(input)) return undefined;
  const title = input.userDefinedTitle!.trim().replace(/[\r\n]+/g, ' ');
  return buildCommand(title);
}

/** argv 首轮正文要不要推迟到启动命令和一次性改名之后。改名不在 startupCommands
 *  里，但同样必须发生在正文之前。 */
export function spawnHasStartupWork(
  startupCommands: readonly string[] | undefined,
  initialNativeRename: string | undefined,
): boolean {
  return (startupCommands?.length ?? 0) > 0 || !!initialNativeRename;
}
