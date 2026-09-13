import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { resolveCliSpawn } from '../core/self-spawn.js';
import {
  readHeadlessSession,
  type HeadlessSessionRecord,
} from '../services/headless-session-store.js';

const USAGE = `botmux session

Usage:
  botmux session start --headless --bot <bot> --working-dir <dir>
                       --prompt-file <path> [--json]
                       [--model <model>] [--reasoning-effort <effort>]
                       [--timeout <seconds>] [--name <title>]
  botmux session send <session-id> --prompt-file <path> [--wait] [--json]
  botmux session wait <session-id> [--trigger-id <triggerId>] [--json]
  botmux session result <session-id> [--trigger-id <triggerId>] [--json]
  botmux session list [--bot <larkAppId>] [--json]
  botmux session bind <session-id> --chat-id <oc_xxx> [--into <om_xxx>] [--json]
  botmux session publish <session-id> --create-group --name "任务名" [--json]
  botmux session publish <session-id> --chat-id <oc_xxx> [--name "任务名"] [--json]

Notes:
  session is the stable automation-facing wrapper over BotMux headless sessions.
  start returns a publishable session id plus the first result. publish binds the
  session to a new or existing Lark chat, then sends and publishes a summary of
  prior context.`;

const SUMMARY_PROMPT = [
  '请总结这个 headless session 到目前为止的上下文。',
  '',
  '请包含:',
  '- 已完成的分析或动作',
  '- 关键结论和证据',
  '- 当前未解决的问题',
  '- 建议下一步',
  '',
  '面向刚加入群聊的人，使用简洁中文输出。',
].join('\n');

type SessionParsedCommand =
  | { ok: true; kind: 'help' }
  | {
      ok: true;
      kind: 'start';
      headless: true;
      bot?: string;
      workingDir?: string;
      promptFile?: string;
      prompt?: string;
      name?: string;
      model?: string;
      reasoningEffort?: string;
      timeout?: string;
      json: boolean;
    }
  | {
      ok: true;
      kind: 'publish';
      session: string;
      createGroup: boolean;
      chatId?: string;
      name?: string;
      summaryPrompt?: string;
      summaryPromptFile?: string;
      json: boolean;
    }
  | {
      ok: true;
      kind: 'passthrough';
      headlessSubcommand: 'create' | 'run' | 'send' | 'wait' | 'result' | 'list' | 'bind';
      args: readonly string[];
      json: boolean;
    }
  | { ok: false; error: string };

function one(args: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === flag) return args[i + 1];
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return undefined;
}

function has(args: readonly string[], flag: string): boolean {
  return args.some(token => token === flag);
}

function unknownFlags(
  args: readonly string[],
  valueFlags: readonly string[],
  boolFlags: readonly string[],
): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (!token.startsWith('-')) continue;
    const flag = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    if (valueFlags.includes(flag)) {
      if (!token.includes('=')) i += 1;
      continue;
    }
    if (boolFlags.includes(flag)) continue;
    out.push(flag);
  }
  return [...new Set(out)];
}

function missingValue(args: readonly string[], flag: string): boolean {
  const index = args.findIndex(token => token === flag || token.startsWith(`${flag}=`));
  if (index < 0) return false;
  const token = args[index]!;
  if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1).trim() === '';
  const next = args[index + 1];
  return next === undefined || (next.startsWith('-') && next !== '-');
}

function positionals(
  args: readonly string[],
  valueFlags: readonly string[],
  boolFlags: readonly string[],
): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (!token.startsWith('-')) {
      out.push(token);
      continue;
    }
    const flag = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    if (valueFlags.includes(flag) && !token.includes('=')) i += 1;
    if (!valueFlags.includes(flag) && !boolFlags.includes(flag)) {
      // Unknown flags are reported before positionals are consumed.
    }
  }
  return out;
}

function stdinText(): string {
  if (process.stdin.isTTY) return '';
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function parseSessionArgs(args: readonly string[]): SessionParsedCommand {
  const sub = args[0] ?? 'help';
  const rest = args.slice(1);
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    return { ok: true, kind: 'help' };
  }

  if (
    sub === 'create' || sub === 'run' || sub === 'send'
    || sub === 'wait' || sub === 'result' || sub === 'list'
    || sub === 'bind'
  ) {
    return {
      ok: true,
      kind: 'passthrough',
      headlessSubcommand: sub,
      args: rest,
      json: has(rest, '--json'),
    };
  }

  if (sub === 'start') {
    const valueFlags = [
      '--bot',
      '--working-dir',
      '--prompt-file',
      '--prompt',
      '--model',
      '--reasoning-effort',
      '--timeout',
      '--name',
      '--title',
    ];
    const bad = unknownFlags(rest, valueFlags, ['--headless', '--json']);
    if (bad.length > 0) return { ok: false, error: `unknown option: ${bad.join(', ')}` };
    for (const flag of valueFlags) {
      if (missingValue(rest, flag)) return { ok: false, error: `${flag} requires a value` };
    }
    if (!has(rest, '--headless')) {
      return { ok: false, error: 'session start currently requires --headless' };
    }
    const promptFile = one(rest, '--prompt-file')?.trim();
    const prompt = one(rest, '--prompt') ?? stdinText();
    if (!promptFile && !prompt.trim()) {
      return { ok: false, error: 'pass --prompt-file, --prompt, or stdin' };
    }
    return {
      ok: true,
      kind: 'start',
      headless: true,
      bot: one(rest, '--bot')?.trim(),
      workingDir: one(rest, '--working-dir')?.trim(),
      promptFile,
      prompt,
      name: one(rest, '--name')?.trim() || one(rest, '--title')?.trim(),
      model: one(rest, '--model')?.trim(),
      reasoningEffort: one(rest, '--reasoning-effort')?.trim(),
      timeout: one(rest, '--timeout')?.trim(),
      json: has(rest, '--json'),
    };
  }

  if (sub === 'publish') {
    const valueFlags = [
      '--chat-id',
      '--name',
      '--summary-prompt',
      '--summary-prompt-file',
    ];
    const bad = unknownFlags(rest, valueFlags, ['--create-group', '--json']);
    if (bad.length > 0) return { ok: false, error: `unknown option: ${bad.join(', ')}` };
    for (const flag of valueFlags) {
      if (missingValue(rest, flag)) return { ok: false, error: `${flag} requires a value` };
    }
    const positional = positionals(rest, valueFlags, ['--create-group', '--json']);
    const session = positional[0]?.trim();
    const createGroup = has(rest, '--create-group');
    const chatId = one(rest, '--chat-id')?.trim();
    const name = one(rest, '--name')?.trim();
    if (!session) return { ok: false, error: 'publish requires a session id' };
    if (createGroup && chatId) {
      return { ok: false, error: 'use either --create-group or --chat-id, not both' };
    }
    if (!createGroup && !chatId) {
      return { ok: false, error: 'publish requires --create-group or --chat-id' };
    }
    if (createGroup && !name) {
      return { ok: false, error: 'publish --create-group requires --name' };
    }
    return {
      ok: true,
      kind: 'publish',
      session,
      createGroup,
      chatId,
      name,
      summaryPrompt: one(rest, '--summary-prompt'),
      summaryPromptFile: one(rest, '--summary-prompt-file')?.trim(),
      json: has(rest, '--json'),
    };
  }

  return { ok: false, error: `unknown session subcommand: ${sub}` };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string, json: boolean, code = 1): number {
  if (json) printJson({ ok: false, error: message });
  else process.stderr.write(`botmux session: ${message}\n`);
  return code;
}

function dataDir(): string {
  const resolved = process.env.SESSION_DATA_DIR ?? resolveBotmuxDataDir();
  process.env.SESSION_DATA_DIR = resolved;
  return resolved;
}

function cliScriptPath(): string {
  return process.argv[1] || '';
}

function runBotmux(args: readonly string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const resolved = resolveCliSpawn(cliScriptPath(), args);
  const result = spawnSync(resolved.command, resolved.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function parseJson(stdout: string): any {
  return JSON.parse(stdout || '{}');
}

function firstChatId(stdout: string): string | undefined {
  return stdout.split(/\r?\n/).map(line => line.trim()).find(line => /^oc_[A-Za-z0-9_-]+$/.test(line));
}

function sessionRecord(idOrSessionId: string): HeadlessSessionRecord | null {
  return readHeadlessSession(idOrSessionId);
}

function summaryPrompt(parsed: Extract<SessionParsedCommand, { kind: 'publish' }>): string {
  if (parsed.summaryPromptFile) return readFileSync(parsed.summaryPromptFile, 'utf8');
  return parsed.summaryPrompt ?? SUMMARY_PROMPT;
}

function compactStartOutput(raw: any): Record<string, unknown> {
  const headlessId = raw?.created?.headlessId;
  const botmuxSessionId = raw?.created?.sessionId ?? raw?.trigger?.target?.sessionId;
  const triggerId = raw?.trigger?.triggerId ?? raw?.result?.triggerId;
  return {
    ok: raw?.ok === true,
    sessionId: headlessId ?? botmuxSessionId,
    headlessId,
    botmuxSessionId,
    triggerId,
    state: raw?.result?.state,
    output: raw?.result?.output,
    result: raw?.result,
    raw,
  };
}

export function parseSessionCommandForTest(args: readonly string[]): SessionParsedCommand {
  return parseSessionArgs(args);
}

export async function cmdSession(args: readonly string[]): Promise<number> {
  const parsed = parseSessionArgs(args);
  const wantsJson = args.includes('--json');
  if (!parsed.ok) return fail(parsed.error, wantsJson, 2);
  if (parsed.kind === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  dataDir();

  if (parsed.kind === 'passthrough') {
    const result = runBotmux(['headless', parsed.headlessSubcommand, ...parsed.args]);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.status;
  }

  if (parsed.kind === 'start') {
    const headlessArgs = ['headless', 'run', '--wait', '--json'];
    if (parsed.bot) headlessArgs.push('--bot', parsed.bot);
    if (parsed.workingDir) headlessArgs.push('--working-dir', parsed.workingDir);
    if (parsed.model) headlessArgs.push('--model', parsed.model);
    if (parsed.reasoningEffort) headlessArgs.push('--reasoning-effort', parsed.reasoningEffort);
    if (parsed.timeout) headlessArgs.push('--timeout', parsed.timeout);
    if (parsed.name) headlessArgs.push('--title', parsed.name);
    if (parsed.promptFile) headlessArgs.push('--prompt-file', parsed.promptFile);
    else if (parsed.prompt) headlessArgs.push('--prompt', parsed.prompt);
    const result = runBotmux(headlessArgs);
    if (result.status !== 0) {
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.stdout) process.stdout.write(result.stdout);
      return result.status;
    }
    let raw: any;
    try { raw = parseJson(result.stdout); } catch (error) {
      return fail(`headless run did not return JSON: ${(error as Error).message}`, parsed.json);
    }
    const output = compactStartOutput(raw);
    if (parsed.json) printJson(output);
    else {
      process.stdout.write(`${output.sessionId ?? ''}\n`);
      const content = raw?.result?.output?.content;
      if (typeof content === 'string' && content) process.stdout.write(`${content}\n`);
    }
    return raw?.ok === true ? 0 : 1;
  }

  const record = sessionRecord(parsed.session);
  if (!record) return fail(`headless session not found: ${parsed.session}`, parsed.json);

  let chatId = parsed.chatId;
  let createGroup: Record<string, unknown> | undefined;
  if (parsed.createGroup) {
    const groupArgs = ['create-group', '--bot', record.larkAppId, '--name', parsed.name!, '--json-status'];
    if (record.workingDir) groupArgs.push('--working-dir', record.workingDir);
    const group = runBotmux(groupArgs);
    chatId = firstChatId(group.stdout);
    createGroup = {
      status: group.status,
      chatId,
      stdout: group.stdout,
      stderr: group.stderr,
    };
    if (!chatId) {
      if (group.stderr) process.stderr.write(group.stderr);
      return fail('create-group did not return a chat id', parsed.json);
    }
  }
  if (!chatId) return fail('missing chat id', parsed.json);

  const bindArgs = [
    'headless',
    'bind',
    parsed.session,
    '--chat-id',
    chatId,
    '--scope',
    'thread',
    '--replay',
    'none',
    '--json',
  ];
  if (parsed.name) bindArgs.push('--title', parsed.name);
  const bind = runBotmux(bindArgs);
  if (bind.status !== 0) {
    if (bind.stderr) process.stderr.write(bind.stderr);
    if (bind.stdout) process.stdout.write(bind.stdout);
    return bind.status;
  }
  let bindJson: any;
  try { bindJson = parseJson(bind.stdout); } catch (error) {
    return fail(`headless bind did not return JSON: ${(error as Error).message}`, parsed.json);
  }

  const sendArgs = [
    'headless',
    'send',
    '--session',
    parsed.session,
    '--prompt',
    summaryPrompt(parsed),
    '--wait',
    '--json',
  ];
  const sent = runBotmux(sendArgs);
  if (sent.status !== 0) {
    if (sent.stderr) process.stderr.write(sent.stderr);
    if (sent.stdout) process.stdout.write(sent.stdout);
    return sent.status;
  }
  let sentJson: any;
  try { sentJson = parseJson(sent.stdout); } catch (error) {
    return fail(`headless send did not return JSON: ${(error as Error).message}`, parsed.json);
  }
  const summaryTriggerId = sentJson?.trigger?.triggerId ?? sentJson?.result?.triggerId;
  let publishedJson: any;
  if (summaryTriggerId) {
    const publish = runBotmux([
      'headless',
      'publish',
      parsed.session,
      '--trigger-id',
      summaryTriggerId,
      '--json',
    ]);
    if (publish.status !== 0) {
      if (publish.stderr) process.stderr.write(publish.stderr);
      if (publish.stdout) process.stdout.write(publish.stdout);
      return publish.status;
    }
    try { publishedJson = parseJson(publish.stdout); } catch (error) {
      return fail(`headless publish did not return JSON: ${(error as Error).message}`, parsed.json);
    }
  }

  const output = {
    ok: bindJson?.ok === true && sentJson?.ok === true
      && (!summaryTriggerId || publishedJson?.ok === true),
    sessionId: record.id,
    botmuxSessionId: record.sessionId,
    chatId,
    ...(createGroup ? { createGroup } : {}),
    bind: bindJson,
    summary: sentJson,
    ...(publishedJson ? { published: publishedJson } : {}),
  };
  if (parsed.json) printJson(output);
  else {
    process.stdout.write(`${chatId}\n`);
    if (summaryTriggerId) process.stdout.write(`${summaryTriggerId}\n`);
  }
  return output.ok ? 0 : 1;
}
