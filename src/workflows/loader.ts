import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalJsonStringify,
  parseWorkflowDefinition,
  type WorkflowDefinition,
} from './definition.js';
import { ensureRunDir } from './runs-dir.js';
import { logger } from '../utils/logger.js';

export type RunChatBinding = {
  chatId: string;
  larkAppId: string;
};

type RunFileOptions = {
  runDir?: string;
  runsDir?: string;
};

export function workflowDefinitionSearchPaths(workflowId: string): string[] {
  const home = process.env.HOME;
  return [
    join(process.cwd(), 'workflows', `${workflowId}.workflow.json`),
    join(home ?? '', '.botmux', 'workflows', `${workflowId}.workflow.json`),
  ];
}

export async function loadWorkflowDefinition(workflowId: string): Promise<WorkflowDefinition> {
  const paths = workflowDefinitionSearchPaths(workflowId);
  for (const path of paths) {
    try {
      const raw = await fs.readFile(path, 'utf-8');
      return parseWorkflowDefinition(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(
        `Failed to load workflow '${workflowId}' from ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  throw new Error(
    `Workflow '${workflowId}' not found. Looked in:\n${paths.map((p) => `- ${p}`).join('\n')}`,
  );
}

export async function snapshotWorkflowDefinition(
  runId: string,
  def: WorkflowDefinition,
  opts: RunFileOptions = {},
): Promise<string> {
  const dir = await getOrEnsureRunDir(runId, opts);
  const path = join(dir, 'workflow.json');
  await fs.writeFile(path, canonicalJsonStringify(def), 'utf-8');
  return path;
}

/**
 * Load the workflow definition snapshot from a run's directory.  Each run
 * persists `workflow.json` next to `events.ndjson` so consumers that come
 * in via run id alone (Lark card callbacks, dashboard resolve) can recover
 * the definition without needing the catalog (which may drift).
 *
 * Returns null when the snapshot is missing or unreadable — callers can
 * still operate (e.g. resolveWait without ctx.def degrades to v0.1
 * approve/reject semantics).  The fallback is the *intended* design, but
 * we log non-ENOENT failures so an unexpected parse/IO error doesn't go
 * silently null and confuse debugging (ENOENT stays silent — missing
 * snapshot is a normal state for legacy v0.1 runs that predate this file).
 */
export async function readWorkflowDefinitionFromRunDir(
  runDir: string,
): Promise<WorkflowDefinition | null> {
  const path = join(runDir, 'workflow.json');
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return parseWorkflowDefinition(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn?.(
        `readWorkflowDefinitionFromRunDir: ${path} unreadable — caller falls back to v0.1 wait semantics: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return null;
  }
}

export async function writeRunChatBinding(
  runId: string,
  binding: RunChatBinding,
  opts: RunFileOptions = {},
): Promise<string> {
  const dir = await getOrEnsureRunDir(runId, opts);
  const path = join(dir, 'chat-binding.json');
  await fs.writeFile(path, JSON.stringify(binding, null, 2), 'utf-8');
  return path;
}

export async function readRunChatBinding(
  runId: string,
  opts: RunFileOptions = {},
): Promise<RunChatBinding> {
  const dir = await getOrEnsureRunDir(runId, opts);
  const path = join(dir, 'chat-binding.json');
  const raw = await fs.readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<RunChatBinding>;
  if (!parsed.chatId || !parsed.larkAppId) {
    throw new Error(`Invalid workflow chat binding at ${path}`);
  }
  return { chatId: parsed.chatId, larkAppId: parsed.larkAppId };
}

async function getOrEnsureRunDir(runId: string, opts: RunFileOptions): Promise<string> {
  if (opts.runDir) {
    await fs.mkdir(opts.runDir, { recursive: true });
    return opts.runDir;
  }
  return ensureRunDir(runId, opts.runsDir);
}
