/**
 * Native ZCode lifecycle bridge, as a botmux subcommand.
 *
 * WHY A SUBCOMMAND AND NOT A SCRIPT FILE: the original bridge shipped as
 * `src/services/zcode-session-hook.mjs`, but nothing in botmux ever wrote it to
 * a path ZCode could reach (`~/.botmux/bin/` had no installer, tsc does not copy
 * `.mjs` into dist, and the npm `files` whitelist excludes it). On a clean
 * install the hook therefore never ran, no marker/receipt was ever recorded, and
 * EVERY submit reported `submit_unconfirmed` while the PTY had in fact executed
 * the message. Running the bridge through `botmux zcode-session-hook` reuses the
 * same invocation machinery as `botmux session-ready`, which resolves correctly
 * in all three runtime forms (tsx, node dist, compiled single-file binary).
 *
 * Records identities and digests only — never prompt text or credentials.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BOTMUX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NATIVE_ID = /^sess_[A-Za-z0-9_-]{1,120}$/;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const LIFECYCLE_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'Stop']);

interface ZcodeHookInput {
  sessionId?: unknown;
  session_id?: unknown;
  hookEventName?: unknown;
  hook_event_name?: unknown;
  prompt?: unknown;
  cwd?: unknown;
  source?: unknown;
  model?: unknown;
  turnId?: unknown;
}

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buf.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error('Hook input exceeds bridge limit');
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readMarker(path: string): Promise<any | null> {
  try {
    if ((await stat(path)).size > 65_536) return null;
    return JSON.parse(await readFile(path, 'utf8'));
  } catch { return null; }
}

/** One immutable receipt per native turn: a later lifecycle event cannot rewrite its evidence. */
async function createOnce(path: string, record: unknown): Promise<boolean> {
  try {
    await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return true;
  } catch (error: any) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

export function zcodeRuntimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  // The worker reads markers from `config.session.dataDir` (SESSION_DATA_DIR),
  // but BOTMUX_ZCODE_RUNTIME_DIR is only injected on a non-reattach launch that
  // actually prepared the provider override. On restore/adopt/degrade, and with
  // a custom data root, the hook used to fall back to the HOME default and the
  // two sides disagreed — every message then reported submit_unconfirmed.
  return env.BOTMUX_ZCODE_RUNTIME_DIR?.trim()
    || (env.SESSION_DATA_DIR?.trim() ? join(env.SESSION_DATA_DIR.trim(), 'zcode-runtime') : '')
    || join(homedir(), '.botmux', 'data', 'zcode-runtime');
}

/** Persist one lifecycle event. Exported so a test can drive it without stdio. */
export async function recordZcodeLifecycle(input: {
  botmuxSessionId: string;
  cliSessionId: string;
  event: string;
  prompt?: string;
  cwd?: string;
  source?: string;
  model?: string;
  turnId?: string;
  runtimeRoot?: string;
  now?: () => number;
}): Promise<void> {
  const { botmuxSessionId, cliSessionId, event } = input;
  if (!BOTMUX_ID.test(botmuxSessionId)) return;
  if (!NATIVE_ID.test(cliSessionId)) return;
  if (!LIFECYCLE_EVENTS.has(event)) return;

  const directory = join(input.runtimeRoot ?? zcodeRuntimeRoot(), botmuxSessionId);
  const file = join(directory, 'native-session.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const previous = await readMarker(file);

  // Subagents inherit BOTMUX_* too. The root identity is immutable within a botmux session.
  if (previous && (previous.botmuxSessionId !== botmuxSessionId || previous.cliSessionId !== cliSessionId)) return;

  const identityFile = join(directory, 'native-session.id');
  await createOnce(identityFile, { botmuxSessionId, cliSessionId });
  const identity = await readMarker(identityFile);
  if (identity?.botmuxSessionId !== botmuxSessionId || identity?.cliSessionId !== cliSessionId) return;

  const updatedAt = (input.now ?? Date.now)();
  const marker: Record<string, unknown> = {
    ...previous,
    version: 1,
    botmuxSessionId,
    cliSessionId,
    bindingSource: previous?.bindingSource ?? 'hook',
    updatedAt,
    ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
  };

  if (event === 'SessionStart') {
    marker.source = input.source;
    if (typeof input.model === 'string') marker.model = input.model;
  } else if (event === 'UserPromptSubmit' && typeof input.prompt === 'string') {
    const sha256 = createHash('sha256').update(input.prompt, 'utf8').digest('hex');
    const receipt = {
      sha256,
      cliSessionId,
      submittedAt: updatedAt,
      ...(typeof input.turnId === 'string' ? { turnId: input.turnId } : {}),
    };
    const receipts = join(directory, 'submissions');
    await mkdir(receipts, { recursive: true, mode: 0o700 });
    const turnSegment = (input.turnId || randomUUID()).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160);
    await createOnce(join(receipts, `${sha256}-${turnSegment}.json`), receipt);
    marker.submission = receipt;
  } else if (event === 'Stop') {
    marker.lastStopAt = updatedAt;
  }

  // Electron/Windows rename over an existing file can fail transiently; retry once.
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
}

/**
 * CLI entry: `botmux zcode-session-hook`. Always exits 0 — a failing hook must
 * never disturb the observed CLI, and ZCode has no hook-failure surface to show.
 */
export async function runZcodeSessionHookCli(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    const botmuxSessionId = env.BOTMUX_SESSION_ID;
    // Standalone ZCode sessions must not be affected by the installed user hook.
    if (!botmuxSessionId || !BOTMUX_ID.test(botmuxSessionId)) return;
    const input = (await readStdin()) as ZcodeHookInput | null;
    if (!input || typeof input !== 'object') return;
    const cliSessionId = String(input.sessionId ?? input.session_id ?? '');
    const event = String(input.hookEventName ?? input.hook_event_name ?? '');
    await recordZcodeLifecycle({
      botmuxSessionId,
      cliSessionId,
      event,
      prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
      cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
      source: typeof input.source === 'string' ? input.source : undefined,
      model: typeof input.model === 'string' ? input.model : undefined,
      turnId: typeof input.turnId === 'string' ? input.turnId : undefined,
      runtimeRoot: zcodeRuntimeRoot(env),
    });
  } catch {
    // No input/error detail is logged: hook input includes user text and attachments.
    process.stderr.write('botmux ZCode lifecycle bridge could not persist session evidence\n');
  }
}

// Direct execution guard: `tsx src/services/zcode-session-hook.ts` (tests) and any
// future standalone invocation run the bridge; importing it stays side-effect free.
if (process.argv[1] && /zcode-session-hook\.(ts|js)$/.test(process.argv[1])) {
  void runZcodeSessionHookCli().then(() => { process.stdout.write('{}\n'); });
}
