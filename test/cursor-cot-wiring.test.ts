import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source lock for the Cursor CoT reader wiring.
 *
 * cursor-cot.test.ts covers the service module, but cannot see the worker's
 * connection points. The review flagged exactly this gap: deleting an arm
 * call leaves no failing test. These invariants anchor every delivery mode
 * the session-long reader is expected to cover; reverting a call makes its
 * matched line disappear and fails the assertion.
 */
const WORKER = 'src/worker.ts';

function read(rel: string): string {
  return readFileSync(resolve(rel), 'utf8');
}

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`signature not found: ${signature}`);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end === -1 ? undefined : end + 2);
}

describe('cursor CoT reader wiring (source lock)', () => {
  const src = read(WORKER);

  it('marks the reader chat only after start succeeds', () => {
    // A missing/unresolved store must not make ensureCursorCotReader believe
    // a reader is running and short-circuit every later attempt.
    const body = functionBody(src, 'function ensureCursorCotReader(chatId: string): void {');
    expect(body).toContain('const ok = startCursorCot(');
    expect(body).toContain('if (ok)');
    expect(body).toContain('cursorCotReaderChatId = chatId;');
  });

  it('resolves the chatId from the observed session or the live pid', () => {
    // Covers queued/Goal turns where spawn-time observation has not resolved.
    const body = functionBody(src, 'function armCursorCotForTurn(): void {');
    expect(body).toContain('lastSpawnEffectiveCliSessionId');
    expect(body).toContain('findCursorChatIdByPid(');
  });

  it('starts the reader when the chatId is first observed (argv first turn)', () => {
    // passesInitialPromptViaArgs means the first prompt never enters
    // flushPending — the observation callback is the only early hook.
    const body = functionBody(src, 'function observeCursorCliSessionId(pid: number, label');
    expect(body).toContain('ensureCursorCotReader(chatId);');
  });

  it('starts the reader on adopt attach and arms queued cursor turns', () => {
    const attach = functionBody(src, 'function cursorBridgeAttach(');
    expect(attach).toContain("path.split('/').slice(-2, -1)[0]");
    expect(attach).toContain('ensureCursorCotReader(chatId);');
    const queued = functionBody(src, 'const prepareNormalWrite = (): void => {');
    expect(queued).toContain('armCursorCotForTurn();');
  });

  it('stops readers and clears the reader chat on bridge teardown', () => {
    const body = functionBody(src, 'function stopCodexBridge(): void {');
    expect(body).toContain('stopAllCursorCot();');
    expect(body).toContain('cursorCotReaderChatId = undefined;');
  });
});
