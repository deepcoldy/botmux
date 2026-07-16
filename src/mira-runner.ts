#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { extractMiraHistoryFinalText, sanitizeMiraFinalText } from './mira-output.js';
import { RunnerControlWriter } from './adapters/cli/runner-control-channel.js';

type JsonObject = Record<string, any>;

interface Args {
  sessionId: string;
  miraSessionId?: string;
  model?: string;
  botName?: string;
  botOpenId?: string;
  locale?: string;
}

interface CompletionResult {
  finalText: string;
  turnId: string;
}

const MIRA_DOMAIN = 'https://mira.bytedance.com';
const API_BASE_URL = process.env.MIRA_API_BASE_URL ?? `${MIRA_DOMAIN}/mira/api/v1`;
const MODEL_METADATA_URL = process.env.MIRA_MODEL_METADATA_URL ?? `${MIRA_DOMAIN}/api/v1/model/metadata`;
const DEFAULT_DATA_SOURCES = ['manus'];
const LAST_ROUND_RETRY_DELAYS_MS = [0, 250, 750];
const COOKIE_DB_PATH = process.env.MIRA_COOKIE_DB
  ?? join(homedir(), 'Library', 'Application Support', 'mira', 'Cookies');
const output = new RunnerControlWriter();

function parseArgs(argv: string[]): Args {
  const out: Args = { sessionId: '' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--session-id' && val !== undefined) { out.sessionId = val; i++; }
    else if (key === '--mira-session-id' && val !== undefined) { out.miraSessionId = val; i++; }
    else if (key === '--model' && val !== undefined) { out.model = val; i++; }
    else if (key === '--bot-name' && val !== undefined) { out.botName = val; i++; }
    else if (key === '--bot-open-id' && val !== undefined) { out.botOpenId = val; i++; }
    else if (key === '--locale' && val !== undefined) { out.locale = val; i++; }
  }
  if (!out.sessionId) throw new Error('--session-id is required');
  return out;
}

function emitMarker(kind: string, payload: unknown): void {
  output.marker(kind, payload);
}

function writeLine(text = ''): void {
  output.line(text);
}

function prompt(): void {
  output.display('› ');
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runSqliteCookieQuery(dbPath: string): string {
  const sql = [
    "select name || '=' || value",
    'from cookies',
    "where value != ''",
    "  and (host_key = 'mira.bytedance.com' or host_key = '.mira.bytedance.com' or host_key like '%.mira.bytedance.com')",
    "order by case when name = 'mira_session' then 0 else 1 end",
  ].join(' ');
  return execFileSync('sqlite3', [dbPath, sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
  });
}

function readCookieHeader(): string {
  if (process.env.MIRA_COOKIE_HEADER?.trim()) return process.env.MIRA_COOKIE_HEADER.trim();
  if (process.env.MIRA_SESSION?.trim()) return `mira_session=${process.env.MIRA_SESSION.trim()}`;
  if (!existsSync(COOKIE_DB_PATH)) {
    throw new Error(
      `Mira cookie database not found at ${COOKIE_DB_PATH}. Open Mira.app and sign in, or set MIRA_COOKIE_HEADER.`,
    );
  }

  let output: string;
  try {
    output = runSqliteCookieQuery(COOKIE_DB_PATH);
  } catch (err: any) {
    const detail = err?.stderr ? String(err.stderr).trim() : errorMessage(err);
    throw new Error(`Failed to read Mira cookies via sqlite3: ${detail}`);
  }

  const cookies = output.split('\n').map(s => s.trim()).filter(Boolean);
  if (!cookies.some(c => c.startsWith('mira_session='))) {
    throw new Error('Mira login cookie mira_session was not found. Open Mira.app and sign in, then try again.');
  }
  return cookies.join('; ');
}

function parseDataSources(): string[] {
  const raw = process.env.MIRA_DATA_SOURCES?.trim();
  if (!raw) return DEFAULT_DATA_SOURCES;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch { /* fall through to CSV */ }
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function extractMiraMessage(data: string): JsonObject | undefined {
  if (data === '[DONE]') return { event: 'finish', data: {} };
  try {
    const outer = JSON.parse(data);
    const message = outer.Message;
    if (typeof message === 'string') return JSON.parse(message);
    if (message && typeof message === 'object') return message;
  } catch {
    return undefined;
  }
  return undefined;
}

function sseDataLines(block: string): string[] {
  return block
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart());
}

function findSseSeparator(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return undefined;
  if (lf < 0) return { index: crlf, length: 4 };
  if (crlf < 0) return { index: lf, length: 2 };
  return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 };
}

function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as JsonObject;
  for (const key of ['result', 'text', 'content', 'answer', 'delta']) {
    const nested = obj[key];
    if (typeof nested === 'string') return nested;
  }
  if (obj.content && typeof obj.content === 'object') {
    const nested = extractText(obj.content);
    if (nested) return nested;
  }
  return undefined;
}

function finalTextFromMessage(message: JsonObject): string | undefined {
  if (message.event !== 'content') return undefined;
  const data = message.data;
  if (!data || typeof data !== 'object') return extractText(data);
  const obj = data as JsonObject;
  return extractText(obj.content ?? obj);
}

function titleFromMessage(message: JsonObject): string | undefined {
  if (message.event !== 'title') return undefined;
  return extractText(message.data);
}

class MiraClient {
  private currentSessionId: string | undefined;
  private cookieHeader: string | undefined;
  private readonly explicitModel: string | undefined;
  private resolvedModel: string | undefined;
  private readonly dataSources = parseDataSources();

  constructor(private readonly args: Args) {
    this.currentSessionId = args.miraSessionId;
    this.explicitModel = process.env.MIRA_MODEL?.trim() || args.model?.trim() || undefined;
  }

  async ensureSession(): Promise<string> {
    if (this.currentSessionId) {
      emitMarker('thread', { threadId: this.currentSessionId });
      return this.currentSessionId;
    }

    const model = await this.resolveModel();
    const sessionProperties: JsonObject = {
      topic: `botmux ${this.args.sessionId.slice(0, 8)}`,
      dataSource: '360_performance',
      dataSources: this.dataSources,
      model,
    };

    const payload = {
      sessionProperties: {
        ...sessionProperties,
      },
    };
    const response = await fetch(`${API_BASE_URL}/chat/create`, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Mira chat/create failed (${response.status}): ${text.slice(0, 500)}`);
    let parsed: JsonObject;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Mira chat/create returned non-JSON: ${text.slice(0, 500)}`);
    }
    if (parsed.code && parsed.code !== 0) {
      throw new Error(`Mira API error ${parsed.code}: ${parsed.msg ?? parsed.message ?? 'unknown'}`);
    }
    const sessionId = parsed.sessionItem?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error(`Mira chat/create response did not include sessionItem.sessionId: ${text.slice(0, 500)}`);
    }
    this.currentSessionId = sessionId;
    emitMarker('thread', { threadId: sessionId });
    return sessionId;
  }

  async complete(content: string): Promise<CompletionResult> {
    const sessionId = await this.ensureSession();
    const model = await this.resolveModel();
    const startedAt = Date.now();
    const online = boolEnv('MIRA_ONLINE', true);
    const payload: JsonObject = {
      sessionId,
      content,
      messageType: 1,
      summaryAgent: model,
      dataSources: this.dataSources,
      comprehensive: 1,
      config: {
        online,
        mode: process.env.MIRA_MODE || 'quick',
        tool_list: online
          ? [
            { name: 'Web', id: 'Web', scope: 'GLOBAL' },
            { name: 'KnowledgeQASearch', id: 'KnowledgeQASearch', scope: 'GLOBAL' },
          ]
          : [],
        updatedAt: startedAt,
      },
    };

    const response = await fetch(`${API_BASE_URL}/chat/completion`, {
      method: 'POST',
      headers: await this.headers({ Accept: 'text/event-stream' }),
      body: JSON.stringify(payload),
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(`Mira chat/completion failed (${response.status}): ${text.slice(0, 500)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalText = '';
    let seenTitle = false;
    let done = false;

    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const sep = findSseSeparator(buffer);
        if (!sep) break;
        const block = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep.length);
        for (const data of sseDataLines(block)) {
          const message = extractMiraMessage(data);
          if (!message) continue;
          if (message.event === 'finish') {
            done = true;
            break;
          }
          const title = titleFromMessage(message);
          if (title && !seenTitle) {
            seenTitle = true;
            writeLine(`[mira] ${title}`);
          }
          const errorValue = (message as JsonObject).error ?? (message.data as JsonObject | undefined)?.error;
          if (errorValue) throw new Error(`Mira stream error: ${JSON.stringify(errorValue)}`);
          const text = finalTextFromMessage(message);
          if (text) finalText = text;
        }
        if (done) break;
      }
    }

    try { await reader.cancel(); } catch { /* stream already closed */ }
    const sanitizedFinalText = sanitizeMiraFinalText(finalText);
    return {
      finalText: sanitizedFinalText || await this.fetchLastRoundFinalText(sessionId).catch(() => '') || '',
      turnId: `mira-${startedAt}`,
    };
  }

  private async headers(extraHeaders: Record<string, string> = {}): Promise<Record<string, string>> {
    if (!this.cookieHeader) this.cookieHeader = readCookieHeader();
    return {
      'Content-Type': 'application/json',
      Cookie: this.cookieHeader,
      ...extraHeaders,
    };
  }

  private async resolveModel(): Promise<string> {
    if (this.resolvedModel) return this.resolvedModel;
    if (this.explicitModel) {
      this.resolvedModel = this.explicitModel;
      return this.resolvedModel;
    }

    const settingsModel = await this.fetchUserDefaultModel().catch(err => {
      writeLine(`[mira] failed to read Mira default model: ${errorMessage(err)}`);
      return undefined;
    });
    if (settingsModel) {
      this.resolvedModel = settingsModel;
      return settingsModel;
    }

    const metadataModel = await this.fetchMetadataDefaultModel().catch(err => {
      writeLine(`[mira] failed to read Mira model metadata: ${errorMessage(err)}`);
      return undefined;
    });
    if (metadataModel) {
      this.resolvedModel = metadataModel;
      return metadataModel;
    }

    throw new Error('Unable to determine Mira model. Set a Default Model in Mira.app settings, or set MIRA_MODEL.');
  }

  private async fetchUserDefaultModel(): Promise<string | undefined> {
    const json = await this.fetchJson(`${API_BASE_URL}/user/settings/get`, 'Mira user settings');
    if (json.code && json.code !== 0) {
      throw new Error(`API error ${json.code}: ${json.msg ?? json.message ?? 'unknown'}`);
    }
    const model = json.data?.settings?.default_model;
    return typeof model === 'string' && model.trim() ? model.trim() : undefined;
  }

  private async fetchMetadataDefaultModel(): Promise<string | undefined> {
    const json = await this.fetchJson(MODEL_METADATA_URL, 'Mira model metadata');
    if (json.code && json.code !== 0) {
      throw new Error(`API error ${json.code}: ${json.msg ?? json.message ?? 'unknown'}`);
    }
    const models = Array.isArray(json.data?.models) ? json.data.models : [];
    const enabled = models.filter((model: JsonObject) => model && model.enable !== false);
    const selected = enabled.find((model: JsonObject) => model.default === true) ?? enabled[0];
    const key = selected?.key;
    return typeof key === 'string' && key.trim() ? key.trim() : undefined;
  }

  private async fetchLastRoundFinalText(sessionId: string): Promise<string | undefined> {
    for (const delay of LAST_ROUND_RETRY_DELAYS_MS) {
      if (delay > 0) await sleep(delay);
      const text = await this.fetchLastRoundFinalTextOnce(sessionId).catch(() => undefined);
      if (text) return text;
    }
    return undefined;
  }

  private async fetchLastRoundFinalTextOnce(sessionId: string): Promise<string | undefined> {
    const url = `${API_BASE_URL}/chat/messages/round/last?session_id=${encodeURIComponent(sessionId)}`;
    const json = await this.fetchJson(url, 'Mira last round messages');
    if (json.code && json.code !== 0) return undefined;
    return extractMiraHistoryFinalText(json);
  }

  private async fetchJson(url: string, label: string): Promise<JsonObject> {
    const response = await fetch(url, {
      method: 'GET',
      headers: await this.headers(),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${label} failed (${response.status}): ${text.slice(0, 500)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${label} returned non-JSON: ${text.slice(0, 500)}`);
    }
  }
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  output.error(`${errorMessage(err)}\n`);
  process.exit(2);
}

const client = new MiraClient(args);
const queue: string[] = [];
let inputBuffer = '';
let processing = false;

async function runTurn(content: string): Promise<void> {
  const startedAtMs = Date.now();
  writeLine();
  writeLine('[user]');
  writeLine(content);
  writeLine();
  writeLine('[mira] thinking...');

  const result = await client.complete(content);
  const completedAtMs = Date.now();
  if (result.finalText) {
    writeLine();
    writeLine(result.finalText);
    emitMarker('final', {
      nativeTurnId: result.turnId,
      content: result.finalText,
      startedAtMs,
      completedAtMs,
    });
  } else {
    writeLine('[mira] completed without text output.');
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
        const message = `Mira runner error: ${errorMessage(err)}`;
        writeLine(message);
        emitMarker('final', {
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
  if (trimmed.startsWith('::botmux-mira:')) {
    const encoded = trimmed.slice('::botmux-mira:'.length);
    try {
      const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      if (decoded?.type === 'message' && typeof decoded.content === 'string') {
        queue.push(decoded.content);
        void drainQueue();
      }
    } catch (err) {
      writeLine(`[mira] bad botmux input: ${errorMessage(err)}`);
    }
    return;
  }
  queue.push(line);
  void drainQueue();
}

function handleInput(data: Buffer): void {
  const text = data.toString('utf8');
  for (const ch of text) {
    if (ch === '\u0003') {
      process.exit(130);
    } else if (ch === '\r' || ch === '\n') {
      const line = inputBuffer;
      inputBuffer = '';
      enqueueLine(line);
    } else if (ch === '\u007f' || ch === '\b') {
      inputBuffer = inputBuffer.slice(0, -1);
    } else {
      inputBuffer += ch;
    }
  }
}

async function main(): Promise<void> {
  await client.ensureSession();
  writeLine('Mira connected.');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleInput);
  prompt();
}

process.on('SIGTERM', () => {
  process.exit(0);
});

main().catch(err => {
  output.error(`Mira runner failed: ${errorMessage(err)}\n`);
  process.exit(1);
});
