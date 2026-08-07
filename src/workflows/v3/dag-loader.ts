import { readFileSync } from 'node:fs';
import {
  DagValidationError,
  validateDag,
  type V3Dag,
} from './dag.js';

export { DagValidationError };

/** Load and validate a v3 DAG from a Node.js filesystem host. */
export function loadDag(path: string): V3Dag {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`v3: cannot read dag.json at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`v3: dag.json at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return validateDag(parsed);
}
