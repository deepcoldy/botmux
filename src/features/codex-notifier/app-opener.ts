import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CodexAppOpenResult =
  | { ok: true }
  | {
      ok: false;
      error: 'invalid_thread_id' | 'unsupported_platform' | 'open_failed';
      detail?: string;
    };

export type CodexAppOpenRunner = (
  executable: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean; maxBuffer: number },
) => Promise<unknown>;

export function isCodexAppThreadId(value: string): boolean {
  return CODEX_THREAD_ID_PATTERN.test(value);
}

export function canOpenCodexAppThread(
  threadId: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'darwin' && isCodexAppThreadId(threadId);
}

/** 在运行 BotMux 的 macOS 用户会话中打开可信的 Codex App 线程。 */
export async function openCodexAppThread(
  threadId: string,
  options: {
    platform?: NodeJS.Platform;
    run?: CodexAppOpenRunner;
    timeoutMs?: number;
  } = {},
): Promise<CodexAppOpenResult> {
  if (!isCodexAppThreadId(threadId)) return { ok: false, error: 'invalid_thread_id' };
  if ((options.platform ?? process.platform) !== 'darwin') {
    return { ok: false, error: 'unsupported_platform' };
  }

  const run = options.run ?? (async (executable, args, runOptions) => {
    await execFileAsync(executable, args, runOptions);
  });
  try {
    await run(
      '/usr/bin/open',
      ['-u', `codex://threads/${encodeURIComponent(threadId)}`],
      { timeout: options.timeoutMs ?? 1_500, windowsHide: true, maxBuffer: 1024 },
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: 'open_failed',
      detail: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    };
  }
}
