import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PtyHandle } from '../src/adapters/cli/types.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { codexTerminalSessionIsBound } from '../src/services/codex-terminal-session.js';
import { CodexBridgeQueue, STRUCTURED_SUBMIT_START_GRACE_MS } from '../src/services/codex-bridge-queue.js';
import { strictInputHandle } from '../src/adapters/cli/strict-input-handle.js';
import { drainCodexRollout, findCodexRolloutBySessionId } from '../src/services/codex-transcript.js';

const { owned } = vi.hoisted(() => ({ owned: vi.fn() }));
vi.mock('../src/services/codex-transcript.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/codex-transcript.js')>(),
  findCodexRolloutSetByPid: owned,
}));

const SID = '019dd80d-d922-7a11-8339-0208d8c5b4ee';
const FOREIGN_SID = '019dd80d-d922-7a11-8339-0208d8c5b4ec';
const INPUT = '<session_id>botmux-owned-session</session_id>\n<user_message>继续检查</user_message>';
let home: string;
let previousHome: string | undefined;
let previousScale: string | undefined;

function history(sid: string, text: string) {
  appendFileSync(join(home, 'history.jsonl'), `${JSON.stringify({ session_id: sid, text })}\n`);
}

function pane(onEnter: (text: string) => void) {
  let text = '';
  return {
    cliPid: 1234,
    write(data: string) { text = data.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, ''); },
    pasteText(data: string) { text = data; },
    sendSpecialKeys() { onEnter(text); },
    text: () => text,
  } satisfies PtyHandle & { text(): string };
}

beforeEach(() => {
  previousHome = process.env.CODEX_HOME;
  previousScale = process.env.BOTMUX_TIME_SCALE;
  home = mkdtempSync(join(tmpdir(), 'bmx-codex-correlation-'));
  process.env.CODEX_HOME = home;
  process.env.BOTMUX_TIME_SCALE = '0.01';
  writeFileSync(join(home, 'history.jsonl'), '');
  // Linux sandbox denies readlink(/proc/<pid>/fd/*).
  owned.mockReset().mockReturnValue(undefined);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  if (previousScale === undefined) delete process.env.BOTMUX_TIME_SCALE;
  else process.env.BOTMUX_TIME_SCALE = previousScale;
});

describe('owned Codex input when rollout fds are unavailable', () => {
  it.each(['paste', 'raw', 'strict'] as const)('%s: binds the exact submitted history and keeps collecting past the lease', async mode => {
    const target = pane(text => {
      history(FOREIGN_SID, INPUT); // Concurrent same-text submit must not win.
      history(SID, text);
    });
    if (mode === 'raw') delete (target as Partial<PtyHandle>).pasteText;
    const handle = mode === 'strict' ? strictInputHandle(target) : target;
    const result = await createCodexAdapter().writeInput(handle, INPUT, { correlateTranscript: true });
    expect(result).toMatchObject({ submitted: true, cliSessionId: SID, ownershipProven: true });
    expect(codexTerminalSessionIsBound(handle, SID)).toBe(true);
    expect(codexTerminalSessionIsBound(handle, FOREIGN_SID)).toBe(false);

    // The transport suffix must preserve the bridge's original logical-input
    // fingerprint. A genuinely started turn cannot expire and raise a false
    // "no transcript start" notice while the model is still working.
    const now = Date.now();
    const dir = join(home, 'sessions', '2026', '10', '26');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-2026-10-26T11-56-33-${SID}.jsonl`);
    writeFileSync(path, `${JSON.stringify({
      timestamp: new Date(now).toISOString(), type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: target.text() }] },
    })}\n`);
    const resolved = findCodexRolloutBySessionId(result!.cliSessionId!);
    expect(resolved).toBe(path);
    const start = drainCodexRollout(resolved!, 0);
    const queue = new CodexBridgeQueue();
    queue.mark('om_input', INPUT, now);
    queue.ingest(start.events);
    expect(queue.pruneExpiredPreStartHeads(now + STRUCTURED_SUBMIT_START_GRACE_MS * 2)).toEqual([]);
    expect(queue.hasBlockingTurn(now + STRUCTURED_SUBMIT_START_GRACE_MS * 2)).toBe(true);
    appendFileSync(path, `${JSON.stringify({
      timestamp: new Date(now + 60_000).toISOString(), type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'native-turn', last_agent_message: '检查完成' },
    })}\n`);
    queue.ingest(drainCodexRollout(resolved!, start.newOffset).events);
    expect(queue.drainEmittable()).toMatchObject([{ turnId: 'om_input', finalText: '检查完成' }]);
  });

  it('does not bind a plain sibling history line without this write\'s marker', async () => {
    const target = pane(() => history(FOREIGN_SID, INPUT));
    const result = await createCodexAdapter().writeInput(target, INPUT, { correlateTranscript: true });
    expect(result).toMatchObject({ submitted: false });
    expect(codexTerminalSessionIsBound(target, FOREIGN_SID)).toBe(false);
  });

  it('also correlates a readable process with no open rollout yet', async () => {
    owned.mockReturnValue(new Set());
    const target = pane(text => history(SID, text));
    expect(await createCodexAdapter().writeInput(target, INPUT, { correlateTranscript: true }))
      .toMatchObject({ cliSessionId: SID, ownershipProven: true });
  });

  it('accepts the exact late receipt through the deferred recheck', async () => {
    const target = pane(() => {});
    const result = await createCodexAdapter().writeInput(target, INPUT, { correlateTranscript: true });
    expect(result).toMatchObject({ submitted: false });
    history(SID, target.text());
    expect(await result?.recheck?.()).toMatchObject({ submitted: true, cliSessionId: SID, ownershipProven: true });
    expect(codexTerminalSessionIsBound(target, SID)).toBe(true);
  });

  it('does not bind a delayed receipt to a replacement process', async () => {
    const target = pane(() => {});
    const result = await createCodexAdapter().writeInput(target, INPUT, { correlateTranscript: true });
    target.cliPid += 1;
    history(SID, target.text());
    // The replacement pid cannot own the rollout: the line comes back only as
    // the non-binding candidate (#2401), and the terminal session stays unbound.
    expect(await result?.recheck?.()).toEqual({ submitted: true, unprovenCliSessionId: SID });
    expect(codexTerminalSessionIsBound(target, SID)).toBe(false);
  });

  it('uses a different marker for repeated identical writes', async () => {
    const target = pane(text => history(SID, text));
    const adapter = createCodexAdapter();
    await adapter.writeInput(target, INPUT, { correlateTranscript: true });
    const first = target.text();
    await adapter.writeInput(target, INPUT, { correlateTranscript: true });
    expect(target.text()).not.toBe(first);
  });

  it('keeps bare adopt/zero-prompt input unproven and byte-for-byte unchanged', async () => {
    const target = pane(text => history(SID, text));
    // No correlation context: input is untouched, and the matched history line
    // comes back only as the non-binding candidate (#2401), never proven.
    expect(await createCodexAdapter().writeInput(target, INPUT))
      .toEqual({ submitted: true, unprovenCliSessionId: SID });
    expect(target.text()).toBe(INPUT);
    expect(codexTerminalSessionIsBound(target, SID)).toBe(false);
  });

  it('keeps the explicit remote thread gate and input unchanged', async () => {
    const target = Object.assign(pane(text => {
      history(FOREIGN_SID, text);
      history(SID, text);
    }), { expectedCodexSessionId: SID });
    const result = await createCodexAdapter().writeInput(target, INPUT, { correlateTranscript: true });
    expect(result).toMatchObject({ cliSessionId: SID, ownershipProven: true });
    expect(target.text()).toBe(INPUT);
  });

  it('retains the available owned-fd filter without changing the input', async () => {
    owned.mockReturnValue(new Set([SID]));
    const target = pane(text => {
      history(FOREIGN_SID, text);
      history(SID, text);
    });
    const result = await createCodexAdapter().writeInput(target, INPUT, { correlateTranscript: true });
    expect(result).toMatchObject({ cliSessionId: SID, ownershipProven: true });
    expect(target.text()).toBe(INPUT);
    expect(readFileSync(join(home, 'history.jsonl'), 'utf8')).not.toContain('botmux_input_id');
  });
});
