/** Discovery for migration: unlike the dashboard catalog, never hide errors. */

import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { parseWorkflowDefinition, type WorkflowDefinition } from '../definition.js';
import { legacyWorkflowDefinitionSearchPaths } from './v2-definition-paths.js';

export type LegacyMigrationCandidate =
  | {
    kind: 'valid';
    path: string;
    definition: WorkflowDefinition;
  }
  | {
    kind: 'shadowed';
    path: string;
    definition: WorkflowDefinition;
    shadowedBy: string;
  }
  | {
    kind: 'invalid';
    path: string;
    inferredWorkflowId: string;
    error: string;
  };

function defaultSearchDirs(): string[] {
  return [...new Set(legacyWorkflowDefinitionSearchPaths('__migration_sentinel__').map(dirname))];
}

async function parseCandidate(path: string): Promise<LegacyMigrationCandidate> {
  const inferredWorkflowId = basename(path).replace(/\.workflow\.json$/, '');
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const definition = parseWorkflowDefinition(JSON.parse(raw));
    return { kind: 'valid', path: resolve(path), definition };
  } catch (err) {
    return {
      kind: 'invalid',
      path: resolve(path),
      inferredWorkflowId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function scanAll(dirs: string[]): Promise<LegacyMigrationCandidate[]> {
  const out: LegacyMigrationCandidate[] = [];
  const seen = new Map<string, string>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((name) => name.endsWith('.workflow.json')).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const name of names) {
      const parsed = await parseCandidate(join(dir, name));
      if (parsed.kind !== 'valid') {
        out.push(parsed);
        continue;
      }
      if (name !== `${parsed.definition.workflowId}.workflow.json`) {
        out.push({
          kind: 'invalid',
          path: parsed.path,
          inferredWorkflowId: parsed.definition.workflowId,
          error:
            `filename ${JSON.stringify(name)} does not match workflowId ` +
            `${JSON.stringify(parsed.definition.workflowId)}; the v2 loader cannot resolve this asset by id`,
        });
        continue;
      }
      const winner = seen.get(parsed.definition.workflowId);
      if (winner) {
        out.push({ ...parsed, kind: 'shadowed', shadowedBy: winner });
      } else {
        seen.set(parsed.definition.workflowId, parsed.path);
        out.push(parsed);
      }
    }
  }
  return out;
}

function looksLikePath(ref: string): boolean {
  return isAbsolute(ref) || ref.includes(sep) || ref.includes('/') || ref.includes('\\') || ref.endsWith('.json');
}

async function scanRefs(refs: string[]): Promise<LegacyMigrationCandidate[]> {
  const out: LegacyMigrationCandidate[] = [];
  const seenPaths = new Set<string>();
  for (const ref of refs) {
    let path: string | undefined;
    if (looksLikePath(ref)) {
      path = resolve(ref);
    } else {
      for (const candidate of legacyWorkflowDefinitionSearchPaths(ref)) {
        try {
          const stat = await fs.stat(candidate);
          if (stat.isFile()) {
            path = candidate;
            break;
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
    }
    if (!path) {
      out.push({
        kind: 'invalid',
        path: looksLikePath(ref) ? resolve(ref) : legacyWorkflowDefinitionSearchPaths(ref)[0]!,
        inferredWorkflowId: ref,
        error: `legacy workflow ${JSON.stringify(ref)} was not found`,
      });
      continue;
    }
    const normalized = resolve(path);
    if (seenPaths.has(normalized)) continue;
    seenPaths.add(normalized);
    out.push(await parseCandidate(normalized));
  }
  return out;
}

export async function scanLegacyWorkflowCandidates(input: {
  refs?: string[];
  dirs?: string[];
} = {}): Promise<LegacyMigrationCandidate[]> {
  if (input.refs?.length) return scanRefs(input.refs);
  return scanAll(input.dirs ?? defaultSearchDirs());
}
