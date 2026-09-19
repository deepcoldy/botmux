import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';

const MESSAGE_ID_RE = /^om_[A-Za-z0-9_-]{1,128}$/;

export interface ReportTaskLineage {
  id: string;
  taskRoot: string;
  chatId: string;
  dispatchRootMessageId: string;
}

type TaskBinding = {
  schemaVersion?: unknown;
  status?: unknown;
  taskSlug?: unknown;
  taskRoot?: unknown;
  taskChatId?: unknown;
  dispatch?: {
    mode?: unknown;
    success?: unknown;
    chatId?: unknown;
    messageId?: unknown;
  };
};

function nonBlank(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
}

export function resolveReportTaskLineage(input: {
  contentFile?: string;
  chatId: string;
}): ReportTaskLineage | undefined {
  if (!input.contentFile || !nonBlank(input.chatId)) return undefined;

  let contentPath: string;
  try {
    contentPath = realpathSync(resolve(input.contentFile));
  } catch {
    return undefined;
  }

  let cursor = dirname(contentPath);
  const filesystemRoot = parse(cursor).root;
  for (let depth = 0; depth < 32; depth++) {
    const bindingPath = join(cursor, 'context', 'botmux-task.json');
    // An invalid nearest binding must not inherit its parent's task.
    if (existsSync(bindingPath)) {
      let binding: TaskBinding;
      try {
        const parsed: unknown = JSON.parse(readFileSync(bindingPath, 'utf-8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
        binding = parsed as TaskBinding;
      } catch {
        return undefined;
      }

      const taskSlug = nonBlank(binding.taskSlug);
      const taskRootRaw = nonBlank(binding.taskRoot);
      const taskChatId = nonBlank(binding.taskChatId);
      const dispatchChatId = nonBlank(binding.dispatch?.chatId);
      const dispatchMessageId = nonBlank(binding.dispatch?.messageId);
      if (binding.schemaVersion !== 1
        || binding.status !== 'dispatched'
        || !taskSlug
        || !taskRootRaw
        || taskChatId !== input.chatId
        || binding.dispatch?.mode !== 'chat'
        || binding.dispatch?.success !== true
        || dispatchChatId !== input.chatId
        || !dispatchMessageId
        || !MESSAGE_ID_RE.test(dispatchMessageId)) return undefined;

      let taskRoot: string;
      let discoveredRoot: string;
      try {
        taskRoot = realpathSync(resolve(taskRootRaw));
        discoveredRoot = realpathSync(cursor);
      } catch {
        return undefined;
      }
      const child = relative(taskRoot, contentPath);
      if (taskRoot !== discoveredRoot || child.startsWith('..') || isAbsolute(child)) return undefined;

      return {
        id: `agent-task:${taskSlug}:${dispatchMessageId}`,
        taskRoot,
        chatId: input.chatId,
        dispatchRootMessageId: dispatchMessageId,
      };
    }
    if (cursor === filesystemRoot) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return undefined;
}
