import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// The daemon's own worker callbacks, run without importing daemon.ts (which
// would start the fleet): what reaches the workflow wake as proof that the
// main session's CLI took a wake's text.
const source = ts.createSourceFile('daemon.ts', readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
function daemonCallback(name: string, scope: Record<string, unknown>) {
  let method: ts.MethodDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === name) method = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!method) throw new Error(`daemon callback ${name} missing`);
  const code = ts.transpileModule(`const hooks = { ${method.getText(source)} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function('scope', `with (scope) { ${code}; return hooks.${name}; }`)(scope);
}

function harness() {
  const onInputAccepted = vi.fn();
  const scope = {
    workflowMainWake: { onInputAccepted },
    logger: { warn: vi.fn(), error: vi.fn() },
    deploymentContinuationAuthority: () => undefined,
    recordDeploymentContinuation: () => false,
    sessionStore: {},
    setActiveInteractiveTurn: () => {},
    confirmNativeGroupContextInput: () => {},
    getBot: () => ({ config: { cliId: 'claude-code' } }),
  };
  const ds = { larkAppId: 'app_main', chatId: 'oc_main', session: { sessionId: 'sess-main', workerGeneration: 2, cliSessionId: 'native-1' } };
  return {
    ds,
    onInputAccepted,
    nativeInputConsumed: daemonCallback('onNativeInputConsumed', scope),
    promptSubmittedInput: daemonCallback('onPromptSubmittedInput', scope),
  };
}

describe('daemon: proof a wake\'s text was taken reaches the workflow wake', () => {
  const turnId = 'workflow-event:run-1:3';

  it('the prompt hook submitted the turn\'s text: forwarded for the live worker generation only', () => {
    const h = harness();
    h.promptSubmittedInput(h.ds, turnId, { workerGeneration: 1 });
    expect(h.onInputAccepted).not.toHaveBeenCalled();
    h.promptSubmittedInput(h.ds, turnId, { workerGeneration: 2 });
    expect(h.onInputAccepted).toHaveBeenCalledWith('sess-main', turnId);
  });

  it('a transcript receipt: forwarded unless from an older generation or naming another conversation', () => {
    const h = harness();
    const receipt = { type: 'native_input_consumed', turnId, proofKind: 'claude_transcript_user_record' };
    h.nativeInputConsumed(h.ds, receipt, { workerGeneration: 1 });
    h.nativeInputConsumed(h.ds, { ...receipt, nativeSessionId: 'native-other' }, { workerGeneration: 2 });
    expect(h.onInputAccepted).not.toHaveBeenCalled();
    h.nativeInputConsumed(h.ds, { ...receipt, nativeSessionId: 'native-1' }, { workerGeneration: 2 });
    expect(h.onInputAccepted).toHaveBeenCalledWith('sess-main', turnId);
  });
});
