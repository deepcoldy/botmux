/**
 * Per-bot CLI config profile (`cliConfigDir`): launch the CLI against a config
 * dir other than its default, e.g. Claude Code with `CLAUDE_CONFIG_DIR=~/.claude-api`.
 *
 * Why a first-class field instead of a wrapper script via `cliPathOverride`:
 * botmux derives its hook install target, transcript / pid-state paths,
 * `.claude.json` folder trust and MCP gateway entry from the CLI's data root.
 * A wrapper that swaps the dir behind botmux's back leaves all of those pointing
 * at `~/.claude`. Declaring the dir lets the adapter (see
 * `claudeConfigProfileVariant`) move every derived path with it.
 *
 * Compatible with the file sandbox: a sandboxed bot still gets its own
 * BOT_HOME data root, provisioned FROM this profile instead of `~/.claude`.
 *
 * Pure and dependency-free: shared by the loader, adapter registry, daemon IPC
 * and the Dashboard bundle.
 */

/** CLIs whose launch honors `cliConfigDir`. */
export function cliSupportsConfigDir(cliId: string | undefined): boolean {
  return cliId === 'claude-code';
}

/** Environment variable that carries the profile into the CLI process. */
export function cliConfigDirEnvKey(cliId: string | undefined): string | undefined {
  return cliId === 'claude-code' ? 'CLAUDE_CONFIG_DIR' : undefined;
}

export const CLI_CONFIG_DIR_MAX = 1024;

/**
 * Accepts an absolute path or a `~/`-prefixed one (expanded at launch, so the
 * stored value stays portable and readable). Returns undefined for "unset"
 * (missing / blank) and throws for a value that cannot be a profile dir — a
 * relative path would resolve against whatever cwd the spawning process has.
 */
export function normalizeCliConfigDir(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new Error('cliConfigDir must be a string');
  const value = raw.trim().replace(/(.)\/+$/, '$1');
  if (!value) return undefined;
  if (value.length > CLI_CONFIG_DIR_MAX) throw new Error('cliConfigDir is too long');
  if (value.includes('\0')) throw new Error('cliConfigDir contains a NUL byte');
  if (!(value.startsWith('/') || value === '~' || value.startsWith('~/'))) {
    throw new Error('cliConfigDir must be an absolute path or start with ~/');
  }
  return value;
}
