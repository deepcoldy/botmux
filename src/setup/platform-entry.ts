import { t } from '../i18n/index.js';
import { isScriptedSetupInvocation } from './setup-args.js';

export type SetupPlatform = 'lark' | 'wecom';

export interface SetupEntry {
  /**
   * Explicit `--platform`; absent means the Feishu flow, whose interactive app
   * source menu may also offer WeCom (see {@link offersWecomSetupSource}).
   */
  platform?: SetupPlatform;
  /** Arguments with `--platform` / `--manual` removed, for the selected flow. */
  args: string[];
  /** A Feishu scripted subcommand (list/add/configure/edit/remove/help). */
  scripted: boolean;
  /** WeCom manual-credential entry: `--manual` or one of its legacy flags. */
  manual: boolean;
}

const WECOM_MANUAL_FLAGS = new Set([
  '--config', '--bot-id', '--secret-file', '--secret-env', '--allow-user', '--core-port', '--managed-core', '--yes',
]);

/**
 * Drop the interactive `--lang <zh|en>` / `--lang=<zh|en>` UI flag. Only used to
 * classify the invocation and for flows that do not take it: in the Feishu
 * scripted parser `--lang` is a bot field and must be passed through untouched.
 */
export function withoutLangArgs(args: readonly string[]): string[] {
  return args.filter((arg, i) => {
    if (arg === '--lang' || arg.startsWith('--lang=')) return false;
    if (i > 0 && args[i - 1] === '--lang') return false;
    return true;
  });
}

/**
 * Platform selection sits outside the existing Feishu scripted parser so none
 * of add/list/configure/edit/remove's credential or owner rules change. An
 * explicit `--platform wecom` goes straight to WeCom (the interactive wizard's
 * app source menu reaches the same QR flow); `--platform feishu` (or `lark`) is
 * the same as giving no platform at all, except that its source menu offers no
 * WeCom item.
 */
export function parseSetupEntry(args: string[]): SetupEntry {
  let platform: SetupPlatform | undefined;
  let manualFlag = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === '--platform' || value.startsWith('--platform=')) {
      if (platform) throw new Error(t('setup.platform.error_duplicate'));
      const selected = value === '--platform' ? args[++i] : value.slice('--platform='.length);
      if (selected !== 'wecom' && selected !== 'lark' && selected !== 'feishu') {
        throw new Error(t('setup.platform.error_invalid'));
      }
      platform = selected === 'wecom' ? 'wecom' : 'lark';
    } else if (value === '--manual') {
      manualFlag = true;
    } else {
      rest.push(value);
    }
  }
  if (manualFlag && platform !== 'wecom') throw new Error(t('setup.platform.error_manual_requires_wecom'));
  return {
    platform,
    args: rest,
    scripted: isScriptedSetupInvocation(withoutLangArgs(rest)),
    manual: manualFlag || rest.some(arg => WECOM_MANUAL_FLAGS.has(arg)),
  };
}

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
 * "scan to create" — the same QR flow as `botmux setup --platform wecom` — and
 * "enter BotID/Secret", the same wizard in its manual-credentials mode).
 *
 * - Only steps that add a bot: a WeCom bot is stored separately and leaves the
 *   Feishu configuration alone, so offering it where the user asked to replace
 *   that configuration (reconfigure / overwrite .env), or to complete a broken
 *   .env, would answer a different question than the one asked.
 * - Only on an interactive terminal (stdin and stdout both TTY): piped answers
 *   are numbered against the three Feishu sources, so that menu stays byte for
 *   byte what it was; the WeCom wizard refuses a non-TTY anyway.
 * - Not after an explicit `--platform feishu|lark`: that invocation already
 *   chose Feishu and keeps its three-item menu.
 */
export function offersWecomSetupSource(
  entry: SetupSourceEntry,
  context: { platform?: SetupPlatform; stdinIsTTY: boolean | undefined; stdoutIsTTY: boolean | undefined },
): boolean {
  return context.platform === undefined
    && Boolean(context.stdinIsTTY && context.stdoutIsTTY)
    && ADDS_ANOTHER_BOT.has(entry);
}
