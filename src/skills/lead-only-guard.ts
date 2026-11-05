/**
 * "Forward-only" chat-manager mode (per-chat lead-only flag on the manager claim): the Claude Code PreToolUse guard
 * shipped inside the botmux built-in plugin (`<pluginDir>/hooks/`). It matches every
 * tool: Bash is limited to `botmux …` commands, a small set of bookkeeping tools is
 * allowed, and everything else (file/web/agent/MCP tools) is denied.
 * (claude-code only; other CLIs ignore the lead-only flag.)
 *
 * The hook is inert unless the CLI process has BOTMUX_LEAD_ONLY=1 (set by the
 * worker only for a manager session in a lead-only chat), so sharing the plugin
 * dir with every other session is safe. Written in plain node (no python).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';

export const LEAD_ONLY_ENV = 'BOTMUX_LEAD_ONLY';
export const LEAD_ONLY_GUARD_FILENAME = 'lead-only-guard.mjs';

/** Non-Bash tools a lead may still use: planning/bookkeeping only, no file/web/MCP access. */
export const LEAD_ALLOWED_TOOLS = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'Skill', 'ToolSearch', 'BashOutput', 'KillShell', 'KillBash'];

export const LEAD_ONLY_BLOCK_MESSAGE =
  '负责人只转发模式：本会话只能执行 botmux 命令，具体工作请 botmux dispatch 给执行 bot。 / Lead-only manager mode: only `botmux ...` commands are allowed in this session; dispatch the work to an executor bot with `botmux dispatch`.';

export const LEAD_ONLY_GUARD_SCRIPT = `#!/usr/bin/env node
// botmux lead-only guard (PreToolUse, all tools). Inert unless BOTMUX_LEAD_ONLY=1.
import { readFileSync } from 'node:fs';
const LEAD_ALLOWED_TOOLS = new Set(${JSON.stringify(LEAD_ALLOWED_TOOLS)});
if (process.env.${LEAD_ONLY_ENV} !== '1') process.exit(0);
let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const tool = String(input.tool_name || 'Bash');
if (tool !== 'Bash') {
  if (LEAD_ALLOWED_TOOLS.has(tool)) process.exit(0);
  process.stderr.write(${JSON.stringify(LEAD_ONLY_BLOCK_MESSAGE)} + '\\n');
  process.exit(2);
}
const cmd = String((input.tool_input && input.tool_input.command) || '');
const hd = cmd.indexOf('<<');
const head = (hd >= 0 ? cmd.slice(0, hd) : cmd).trim();
// A heredoc must be the whole rest of the command: one delimiter, nothing after
// its terminator line, and an unquoted delimiter's body (which the shell
// expands) must not contain command substitution.
if (hd >= 0) {
  const hm = /^<<-?[ \\t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\\1[ \\t]*\\n/.exec(cmd.slice(hd));
  if (!hm) { process.stderr.write(${JSON.stringify(LEAD_ONLY_BLOCK_MESSAGE)} + '\\n'); process.exit(2); }
  const lines = cmd.slice(hd + hm[0].length).split('\\n');
  const end = lines.findIndex(l => l.replace(/^\\t+/, '') === hm[2]);
  const body = end >= 0 ? lines.slice(0, end).join('\\n') : lines.join('\\n');
  const tail = end >= 0 ? lines.slice(end + 1).join('\\n').trim() : '';
  if (tail || (!hm[1] && /\\$\\(|\`/.test(body))) {
    process.stderr.write(${JSON.stringify(LEAD_ONLY_BLOCK_MESSAGE)} + '\\n');
    process.exit(2);
  }
}
// Quoted argument text is data, not shell syntax: '...' never expands, and "..."
// is safe once it holds no command substitution. Strip both before looking for
// command separators, so a dispatch brief may contain ; | & in quotes.
let unsafeQuote = false;
const bare = head
  .replace(/'[^']*'/g, "''")
  .replace(/"(?:[^"\\\\]|\\\\.)*"/g, q => { if (/\\$\\(|\`/.test(q)) unsafeQuote = true; return '""'; });
const ok = !unsafeQuote && /^botmux(\\s|$)/.test(bare) && !/[;&|\`\\n'"]|\\$\\(/.test(bare.replace(/''|""/g, ''));
if (ok) process.exit(0);
process.stderr.write(${JSON.stringify(LEAD_ONLY_BLOCK_MESSAGE)} + '\\n');
process.exit(2);
`;

export const LEAD_ONLY_HOOKS_JSON = JSON.stringify({
  hooks: {
    PreToolUse: [{
      matcher: '*',
      hooks: [{ type: 'command', command: `node "\${CLAUDE_PLUGIN_ROOT}/hooks/${LEAD_ONLY_GUARD_FILENAME}"` }],
    }],
  },
}, null, 2) + '\n';

function writeIfChanged(file: string, content: string): void {
  if (existsSync(file) && readFileSync(file, 'utf-8') === content) return;
  atomicWriteFileSync(file, content);
}

/** Materialise the guard + hooks.json under a Claude plugin dir (idempotent). */
export function ensureLeadOnlyGuard(pluginRoot: string): void {
  try {
    const dir = join(pluginRoot, 'hooks');
    mkdirSync(dir, { recursive: true });
    writeIfChanged(join(dir, LEAD_ONLY_GUARD_FILENAME), LEAD_ONLY_GUARD_SCRIPT);
    writeIfChanged(join(dir, 'hooks.json'), LEAD_ONLY_HOOKS_JSON);
  } catch (err: any) {
    logger.warn(`[skills] Failed to write lead-only guard under ${pluginRoot}: ${err.message}`);
  }
}
