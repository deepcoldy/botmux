import { describe, expect, it, vi } from 'bun:test';
import {
  CodexAppRpcResponseError,
  CodexAppTransportError,
  CodexAppTurnController,
} from '../src/services/codex-app-turn-controller.js';
import type {
  CodexAppFinalMarker,
  CodexAppLifecycleEvent,
  CodexAppRunnerInput,
} from '../src/services/codex-app-runner-protocol.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createHarness() {
  const requests: Array<{
    method: string;
    params: any;
    response: Deferred<any>;
  }> = [];
  const finals: Array<CodexAppFinalMarker & { appTurnId: string }> = [];
  const diagnostics: string[] = [];
  const lifecycle: CodexAppLifecycleEvent[] = [];
  const displayed: string[] = [];
  let now = 100;
  const controller = new CodexAppTurnController({
    cwd: '/repo',
    ensureThread: async () => 'thread-1',
    request: vi.fn((method: string, params: unknown) => {
      const response = deferred<any>();
      requests.push({ method, params, response });
      return response.promise;
    }),
    prepareInput(input: CodexAppRunnerInput, structuredDisabled: boolean) {
      const structured = !!input.codexAppInput && !structuredDisabled;
      const text = structured ? input.codexAppInput!.text : input.content;
      return {
        input: [
          { type: 'text', text, text_elements: [] },
          ...(structured
            ? (input.codexAppInput?.localImages ?? []).map(image => ({
              type: 'localImage',
              path: image.path,
              ...(image.detail ? { detail: image.detail } : {}),
            }))
            : []),
        ],
        ...(structured && input.codexAppInput?.additionalContext
          ? { additionalContext: input.codexAppInput.additionalContext }
          : {}),
        ...(input.replyTurnId ? { clientUserMessageId: input.replyTurnId } : {}),
        visibleText: input.codexAppInput?.text ?? input.content,
        structured,
      };
    },
    isStartCapabilityError: error => (
      error instanceof CodexAppRpcResponseError
      && /additionalContext/.test(error.message)
    ),
    onTurnInput: (_input, prepared) => displayed.push(prepared.visibleText),
    onFinal: marker => finals.push(marker),
    onDiagnostic: message => diagnostics.push(message),
    onLifecycle: event => lifecycle.push(event),
    now: () => now++,
  });
  return { controller, requests, finals, diagnostics, lifecycle, displayed };
}

function completeTurn(controller: CodexAppTurnController, turnId: string, text = 'done'): void {
  controller.handleNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId,
      item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text },
    },
  });
  controller.handleNotification({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } },
  });
}

function input(content: string, replyTurnId: string): CodexAppRunnerInput {
  return {
    type: 'message',
    content: `legacy:${content}`,
    codexAppInput: {
      text: content,
      additionalContext: {
        botmux_sender: { kind: 'untrusted', value: 'Alice' },
      },
      localImages: [{ path: '/tmp/image.png', detail: 'high' }],
    },
    replyTurnId,
  };
}

describe('CodexAppTurnController', () => {
  it('serializes structured steers and binds one final to the last accepted input', async () => {
    const h = createHarness();
    h.controller.enqueue(input('first', 'om_first'));
    await flushAsync();

    expect(h.requests[0]).toMatchObject({
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        clientUserMessageId: 'om_first',
        input: [
          { type: 'text', text: 'first', text_elements: [] },
          { type: 'localImage', path: '/tmp/image.png', detail: 'high' },
        ],
        additionalContext: {
          botmux_sender: { kind: 'untrusted', value: 'Alice' },
        },
      },
    });

    h.requests[0].response.resolve({ turn: { id: 'app-1' } });
    await flushAsync();
    h.controller.enqueue(input('second', 'om_second'));
    h.controller.enqueue(input('third', 'om_third'));

    expect(h.requests.map(request => request.method)).toEqual(['turn/start', 'turn/steer']);
    expect(h.requests[1].params).toMatchObject({
      expectedTurnId: 'app-1',
      clientUserMessageId: 'om_second',
      input: [
        { type: 'text', text: 'second', text_elements: [] },
        { type: 'localImage', path: '/tmp/image.png', detail: 'high' },
      ],
    });

    h.requests[1].response.resolve({ turnId: 'app-1' });
    await flushAsync();
    h.requests[2].response.resolve({ turnId: 'app-1' });
    await flushAsync();
    completeTurn(h.controller, 'app-1', 'merged');

    expect(h.lifecycle.filter(event => event.kind === 'steer_accepted')).toEqual([
      expect.objectContaining({ appTurnId: 'app-1', replyTurnId: 'om_second' }),
      expect.objectContaining({ appTurnId: 'app-1', replyTurnId: 'om_third' }),
    ]);
    expect(h.displayed).toEqual(['first', 'second', 'third']);
    expect(h.finals).toEqual([expect.objectContaining({
      appTurnId: 'app-1',
      replyTurnId: 'om_third',
      content: 'merged',
    })]);
  });

  it('can steer after turn/started while turn/start response is pending', async () => {
    const h = createHarness();
    h.controller.enqueue(input('first', 'om_first'));
    h.controller.enqueue(input('follow up', 'om_second'));
    await flushAsync();

    h.controller.handleNotification({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'app-1', status: 'inProgress' } },
    });

    expect(h.requests.map(request => request.method)).toEqual(['turn/start', 'turn/steer']);
    expect(h.requests[1].params.expectedTurnId).toBe('app-1');
  });

  it('uses a completion barrier while a steer response is in flight', async () => {
    const h = createHarness();
    h.controller.enqueue(input('first', 'om_first'));
    await flushAsync();
    h.requests[0].response.resolve({ turn: { id: 'app-1' } });
    await flushAsync();
    h.controller.enqueue(input('second', 'om_second'));

    completeTurn(h.controller, 'app-1', 'merged');
    expect(h.finals).toHaveLength(0);
    expect(h.lifecycle).toContainEqual(expect.objectContaining({
      kind: 'completion_race',
      appTurnId: 'app-1',
      replyTurnId: 'om_second',
    }));

    h.requests[1].response.resolve({ turnId: 'app-1' });
    await flushAsync();
    expect(h.finals).toEqual([expect.objectContaining({
      appTurnId: 'app-1',
      replyTurnId: 'om_second',
      content: 'merged',
    })]);
  });

  it('keeps a definitely rejected steer queued for the next turn', async () => {
    const h = createHarness();
    h.controller.enqueue(input('first', 'om_first'));
    await flushAsync();
    h.requests[0].response.resolve({ turn: { id: 'app-1' } });
    await flushAsync();
    h.controller.enqueue(input('next turn', 'om_second'));

    h.requests[1].response.reject(new CodexAppRpcResponseError('turn/steer', {
      code: -32600,
      message: 'no active turn to steer',
    }));
    await flushAsync();
    completeTurn(h.controller, 'app-1', 'first done');
    await flushAsync();

    expect(h.requests.map(request => request.method)).toEqual([
      'turn/start',
      'turn/steer',
      'turn/start',
    ]);
    expect(h.lifecycle).toContainEqual(expect.objectContaining({
      kind: 'steer_rejected_fallback',
      appTurnId: 'app-1',
      replyTurnId: 'om_second',
    }));
    expect(h.lifecycle.some(event => event.kind === 'steer_accepted')).toBe(false);
    expect(h.displayed).toEqual(['first', 'next turn']);
  });

  it('does not replay a steer whose transport outcome is unknown', async () => {
    const h = createHarness();
    h.controller.enqueue(input('first', 'om_first'));
    await flushAsync();
    h.requests[0].response.resolve({ turn: { id: 'app-1' } });
    await flushAsync();
    h.controller.enqueue(input('uncertain', 'om_second'));

    h.requests[1].response.reject(new CodexAppTransportError('connection lost'));
    await flushAsync();

    expect(h.requests.map(request => request.method)).toEqual(['turn/start', 'turn/steer']);
    expect(h.finals).toEqual([expect.objectContaining({
      appTurnId: 'app-1',
      replyTurnId: 'om_second',
      content: expect.stringContaining('result unknown'),
    })]);
    expect(h.lifecycle).toContainEqual(expect.objectContaining({
      kind: 'unknown_outcome',
      operation: 'turn/steer',
      category: 'transport',
    }));
  });

  it('retries a pre-start structured capability rejection once with legacy input', async () => {
    const h = createHarness();
    h.controller.enqueue(input('first', 'om_first'));
    await flushAsync();

    h.requests[0].response.reject(new CodexAppRpcResponseError('turn/start', {
      code: -32600,
      message: 'unknown field additionalContext',
    }));
    await flushAsync();

    expect(h.requests).toHaveLength(2);
    expect(h.requests[0].params.input[0].text).toBe('first');
    expect(h.requests[1].params.input).toEqual([
      { type: 'text', text: 'legacy:first', text_elements: [] },
    ]);
    expect(h.requests[1].params).not.toHaveProperty('additionalContext');
    expect(h.displayed).toEqual(['first']);
    expect(h.diagnostics).toContain(
      '[codex-app] structured input unsupported; retrying this turn with the legacy prompt',
    );

    h.requests[1].response.resolve({ turn: { id: 'app-legacy' } });
    await flushAsync();
    completeTurn(h.controller, 'app-legacy');
    expect(h.finals).toHaveLength(1);
  });

  it('ignores duplicate completion notifications after emitting the final', async () => {
    const h = createHarness();
    h.controller.enqueue(input('first', 'om_first'));
    await flushAsync();
    h.requests[0].response.resolve({ turn: { id: 'app-1' } });
    await flushAsync();

    completeTurn(h.controller, 'app-1');
    completeTurn(h.controller, 'app-1');

    expect(h.finals).toHaveLength(1);
  });
});
