#!/usr/bin/env node
/**
 * Mir CLI (mircli) runner — the `mir` adapter's backend.
 *
 * Unlike the interactive PTY adapters, `mir` drives mircli through its
 * non-interactive Print Mode: each botmux turn spawns
 *
 *     mircli -p <content> --lean --output-format text --session-id <sid> -y \
 *            --append-system-prompt <local-runtime-context>
 *
 * in the botmux workspace cwd, captures stdout, and ships it back to the daemon
 * as an OSC `final` marker (parsed by the worker, see APP_RUNNER_OSC_CLI_IDS).
 *
 * Why Print Mode instead of driving the TUI (the original interactive `mir`):
 *   - no "恢复上次对话? [y/N]" startup prompt, no ≥10-line paste folding, no
 *     lazy-save (so no MIRA_HOME isolation / /save flush / transcript drain);
 *   - `mircli` is local-first (`comprehensive=0`): file/bash tools execute on
 *     THIS machine, so `mir` operates on the real workspace (needs the user's
 *     local MCP bridge connected — same prerequisite as standalone mircli);
 *   - delivery is the runner's stdout, so it needs neither `botmux send` nor
 *     BOTMUX_SESSION_ID injection — the daemon already owns the session.
 *
 * Limitation: because delivery is stdout (not `botmux send`), `mir` is a passive
 * participant — it answers when @-mentioned but cannot proactively @ another bot
 * (a structured outbound-mention channel is a separate follow-up).
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { getMiraRuntimePaths, ensureMiramcpSandboxAllows } from './mir-local-runtime.js';

interface Args {
  sessionId: string;
  botName?: string;
  botOpenId?: string;
  locale?: string;
  mircliBin?: string;
}

const OSC_PREFIX = '\x1b]777;botmux:';
const OSC_END = '\x07';
const DEFAULT_QUERY_TIMEOUT = '10m';
const DEFAULT_RUNNER_TIMEOUT_MS = 12 * 60 * 1000;
const MARKER_PREFIX = '::botmux-mir:';
// Backend Claude-harness builtin tools that route to the cloud sandbox; mircli's
// own local tools are the lowercase equivalents. Optionally hard-disallow these
// (MIRCLI_DISALLOW_BUILTIN=1) to push the model onto the local tools. Off by
// default — the validated path relies on --lean + the local MCP bridge.
const BUILTIN_SANDBOX_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

function parseArgs(argv: string[]): Args {
  const out: Args = { sessionId: '' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--session-id' && val !== undefined) { out.sessionId = val; i++; }
    else if (key === '--bot-name' && val !== undefined) { out.botName = val; i++; }
    else if (key === '--bot-open-id' && val !== undefined) { out.botOpenId = val; i++; }
    else if (key === '--locale' && val !== undefined) { out.locale = val; i++; }
    else if (key === '--mircli-bin' && val !== undefined) { out.mircliBin = val; i++; }
  }
  if (!out.sessionId) throw new Error('--session-id is required');
  return out;
}

function b64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function emitMarker(kind: string, payload: unknown): void {
  process.stdout.write(`${OSC_PREFIX}${kind}:${b64Json(payload)}${OSC_END}`);
}

function writeLine(text = ''): void {
  process.stdout.write(text + '\n');
}

function prompt(): void {
  process.stdout.write('› ');
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function splitEnvArgs(value: string | undefined): string[] {
  return (value || '').split(/\s+/).map(s => s.trim()).filter(Boolean);
}

/** Strip OSC/CSI/escape sequences so the captured stdout is plain text. */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
}

/** Ensure ~/.local/bin (where mircli installs) is on PATH for the child. */
function localPathEnv(): string {
  const existing = process.env.PATH || '';
  const localBin = join(homedir(), '.local', 'bin');
  return existing.split(':').includes(localBin) ? existing : `${localBin}:${existing}`;
}

function runtimeSystemPrompt(): string {
  const paths = getMiraRuntimePaths();
  const lines = [
    'You are invoked by BotMux inside the user machine through the local Mir CLI.',
    `Actual local runtime cwd: ${paths.cwd}`,
    `Actual local home: ${paths.home}`,
  ];
  if (paths.logicalCwd && paths.logicalCwd !== paths.cwd) {
    lines.push(
      `Local tool path alias for the same cwd: ${paths.logicalCwd}`,
      'If a local tool reports the physical cwd is outside allowed roots, retry the same operation with this local tool path alias.',
    );
  }
  lines.push(
    `Local tool allowed path candidates: ${paths.allowedPathCandidates.join(', ')}`,
    'BotMux invokes you in a non-interactive message bridge. NEVER emit ```ask_user_call``` or ```ask_user_form_call``` fences for local path, permission, or environment issues.',
    'If the target path is not obvious, use the actual local runtime cwd above. Do not ask the user to choose a path when this cwd is provided.',
    'This BotMux session is not running in /home/mira/.session. Do not report /home/mira/.session as the working directory for this session.',
    'Local filesystem, shell/bash, git, and BotMux CLI tools are available through the Mir CLI local tool bridge for this process.',
    'When the user asks to create, read, list, edit, or inspect local files, run bash/shell commands, inspect git, or operate BotMux, you MUST call the local tools against the actual local cwd above.',
    'Prefer local bash commands that operate from the current cwd with relative paths first; if an absolute physical cwd fails, retry the same operation from the current cwd and then with the local tool path alias before reporting failure.',
    'Do not say the local MCP bridge is disconnected, that only a cloud sandbox is available, or that the operation is cancelled unless a concrete local tool invocation actually returned that error.',
    'If a local tool invocation fails, report the exact failed operation and error concisely, then stop or ask for the missing input.',
  );
  return [
    ...lines,
  ].join('\n');
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractTaggedBlock(content: string, tag: string): string | undefined {
  const open = new RegExp(`<${tag}\\b[^>]*>`, 'i').exec(content);
  if (!open) return undefined;
  const start = open.index + open[0].length;
  const close = content.toLowerCase().indexOf(`</${tag}>`, start);
  if (close < 0) return undefined;
  return content.slice(start, close).trim();
}

function extractOpeningTagAttributes(content: string, tag: string): string | undefined {
  const open = new RegExp(`<${tag}\\b([^>]*)>`, 'i').exec(content);
  return open ? open[1] : undefined;
}

function extractXmlAttribute(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}="([^"]*)"`, 'i');
  const match = pattern.exec(attrs);
  return match ? decodeXmlEntities(match[1]) : undefined;
}

function summarizeAttachments(content: string): string[] {
  const block = extractTaggedBlock(content, 'attachments');
  if (!block) return [];

  const out: string[] = [];
  const itemPattern = /<(image|file)\b([^>]*)\/?>/gi;
  for (const match of block.matchAll(itemPattern)) {
    const type = match[1].toLowerCase();
    const attrs = match[2];
    const n = extractXmlAttribute(attrs, 'n');
    const path = extractXmlAttribute(attrs, 'path');
    const name = extractXmlAttribute(attrs, 'name');
    if (!path) continue;
    const label = type === 'image' ? 'image' : 'file';
    const index = n ? ` ${n}` : '';
    const suffix = name ? ` (${name})` : '';
    out.push(`${label}${index}: ${path}${suffix}`);
  }
  return out;
}

function summarizeRole(content: string): string | undefined {
  const block = extractTaggedBlock(content, 'role');
  if (!block) return undefined;
  const role = decodeXmlEntities(block).trim();
  if (!role) return undefined;
  return ['Role context from BotMux:', role].join('\n');
}

function summarizeBotmuxRouting(content: string): string | undefined {
  const block = extractTaggedBlock(content, 'botmux_routing');
  if (!block) return undefined;
  const routing = decodeXmlEntities(block).trim();
  if (!routing) return undefined;
  return ['BotMux routing instructions:', routing].join('\n');
}

function summarizeAvailableBots(content: string): string | undefined {
  const block = extractTaggedBlock(content, 'available_bots');
  if (!block) return undefined;

  const lines: string[] = [];
  const attrs = extractOpeningTagAttributes(content, 'available_bots') || '';
  const hint = extractXmlAttribute(attrs, 'hint');
  if (hint) lines.push(hint);

  const botPattern = /<bot\b([^>]*)\/?>/gi;
  for (const match of block.matchAll(botPattern)) {
    const name = extractXmlAttribute(match[1], 'name');
    const openId = extractXmlAttribute(match[1], 'open_id');
    if (!name && !openId) continue;
    lines.push(`- ${name || '(unnamed bot)'}: ${openId || '(missing open_id)'}`);
  }

  if (lines.length === 0) return undefined;
  return [
    'Available BotMux bots for handoff:',
    ...lines,
    'To hand work off to one of these bots, use local bash to run: botmux send --mention <open_id> "message".',
  ].join('\n');
}

function summarizeMentions(content: string): string | undefined {
  const block = extractTaggedBlock(content, 'mentions');
  if (!block) return undefined;

  const mentions: string[] = [];
  const mentionPattern = /<mention\b([^>]*)\/?>/gi;
  for (const match of block.matchAll(mentionPattern)) {
    const name = extractXmlAttribute(match[1], 'name');
    const openId = extractXmlAttribute(match[1], 'open_id');
    if (!name && !openId) continue;
    mentions.push(`- ${name || '(unnamed mention)'}${openId ? `: ${openId}` : ''}`);
  }

  if (mentions.length === 0) return undefined;
  return ['Mentions in this BotMux turn:', ...mentions].join('\n');
}

function summarizeSender(content: string): string | undefined {
  const attrs = extractOpeningTagAttributes(content, 'sender');
  if (attrs === undefined) return undefined;
  const type = extractXmlAttribute(attrs, 'type');
  const name = extractXmlAttribute(attrs, 'name');
  const openId = extractXmlAttribute(attrs, 'open_id');
  if (!name && !openId && !type) return undefined;
  const who = `${name || '(unknown)'}${openId ? ` (${openId})` : ''}${type ? ` [${type}]` : ''}`;
  const lines = [`Message sender: ${who}`];
  if (type === 'bot') {
    lines.push('The sender is another bot — your reply is delivered back to it automatically; do not worry about @-mentioning to wake it.');
  }
  return lines.join('\n');
}

function normalizeMircliPrompt(content: string): string {
  const userMessage = extractTaggedBlock(content, 'user_message');
  if (!userMessage) return content;

  const context = [
    summarizeBotmuxRouting(content),
    summarizeRole(content),
    summarizeSender(content),
    summarizeMentions(content),
    summarizeAvailableBots(content),
  ].filter((section): section is string => Boolean(section));

  const sections: string[] = [];
  if (context.length > 0) {
    sections.push(['BotMux context:', ...context].join('\n\n'));
  }
  sections.push(['User request:', decodeXmlEntities(userMessage)].join('\n'));

  const attachments = summarizeAttachments(content);
  if (attachments.length > 0) {
    sections.push([
      'Attachments available on the local filesystem:',
      ...attachments.map(item => `- ${item}`),
    ].join('\n'));
  }
  return sections.join('\n\n');
}

class MircliClient {
  private readonly sessionId: string;
  private readonly mircliBin?: string;

  constructor(args: Args) {
    this.sessionId = args.sessionId;
    this.mircliBin = args.mircliBin;
  }

  async ensureSession(): Promise<string> {
    emitMarker('thread', { threadId: this.sessionId });
    return this.sessionId;
  }

  async complete(content: string): Promise<{ finalText: string; turnId: string }> {
    const startedAt = Date.now();
    // Unwrap botmux's envelope (extract <user_message>, summarize routing/role/
    // mentions/available_bots) before handing the prompt to mircli.
    const finalText = await this.runMircli(normalizeMircliPrompt(content));
    return { finalText: finalText.trim(), turnId: `mircli-${startedAt}` };
  }

  private runMircli(content: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Precedence: adapter cliPathOverride (--mircli-bin) > MIRCLI_BIN env > PATH.
      const bin = this.mircliBin || process.env.MIRCLI_BIN || 'mircli';
      // Patch the local MCP bridge sandbox so writes to this workspace aren't
      // blocked (workspace may sit outside the default /root,/tmp allow-list).
      if (boolEnv('MIRCLI_PATCH_MIRAMCP_CONFIG', true)) {
        try {
          ensureMiramcpSandboxAllows(getMiraRuntimePaths().allowedPathCandidates);
        } catch {
          // Best-effort: the system prompt still gives physical + logical cwd
          // aliases so the model can recover if the bridge hasn't reloaded.
        }
      }
      const args = splitEnvArgs(process.env.MIRCLI_EXTRA_ARGS);
      if (boolEnv('MIRCLI_LEAN', true) && !args.includes('--lean') && !args.includes('--ultra')) {
        args.push('--lean');
      }
      args.push(
        '-p', content,
        '--output-format', 'text',
        '--session-id', this.sessionId,
        '--query-timeout', process.env.MIRCLI_QUERY_TIMEOUT || DEFAULT_QUERY_TIMEOUT,
        '--append-system-prompt', runtimeSystemPrompt(),
      );
      if (boolEnv('MIRCLI_YOLO', true)) args.push('-y');
      // Optional reliability lever: hard-block the backend's cloud-sandbox
      // builtins so the model is pushed onto mircli's local tools.
      if (boolEnv('MIRCLI_DISALLOW_BUILTIN', false)) {
        for (const tool of BUILTIN_SANDBOX_TOOLS) args.push('--disallowed-tool', tool);
      }

      let closed = false;
      let timedOut = false;
      const child = spawn(bin, args, {
        cwd: process.cwd(),
        env: { ...process.env, PATH: localPathEnv() },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      const timeoutMs = Number(process.env.MIRCLI_RUNNER_TIMEOUT_MS || DEFAULT_RUNNER_TIMEOUT_MS);
      const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 5_000).unref();
        }, timeoutMs)
        : undefined;
      timer?.unref();

      child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
      child.on('error', err => {
        if (timer) clearTimeout(timer);
        reject(new Error(`Failed to start mircli (${bin}): ${errorMessage(err)}. Install mircli (curl -fsSL https://tosv.byted.org/obj/juren-cn/mircli/install.sh | bash) or set MIRCLI_BIN.`));
      });
      child.on('close', (code, signal) => {
        closed = true;
        if (timer) clearTimeout(timer);
        const cleanStdout = stripAnsi(stdout).trim();
        const cleanStderr = stripAnsi(stderr).trim();
        if (code === 0) { resolve(cleanStdout || cleanStderr); return; }
        const detail = (cleanStderr || cleanStdout || `signal ${signal ?? 'unknown'}`).slice(0, 1200);
        const suffix = timedOut ? ` after ${timeoutMs}ms` : '';
        reject(new Error(`mircli exited with code ${code ?? 'null'}${suffix}: ${detail}`));
      });
    });
  }
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`Mir runner: ${errorMessage(err)}`);
  process.exit(2);
}

const client = new MircliClient(args);
const queue: string[] = [];
let inputBuffer = '';
let processing = false;

async function runTurn(content: string): Promise<void> {
  const startedAtMs = Date.now();
  writeLine();
  writeLine('[user]');
  writeLine(content);
  writeLine();
  writeLine('[mir] thinking...');

  const result = await client.complete(content);
  const completedAtMs = Date.now();
  if (result.finalText) {
    writeLine();
    writeLine(result.finalText);
    emitMarker('final', {
      turnId: result.turnId,
      content: result.finalText,
      startedAtMs,
      completedAtMs,
    });
  } else {
    writeLine('[mir] completed without text output.');
  }
}

async function drainQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const next = queue.shift()!;
      try {
        await runTurn(next);
      } catch (err) {
        const now = Date.now();
        const message = `Mir runner error: ${errorMessage(err)}`;
        writeLine(message);
        emitMarker('final', {
          turnId: `mir-error-${now}`,
          content: message,
          startedAtMs: now,
          completedAtMs: now,
        });
      }
      prompt();
    }
  } finally {
    processing = false;
  }
}

function enqueueLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed.startsWith(MARKER_PREFIX)) {
    const encoded = trimmed.slice(MARKER_PREFIX.length);
    try {
      const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      if (decoded?.type === 'message' && typeof decoded.content === 'string') {
        queue.push(decoded.content);
        void drainQueue();
      }
    } catch (err) {
      writeLine(`[mir] bad botmux input: ${errorMessage(err)}`);
    }
    return;
  }
  queue.push(line);
  void drainQueue();
}

function handleInput(data: Buffer): void {
  const text = data.toString('utf8');
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code === 3) {           // Ctrl-C
      process.exit(130);
    } else if (ch === '\r' || ch === '\n') {
      const line = inputBuffer;
      inputBuffer = '';
      enqueueLine(line);
    } else if (code === 127 || code === 8) {  // DEL / Backspace
      inputBuffer = inputBuffer.slice(0, -1);
    } else {
      inputBuffer += ch;
    }
  }
}

async function main(): Promise<void> {
  await client.ensureSession();
  writeLine('Mir CLI runner ready.');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleInput);
  prompt();
}

process.on('SIGTERM', () => { process.exit(0); });

main().catch(err => {
  console.error(`Mir runner failed: ${errorMessage(err)}`);
  process.exit(1);
});
