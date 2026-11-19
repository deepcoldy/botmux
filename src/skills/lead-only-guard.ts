/**
 * "Forward-only" chat-manager mode (per-chat lead-only flag on the manager claim): the Claude Code
 * PreToolUse guard. It lives in a DEDICATED plugin dir (`<claude-plugin>-lead-only`) that the
 * claude-code adapter mounts ONLY for lead-only sessions, so no other session ever runs it.
 * It matches every tool: Bash is limited to a single plain `botmux …` command, a small set of
 * bookkeeping tools is allowed, and everything else (file/web/agent/MCP tools) is denied.
 * (claude-code only; other CLIs ignore the lead-only flag.)
 *
 * The hook command is `botmux hook lead-only-guard` (built like every other hook via
 * botmuxShellCommand, so compiled single-binary installs need no node). The Bash check is a strict
 * whitelist lexer, not a regex blacklist: see {@link isPlainBotmuxCommand}.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';
import { botmuxShellCommand } from '../adapters/hook-command.js';

export const LEAD_ONLY_PLUGIN_DIR_SUFFIX = '-lead-only';

export function leadOnlyPluginDir(pluginDir: string): string {
  return `${pluginDir}${LEAD_ONLY_PLUGIN_DIR_SUFFIX}`;
}

/** Non-Bash tools a lead may still use: planning/bookkeeping only, no file/web/MCP access. */
export const LEAD_ALLOWED_TOOLS = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'Skill', 'ToolSearch', 'BashOutput', 'KillShell', 'KillBash'];

export const LEAD_ONLY_BLOCK_MESSAGE =
  '负责人只转发模式：本会话只能执行单条普通 botmux 命令（不能用重定向、管道、; & $ 反引号、括号、# 注释；多行正文请整体放进单引号，或在命令末尾用带引号定界符的 heredoc <<\'EOF\'），不能使用文件工具，具体工作请 botmux dispatch 给执行 bot。 / Lead-only manager mode: only a single plain `botmux ...` command is allowed (no redirects, pipes, ; & $ backticks, parentheses or # comments; put multi-line text wholly inside single quotes, or end the command with a quoted-delimiter heredoc <<\'EOF\'); file tools are not allowed; dispatch the work to an executor bot with `botmux dispatch`.';

// Non-ASCII letters/digits (e.g. a Chinese role in `--bot-app cli_x:执行`) are never shell syntax.
const BARE_WORD_CHAR = /[A-Za-z0-9_@%+=:,./\p{L}\p{N}-]/u;

/**
 * The one heredoc form a lead may use: `<<'DELIM'` or `<<"DELIM"` as the LAST thing on the first line.
 * A quoted delimiter means bash does no expansion in the body, so the body is plain stdin data.
 */
const QUOTED_HEREDOC = /^(.*?)[ \t]+<<(['"])([A-Za-z_][A-Za-z0-9_]*)\2[ \t]*$/;

/**
 * Strict whitelist lexer for a Bash command line. Accepts only when ALL hold:
 *  - tokens are separated by spaces/tabs only;
 *  - a token is a concatenation of bare words (chars `[A-Za-z0-9_@%+=:,./-]`), single-quoted
 *    strings (any content, no escapes) and double-quoted strings (content free of `$`, backtick,
 *    `\` and `!`);
 *  - any other unquoted char (`< > ( ) # ; & | ~ * ? [ { $ !`, backslash, newline, …) rejects;
 *  - argv[0] is exactly the bare word `botmux`.
 * Only trailing whitespace (incl. a final newline) is tolerated.
 *
 * One heredoc is allowed, the form botmux's own rules tell agents to use for multi-line text
 * (`botmux send <<'EOF'`): the first line must be a plain command (as above) followed by
 * `<<'DELIM'` / `<<"DELIM"`, the body must end at a line that is exactly DELIM (bash's own rule),
 * and nothing but whitespace may follow. An unquoted, `<<-` or mid-line heredoc is rejected.
 */
export function parsePlainBotmuxArgv(command: string): string[] | null {
  const nl = command.indexOf('\n');
  const heredoc = nl >= 0 ? QUOTED_HEREDOC.exec(command.slice(0, nl)) : null;
  if (!heredoc) return lexPlainBotmuxArgv(command);
  // If `<<` sat inside a quote, the head has an unbalanced quote and the lexer rejects it.
  const lines = command.slice(nl + 1).split('\n');
  const end = lines.indexOf(heredoc[3]);
  if (end < 0 || lines.slice(end + 1).join('\n').trim() !== '') return null;
  return lexPlainBotmuxArgv(heredoc[1]);
}

function lexPlainBotmuxArgv(command: string): string[] | null {
  const cmd = command.replace(/\s+$/, '');
  let i = 0;
  const argv: string[] = [];
  let tokenRaw = '';
  let tokenValue = '';
  let inToken = false;
  const endToken = (): boolean => {
    if (!inToken) return true;
    if (argv.length === 0 && tokenRaw !== 'botmux') return false;
    argv.push(tokenValue);
    tokenRaw = '';
    tokenValue = '';
    inToken = false;
    return true;
  };
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === ' ' || c === '\t') {
      if (!endToken()) return null;
      i++;
    } else if (BARE_WORD_CHAR.test(c)) {
      inToken = true;
      tokenRaw += c;
      tokenValue += c;
      i++;
    } else if (c === "'") {
      const close = cmd.indexOf("'", i + 1);
      if (close < 0) return null;
      inToken = true;
      tokenRaw += cmd.slice(i, close + 1);
      tokenValue += cmd.slice(i + 1, close);
      i = close + 1;
    } else if (c === '"') {
      const close = cmd.indexOf('"', i + 1);
      if (close < 0) return null;
      if (/[$`\\!]/.test(cmd.slice(i + 1, close))) return null;
      inToken = true;
      tokenRaw += cmd.slice(i, close + 1);
      tokenValue += cmd.slice(i + 1, close);
      i = close + 1;
    } else {
      return null;
    }
  }
  if (!endToken()) return null;
  return argv.length > 0 ? argv : null;
}

export function isPlainBotmuxCommand(command: string): boolean {
  return parsePlainBotmuxArgv(command) !== null;
}

/**
 * Default-deny subcommand allowlist (same idea as the workflow-worker root-command fence in cli.ts):
 * only what a lead needs to read context and forward work. Everything else (mcp, setup, upgrade,
 * restart, delete, plugin, schedule/workflow mutations, hook, ...) starts processes or changes
 * fleet/config state and is denied.
 */
export const LEAD_ALLOWED_BOTMUX_SUBCOMMANDS = new Set([
  'dispatch', 'send', 'status', 'manager', 'history', 'quoted', 'bots', 'capabilities', 'skill',
  // Read-only views the lead rules themselves point to: the task board and `observe` (did a
  // dispatched session start?). There is no built-in `botmux task`/`botmux help`: unknown names fall
  // through to plugin commands, so they are NOT listed (use `--help`).
  // The group whiteboard doubles as the lead's long-lived notes; `whiteboard` is narrowed below.
  'observe', 'whiteboard', 'wb',
  '--help', '-h', '--version', '-v',
]);

/**
 * Flags that make botmux read a local file (or upload a local path) and so bypass the Read-tool ban.
 * `--diff` has no "file" in its name but readSendDiffFile() renders the file's unified-diff content
 * into the outbound card, so it belongs here too.
 */
const LEAD_DENIED_FLAG = /^--(?:[a-z0-9-]*file[a-z0-9-]*|files|images?|videos?|video-covers?|voice|card-json|diff)$/;

/** Second-level `bots` words a lead may use. `invite` changes group membership (pulls agents and
 *  their human owners into the chat with no human-turn gate), so a lead may only read the roster. */
const LEAD_ALLOWED_BOTS_SUBS = new Set(['list', 'ls', 'help', '--help', '-h']);

/** Second-level `whiteboard` words a lead may use: read/update this group's notes board. No enable/disable
 *  (config), no `write --yes` (force-overwrite), no `create`/`path`, and no `list` (it enumerates every
 *  board on the host, with other groups' ids and paths). A bare `whiteboard` means `status`. */
const LEAD_ALLOWED_WHITEBOARD_SUBS = new Set(['status', 'current', 'read', 'update', 'help', '--help', '-h']);

/** `whiteboard` flags that pick a board other than the session's own: an explicit id (the store is
 *  id-keyed with no chat check) or an overridden session/app/chat/directory context. Without them the
 *  CLI resolves the board from the calling session (`current --create` binds this group's default). */
const LEAD_DENIED_WHITEBOARD_FLAG = new Set(['--id', '--session-id', '--lark-app-id', '--app-id', '--chat-id', '--working-dir', '--repo']);

/** Returns a bilingual reason when the parsed argv uses a subcommand/flag a lead may not use, else undefined. */
export function leadOnlyArgvViolation(argv: string[]): string | undefined {
  const sub = argv[1];
  if (sub !== undefined && !LEAD_ALLOWED_BOTMUX_SUBCOMMANDS.has(sub)) {
    return `子命令 \`${sub}\` 不允许 / subcommand \`${sub}\` is not allowed`;
  }
  if (sub === 'bots' && argv[2] !== undefined && !LEAD_ALLOWED_BOTS_SUBS.has(argv[2])) {
    return `子命令 \`bots ${argv[2]}\` 会变更群成员，不允许；负责人只能查看花名册（bots list） / \`bots ${argv[2]}\` changes group membership and is not allowed; a lead may only run \`bots list\``;
  }
  if ((sub === 'whiteboard' || sub === 'wb') && argv[2] !== undefined && !LEAD_ALLOWED_WHITEBOARD_SUBS.has(argv[2])) {
    return `子命令 \`${sub} ${argv[2]}\` 会改白板配置或强制覆盖，不允许；负责人只能 status/current/read/update / \`${sub} ${argv[2]}\` changes whiteboard config or force-overwrites and is not allowed; a lead may only run status/current/read/update`;
  }
  for (const tok of argv.slice(2)) {
    if (!tok.startsWith('--')) continue;
    const name = tok.split('=')[0];
    if ((sub === 'whiteboard' || sub === 'wb') && LEAD_DENIED_WHITEBOARD_FLAG.has(name)) return `参数 \`${name}\` 会指向本群以外的白板，不允许；请先 whiteboard current --create 再不带 --id 读写 / flag \`${name}\` selects a board other than this group's and is not allowed; run \`whiteboard current --create\` then read/update without --id`;
    if (LEAD_DENIED_FLAG.test(name)) return `参数 \`${name}\` 会读取本地文件，不允许，请把文本直接写在命令里 / flag \`${name}\` reads local files and is not allowed; put the text inline`;
  }
  return undefined;
}

/** True when the PreToolUse payload may proceed in a lead-only session. */
export function isLeadOnlyToolCallAllowed(input: unknown): boolean {
  const obj = (input && typeof input === 'object' ? input : {}) as {
    tool_name?: unknown; tool_input?: { command?: unknown };
  };
  const tool = String(obj.tool_name || 'Bash');
  if (tool !== 'Bash') {
    if (LEAD_ALLOWED_TOOLS.includes(tool)) return true;
    return false;
  }
  const command = obj.tool_input?.command;
  if (typeof command !== 'string') return false;
  const argv = parsePlainBotmuxArgv(command);
  return argv !== null && leadOnlyArgvViolation(argv) === undefined;
}

/** `botmux hook lead-only-guard`: read the PreToolUse JSON on stdin, exit 2 to deny. Fails closed. */
export function runLeadOnlyGuardHook(): never {
  let input: unknown;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { input = null; }
  if (input !== null && isLeadOnlyToolCallAllowed(input)) process.exit(0);
  let reason = '';
  try {
    const cmd = (input as { tool_input?: { command?: unknown } } | null)?.tool_input?.command;
    const argv = typeof cmd === 'string' ? parsePlainBotmuxArgv(cmd) : null;
    reason = argv ? (leadOnlyArgvViolation(argv) ?? '') : '';
  } catch { /* fall through to the generic message */ }
  process.stderr.write((reason ? reason + '\n' : '') + LEAD_ONLY_BLOCK_MESSAGE + '\n');
  process.exit(2);
}

const LEAD_ONLY_MANIFEST = JSON.stringify({
  name: 'botmux-lead-only',
  description: 'botmux lead-only manager guard (PreToolUse)',
  version: '1.0.0',
}, null, 2) + '\n';

export function leadOnlyHooksJson(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: '*',
        hooks: [{ type: 'command', command: botmuxShellCommand(['hook', 'lead-only-guard']),
          // A guard that cannot run (no node, spawn error) must deny, not silently continue.
          onFailure: 'block',
        }],
      }],
    },
  }, null, 2) + '\n';
}

function writeIfChanged(file: string, content: string): void {
  if (existsSync(file) && readFileSync(file, 'utf-8') === content) return;
  atomicWriteFileSync(file, content);
}

/**
 * Materialise the dedicated lead-only plugin dir (manifest + hooks.json; idempotent) and return its
 * path, or undefined if it could not be written (caller must then fail closed).
 */
export function ensureLeadOnlyPluginDir(pluginDir: string): string | undefined {
  const root = leadOnlyPluginDir(pluginDir);
  try {
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeIfChanged(join(root, '.claude-plugin', 'plugin.json'), LEAD_ONLY_MANIFEST);
    writeIfChanged(join(root, 'hooks', 'hooks.json'), leadOnlyHooksJson());
    return root;
  } catch (err: any) {
    logger.warn(`[skills] Failed to write lead-only plugin dir ${root}: ${err.message}`);
    return undefined;
  }
}
