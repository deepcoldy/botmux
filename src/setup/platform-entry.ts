/** Each step of the interactive `botmux setup` that asks for the Feishu app source. */
export type SetupSourceEntry =
  /** No bots.json and no .env yet. */
  | 'first-run'
  /** bots.json mode → "Add new bot". */
  | 'add-bot'
  /** .env mode → "Add new bot" (the .env bot migrates into bots.json). */
  | 'env-add-bot'
  /** bots.json mode → "Reconfigure": discard every configured bot, rebuild one. */
  | 'reconfigure'
  /** .env mode → "Overwrite current configuration". */
  | 'env-overwrite'
  /** .env mode → "Add new bot", but the .env has no credentials to migrate. */
  | 'env-missing-credentials';

/** Steps that put one more bot next to whatever is configured. */
const ADDS_ANOTHER_BOT: ReadonlySet<SetupSourceEntry> = new Set(['first-run', 'add-bot', 'env-add-bot']);

/**
 * Whether the app source menu ends with a WeCom section (a separator row, then
 * "scan to create" and "enter BotID/Secret", the two modes of the WeCom
 * wizard). This section is the only way into WeCom setup from the CLI.
 *
 * - Only steps that add a bot: a WeCom bot is stored separately and leaves the
 *   Feishu configuration alone, so offering it where the user asked to replace
 *   that configuration (reconfigure / overwrite .env), or to complete a broken
 *   .env, would answer a different question than the one asked.
 * - Only on an interactive terminal (stdin and stdout both TTY): piped answers
 *   are numbered against the Feishu sources, so that menu stays byte for byte
 *   what it was; the WeCom wizard refuses a non-TTY anyway.
 */
export function offersWecomSetupSource(
  entry: SetupSourceEntry,
  context: { stdinIsTTY: boolean | undefined; stdoutIsTTY: boolean | undefined },
): boolean {
  return Boolean(context.stdinIsTTY && context.stdoutIsTTY)
    && ADDS_ANOTHER_BOT.has(entry);
}
