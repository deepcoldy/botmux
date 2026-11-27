import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function loadDispatcherSeams(): {
  shapeCardActionResult: (result: any) => any;
  patchTimedOutCardActionResult: (appId: string, data: any, shapedResult: any) => Promise<void>;
  calls: {
    token: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
} {
  const parsed = ts.createSourceFile(
    'event-dispatcher.ts',
    readFileSync(join(process.cwd(), 'src/im/lark/event-dispatcher.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = [
    'shapeCardActionResult',
    'patchTimedOutCardActionResult',
    'serializeRawCardForPatch',
    'cardActionMessageId',
    'cardActionToken',
    'delayedUpdateCardFromRaw',
    'cardActionPatchErrorDetail',
  ];
  const printer = ts.createPrinter();
  const declarations = names.map(name => {
    const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!declaration) throw new Error(`Missing dispatcher seam: ${name}`);
    return printer.printNode(ts.EmitHint.Unspecified, declaration, parsed);
  });
  const code = ts.transpileModule(declarations.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const calls = {
    token: vi.fn(async () => undefined),
    patch: vi.fn(async () => undefined),
    warn: vi.fn(),
  };
  const scope: Record<string, unknown> = {
    updateInteractiveCardByToken: calls.token,
    updateMessage: calls.patch,
    logger: { warn: calls.warn },
    extractLarkErrorShape: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
  };
  const proxy = new Proxy(scope, {
    has: (_target, key) => key !== Symbol.unscopables,
    get: (target, key) => key in target ? target[key as string] : (globalThis as any)[key],
  });
  const seams = new Function('scope', `with (scope) { ${code}; return { shapeCardActionResult, patchTimedOutCardActionResult }; }`)(proxy) as {
    shapeCardActionResult: (result: any) => any;
    patchTimedOutCardActionResult: (appId: string, data: any, shapedResult: any) => Promise<void>;
  };
  return { ...seams, calls };
}

const click = {
  token: 'callback-token',
  message_id: 'om_message',
};

describe('card action deferred update routing', () => {
  it('converts shaped card responses to deferredCard', () => {
    const { shapeCardActionResult } = loadDispatcherSeams();
    expect(shapeCardActionResult({ toast: { type: 'success', content: 'ok' }, card: { type: 'raw', data: { schema: '2.0' } } }))
      .toEqual({ toast: { type: 'success', content: 'ok' }, deferredCard: { type: 'raw', data: { schema: '2.0' } } });
  });

  it('uses token delayed update for template cards', async () => {
    const seams = loadDispatcherSeams();
    const card = { card: { type: 'template', data: { template_id: 'tpl' } } };
    await seams.patchTimedOutCardActionResult('app', click, { deferredCard: { type: 'raw', data: card } });
    expect(seams.calls.token).toHaveBeenCalledWith('app', 'callback-token', card.card);
    expect(seams.calls.patch).not.toHaveBeenCalled();
  });

  it('uses token delayed update for Card 2.0', async () => {
    const seams = loadDispatcherSeams();
    const card = { schema: '2.0', body: { elements: [] } };
    await seams.patchTimedOutCardActionResult('app', click, { deferredCard: { type: 'raw', data: card } });
    expect(seams.calls.token).toHaveBeenCalledWith('app', 'callback-token', card);
    expect(seams.calls.patch).not.toHaveBeenCalled();
  });

  it('keeps Card 1.0 group cards on message.patch even when token exists', async () => {
    const seams = loadDispatcherSeams();
    const card = { config: { update_multi: true }, elements: [] };
    await seams.patchTimedOutCardActionResult('app', click, { deferredCard: { type: 'raw', data: card } });
    expect(seams.calls.token).not.toHaveBeenCalled();
    expect(seams.calls.patch).toHaveBeenCalledWith('app', 'om_message', JSON.stringify(card));
  });

  it('falls back to message.patch when token delayed update fails', async () => {
    const seams = loadDispatcherSeams();
    seams.calls.token.mockRejectedValueOnce(new Error('token failed'));
    const card = { schema: '2.0', body: { elements: [] } };
    await seams.patchTimedOutCardActionResult('app', click, { deferredCard: { type: 'raw', data: card } });
    expect(seams.calls.token).toHaveBeenCalled();
    expect(seams.calls.patch).toHaveBeenCalledWith('app', 'om_message', JSON.stringify(card));
    expect(seams.calls.warn).toHaveBeenCalledWith(expect.stringContaining('falling back to message.patch'));
  });
});
