/**
 * Session cost calculator — computes token usage from JSONL logs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
import { expandHome } from './session-manager.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  model: string;
  turns: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function getSessionJsonlPath(sessionId: string, cwd: string): string | null {
  const resolvedCwd = resolve(expandHome(cwd));
  // Claude stores sessions at ~/.claude/projects/<project-key>/<sessionId>.jsonl
  // where project-key = absolute path with / replaced by -
  const projectKey = resolvedCwd.replace(/\//g, '-');
  const jsonlPath = join(homedir(), '.claude', 'projects', projectKey, `${sessionId}.jsonl`);
  return existsSync(jsonlPath) ? jsonlPath : null;
}

export function getSessionCost(sessionId: string, cwd: string): SessionCost | null {
  const jsonlPath = getSessionJsonlPath(sessionId, cwd);
  if (!jsonlPath) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;
  let model = '';
  let turns = 0;

  try {
    const content = readFileSync(jsonlPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'assistant') continue;
        const msg = entry.message;
        if (!msg?.usage) continue;
        const u = msg.usage;
        inputTokens += u.input_tokens ?? 0;
        outputTokens += u.output_tokens ?? 0;
        cacheReadTokens += u.cache_read_input_tokens ?? 0;
        cacheCreateTokens += u.cache_creation_input_tokens ?? 0;
        if (msg.model && !model) model = msg.model;
        turns++;
      } catch { /* skip malformed lines */ }
    }
  } catch (err: any) {
    logger.error(`Failed to read session JSONL: ${err.message}`);
    return null;
  }

  return { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, model, turns };
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}
