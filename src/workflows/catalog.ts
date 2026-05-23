/**
 * Workflow catalog — discovery + summary load for the dashboard catalog page.
 *
 * Reuses `workflowDefinitionSearchPaths()` so the catalog list and CLI/IM
 * `loadWorkflowDefinition()` see the same files.  Two search paths today:
 *   - `<cwd>/workflows/*.workflow.json`           (per-project)
 *   - `$HOME/.botmux/workflows/*.workflow.json`   (global, daemon default)
 *
 * Dedupe rule when the same `workflowId` appears in both: cwd wins, then
 * HOME.  Matches `loadWorkflowDefinition()` which short-circuits on the first
 * search path that resolves.
 *
 * Read-only and pure: never writes or normalizes the source files — the
 * dashboard catalog list should reflect exactly what the daemon would resolve.
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';

import {
  computeRevisionId,
  parseWorkflowDefinition,
  type WorkflowDefinition,
} from './definition.js';
import { workflowDefinitionSearchPaths } from './loader.js';

const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

export type CatalogEntry = {
  workflowId: string;
  version: number;
  path: string;
  revisionId: string;
  paramCount: number;
  requiredParamCount: number;
  nodeCount: number;
};

export type CatalogDefinition = {
  definition: WorkflowDefinition;
  revisionId: string;
  path: string;
};

export function isValidWorkflowId(id: string): boolean {
  return WORKFLOW_ID_PATTERN.test(id);
}

function searchDirectories(): string[] {
  // workflowDefinitionSearchPaths returns full file paths for a given id; we
  // strip the filename so we can scan the parent directories instead.  Filter
  // duplicates so home-only setups don't double-walk.
  const dirs = new Set<string>();
  for (const path of workflowDefinitionSearchPaths('__sentinel__')) {
    dirs.add(dirname(path));
  }
  return [...dirs];
}

async function readEntriesFromDir(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    return names.filter((n) => n.endsWith('.workflow.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function summarize(def: WorkflowDefinition, path: string): CatalogEntry {
  const params = def.params ?? {};
  const paramCount = Object.keys(params).length;
  const requiredParamCount = Object.values(params).filter((p) => p.required).length;
  return {
    workflowId: def.workflowId,
    version: def.version,
    path,
    revisionId: computeRevisionId(def),
    paramCount,
    requiredParamCount,
    nodeCount: Object.keys(def.nodes).length,
  };
}

/**
 * List every parseable workflow visible to the daemon.
 *
 * Files that fail to parse (zod errors, cycles, etc.) are skipped silently so
 * one bad authoring attempt doesn't poison the whole catalog.  The CLI's
 * `botmux workflow validate` is the right surface for line-level errors.
 *
 * Search-path priority matches `loadWorkflowDefinition`: cwd-local before
 * HOME global so per-project drafts override globals with the same id.
 *
 * `opts.dirs` is a test seam — production callers use the default search
 * paths.  Tests pass scoped tmp directories so they don't read whatever
 * happens to live under `$HOME/.botmux/workflows`.
 */
export async function listWorkflowDefinitions(opts: {
  dirs?: string[];
} = {}): Promise<CatalogEntry[]> {
  const dirs = opts.dirs ?? searchDirectories();
  const seen = new Map<string, CatalogEntry>();
  for (const dir of dirs) {
    const files = await readEntriesFromDir(dir);
    for (const name of files) {
      const path = join(dir, name);
      try {
        const raw = await fs.readFile(path, 'utf-8');
        const def = parseWorkflowDefinition(JSON.parse(raw));
        // First occurrence wins (cwd before HOME by search-path order).
        if (!seen.has(def.workflowId)) {
          seen.set(def.workflowId, summarize(def, path));
        }
      } catch {
        // Skip unreadable / unparseable file — see comment block above.
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.workflowId.localeCompare(b.workflowId));
}

/**
 * Load a single workflow definition by id and surface its source path +
 * revisionId in the response envelope.  Returns `undefined` when no file in
 * any search path resolves the id, so the caller can return 404.
 *
 * `opts.searchPaths` is a test seam; production callers use the default
 * search paths derived from cwd + `$HOME/.botmux/workflows`.
 */
export async function loadCatalogDefinition(
  workflowId: string,
  opts: { searchPaths?: string[] } = {},
): Promise<CatalogDefinition | undefined> {
  const paths = opts.searchPaths ?? workflowDefinitionSearchPaths(workflowId);
  for (const path of paths) {
    try {
      const raw = await fs.readFile(path, 'utf-8');
      const def = parseWorkflowDefinition(JSON.parse(raw));
      return { definition: def, revisionId: computeRevisionId(def), path };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
  return undefined;
}
