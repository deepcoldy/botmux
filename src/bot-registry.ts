import * as Lark from '@larksuiteoapi/node-sdk';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { CliId } from './adapters/cli/types.js';
import type { ImAdapter } from './im/types.js';

// ─── IM identifier ───────────────────────────────────────────────────────────

export type ImId = 'lark' | 'weixin';

// ─── Bot config types ────────────────────────────────────────────────────────

export interface BotConfigBase {
  im: ImId;
  cliId: CliId;
  cliPathOverride?: string;
  backendType?: 'pty' | 'tmux';
  workingDir?: string;
  workingDirs?: string[];
  allowedUsers?: string[];
  projectScanDir?: string;
}

export interface LarkBotConfig extends BotConfigBase {
  im: 'lark';
  larkAppId: string;
  larkAppSecret: string;
}

export interface WeixinBotConfig extends BotConfigBase {
  im: 'weixin';
}

export type BotConfig = LarkBotConfig | WeixinBotConfig;

// ─── Bot state ───────────────────────────────────────────────────────────────

export interface BotState {
  config: BotConfig;
  imBotId: string;               // larkAppId for Lark, 'weixin-<cliId>' for WeChat
  adapter?: ImAdapter;           // set after adapter creation
  botUserId?: string;            // was: botOpenId
  botName?: string;              // IM app display name
  resolvedAllowedUsers: string[];
}

const bots = new Map<string, BotState>();

// ─── Lark client storage ─────────────────────────────────────────────────────
// Used by im/lark/client.ts functions that take appId

// Provide a custom logger that writes to stderr.
// The default Lark SDK logger uses console.log (stdout), which corrupts
// MCP stdio protocol when the server is spawned as an MCP child process.
export const stderrLogger = {
  error: (...msg: any[]) => { process.stderr.write(`[lark:error] ${msg.map(m => JSON.stringify(m)).join(' ')}\n`); },
  warn:  (...msg: any[]) => { process.stderr.write(`[lark:warn] ${msg.map(m => JSON.stringify(m)).join(' ')}\n`); },
  info:  (...msg: any[]) => { process.stderr.write(`[lark:info] ${msg.map(m => JSON.stringify(m)).join(' ')}\n`); },
  debug: (...msg: any[]) => { process.stderr.write(`[lark:debug] ${msg.map(m => JSON.stringify(m)).join(' ')}\n`); },
  trace: (...msg: any[]) => { process.stderr.write(`[lark:trace] ${msg.map(m => JSON.stringify(m)).join(' ')}\n`); },
};

const larkClients = new Map<string, Lark.Client>();

export function registerLarkClient(appId: string, client: Lark.Client): void {
  larkClients.set(appId, client);
}

// Keep getBotClient working — it's called by every function in im/lark/client.ts
export function getBotClient(appId: string): Lark.Client {
  const c = larkClients.get(appId);
  if (!c) throw new Error(`Lark client not registered: ${appId}`);
  return c;
}

// ─── Bot registration ────────────────────────────────────────────────────────

export function registerBot(cfg: BotConfig): BotState {
  const imBotId = cfg.im === 'lark' ? cfg.larkAppId : `weixin-${cfg.cliId}`;
  const state: BotState = {
    config: cfg,
    imBotId,
    resolvedAllowedUsers: [...(cfg.allowedUsers ?? [])],
  };
  bots.set(imBotId, state);
  return state;
}

export function getBot(imBotId: string): BotState {
  const state = bots.get(imBotId);
  if (!state) {
    throw new Error(`Bot not registered: ${imBotId}`);
  }
  return state;
}

export function getAllBots(): BotState[] {
  return Array.from(bots.values());
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
    return parseBotConfigFile(resolved);
  }

  // 2. ~/.botmux/bots.json
  const defaultPath = resolve(homedir(), '.botmux', 'bots.json');
  if (existsSync(defaultPath)) {
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
    const im: ImId = entry.im ?? 'lark';

    // Parse workingDirs from comma-separated workingDir if workingDirs not explicitly set
    let workingDirs = entry.workingDirs;
    if (!workingDirs && entry.workingDir) {
      workingDirs = String(entry.workingDir).split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    if (im === 'lark') {
      if (!entry.larkAppId || typeof entry.larkAppId !== 'string') {
        throw new Error(`Bot config [${i}]: larkAppId is required for lark bots`);
      }
      if (!entry.larkAppSecret || typeof entry.larkAppSecret !== 'string') {
        throw new Error(`Bot config [${i}]: larkAppSecret is required for lark bots`);
      }
      configs.push({
        im: 'lark',
        larkAppId: entry.larkAppId,
        larkAppSecret: entry.larkAppSecret,
        cliId: entry.cliId ?? 'claude-code',
        cliPathOverride: entry.cliPathOverride,
        backendType: entry.backendType,
        workingDir: workingDirs?.[0] ?? entry.workingDir,
        workingDirs,
        allowedUsers: entry.allowedUsers,
        projectScanDir: entry.projectScanDir,
      });
    } else if (im === 'weixin') {
      configs.push({
        im: 'weixin',
        cliId: entry.cliId ?? 'claude-code',
        cliPathOverride: entry.cliPathOverride,
        backendType: entry.backendType,
        workingDir: workingDirs?.[0] ?? entry.workingDir,
        workingDirs,
        allowedUsers: entry.allowedUsers,
        projectScanDir: entry.projectScanDir,
      });
    } else {
      throw new Error(`Bot config [${i}]: unknown im type '${im}'`);
    }
  }

  return configs;
}
