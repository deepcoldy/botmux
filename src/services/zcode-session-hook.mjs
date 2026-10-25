#!/usr/bin/env node
// Native ZCode lifecycle bridge. It records identities/digests, never prompt text or credentials.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BOTMUX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NATIVE_ID = /^sess_[A-Za-z0-9_-]{1,120}$/;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

async function readInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error('Hook input exceeds bridge limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readMarker(path) {
  try {
    if ((await stat(path)).size > 65_536) return null;
    return JSON.parse(await readFile(path, 'utf8'));
  } catch { return null; }
}

async function createOnce(path, record) {
  try {
    await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

async function main() {
  const botmuxSessionId = process.env.BOTMUX_SESSION_ID;
  // Standalone ZCode and desktop sessions must not be affected by installed user hooks.
  if (!botmuxSessionId || !BOTMUX_ID.test(botmuxSessionId)) return;
  const input = await readInput();
  const cliSessionId = input.sessionId ?? input.session_id;
  const event = input.hookEventName ?? input.hook_event_name;
  if (!NATIVE_ID.test(cliSessionId ?? '') || !['SessionStart', 'UserPromptSubmit', 'Stop'].includes(event)) return;
  const runtimeRoot = process.env.BOTMUX_ZCODE_RUNTIME_DIR?.trim() || join(homedir(), '.botmux', 'data', 'zcode-runtime');
  const directory = join(runtimeRoot, botmuxSessionId);
  const file = join(directory, 'native-session.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const previous = await readMarker(file);
  // Subagents inherit BOTMUX_* too. The root identity is immutable within a botmux session.
  if (previous && (previous.botmuxSessionId !== botmuxSessionId || previous.cliSessionId !== cliSessionId)) return;
  const identityFile = join(directory, 'native-session.id');
  await createOnce(identityFile, { botmuxSessionId, cliSessionId });
  const identity = await readMarker(identityFile);
  if (identity?.botmuxSessionId !== botmuxSessionId || identity?.cliSessionId !== cliSessionId) return;
  const updatedAt = Date.now();
  const marker = {
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
    const turnId = typeof input.turnId === 'string' ? input.turnId : undefined;
    const receipt = { sha256, cliSessionId, submittedAt: updatedAt, ...(turnId ? { turnId } : {}) };
    const receipts = join(directory, 'submissions');
    await mkdir(receipts, { recursive: true, mode: 0o700 });
    const turnSegment = (turnId || randomUUID()).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160);
    // One immutable receipt per native turn: a later lifecycle event cannot rewrite its evidence.
    await createOnce(join(receipts, `${sha256}-${turnSegment}.json`), receipt);
    marker.submission = receipt;
  } else if (event === 'Stop') {
    marker.lastStopAt = updatedAt;
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
}

main().then(() => {
  process.stdout.write('{}\n');
}).catch(() => {
  // No input/error detail is logged: hook input includes user text and attachments.
  process.stderr.write('botmux ZCode lifecycle bridge could not persist session evidence\n');
  process.exitCode = 1;
});
