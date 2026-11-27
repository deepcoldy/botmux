import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
/** Committed audit records are unordered across daemons. Pending files and
 * historical torn JSONL tails are deliberately not accepted as new intents. */
export function readCommittedBytedcliAudit(root: string): any[] {
  const records = join(root, 'records');
  if (existsSync(records)) return readdirSync(records).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(records, name), 'utf8')));
  return readFileSync(join(root, 'audit.jsonl'), 'utf8').trim().split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
