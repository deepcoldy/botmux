import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { hasEmptyCodexComposer, parseCodexEffortMenu } from '../src/utils/codex-effort-menu.js';

// Exercise the production input boundaries without starting worker.ts's IPC server.
const parsed = ts.createSourceFile('worker.ts', readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function evaluate<T>(name: string, state: Record<string, any>): T {
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing worker function: ${name}`);
  const code = ts.transpileModule(declaration.getText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function('state', `with (state) { ${code}; return ${name}; }`)(state) as T;
}

describe('Codex effort menu input ownership', () => {
  it.each(['handleTuiKeys', 'handleTuiTextInput', 'handleTermAction'])(
    '%s never forwards input to a CLI replaced during menu cancellation', async name => {
      let release!: () => void;
      const cancelled = new Promise<void>(resolve => { release = resolve; });
      const state = {
        backend: {}, cliAdapter: {}, cliLifetimeNonce: 1,
        codexCliEffortOperation: {}, cancelCodexCliEffort: vi.fn(() => cancelled),
        effectiveBackendType: 'pty', isRemoteBackendType: () => false,
      };
      const handler = evaluate<(...args: any[]) => Promise<unknown>>(name, state);
      const result = handler(...(name === 'handleTermAction' ? ['enter'] : [['Enter'], 'user input']));
      expect(state.cancelCodexCliEffort).toHaveBeenCalledOnce();
      // No replacement write functions are supplied: reaching one fails the test.
      state.backend = {};
      release();
      expect(await result).toBe(name === 'handleTermAction' ? undefined : false);
    },
  );

  it('fences an in-place CLI restart even when the backend object stays the same', async () => {
    const state: Record<string, any> = {
      backend: {}, cliAdapter: {}, cliLifetimeNonce: 1, codexCliEffortOperation: {},
      cancelCodexCliEffort: async () => { state.cliLifetimeNonce++; },
    };
    const keys = evaluate<(keys: string[], final: boolean) => Promise<boolean>>('handleTuiKeys', state);
    expect(await keys(['Enter'], true)).toBe(false);
  });

  it.each([false, true])('holds queued messages until the picker is visibly closed (observe=%s)', observe => {
    let screen = 'Advanced Reasoning\n› 1. Max\n  2. Ultra\nenter default · s session · esc back';
    const backend = { captureCurrentScreen: () => screen };
    const state = {
      backend, cliLifetimeNonce: 1, codexCliEffortRecovery: { backend, lifetime: 1 },
      isObserveBackend: () => observe, renderer: { rawSnapshot: () => screen },
      hasEmptyCodexComposer, parseCodexEffortMenu,
    };
    const held = evaluate<() => boolean>('codexCliEffortNeedsRecovery', state);
    expect(held()).toBe(true);
    screen = '';
    expect(held()).toBe(true);
    screen = '› Ask Codex to do anything';
    expect(held()).toBe(false);
    expect(state.codexCliEffortRecovery).toBeUndefined();
  });

  it('does not carry an old picker recovery hold into a replacement CLI', () => {
    const state = {
      backend: {}, cliLifetimeNonce: 2, codexCliEffortRecovery: { backend: {}, lifetime: 1 },
    };
    expect(evaluate<() => boolean>('codexCliEffortNeedsRecovery', state)()).toBe(false);
    expect(state.codexCliEffortRecovery).toBeUndefined();
  });
});
