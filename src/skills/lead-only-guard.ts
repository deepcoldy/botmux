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
  '负责人只转发模式：本会话只能执行单条普通 botmux 命令（不能用 heredoc、重定向、管道、; & $ 反引号、括号、# 注释；多行正文请整体放进单引号），具体工作请 botmux dispatch 给执行 bot。 / Lead-only manager mode: only a single plain `botmux ...` command is allowed (no heredoc, redirects, pipes, ; & $ backticks, parentheses or # comments; put multi-line text wholly inside single quotes); dispatch the work to an executor bot with `botmux dispatch`.';

const BARE_WORD_CHAR = /[A-Za-z0-9_@%+=:,./-]/;

/**
 * Strict whitelist lexer for a Bash command line. Accepts only when ALL hold:
 *  - tokens are separated by spaces/tabs only;
 *  - a token is a concatenation of bare words (chars `[A-Za-z0-9_@%+=:,./-]`), single-quoted
 *    strings (any content, no escapes) and double-quoted strings (content free of `$`, backtick,
 *    `\` and `!`);
 *  - any other unquoted char (`< > ( ) # ; & | ~ * ? [ { $ !`, backslash, newline, …) rejects;
 *  - argv[0] is exactly the bare word `botmux`.
 * No heredoc support. Only trailing whitespace (incl. a final newline) is tolerated.
 */
export function parsePlainBotmuxArgv(command: string): string[] | null {
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
  'help', '--help', '-h', '--version', '-v',
]);

/** Flags that make botmux read a local file (or upload a local path) and so bypass the Read-tool ban. */
const LEAD_DENIED_FLAG = /^--(?:[a-z0-9-]*file[a-z0-9-]*|files|images?|videos?|video-covers?|voice|card-json)$/;

/** Returns a bilingual reason when the parsed argv uses a subcommand/flag a lead may not use, else undefined. */
export function leadOnlyArgvViolation(argv: string[]): string | undefined {
  const sub = argv[1];
  if (sub !== undefined && !LEAD_ALLOWED_BOTMUX_SUBCOMMANDS.has(sub)) {
    return `子命令 \`${sub}\` 不允许 / subcommand \`${sub}\` is not allowed`;
  }
  for (const tok of argv.slice(2)) {
    if (!tok.startsWith('--')) continue;
    const name = tok.split('=')[0];
    if (LEAD_DENIED_FLAG.test(name)) return `参数 \`${name}\` 会读取本地文件，不允许，请把文本直接写在命令里 / flag \`${name}\` reads local files and is not allowed; put the text inline`;
  }
  return undefined;
}

/** True when the PreToolUse payload may proceed in a lead-only session. */
export function isLeadOnlyToolCallAllowed(input: unknown): boolean {
  const obj = (input && typeof input === 'object' ? input : {}) as { tool_name?: unknown; tool_input?: { command?: unknown } };
  const tool = String(obj.tool_name || 'Bash');
  if (tool !== 'Bash') return LEAD_ALLOWED_TOOLS.includes(tool);
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
