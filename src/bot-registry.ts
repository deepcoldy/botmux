import * as Lark from '@larksuiteoapi/node-sdk';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { CliId } from './adapters/cli/types.js';
import { logger } from './utils/logger.js';

export interface OncallChat {
  /** Lark chat_id (oc_xxx) the bot was pulled into. */
  chatId: string;
  /** Default working directory used for every new topic spawned in this chat. */
  workingDir: string;
}

export interface BotConfig {
  larkAppId: string;
  larkAppSecret: string;
  /** Optional status/PM2 label. PM2 process name is rendered as `botmux-<name>`. */
  name?: string;
  cliId: CliId;
  cliPathOverride?: string;
  backendType?: 'pty' | 'tmux';
  workingDir?: string;
  workingDirs?: string[];
  allowedUsers?: string[];
  projectScanDir?: string;
  /** Oncall bindings: chat_id → default workingDir. Any group member can talk; allowedUsers still gates card buttons / daemon commands. */
  oncallChats?: OncallChat[];
}

export interface BotState {
  config: BotConfig;
  client: Lark.Client;
  botOpenId?: string;
  botName?: string;       // Lark app display name (from /bot/v3/info)
  resolvedAllowedUsers: string[];
}

const bots = new Map<string, BotState>();

/** Path of the bot config file we loaded (so `/oncall` can persist bindings back). */
let loadedConfigPath: string | undefined;
export function getLoadedConfigPath(): string | undefined {
  return loadedConfigPath;
}

// Route Lark SDK output through our logger so it inherits the same sink
// rules (info/debug → daemon.log in daemon mode, → stderr in CLI mode,
// dropped when CLI is silent). The default SDK logger calls console.log,
// which would corrupt CLI stdout consumers.
//
// Volume control: the SDK is chatty at info/debug ("client ready", request
// traces, etc.); without DEBUG=1 those become no-ops in the CLI path and
// stay in daemon.log on the daemon path — pm2's error.log no longer sees
// "[lark:info] client ready" floods.
function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
const fmtLark = (msg: any[]) => msg.map(safeStringify).join(' ');
const larkLogger = {
  error: (...msg: any[]) => logger.error(`[lark] ${fmtLark(msg)}`),
  warn:  (...msg: any[]) => logger.warn(`[lark] ${fmtLark(msg)}`),
  info:  (...msg: any[]) => logger.info(`[lark] ${fmtLark(msg)}`),
  debug: (...msg: any[]) => logger.debug(`[lark] ${fmtLark(msg)}`),
  trace: (..._msg: any[]) => { /* SDK trace dropped entirely — uninteresting per-byte WS frames */ },
};

export function registerBot(cfg: BotConfig): BotState {
  const client = new Lark.Client({
    appId: cfg.larkAppId,
    appSecret: cfg.larkAppSecret,
    logger: larkLogger,
  });
  const state: BotState = {
    config: cfg,
    client,
    resolvedAllowedUsers: [...(cfg.allowedUsers ?? [])],
  };
  bots.set(cfg.larkAppId, state);
  return state;
}

export function getBot(larkAppId: string): BotState {
  const state = bots.get(larkAppId);
  if (!state) {
    throw new Error(`Bot not registered: ${larkAppId}`);
  }
  return state;
}

export function getBotClient(larkAppId: string): Lark.Client {
  return getBot(larkAppId).client;
}

export function getAllBots(): BotState[] {
  return Array.from(bots.values());
}

/** Lookup the oncall binding for a given bot+chat, if any. */
export function findOncallChat(larkAppId: string, chatId: string): OncallChat | undefined {
  const bot = bots.get(larkAppId);
  return bot?.config.oncallChats?.find(c => c.chatId === chatId);
}

// Cross-bot oncall chat check — cached by config-file mtime.
//
// /oncall bind is per-bot, but oncall is meant to be a chat-level property:
// once any bot in a multi-bot deployment binds the chat, every sibling bot
// should treat that chat as an oncall workspace too (otherwise unbound bots
// fall back to allowedUsers and reply "⚠️ 无操作权限" when @-mentioned).
//
// Multi-daemon deployments run one bot per process, so the in-memory `bots`
// map only sees this daemon's own bot — sibling bots' bindings live only on
// disk in the shared bots.json. Re-read that file lazily, keyed by mtime,
// so the hot path is a single stat() once the cache is warm.
let oncallChatCache: { mtimeMs: number; chats: Map<string, OncallChat> } | null = null;

export function findOncallChatForAnyBot(chatId: string): OncallChat | undefined {
  // Fast path: this daemon's own bot(s). Covers single-daemon setups and any
  // case where the receiving bot itself is bound.
  for (const bot of bots.values()) {
    const entry = bot.config.oncallChats?.find(c => c.chatId === chatId);
    if (entry) return entry;
  }
  // Slow path: scan the shared bots.json for sibling bots' bindings.
  const path = loadedConfigPath;
  if (!path) return undefined;
  try {
    const stat = statSync(path);
    if (!oncallChatCache || oncallChatCache.mtimeMs !== stat.mtimeMs) {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      const chats = new Map<string, OncallChat>();
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (!Array.isArray(entry?.oncallChats)) continue;
          for (const c of entry.oncallChats) {
            if (c && typeof c.chatId === 'string' && typeof c.workingDir === 'string') {
              chats.set(c.chatId, { chatId: c.chatId, workingDir: c.workingDir });
            }
          }
        }
      }
      oncallChatCache = { mtimeMs: stat.mtimeMs, chats };
    }
    return oncallChatCache.chats.get(chatId);
  } catch {
    return undefined;
  }
}

export function isChatOncallBoundForAnyBot(chatId: string): boolean {
  return !!findOncallChatForAnyBot(chatId);
}

/**
 * Load bot configurations from one of (in priority order):
 * 1. BOTS_CONFIG env var — path to a JSON file
 * 2. ~/.botmux/bots.json — default config path
 */
export function loadBotConfigs(): BotConfig[] {
  // 1. BOTS_CONFIG env var
  const botsConfigPath = process.env.BOTS_CONFIG;
  if (botsConfigPath) {
    const resolved = resolve(botsConfigPath);
    if (!existsSync(resolved)) {
      throw new Error(`BOTS_CONFIG file not found: ${resolved}`);
    }
    loadedConfigPath = resolved;
    return parseBotConfigFile(resolved);
  }

  // 2. ~/.botmux/bots.json
  const defaultPath = resolve(homedir(), '.botmux', 'bots.json');
  if (existsSync(defaultPath)) {
    loadedConfigPath = defaultPath;
    return parseBotConfigFile(defaultPath);
  }

  throw new Error(
    'No bot configuration found. Set BOTS_CONFIG or create ~/.botmux/bots.json.\nSee README for config format.'
  );
}

function parseBotConfigFile(filePath: string): BotConfig[] {
  const raw = readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in bot config file: ${filePath}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Bot config file must contain a JSON array: ${filePath}`);
  }

  const configs: BotConfig[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry.larkAppId || typeof entry.larkAppId !== 'string') {
      throw new Error(`Bot config [${i}]: larkAppId is required and must be a string`);
    }
    if (!entry.larkAppSecret || typeof entry.larkAppSecret !== 'string') {
      throw new Error(`Bot config [${i}]: larkAppSecret is required and must be a string`);
    }

    // Parse workingDirs from comma-separated workingDir if workingDirs not explicitly set
    let workingDirs = entry.workingDirs;
    if (!workingDirs && entry.workingDir) {
      workingDirs = String(entry.workingDir).split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    let oncallChats: OncallChat[] | undefined;
    if (Array.isArray(entry.oncallChats)) {
      oncallChats = entry.oncallChats
        .filter((c: any) => c && typeof c.chatId === 'string' && typeof c.workingDir === 'string')
        .map((c: any) => ({
          chatId: c.chatId,
          workingDir: c.workingDir,
        }));
    }

    configs.push({
      larkAppId: entry.larkAppId,
      larkAppSecret: entry.larkAppSecret,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined,
      cliId: entry.cliId ?? 'claude-code',
      cliPathOverride: entry.cliPathOverride,
      backendType: entry.backendType,
      workingDir: workingDirs?.[0] ?? entry.workingDir,
      workingDirs,
      allowedUsers: entry.allowedUsers,
      projectScanDir: entry.projectScanDir,
      oncallChats,
    });
  }

  return configs;
}
