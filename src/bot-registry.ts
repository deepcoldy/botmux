import * as Lark from '@larksuiteoapi/node-sdk';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { CliId } from './adapters/cli/types.js';

export interface OncallChat {
  /** Lark chat_id (oc_xxx) the bot was pulled into. */
  chatId: string;
  /** Default working directory used for every new topic spawned in this chat. */
  workingDir: string;
  /** open_id allowlist — may only operate (cards / daemon commands). Empty = initial binder only (set at bind time). */
  owners: string[];
}

export interface BotConfig {
  larkAppId: string;
  larkAppSecret: string;
  cliId: CliId;
  cliPathOverride?: string;
  backendType?: 'pty' | 'tmux';
  workingDir?: string;
  workingDirs?: string[];
  allowedUsers?: string[];
  projectScanDir?: string;
  /** Oncall bindings: chat_id → default workingDir + owners. Any group member can talk; only owners can run card buttons / daemon commands. */
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

// Provide a custom logger that writes to stderr.
// The default Lark SDK logger uses console.log (stdout), which corrupts
// MCP stdio protocol when the server is spawned as an MCP child process.
function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
const stderrLogger = {
  error: (...msg: any[]) => { process.stderr.write(`[lark:error] ${msg.map(safeStringify).join(' ')}\n`); },
  warn:  (...msg: any[]) => { process.stderr.write(`[lark:warn] ${msg.map(safeStringify).join(' ')}\n`); },
  info:  (...msg: any[]) => { process.stderr.write(`[lark:info] ${msg.map(safeStringify).join(' ')}\n`); },
  debug: (...msg: any[]) => { process.stderr.write(`[lark:debug] ${msg.map(safeStringify).join(' ')}\n`); },
  trace: (...msg: any[]) => { process.stderr.write(`[lark:trace] ${msg.map(safeStringify).join(' ')}\n`); },
};

export function registerBot(cfg: BotConfig): BotState {
  const client = new Lark.Client({
    appId: cfg.larkAppId,
    appSecret: cfg.larkAppSecret,
    logger: stderrLogger,
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
          owners: Array.isArray(c.owners) ? c.owners.filter((o: any) => typeof o === 'string') : [],
        }));
    }

    configs.push({
      larkAppId: entry.larkAppId,
      larkAppSecret: entry.larkAppSecret,
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
