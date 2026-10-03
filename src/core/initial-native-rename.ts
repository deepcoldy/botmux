/**
 * 话题头（以及其它在首次 spawn 之前就写好的用户标题）怎么落到 CLI 自己的会话名。
 *
 * 三条通道，故意不合成一条：
 *   - Pi：启动参数 `--name`。标题在进程起来时就在，不必敲命令。
 *   - Claude Code / Grok / Cursor：追加一条一次性的 `/rename <标题>` 到本次 spawn
 *     的 startupCommands 末尾。Grok 和 Cursor 把首轮正文烤进 argv，多了这条命令后
 *     现有的 shouldDeferInitialPromptForStartup 会把正文挪回队列，于是顺序变成
 *     「已有启动命令 → /rename → 正文」。Claude Code 的 `/model` `/effort` 本来就是
 *     进程参数，正文本来就走队列，同一条追加把它放在正文之前。
 *   - Codex：用户标题已经由 thread/name/set 在首条输入提交后写上，这里不再敲 `/rename`。
 *
 * 只作用于还没有 CLI 会话 id 的全新 spawn。冷恢复、接管、wrapper、远端后端都不做：
 * 冷恢复重敲会盖掉用户在 CLI 里改过的名字；riff/mojo 会跳过 startupCommands，
 * 若仍把命令算进 hasStartupCommands，argv 正文会被推迟却永远敲不进去。
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
 * 追加到本次 spawn 的 startupCommands 末尾的那一行。不经过
 * normalizeStartupCommand：那条有 200 字上限，而会话标题本身就可以到 200，
 * 加上 `/rename ` 前缀会把合法标题丢掉。运行时只是把这一行敲进 TUI。
 */
export function initialNativeRenameStartupCommand(input: InitialNativeRenameInput): string | undefined {
  if (!input.cliId || !STARTUP_RENAME_CLI_IDS.has(input.cliId) || !eligible(input)) return undefined;
  const title = input.userDefinedTitle!.trim().replace(/[\r\n]+/g, ' ');
  return `/rename ${title}`;
}

/** 不改 bot 配置。没有改名命令时原样返回，避免把 `undefined` 变成空数组。 */
export function withInitialNativeRenameStartupCommand(
  commands: readonly string[] | undefined,
  renameCommand: string | undefined,
): string[] | undefined {
  if (!renameCommand) return commands ? [...commands] : undefined;
  return [...(commands ?? []), renameCommand];
}
