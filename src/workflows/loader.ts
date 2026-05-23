import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalJsonStringify,
  parseWorkflowDefinition,
  type WorkflowDefinition,
} from './definition.js';
import { ensureRunDir } from './runs-dir.js';

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
