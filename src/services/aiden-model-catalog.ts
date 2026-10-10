import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

interface AidenModelsPayload {
  readonly schema_version?: unknown;
  readonly models?: unknown;
}

/** Parse `aiden x models --codex --json` without depending on capacity metadata. */
export function parseAidenCodexModelsJson(stdout: string): string[] {
  let payload: AidenModelsPayload;
  try {
    payload = JSON.parse(stdout) as AidenModelsPayload;
  } catch {
    return [];
  }
  if (payload.schema_version !== 1 || !Array.isArray(payload.models)) return [];

  const models: string[] = [];
  const seen = new Set<string>();
  for (const entry of payload.models) {
    if (!entry || typeof entry !== 'object') continue;
    const { cli_type: cliType, id } = entry as { cli_type?: unknown; id?: unknown };
    if (cliType !== 'codex' || typeof id !== 'string' || id.trim().length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push(id);
  }
  return models;
}

/** Query Aiden's authenticated AIPROXY catalog. All failures are fail-soft. */
export async function detectAidenCodexModels(): Promise<readonly string[] | null> {
  try {
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('aiden', [
      'x', 'models', '--codex', '--json', '--timeout', '10000',
    ], {
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    const models = parseAidenCodexModelsJson(stdout);
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}
