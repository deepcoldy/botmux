import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomBridge, type WecomBridgePolicy, type WecomCore } from '../src/im/wecom/gateway/bridge.js';
import { WecomHttpCore } from '../src/im/wecom/gateway/core-client.js';
import { requestWecomCoreSessionAction } from '../src/im/wecom/gateway/command.js';
import { describeCloseResidual, parseCloseResidual } from '../src/core/close-residual.js';
import type { WecomCardEvent, WecomInboundMessage, WecomTemplateCard } from '../src/im/wecom/protocol/types.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SESSION_ID = 'sid-close-1';

/** A core HTTP client whose /close answers with `closeBody`. */
function httpCore(closeBody: Record<string, unknown>) {
  const request = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith('/close')) return new Response(JSON.stringify(closeBody));
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  });
  return { http: new WecomHttpCore('http://127.0.0.1:12345', request as typeof fetch), request };
}

function cardFixture(closeBody: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'wecom-close-residual-'));
  dirs.push(dir);
  const stateFile = join(dir, 'state.json');
  const { http, request } = httpCore(closeBody);
  const core: WecomCore = {
    trigger: vi.fn(async () => ({ ok: true, triggerId: 'turn-1', target: { kind: 'turn' as const, sessionId: SESSION_ID } })),
    result: vi.fn(async () => ({ ok: true, state: 'completed' as const, output: { content: 'answer' } })),
    interrupt: vi.fn(async () => {}),
    close: sessionId => http.close(sessionId),
  };
  const transport = {
    reply: vi.fn(async (_message: WecomInboundMessage, _text: string, _options?: { streamId?: string; finish?: boolean }) => {}),
    send: vi.fn(async (_id: string, _text: string) => {}),
    sendCard: vi.fn(async (_id: string, _card: WecomTemplateCard) => {}),
    updateCard: vi.fn(async (_event: WecomCardEvent, _card: WecomTemplateCard) => {}),
  };
  const policy: WecomBridgePolicy = { allowedUsers: ['alice'], replyCardActions: true };
  const bridge = new WecomBridge({ botId: 'bot', stateFile, allowedUsers: ['alice'], policy: () => policy, core, transport });
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const message: WecomInboundMessage = {
    messageId: 'm1', userId: 'alice', conversationId: 'g', chatType: 'group', text: 'hello', attachments: [],
    replyContext: { requestId: 'req-m1' },
  };
  const closeEvent = (): WecomCardEvent => {
    const task = Object.values(state().tasks)[0] as { streamId: string };
    return {
      messageId: 'card-close', botId: 'bot', userId: 'alice', conversationId: 'g', chatType: 'group',
      requestId: 'callback', taskId: `${task.streamId}-final`, eventKey: 'action:close', receivedAt: Date.now(),
    };
  };
  return { bridge, state, message, closeEvent, request };
}

function loggedLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map(call => call.map(String).join(' '));
}

describe('WeCom card close does not flatten a close residual into a clean close', () => {
  it('logs the surviving remote id and keeps the session under an uncertain management lock', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = cardFixture({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'remote_cancel_failed', taskId: 'remote-task-7' },
    });
    await f.bridge.receive(f.message);
    await f.bridge.tick();

    await f.bridge.receiveCardEvent(f.closeEvent());

    expect(f.request.mock.calls.some(call => String(call[0]).endsWith(`/api/sessions/${SESSION_ID}/close`))).toBe(true);
    const residualLines = loggedLines(errors).filter(line => line.includes('remote-task-7'));
    expect(residualLines).toHaveLength(1);
    expect(residualLines[0]).toContain(SESSION_ID);
    // The Dashboard projects this lock as the session's managementState.
    expect(f.state().sessionLocks?.[SESSION_ID]).toBe('uncertain');
  });

  it('a clean close clears the lock and logs nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = cardFixture({ ok: true, outcome: 'closed' });
    await f.bridge.receive(f.message);
    await f.bridge.tick();

    await f.bridge.receiveCardEvent(f.closeEvent());

    expect(f.request.mock.calls.some(call => String(call[0]).endsWith('/close'))).toBe(true);
    expect(errors).not.toHaveBeenCalled();
    expect(f.state().sessionLocks?.[SESSION_ID]).toBeUndefined();
  });
});

describe('WecomHttpCore.close decodes the residual at the JSON seam', () => {
  it.each([
    { name: 'clean close', body: { ok: true, outcome: 'closed' }, ok: true },
    { name: 'older core without outcome', body: { ok: true }, ok: true },
    { name: 'declared residual with a malformed payload', body: { ok: true, outcome: 'closed_with_residual', residual: 'x' }, ok: false },
    {
      name: 'local subtree residual',
      body: { ok: true, outcome: 'closed_with_residual', residual: { reason: 'local_subtree_boundary_unproven' } },
      ok: false,
    },
  ])('$name', async ({ body, ok }) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { http } = httpCore(body);

    expect(await http.close(SESSION_ID)).toEqual({ ok });

    const residual = parseCloseResidual(body);
    if (!residual) {
      expect(errors).not.toHaveBeenCalled();
      return;
    }
    const lines = loggedLines(errors);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(SESSION_ID);
    // A local residual names the host subtree, never a phantom remote id.
    expect(lines[0]).toContain(describeCloseResidual(residual));
  });
});

describe('Dashboard host close/archive of a WeCom session does not report a residual as completed', () => {
  const CORE_PORT = 19123;
  // The managed core's credential of this start: every request to the core is signed with it.
  const CORE_CREDENTIAL = 'core-credential-fixture';

  /** The dedicated core: `/close` answers with `closeBody`, every other route succeeds. */
  function coreRequest(closeBody: Record<string, unknown>) {
    return vi.fn(async (_port: number, path: string, _init?: RequestInit, _secret?: string) => (
      path.endsWith('/close')
        ? new Response(JSON.stringify(closeBody))
        : new Response(JSON.stringify({ ok: true }))
    ));
  }

  /** Gateway control replies to the Dashboard with exactly this controlSession result. */
  async function hostControl(operation: 'close' | 'archive', closeBody: Record<string, unknown>) {
    const f = cardFixture({ ok: true, outcome: 'closed' });
    await f.bridge.receive(f.message);
    await f.bridge.tick();
    const request = coreRequest(closeBody);
    const result = await f.bridge.controlSession(
      { sessionId: SESSION_ID, operation, requestId: `host-${operation}` },
      (sessionId, op) => requestWecomCoreSessionAction({ corePort: CORE_PORT, sessionId, operation: op, secret: CORE_CREDENTIAL, request }),
    );
    return { result, request };
  }

  it.each(['close', 'archive'] as const)('%s: a residual reaches the log and the Dashboard gets an uncertain result', async operation => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result, request } = await hostControl(operation, {
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'remote_cancel_failed', taskId: 'remote-task-9' },
    });

    expect(request).toHaveBeenCalledWith(CORE_PORT, `/api/sessions/${SESSION_ID}/close`, expect.anything(), CORE_CREDENTIAL);
    expect(result).toEqual({ ok: false, status: 'uncertain' });
    const residualLines = loggedLines(errors).filter(line => line.includes('remote-task-9'));
    expect(residualLines).toHaveLength(1);
    expect(residualLines[0]).toContain(SESSION_ID);
  });

  it.each(['close', 'archive'] as const)('%s: a clean close completes without logging', async operation => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = await hostControl(operation, { ok: true, outcome: 'closed' });

    expect(result).toEqual({ ok: true, status: 'completed' });
    expect(errors).not.toHaveBeenCalled();
  });

  it.each([
    ['delete', 'prune'],
    ['restart', 'restart'],
    ['resume', 'wake'],
    ['suspend', 'suspend'],
  ] as const)('%s keeps its own core route (/%s)', async (operation, route) => {
    const request = coreRequest({ ok: true, outcome: 'closed_with_residual' });

    const result = await requestWecomCoreSessionAction({ corePort: CORE_PORT, sessionId: SESSION_ID, operation, secret: CORE_CREDENTIAL, request });

    expect(result).toEqual({ ok: true });
    expect(request).toHaveBeenCalledExactlyOnceWith(CORE_PORT, `/api/sessions/${SESSION_ID}/${route}`, expect.anything(), CORE_CREDENTIAL);
  });
});
