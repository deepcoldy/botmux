import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDatabaseSyncNow, type DatabaseSyncLike } from './sqlite-compat.js';
import { zcodeSessionDbPath } from './zcode-session.js';

/** Token accounting for one ZCode session, read from the CLI's own `model_usage`
 *  ledger. ZCode persists this itself — botmux only reads it. */
export interface ZcodeUsageTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** Prompt size of the NEWEST request: ZCode bills the whole prompt per call,
   *  so this is the live context — not a sum over turns. */
  contextUsed: number;
  /** False when the CLI recorded calls but the provider reported no token
   *  counts at all. The card must then show nothing rather than a fake `0/1M`. */
  hasTokenEvidence: boolean;
  contextWindow?: number;
  turnInputTokens: number;
  turnOutputTokens: number;
  modelId?: string;
  reasoningLevel?: string;
}

interface ZcodeUsageRow {
  turn_id?: string;
  provider_id?: string;
  model_id?: string;
  variant?: string;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** ZCODE_DATA_BASE_DIR is the PARENT of `.zcode` (matches the native CLI). */
function personalProviderConfigPath(env: NodeJS.ProcessEnv): string {
  return env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim()
    || join(env.ZCODE_DATA_BASE_DIR?.trim() || homedir(), '.zcode', 'v2', 'provider_config.json');
}

const WINDOW_CACHE_MS = 10_000;
let windowCache: { at: number; file: string; windows: Map<string, number> } | null = null;

/** Context window the provider config declares for a model. This is the same
 *  declaration the CLI's own context view uses. Absent ⇒ the card shows the
 *  token count without a percentage, rather than guessing a capacity from the
 *  model name. */
export function zcodeContextWindow(
  providerId: string,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const file = personalProviderConfigPath(env);
  const now = Date.now();
  if (!windowCache || windowCache.file !== file || now - windowCache.at > WINDOW_CACHE_MS) {
    const windows = new Map<string, number>();
    try {
      const rules = JSON.parse(readFileSync(file, 'utf8'))?.config?.modelConfigRules;
      for (const key of ['providerModelRules', 'manualProviderModelRules'] as const) {
        const list = rules?.[key];
        if (!Array.isArray(list)) continue;
        for (const rule of list) {
          const window = rule?.config?.properties?.contextWindow;
          if (typeof rule?.providerId === 'string' && typeof rule?.modelId === 'string'
            && typeof window === 'number' && Number.isFinite(window) && window > 0) {
            windows.set(`${rule.providerId}/${rule.modelId}`, window);
          }
        }
      }
    } catch { /* unreadable config ⇒ no window ⇒ no percentage */ }
    windowCache = { at: now, file, windows };
  }
  return windowCache.windows.get(`${providerId}/${modelId}`);
}

/** Successful main-turn usage. Title generation and subagent calls carry their
 *  own `query_source` and are excluded; only `completed` requests move the
 *  gauge, so a failed or cancelled call cannot inflate it. */
export function readZcodeUsage(
  cliSessionId: string,
  dbPath: string = zcodeSessionDbPath(),
  env: NodeJS.ProcessEnv = process.env,
): ZcodeUsageTotals | null {
  if (!cliSessionId || !existsSync(dbPath)) return null;
  let db: DatabaseSyncLike | null = null;
  try {
    db = openDatabaseSyncNow(dbPath, { readOnly: true });
    if (!db) return null;
    const rows = db.prepare(
      `SELECT turn_id, provider_id, model_id, variant, input_tokens, output_tokens, reasoning_tokens,
              cache_read_input_tokens, cache_creation_input_tokens
         FROM model_usage
        WHERE session_id = ? AND query_source = 'main_turn' AND status = 'completed'
        ORDER BY started_at ASC`,
    ).all(cliSessionId) as ZcodeUsageRow[];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const last = rows[rows.length - 1]!;
    const totals: ZcodeUsageTotals = {
      turns: rows.length, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreateTokens: 0, contextUsed: 0,
      turnInputTokens: 0, turnOutputTokens: 0, hasTokenEvidence: false,
    };
    for (const row of rows) {
      const input = Number(row.input_tokens) || 0;
      // Reasoning tokens are billed output that ZCode reports separately.
      const output = (Number(row.output_tokens) || 0) + (Number(row.reasoning_tokens) || 0);
      totals.inputTokens += input;
      totals.outputTokens += output;
      totals.cacheReadTokens += Number(row.cache_read_input_tokens) || 0;
      totals.cacheCreateTokens += Number(row.cache_creation_input_tokens) || 0;
      if (row.turn_id !== undefined && row.turn_id === last.turn_id) {
        totals.turnInputTokens += input;
        totals.turnOutputTokens += output;
      }
    }
    totals.contextUsed = Number(last.input_tokens) || 0;
    totals.hasTokenEvidence = totals.inputTokens > 0 || totals.outputTokens > 0;
    if (typeof last.model_id === 'string' && last.model_id) totals.modelId = last.model_id;
    // ZCode stores the reasoning level it actually ran as `variant`.
    if (typeof last.variant === 'string' && last.variant) totals.reasoningLevel = last.variant;
    if (typeof last.provider_id === 'string' && last.model_id) {
      const window = zcodeContextWindow(last.provider_id, last.model_id, env);
      if (window) totals.contextWindow = window;
    }
    return totals;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}
