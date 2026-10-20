import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandHomePath as expandHome } from '../utils/working-dir.js';

/** Codex stores config, history, and transcripts under CODEX_HOME when set;
 *  otherwise it defaults to ~/.codex. Keep this dynamic so tests and child
 *  processes that set CODEX_HOME after module load still resolve correctly. */
export function codexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? expandHome(configured) : join(homedir(), '.codex');
}

export function codexHistoryPath(): string {
  return join(codexHome(), 'history.jsonl');
}

export function codexSessionsRoot(): string {
  return join(codexHome(), 'sessions');
}
