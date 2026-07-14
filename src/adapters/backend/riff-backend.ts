import { readFileSync } from 'node:fs';
import type { SessionBackend, SpawnOpts } from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * Fallback system prompt injected into every riff task when no explicit
 * `systemPrompt` is configured. Mirrors the `<botmux_routing>` block that
 * codex/gemini/etc. get via buildBotmuxShellHints — the riff agent must use
 * `botmux send` to reply (same as any other botmux-bridged CLI), not rely on
 * passive output capture. botmux is installed in the sandbox via setupCommands.
 */
const DEFAULT_RIFF_SYSTEM_PROMPT = [
  'You are running inside a botmux-bridged session: Feishu/Lark topic group ↔ riff agent sandbox.',
  'The user reads on Lark and cannot see your terminal output.',
  '',
  'IMPORTANT: `botmux send` / `botmux history` / `botmux quoted` / `botmux bots` are SHELL commands (CLI programs installed in $PATH), NOT MCP tools. Run them via the Bash tool — do not look for them in the MCP tool list.',
  '',
  'To send a message to the user (the only way): run `botmux send "your message"` via Bash. Attach images with `--images /path`, files with `--files /path`.',
  'Multi-line messages MUST use a heredoc — never `botmux send "line1\\nline2"`, since `\\n` may appear literally in Lark.',
  "Correct multi-line example:\n  botmux send <<'EOF'\n  line 1\n  line 2\n  EOF",
  '',
  'Helpers: `botmux history` (read this session\'s history), `botmux quoted <message_id>` (fetch a quoted message), `botmux bots list` (list other bots in the group).',
  '',
  '@ decision (mandatory): every `botmux send` MUST explicitly pick one or it errors — `--mention <open_id:name>` (name a person/bot; REQUIRED to collaborate with another bot) / `--mention-back` (@ the sender of the message you are replying to) / `--no-mention` (none). Choose by value: substantive conclusion the other party should read/confirm/decide → --mention-back; pure record / low-priority / short ack → --no-mention; a contentless "got it" is better not sent.',
  '',
  'When to send: key conclusions, plans (wait for user approval before acting), final results, progress updates. A bare `print`/`echo` does NOT count as a reply.',
  'Keep final answers concise. For images/files: write them to disk then send via `botmux send --images/--files`.',
].join('\n');

/**
 * Mandatory setup commands run in the riff sandbox to ensure `botmux` is
 * available. These are ALWAYS sent to the riff API via `config.setupCommands`
 * (not via prompt injection) so the install is reliable and not dependent on
 * the agent parsing a prompt. The riff sandbox has Node.js (it runs aiden),
 * so npm install works. Any user-configured setupCommands are appended AFTER
 * these mandatory commands.
 */
const MANDATORY_SETUP_COMMANDS = [
  'which botmux >/dev/null 2>&1 || npm install -g botmux@canary 2>/dev/null',
];

export interface RiffBackendConfig {
  baseUrl: string;
  templateId?: string;
  agent?: string;
  model?: string;
  /** Direct JWT token (takes precedence over jwtEnv). */
  jwt?: string;
  /** Name of env var containing the JWT token (default: RIFF_JWT). */
  jwtEnv?: string;
  sandboxCluster?: string;
  defaultRepo?: string;
  defaultBranch?: string;
  injectStatusLines?: boolean;
  logLevel?: string;
  /**
   * Environment variables injected into the riff sandbox execution environment.
   * Merged from: botmux session context vars (BOTMUX_SESSION_ID, …) → per-bot
   * env (bots.json `env`) → explicit config.env (which takes precedence).
   * The sandbox installs botmux via setupCommands, so BOTMUX_* vars are needed
   * for the agent to use `botmux send`. Sent as `config.env` to the riff API.
   */
  env?: Record<string, string>;
  /**
   * System prompt injected into the riff task. Prepended to the userPrompt
   * (riff API has no separate system-prompt field) so the agent knows it is
   * running inside a botmux-bridged session. When unset, the built-in
   * DEFAULT_RIFF_SYSTEM_PROMPT is used as a fallback.
   */
  systemPrompt?: string;
  /**
   * ADDITIONAL shell commands run in the riff sandbox before the agent starts
   * working. botmux is ALWAYS installed via MANDATORY_SETUP_COMMANDS (not
   * user-editable, sent to the riff API as config.setupCommands); these are
   * extra commands the user wants to run after that (e.g. installing other
   * dependencies). Sent to the riff API as `config.setupCommands` appended
   * after the mandatory botmux install commands.
   */
  setupCommands?: string[];
}

interface RiffAttachment {
  path: string;
  name: string;
  type: 'image' | 'file';
}

interface RiffTaskResponse {
  success: boolean;
  data: {
    id: string;
    status: string;
    accessUrl?: string;
    queuePosition?: number | null;
  };
}

/**
 * RiffBackend — bridges botmux's SessionBackend interface to riff's HTTP API.
 *
 * Lifecycle:
 *   spawn()       → initializes riff client (no actual task created yet)
 *   write(text)   → creates a task (first write) or follow-up (subsequent writes)
 *                   SSE output events flow through onData callback
 *   kill()        → cancels current task via task-cancel
 *   onExit        → fires on /close (kill) or unrecoverable error, NOT on task done
 *
 * SSE events use standard SSE format: event type in `event:` line, JSON in `data:` lines.
 * Events: output (text chunks), status (state changes), init (full state + accessUrl),
 * session_info (sandbox access info), done (task completion), log (verbose logs).
 */
export class RiffBackend implements SessionBackend {
  private config: RiffBackendConfig;
  private sessionId: string;
  private dataCb: ((data: string) => void) | null = null;
  private exitCb: ((code: number | null, signal: string | null) => void) | null = null;
  private accessUrlCb: ((url: string) => void) | null = null;
  private outputBuffer = '';
  private currentTaskId: string | null = null;
  private currentAccessUrl: string | null = null;
  private abortController: AbortController | null = null;
  private killed = false;
  private taskDone = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;

  constructor(config: RiffBackendConfig, sessionId: string) {
    this.config = config;
    this.sessionId = sessionId;
  }

  /** Called when the riff sandbox accessUrl becomes available or changes. */
  onAccessUrl(cb: (url: string) => void): void {
    this.accessUrlCb = cb;
    if (this.currentAccessUrl) cb(this.currentAccessUrl);
  }

  /** Resolve JWT dynamically — re-reads env/keychain each call so auto-refresh works. */
  private getJwt(): string | null {
    return this.resolveJwt();
  }

  private resolveJwt(): string | null {
    if (this.config.jwt) return this.config.jwt;
    const envKey = this.config.jwtEnv ?? 'RIFF_JWT';
    const fromEnv = process.env[envKey];
    if (fromEnv) return fromEnv;

    // Fallback: try ByteCloud Auth SDK keychain (kaboo-cli / aiden-cli / cjadk)
    const fromKeychain = this.readJwtFromBytecloudKeychain();
    if (fromKeychain) {
      logger.info(`[riff] JWT loaded from ByteCloud keychain`);
      return fromKeychain;
    }

    logger.warn(`[riff] JWT not found in config, env ${envKey}, or ByteCloud keychain; API calls will fail`);
    return null;
  }

  private readJwtFromBytecloudKeychain(): string | null {
    const home = process.env.HOME ?? '~';
    const candidates = [
      `${home}/.config/kaboo-cli/bytecloud-auth/keychain/auth/cn/default`,
      `${home}/.config/aiden-cli/bytecloud-auth/keychain/auth/cn/default`,
      `${home}/.cjadk/bytecloud-auth/keychain/auth/cn/default`,
    ];
    for (const path of candidates) {
      try {
        const raw = readFileSync(path, 'utf-8');
        const data = JSON.parse(raw) as Record<string, unknown>;
        const jwt = data['bytecloud_jwt'] as string | undefined;
        if (jwt) return jwt;
      } catch { /* try next */ }
    }
    return null;
  }

  spawn(_bin: string, _args: string[], _opts: SpawnOpts): void {
    logger.info(`[riff] spawn (ignoring bin/args, using config: ${this.config.baseUrl})`);
    // No actual process to spawn. Task creation happens on first write().
  }

  write(data: string): void {
    if (this.killed) return;

    const { text, attachments } = this.extractAttachments(data);

    if (!this.currentTaskId || this.taskDone) {
      this.createTask(text, attachments);
    } else {
      this.followUp(text, attachments);
    }
    this.taskDone = false;
  }

  resize(_cols: number, _rows: number): void {
    // No terminal screen to resize.
  }

  onData(cb: (data: string) => void): void {
    this.dataCb = cb;
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCb = cb;
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    logger.info('[riff] kill requested');

    if (this.currentTaskId && !this.taskDone) {
      this.cancelTask(this.currentTaskId).catch((err) => {
        logger.warn(`[riff] task-cancel failed: ${err}`);
      });
    }

    this.abortController?.abort();
    this.exitCb?.(0, null);
  }

  destroySession(): void {
    this.kill();
  }

  getChildPid(): number | null {
    return null;
  }

  captureCurrentScreen(): string {
    return this.outputBuffer;
  }

  captureViewport(): string {
    return this.outputBuffer;
  }

  getPaneSize(): { cols: number; rows: number } | null {
    return null;
  }

  // ── Private helpers ──────────────────────────────────────────────

  private extractAttachments(content: string): { text: string; attachments: RiffAttachment[] } {
    const attachments: RiffAttachment[] = [];
    const attachRegex = /<attachments[^>]*>([\s\S]*?)<\/attachments>/g;
    let match: RegExpExecArray | null;
    let text = content;

    while ((match = attachRegex.exec(content)) !== null) {
      const block = match[1]!;
      const imgRegex = /<image\s+[^>]*path="([^"]+)"[^>]*\/>/g;
      const fileRegex = /<file\s+[^>]*path="([^"]+)"(?:\s+name="([^"]*)")?[^>]*\/>/g;
      let m: RegExpExecArray | null;
      while ((m = imgRegex.exec(block)) !== null) {
        attachments.push({ path: m[1]!, name: this.basename(m[1]!), type: 'image' });
      }
      while ((m = fileRegex.exec(block)) !== null) {
        attachments.push({ path: m[1]!, name: m[2] ?? this.basename(m[1]!), type: 'file' });
      }
      text = text.replace(match[0]!, '').trim();
    }

    return { text, attachments };
  }

  private basename(p: string): string {
    const parts = p.split(/[/\\]/);
    return parts[parts.length - 1] ?? p;
  }

  private async createTask(prompt: string, attachments: RiffAttachment[]): Promise<void> {
    const url = `${this.config.baseUrl}/api/task-execute`;

    // riff task-execute body: origin at top level, prompt inside config.userPrompt
    // agent 可选值: aiden (默认), aiden-claude, codex, opencode
    const config: Record<string, unknown> = {
      userPrompt: this.injectSystemPrompt(prompt),
      agent: this.config.agent ?? 'aiden',
    };
    if (this.config.model) config.model = this.config.model;
    if (this.config.sandboxCluster) config.sandboxCluster = this.config.sandboxCluster;
    if (this.config.defaultRepo) {
      config.repos = [{ repo: this.config.defaultRepo, branch: this.config.defaultBranch ?? 'main' }];
    }
    // Inject env into the riff sandbox so the agent can use `botmux send` etc.
    // Merged from: per-bot env (bots.json `env`) + botmux session context vars +
    // any explicit config.env (which takes precedence).
    const env = this.buildEnv();
    if (Object.keys(env).length > 0) config.env = env;
    // Always send setupCommands to the riff API: mandatory botmux install first
    // (MANDATORY_SETUP_COMMANDS, not user-editable), then any user-configured
    // additional commands. botmux is installed via the API's native
    // setupCommands support — NOT via prompt injection — so it is reliable.
    const setup = [...MANDATORY_SETUP_COMMANDS, ...(this.config.setupCommands ?? [])];
    config.setupCommands = setup;

    const payload: Record<string, unknown> = {
      origin: 'botmux',
      threadId: this.sessionId,
      config,
      useRunner: true,
    };
    if (this.config.templateId) payload.templateId = this.config.templateId;

    try {
      const taskId = await this.uploadAndCreate(url, payload, attachments);
      this.currentTaskId = taskId;
      this.streamTask(taskId);
    } catch (err) {
      this.emitError(`创建 riff 任务失败: ${err}`);
    }
  }

  private async followUp(prompt: string, attachments: RiffAttachment[]): Promise<void> {
    const url = `${this.config.baseUrl}/api/task-follow-up`;

    // riff task-follow-up body: parentTaskId + origin + prompt at top level
    const payload: Record<string, unknown> = {
      origin: 'botmux',
      parentTaskId: this.currentTaskId,
      prompt: this.injectSystemPrompt(prompt),
    };

    try {
      const taskId = await this.uploadAndCreate(url, payload, attachments);
      this.currentTaskId = taskId;
      this.streamTask(taskId);
    } catch (err) {
      this.emitError(`riff follow-up 失败: ${err}`);
    }
  }

  /**
   * Prepend the configured system prompt to the user prompt.
   * The riff API has no separate system-prompt field (only userPrompt), so we
   * fold the system prompt into the prompt text. config.systemPrompt takes
   * precedence over the built-in DEFAULT_RIFF_SYSTEM_PROMPT. The result is
   * wrapped in a <system> block so the agent can distinguish it from the user
   * message. NOTE: setup commands (botmux install) are NOT injected here —
   * they are sent to the riff API via config.setupCommands for reliability.
   */
  private injectSystemPrompt(prompt: string): string {
    const sys = this.config.systemPrompt?.trim() ?? DEFAULT_RIFF_SYSTEM_PROMPT;
    if (!sys) return prompt;
    return `<system>\n${sys}\n</system>\n\n${prompt}`;
  }

  /**
   * Build the env object for the riff sandbox. Precedence (highest wins):
   *   1. config.env (explicit per-bot riff config)
   *   2. per-bot env from bots.json `env` (merged by the worker into config.env)
   * Returns a clean Record with empty values dropped.
   */
  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    if (this.config.env) {
      for (const [k, v] of Object.entries(this.config.env)) {
        if (v != null && v !== '') env[k] = String(v);
      }
    }
    return env;
  }

  private async uploadAndCreate(
    url: string,
    payload: Record<string, unknown>,
    attachments: RiffAttachment[],
  ): Promise<string> {
    const headers: Record<string, string> = {};
    const jwt = this.getJwt();
    if (jwt) headers['x-jwt-token'] = jwt;

    let resp: Response;
    if (attachments.length > 0) {
      const form = new FormData();
      form.append('payload', JSON.stringify(payload));
      for (const att of attachments) {
        try {
          const fileData = await this.readFileAsBlob(att.path);
          form.append('attachments', fileData, att.name);
        } catch (err) {
          logger.warn(`[riff] failed to read attachment ${att.path}: ${err}`);
        }
      }
      resp = await fetch(url, { method: 'POST', headers, body: form });
    } else {
      headers['Content-Type'] = 'application/json';
      resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    }

    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const result = (await resp.json()) as RiffTaskResponse;
    if (!result.success || !result.data?.id) {
      throw new Error(`riff API returned error: ${JSON.stringify(result)}`);
    }

    // Capture accessUrl from response if available
    if (result.data.accessUrl) {
      this.currentAccessUrl = result.data.accessUrl;
      this.accessUrlCb?.(result.data.accessUrl);
    }

    // If queued, inject a status line
    if (result.data.status === 'queued' && result.data.queuePosition != null) {
      const line = `\n[riff] 任务排队中，位置: ${result.data.queuePosition}\n`;
      this.outputBuffer += line;
      this.dataCb?.(line);
    }

    return result.data.id;
  }

  private async readFileAsBlob(path: string): Promise<Blob> {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(path);
    return new Blob([buf]);
  }

  private async cancelTask(taskId: string): Promise<void> {
    const url = `${this.config.baseUrl}/api/task-cancel`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const jwt = this.getJwt();
    if (jwt) headers['x-jwt-token'] = jwt;
    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ taskId }),
    }).catch(() => { /* best effort */ });
  }

  private async streamTask(taskId: string): Promise<void> {
    const url = `${this.config.baseUrl}/api2/task-stream?id=${encodeURIComponent(taskId)}`;
    const headers: Record<string, string> = {};
    const jwt = this.getJwt();
    if (jwt) headers['x-jwt-token'] = jwt;

    this.abortController = new AbortController();

    try {
      const resp = await fetch(url, { headers, signal: this.abortController.signal });
      if (!resp.ok || !resp.body) {
        throw new Error(`SSE HTTP ${resp.status}`);
      }

      this.reconnectAttempts = 0;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Standard SSE: events separated by blank line (\n\n)
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const eventBlock of events) {
          this.handleSseEvent(eventBlock, taskId);
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      logger.warn(`[riff] SSE stream error: ${err}`);

      // Attempt reconnect if task is still running
      if (!this.killed && !this.taskDone && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = 1000 * this.reconnectAttempts;
        logger.info(`[riff] SSE reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);
        const line = `\n[riff] 连接中断，正在重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})\n`;
        this.outputBuffer += line;
        this.dataCb?.(line);
        await new Promise((r) => setTimeout(r, delay));
        this.streamTask(taskId);
      } else if (!this.killed && !this.taskDone) {
        this.emitError(`SSE 连接中断，重连失败`);
      }
    }
  }

  private handleSseEvent(block: string, taskId: string): void {
    // Standard SSE parsing: event type from `event:` line, data from `data:` lines
    // Also handle SSE comments (lines starting with `:`) — ignore them (heartbeats)
    let eventType = 'message';
    const dataLines: string[] = [];

    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // SSE comment / heartbeat
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length === 0) return;

    try {
      const data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;

      switch (eventType) {
        case 'output': {
          const chunk = data['chunk'] as string | undefined;
          if (chunk) {
            this.outputBuffer += chunk;
            this.dataCb?.(chunk);
          }
          break;
        }
        case 'status': {
          if (this.config.injectStatusLines !== false) {
            const status = data['status'] as string | undefined;
            if (status) {
              const line = `\n[riff] 状态: ${status}\n`;
              this.outputBuffer += line;
              this.dataCb?.(line);
            }
          }
          break;
        }
        case 'init':
        case 'session_info': {
          // accessUrl lives in init / session_info events, not in done
          const accessUrl = data['accessUrl'] as string | undefined;
          if (accessUrl) {
            this.currentAccessUrl = accessUrl;
            this.accessUrlCb?.(accessUrl);
            if (this.config.injectStatusLines !== false) {
              const line = `\n[riff] Sandbox: ${accessUrl}\n`;
              this.outputBuffer += line;
              this.dataCb?.(line);
            }
          }
          break;
        }
        case 'done': {
          this.taskDone = true;
          const status = data['status'] as string | undefined;
          const exitCode = data['exitCode'] as number | undefined;
          if (this.config.injectStatusLines !== false) {
            const doneLine = `\n[riff] 任务完成${status ? ` (${status}${exitCode != null ? `, exit=${exitCode}` : ''})` : ''}\n`;
            this.outputBuffer += doneLine;
            this.dataCb?.(doneLine);
          }
          // Fetch final output from task-detail API (SSE has no output events for runner tasks)
          if (status === 'completed' || status === 'failed') {
            this.fetchAndEmitOutput(taskId);
          }
          // NOTE: task done does NOT trigger onExit — session stays alive
          // for follow-up messages. Only /close or unrecoverable errors exit.
          break;
        }
        case 'log': {
          const text = data['text'] as string | undefined;
          const kind = data['kind'] as string | undefined;
          const group = (data['group'] as string | undefined)
            ?? (data['payload'] as Record<string, unknown> | undefined)?.['group'] as string | undefined;
          // stdout logs are the real output stream — emit as data regardless of logLevel
          if (group === 'stdout' && text) {
            this.outputBuffer += text;
            this.dataCb?.(text);
          } else if (this.config.logLevel === 'verbose' && text) {
            const logLine = `\n[riff:${kind ?? 'log'}] ${text}\n`;
            this.outputBuffer += logLine;
            this.dataCb?.(logLine);
          }
          break;
        }
      }
    } catch (err) {
      logger.warn(`[riff] failed to parse SSE event: ${err}`);
    }
  }

  private emitError(message: string): void {
    const line = `\n[riff] 错误: ${message}\n`;
    this.outputBuffer += line;
    this.dataCb?.(line);
    logger.error(`[riff] ${message}`);
  }

  private async fetchAndEmitOutput(taskId: string): Promise<void> {
    try {
      const url = `${this.config.baseUrl}/api/task-detail?id=${encodeURIComponent(taskId)}`;
      const headers: Record<string, string> = {};
      const jwt = this.getJwt();
      if (jwt) headers['x-jwt-token'] = jwt;

      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        logger.warn(`[riff] task-detail fetch failed: HTTP ${resp.status}`);
        return;
      }
      const result = (await resp.json()) as {
        success: boolean;
        data?: {
          task?: {
            output?: string;
            resultOutput?: {
              displayReport?: {
                content?: string;
                kind?: string;
              };
            };
          };
        };
      };

      // Prefer displayReport content (cleaner), fall back to raw output
      const displayContent = result.data?.task?.resultOutput?.displayReport?.content;
      const rawOutput = result.data?.task?.output ?? '';
      const output = displayContent && displayContent.length > 0
        ? displayContent
        : rawOutput;

      if (output && output.length > 0) {
        // Clean up: strip leading "startedcompleted" noise from aiden runner
        const cleaned = output.replace(/^(started|completed)+/, '').trim();
        if (cleaned.length > 0) {
          this.outputBuffer += cleaned;
          this.dataCb?.(cleaned);
        }
      }
    } catch (err) {
      logger.warn(`[riff] fetchAndEmitOutput failed: ${err}`);
    }
  }
}
