import { readFileSync } from 'node:fs';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { fetchDaemonIpc } from '../core/daemon-ipc-auth.js';
import {
  listOnlineDaemons,
  findOnlineDaemon,
  type OnlineDaemonInfo,
} from '../utils/daemon-discovery.js';
import {
  listHeadlessSessions,
  readHeadlessSession,
  type HeadlessSessionRecord,
} from '../services/headless-session-store.js';
import type { TriggerRequest, TriggerResponse } from '../services/trigger-types.js';

type ReasoningEffort = NonNullable<HeadlessSessionRecord['reasoningEffort']>;

const REASONING_EFFORTS = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

const USAGE = `botmux headless

Usage:
  botmux headless create [--bot <larkAppId>] [--title <title>] [--working-dir <dir>]
                          [--model <model>] [--reasoning-effort <effort>] [--json]
  botmux headless run [--session <id>] [prompt...] [--prompt <text>|--prompt-file <path>]
                       [--bot <larkAppId>] [--title <title>] [--working-dir <dir>]
                       [--model <model>] [--reasoning-effort <effort>]
                       [--wait] [--timeout <seconds>] [--json]
  botmux headless send --session <id> [prompt...] [--prompt <text>|--prompt-file <path>]
                        [--wait] [--timeout <seconds>] [--json]
  botmux headless wait <id> [--trigger-id <triggerId>] [--timeout <seconds>] [--json]
  botmux headless result <id> [--trigger-id <triggerId>] [--json]
  botmux headless list [--bot <larkAppId>] [--json]
  botmux headless publish <id> [--chat-id <oc_...>] [--into <om_...>] [--trigger-id <triggerId>] [--json]
  botmux headless bind <id> --chat-id <oc_...> [--into <om_...>] [--scope chat|thread]
                       [--title <topic title>] [--replay latest|none]
                       [--trigger-id <triggerId>] [--json]`;

export type HeadlessParsedCommand =
  | { ok: true; kind: 'help' }
  | { ok: true; kind: 'list'; bot?: string; json: boolean }
  | { ok: true; kind: 'create'; bot?: string; title?: string; workingDir?: string; model?: string; reasoningEffort?: ReasoningEffort; json: boolean }
  | { ok: true; kind: 'run'; session?: string; prompt: string; bot?: string; title?: string; workingDir?: string; model?: string; reasoningEffort?: ReasoningEffort; wait: boolean; timeoutMs: number; json: boolean }
  | { ok: true; kind: 'result'; session: string; triggerId?: string; wait: boolean; timeoutMs: number; json: boolean }
  | { ok: true; kind: 'publish'; session: string; chatId?: string; rootMessageId?: string; triggerId?: string; json: boolean }
  | { ok: true; kind: 'bind'; session: string; chatId: string; rootMessageId?: string; scope?: 'thread' | 'chat'; title?: string; replay: 'latest' | 'none'; triggerId?: string; json: boolean }
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
      // Unknown flags are reported earlier; keep walking deterministically.
    }
  }
  return out;
}

function parseReasoningEffort(raw: string | undefined): ReasoningEffort | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  return REASONING_EFFORTS.has(raw as ReasoningEffort) ? raw as ReasoningEffort : 'invalid';
}

function parseTimeoutMs(raw: string | undefined, fallbackMs: number): number | 'invalid' {
  if (raw === undefined) return fallbackMs;
  if (!/^\d+$/.test(raw)) return 'invalid';
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86_400) return 'invalid';
  return seconds * 1000;
}

function stdinText(): string {
  if (process.stdin.isTTY) return '';
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function promptFromArgs(args: readonly string[], positionalPrompt: readonly string[]): string {
  const promptFile = one(args, '--prompt-file');
  if (promptFile) {
    return promptFile === '-' ? stdinText() : readFileSync(promptFile, 'utf8');
  }
  const explicit = one(args, '--prompt');
  if (explicit !== undefined) return explicit;
  const joined = positionalPrompt.join(' ').trim();
  return joined || stdinText();
}

function looksLikeHeadlessTarget(value: string | undefined): boolean {
  return !!value && (
    value.startsWith('hl_')
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export function parseHeadlessArgs(args: readonly string[]): HeadlessParsedCommand {
  const sub = args[0] ?? 'help';
  const rest = args.slice(1);
  if (sub === 'help' || sub === '--help' || sub === '-h') return { ok: true, kind: 'help' };

  if (sub === 'list' || sub === 'ls') {
    const bad = unknownFlags(rest, ['--bot'], ['--json']);
    if (bad.length > 0) return { ok: false, error: `unknown option: ${bad.join(', ')}` };
    if (missingValue(rest, '--bot')) return { ok: false, error: '--bot requires a value' };
    return { ok: true, kind: 'list', bot: one(rest, '--bot'), json: has(rest, '--json') };
  }

  if (sub === 'create') {
    const valueFlags = ['--bot', '--title', '--working-dir', '--model', '--reasoning-effort'];
    const bad = unknownFlags(rest, valueFlags, ['--json']);
    if (bad.length > 0) return { ok: false, error: `unknown option: ${bad.join(', ')}` };
    for (const flag of valueFlags) {
      if (missingValue(rest, flag)) return { ok: false, error: `${flag} requires a value` };
    }
    const reasoningEffort = parseReasoningEffort(one(rest, '--reasoning-effort'));
    if (reasoningEffort === 'invalid') return { ok: false, error: 'invalid --reasoning-effort' };
    return {
      ok: true,
      kind: 'create',
      bot: one(rest, '--bot'),
      title: one(rest, '--title')?.trim(),
      workingDir: one(rest, '--working-dir')?.trim(),
      model: one(rest, '--model')?.trim(),
      reasoningEffort,
      json: has(rest, '--json'),
    };
  }

  if (sub === 'run' || sub === 'send') {
    const valueFlags = ['--session', '--bot', '--title', '--working-dir', '--model', '--reasoning-effort', '--prompt', '--prompt-file', '--timeout'];
    const bad = unknownFlags(rest, valueFlags, ['--wait', '--json']);
    if (bad.length > 0) return { ok: false, error: `unknown option: ${bad.join(', ')}` };
    for (const flag of valueFlags) {
      if (missingValue(rest, flag)) return { ok: false, error: `${flag} requires a value` };
    }
    const reasoningEffort = parseReasoningEffort(one(rest, '--reasoning-effort'));
    if (reasoningEffort === 'invalid') return { ok: false, error: 'invalid --reasoning-effort' };
    const timeoutMs = parseTimeoutMs(one(rest, '--timeout'), 300_000);
    if (timeoutMs === 'invalid') return { ok: false, error: '--timeout must be 1..86400 seconds' };
    const positional = positionals(rest, valueFlags, ['--wait', '--json']);
    let session = one(rest, '--session')?.trim();
    let promptParts = positional;
    if (!session && sub === 'send') {
      session = positional[0]?.trim();
      promptParts = positional.slice(1);
    } else if (!session && looksLikeHeadlessTarget(positional[0])) {
      session = positional[0]!.trim();
      promptParts = positional.slice(1);
    }
    const prompt = promptFromArgs(rest, promptParts);
    if (!prompt.trim()) return { ok: false, error: 'empty prompt; pass prompt text, --prompt, --prompt-file, or stdin' };
    if (sub === 'send' && !session) return { ok: false, error: 'headless send requires --session <id> or a leading session id' };
    return {
      ok: true,
      kind: 'run',
      session,
      prompt,
      bot: one(rest, '--bot')?.trim(),
      title: one(rest, '--title')?.trim(),
      workingDir: one(rest, '--working-dir')?.trim(),
      model: one(rest, '--model')?.trim(),
      reasoningEffort,
      wait: has(rest, '--wait'),
      timeoutMs,
      json: has(rest, '--json'),
    };
  }

  if (sub === 'wait' || sub === 'result') {
    const valueFlags = ['--trigger-id', '--timeout'];
    const bad = unknownFlags(rest, valueFlags, ['--json']);
    if (bad.length > 0) return { ok: false, error: `unknown option: ${bad.join(', ')}` };
    for (const flag of valueFlags) {
      if (missingValue(rest, flag)) return { ok: false, error: `${flag} requires a value` };
    }
    const timeoutMs = parseTimeoutMs(one(rest, '--timeout'), sub === 'wait' ? 300_000 : 0);
    if (timeoutMs === 'invalid') return { ok: false, error: '--timeout must be 1..86400 seconds' };
    const positional = positionals(rest, valueFlags, ['--json']);
    const session = positional[0]?.trim();
    if (!session) return { ok: false, error: `${sub} requires a headless id or session id` };
    return {
      ok: true,
      kind: 'result',
      session,
      triggerId: one(rest, '--trigger-id')?.trim(),
      wait: sub === 'wait',
      timeoutMs,
      json: has(rest, '--json'),
    };
  }

  if (sub === 'publish') {
    const valueFlags = ['--chat-id', '--into', '--trigger-id'];
    const bad = unknownFlags(rest, valueFlags, ['--json']);
    if (bad.length > 0) return { ok: false, error: `unknown option: ${bad.join(', ')}` };
    for (const flag of valueFlags) {
      if (missingValue(rest, flag)) return { ok: false, error: `${flag} requires a value` };
    }
    const positional = positionals(rest, valueFlags, ['--json']);
    const session = positional[0]?.trim();
    const chatId = one(rest, '--chat-id')?.trim();
    if (!session) return { ok: false, error: 'publish requires a headless id or session id' };
    return {
      ok: true,
      kind: 'publish',
      session,
      chatId,
      rootMessageId: one(rest, '--into')?.trim(),
      triggerId: one(rest, '--trigger-id')?.trim(),
      json: has(rest, '--json'),
    };
  }

  if (sub === 'bind') {
    const valueFlags = ['--chat-id', '--into', '--scope', '--title', '--replay', '--trigger-id'];
    const bad = unknownFlags(rest, valueFlags, ['--json']);
    if (bad.length > 0) return { ok: false, error: `unknown option: ${bad.join(', ')}` };
    for (const flag of valueFlags) {
      if (missingValue(rest, flag)) return { ok: false, error: `${flag} requires a value` };
    }
    const positional = positionals(rest, valueFlags, ['--json']);
    const session = positional[0]?.trim();
    const chatId = one(rest, '--chat-id')?.trim();
    const rootMessageId = one(rest, '--into')?.trim();
    const scopeRaw = one(rest, '--scope')?.trim();
    const title = one(rest, '--title')?.trim();
    const replayRaw = one(rest, '--replay')?.trim() ?? 'latest';
    const triggerId = one(rest, '--trigger-id')?.trim();
    if (!session) return { ok: false, error: 'bind requires a headless id or session id' };
    if (!chatId) return { ok: false, error: 'bind requires --chat-id <oc_...>' };
    if (scopeRaw && scopeRaw !== 'thread' && scopeRaw !== 'chat') return { ok: false, error: '--scope must be chat or thread' };
    if (replayRaw !== 'latest' && replayRaw !== 'none') return { ok: false, error: '--replay must be latest or none' };
    if (scopeRaw === 'chat' && !rootMessageId) {
      return { ok: false, error: 'bind --scope chat requires --into <om_...> as an audit anchor' };
    }
    return {
      ok: true,
      kind: 'bind',
      session,
      chatId,
      rootMessageId,
      scope: scopeRaw as 'thread' | 'chat' | undefined,
      title,
      replay: replayRaw,
      triggerId,
      json: has(rest, '--json'),
    };
  }

  return { ok: false, error: `unknown headless subcommand: ${sub}` };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string, json: boolean, code = 1): number {
  if (json) printJson({ ok: false, error: message });
  else process.stderr.write(`botmux headless: ${message}\n`);
  return code;
}

function dataDir(): string {
  const resolved = process.env.SESSION_DATA_DIR ?? resolveBotmuxDataDir();
  process.env.SESSION_DATA_DIR = resolved;
  return resolved;
}

function daemons(): OnlineDaemonInfo[] {
  return listOnlineDaemons(dataDir());
}

function pickDaemon(bot?: string): OnlineDaemonInfo | { error: string } {
  const online = daemons();
  if (bot?.trim()) {
    const key = bot.trim();
    const exact = findOnlineDaemon(key, dataDir());
    if (exact) return exact;
    const named = online.find(d => d.botName === key || d.larkAppId === key);
    return named ?? { error: `daemon not online for bot ${key}` };
  }
  if (online.length === 1) return online[0]!;
  if (online.length === 0) return { error: 'no online botmux daemon; run botmux start first' };
  return { error: `multiple daemons online; pass --bot (${online.map(d => d.larkAppId).join(', ')})` };
}

function resolveLocalHeadlessRecord(idOrSessionId: string): HeadlessSessionRecord | { error: string } {
  const direct = readHeadlessSession(idOrSessionId);
  if (direct) return direct;
  const matches = listHeadlessSessions().filter(record =>
    record.id.startsWith(idOrSessionId) || record.sessionId.startsWith(idOrSessionId));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) return { error: `ambiguous headless session id: ${idOrSessionId}` };
  return { error: `headless session not found: ${idOrSessionId}` };
}

function daemonForRecord(
  record: HeadlessSessionRecord,
  bot?: string,
): OnlineDaemonInfo | { error: string } {
  if (bot && bot !== record.larkAppId) {
    return { error: `--bot ${bot} does not own headless session ${record.id}` };
  }
  const daemon = findOnlineDaemon(record.larkAppId, dataDir());
  return daemon ?? { error: `daemon not online for bot ${record.larkAppId}` };
}

async function postJson(daemon: OnlineDaemonInfo, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetchDaemonIpc(daemon.ipcPort, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` })) };
}

async function getJson(daemon: OnlineDaemonInfo, path: string): Promise<{ status: number; body: any }> {
  const response = await fetchDaemonIpc(daemon.ipcPort, path, { method: 'GET' });
  return { status: response.status, body: await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` })) };
}

async function createHeadless(
  daemon: OnlineDaemonInfo,
  input: { title?: string; workingDir?: string; model?: string; reasoningEffort?: ReasoningEffort },
): Promise<{ ok: true; headlessId: string; sessionId: string } | { ok: false; error: string; status?: number }> {
  const response = await postJson(daemon, '/api/headless/sessions', input);
  if (response.status >= 200 && response.status < 300 && response.body?.ok) {
    return {
      ok: true,
      headlessId: String(response.body.headlessId),
      sessionId: String(response.body.sessionId),
    };
  }
  return { ok: false, status: response.status, error: String(response.body?.error ?? `HTTP ${response.status}`) };
}

function buildTriggerRequest(input: {
  daemon: OnlineDaemonInfo;
  sessionId: string;
  headlessId?: string;
  prompt: string;
  title?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): TriggerRequest {
  const receivedAt = new Date().toISOString();
  return {
    source: {
      type: 'headless',
      connectorId: 'botmux-headless-cli',
      requestId: input.headlessId ?? `headless-${Date.now()}`,
      receivedAt,
    },
    target: {
      kind: 'turn',
      botId: input.daemon.larkAppId,
      sessionId: input.sessionId,
    },
    envelope: {
      format: 'botmux.headless.v1',
      sourceName: 'botmux headless',
      trusted: false,
      payload: { prompt: input.prompt },
      rawText: input.prompt,
    },
    instruction: input.prompt,
    presentation: input.title ? { title: input.title } : undefined,
    options: {
      asyncReturnSessionId: true,
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    },
  };
}

async function dispatchHeadlessRun(input: {
  daemon: OnlineDaemonInfo;
  record: Pick<HeadlessSessionRecord, 'id' | 'sessionId'>;
  prompt: string;
  title?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): Promise<TriggerResponse & { ok: boolean }> {
  const request = buildTriggerRequest({
    daemon: input.daemon,
    sessionId: input.record.sessionId,
    headlessId: input.record.id,
    prompt: input.prompt,
    title: input.title,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
  });
  const response = await postJson(input.daemon, '/api/trigger', request);
  return response.body as TriggerResponse & { ok: boolean };
}

async function lookupResult(
  daemon: OnlineDaemonInfo,
  sessionId: string,
  triggerId?: string,
): Promise<TriggerResponse> {
  const suffix = triggerId ? `?triggerId=${encodeURIComponent(triggerId)}` : '';
  const response = await getJson(daemon, `/api/sessions/${encodeURIComponent(sessionId)}/trigger-result${suffix}`);
  return response.body as TriggerResponse;
}

async function waitResult(
  daemon: OnlineDaemonInfo,
  sessionId: string,
  triggerId: string | undefined,
  timeoutMs: number,
): Promise<TriggerResponse & { timedOut?: boolean }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await lookupResult(daemon, sessionId, triggerId);
    if (result.state && result.state !== 'running') return result;
    if (timeoutMs <= 0 || Date.now() >= deadline) return { ...result, timedOut: true };
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(50, deadline - Date.now()))));
  }
}

function compactSession(record: HeadlessSessionRecord): Record<string, unknown> {
  return {
    id: record.id,
    sessionId: record.sessionId,
    larkAppId: record.larkAppId,
    title: record.title,
    workingDir: record.workingDir,
    latestTriggerId: record.latestTriggerId,
    lastRunAt: record.lastRunAt,
    boundChatId: record.boundChatId,
    boundRootMessageId: record.boundRootMessageId,
    boundScope: record.boundScope,
  };
}

function printResult(result: TriggerResponse, json: boolean): void {
  if (json) {
    printJson(result);
    return;
  }
  if (result.state === 'completed') {
    process.stdout.write(`${result.output?.content ?? ''}\n`);
    return;
  }
  process.stdout.write(`${result.state ?? (result.ok ? result.action ?? 'ok' : 'error')}\n`);
  if (result.error) process.stderr.write(`${result.error}\n`);
}

export async function cmdHeadless(args: readonly string[]): Promise<number> {
  const parsed = parseHeadlessArgs(args);
  if (!parsed.ok) return fail(parsed.error, args.includes('--json'), 2);
  if (parsed.kind === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  dataDir();

  try {
    if (parsed.kind === 'list') {
      const records = listHeadlessSessions()
        .filter(record => !parsed.bot || record.larkAppId === parsed.bot)
        .map(compactSession);
      if (parsed.json) printJson({ ok: true, sessions: records });
      else if (records.length === 0) process.stdout.write('No headless sessions.\n');
      else for (const record of records) process.stdout.write(`${record.id}  ${record.sessionId}  ${record.title ?? ''}\n`);
      return 0;
    }

    if (parsed.kind === 'create') {
      const daemon = pickDaemon(parsed.bot);
      if ('error' in daemon) return fail(daemon.error, parsed.json);
      const created = await createHeadless(daemon, {
        title: parsed.title,
        workingDir: parsed.workingDir,
        model: parsed.model,
        reasoningEffort: parsed.reasoningEffort,
      });
      if (!created.ok) return fail(created.error, parsed.json);
      const record = resolveLocalHeadlessRecord(created.headlessId);
      const body = {
        ok: true,
        headlessId: created.headlessId,
        sessionId: created.sessionId,
        session: 'error' in record ? undefined : compactSession(record),
      };
      if (parsed.json) printJson(body);
      else process.stdout.write(`${created.headlessId} ${created.sessionId}\n`);
      return 0;
    }

    if (parsed.kind === 'run') {
      let daemon: OnlineDaemonInfo;
      let record: Pick<HeadlessSessionRecord, 'id' | 'sessionId'>;
      let created: { headlessId: string; sessionId: string } | undefined;
      if (parsed.session) {
        const existing = resolveLocalHeadlessRecord(parsed.session);
        if ('error' in existing) return fail(existing.error, parsed.json);
        const owner = daemonForRecord(existing, parsed.bot);
        if ('error' in owner) return fail(owner.error, parsed.json);
        daemon = owner;
        record = existing;
      } else {
        const picked = pickDaemon(parsed.bot);
        if ('error' in picked) return fail(picked.error, parsed.json);
        daemon = picked;
        const made = await createHeadless(daemon, {
          title: parsed.title,
          workingDir: parsed.workingDir,
          model: parsed.model,
          reasoningEffort: parsed.reasoningEffort,
        });
        if (!made.ok) return fail(made.error, parsed.json);
        created = { headlessId: made.headlessId, sessionId: made.sessionId };
        record = { id: made.headlessId, sessionId: made.sessionId };
      }
      const queued = await dispatchHeadlessRun({
        daemon,
        record,
        prompt: parsed.prompt,
        title: parsed.title,
        model: parsed.model,
        reasoningEffort: parsed.reasoningEffort,
      });
      if (!queued.ok) {
        if (parsed.json) printJson({ ok: false, created, trigger: queued });
        else process.stderr.write(`botmux headless: ${queued.error ?? 'trigger failed'}\n`);
        return 1;
      }
      if (parsed.wait) {
        const result = await waitResult(daemon, record.sessionId, queued.triggerId, parsed.timeoutMs);
        if (parsed.json) printJson({ ok: true, created, trigger: queued, result });
        else printResult(result, false);
        return result.state === 'failed' || result.state === 'not_found' ? 1 : 0;
      }
      if (parsed.json) printJson({ ok: true, created, trigger: queued });
      else process.stdout.write(`${record.id} ${record.sessionId} ${queued.triggerId ?? ''}\n`);
      return 0;
    }

    if (parsed.kind === 'result') {
      const record = resolveLocalHeadlessRecord(parsed.session);
      if ('error' in record) return fail(record.error, parsed.json);
      const triggerId = parsed.triggerId ?? record.latestTriggerId;
      if (!triggerId) return fail('headless session has no completed or running trigger yet', parsed.json);
      const daemon = daemonForRecord(record);
      if ('error' in daemon) return fail(daemon.error, parsed.json);
      const result = parsed.wait
        ? await waitResult(daemon, record.sessionId, triggerId, parsed.timeoutMs)
        : await lookupResult(daemon, record.sessionId, triggerId);
      printResult(result, parsed.json);
      return result.state === 'failed' || result.state === 'not_found' ? 1 : 0;
    }

    if (parsed.kind === 'publish') {
      const record = resolveLocalHeadlessRecord(parsed.session);
      if ('error' in record) return fail(record.error, parsed.json);
      const daemon = daemonForRecord(record);
      if ('error' in daemon) return fail(daemon.error, parsed.json);
      const triggerId = parsed.triggerId ?? record.latestTriggerId;
      if (!triggerId) return fail('headless session has no result to publish yet', parsed.json);
      const response = await postJson(daemon, `/api/headless/sessions/${encodeURIComponent(record.sessionId)}/publish`, {
        chatId: parsed.chatId,
        rootMessageId: parsed.rootMessageId,
        triggerId,
      });
      if (response.status >= 200 && response.status < 300 && response.body?.ok) {
        if (parsed.json) printJson(response.body);
        else process.stdout.write(`${response.body.messageId}\n`);
        return 0;
      }
      return fail(String(response.body?.error ?? `HTTP ${response.status}`), parsed.json);
    }

    if (parsed.kind === 'bind') {
      const record = resolveLocalHeadlessRecord(parsed.session);
      if ('error' in record) return fail(record.error, parsed.json);
      const daemon = daemonForRecord(record);
      if ('error' in daemon) return fail(daemon.error, parsed.json);
      const response = await postJson(daemon, `/api/headless/sessions/${encodeURIComponent(record.sessionId)}/bind`, {
        chatId: parsed.chatId,
        rootMessageId: parsed.rootMessageId,
        scope: parsed.scope,
        title: parsed.title,
        replay: parsed.replay,
        triggerId: parsed.triggerId,
      });
      if (response.status >= 200 && response.status < 300 && response.body?.ok) {
        if (parsed.json) printJson(response.body);
        else process.stdout.write(`${record.id} bound\n`);
        return 0;
      }
      return fail(String(response.body?.error ?? `HTTP ${response.status}`), parsed.json);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), 'json' in parsed ? parsed.json : false);
  }

  return fail('unreachable command state', false, 2);
}
